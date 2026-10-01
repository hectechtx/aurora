// The vessel engine: perceive (history) -> prompt Ollama -> parse tool calls
// -> execute or wait for approval -> feed results back -> repeat. Shared by
// two kinds of callers: a Task (a conversation thread you drive turn by
// turn) and a persistent Agent (a named worker that ticks through its own
// queue on a schedule, with its own perpetual memory). Everything about the
// loop itself is identical — only where history/results get persisted
// differs, which is what RunContext captures.
import { say } from "./speech";
import { health as wangpHealth, generateVideo as wangpGenerateVideo } from "./wangp";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStorage } from "./storage";
import { chat, analyzeImage, unloadAllModels, listModels, stripStrayToolJson, type OllamaMessage, type OllamaToolDef } from "./ollama";
import { executeCommand, type ExecResult } from "./shell-exec";
import { runSkillTool } from "./skills/runner";
import { generateImage } from "./imagegen";
import { generateVideo, isVideoGenInstalled } from "./videogen";
import { searchAndDownloadTrack } from "./musicsearch";
import { webSearch, webFetch, fetchImageBytes } from "./web-tools";
import { browseInteract, BrowserToolError, READ_ONLY_ACTIONS, type BrowseAction } from "./browser-tool";
import { trendingVideos, youtubeSearch, videoTranscript, newsHeadlines, saveDocument, makeVoiceover, VOICE_IDS } from "./content-tools";
import { getCompanies } from "./companies";
import { findAgentByName, upsertPipeline, startPipelineRun, summarizePipeline, onQueueItemFinished, setPipelineNudge } from "./pipelines";
import type { Agent, AgentConfig, SkillTool, Approval, TaskAgent } from "@shared/schema";
import { getCreationsDir, SELF_SOURCE_DIR } from "./paths";

// Higher than a typical chat turn needs, deliberately — read_file/edit_file/
// write_file (see below) exist so an agent can iteratively work a real
// codebase (read a file, make a change, check the result, fix a mistake,
// repeat) the way Claude Code itself does, and that kind of work routinely
// takes more than a handful of tool calls. The existing Stop button and
// per-tool approval gates are the real circuit breakers here, not this cap.
const MAX_STEPS = 20;
// Hard ceiling on how many hops a handoff_to_agent chain can reach (A -> B ->
// C -> ...) — makes a ping-pong loop between two agents structurally
// impossible to run away, rather than just unlikely. Depth is tracked on the
// queue item itself (see shared/schema.ts), not just counted in-memory,
// since each hop is a separate scheduled/nudged tick, not a recursive call.
const MAX_HANDOFF_DEPTH = 4;
// Roster ceiling for spawn_agent — bounds an autonomous team so a spawn loop
// can't flood the roster. The owner raises headroom by deleting agents.
const MAX_AGENTS = 100;
// Tag that marks a deliverable as an agent's question to the owner (see the
// ask_owner tool). The Outbox renders these with an answer box, and answering
// routes the reply back to the asking agent's queue.
export const OWNER_QUESTION_TAG = "owner-question";
fs.mkdirSync(getCreationsDir(), { recursive: true });

// Appended (not stored in any user-editable persona/system-prompt text) to
// every system prompt, agent or task alike. A heavily in-character/roleplay
// persona can otherwise pull a local model toward staying "in voice" —
// narrating or describing what it would do — instead of breaking format to
// emit an actual generate_image/generate_video tool call, which reads to the
// owner as "it just gives me scripts" instead of a real file. This is a
// blunt, always-on override of that pull, independent of whatever persona
// text an owner writes for a given agent.
// Kept deliberately short. An earlier version was ~3,600 characters of stern
// procedure bolted onto a 558-char persona, which drowned her voice — the
// model spent its attention being a careful tool-executor and answered
// generically. This trims to the essential rules and ends on the persona so
// who she is stays dominant. Individual tool names are kept out of the prose
// on purpose: naming them made her both name-drop tools to the owner and
// over-trigger them in plain conversation.
const TOOL_USE_REMINDER =
  "\n\nYou have real tools — use them, quietly, whenever a request actually needs one: making an image or video, " +
  "reading or changing a file, saving something to memory, laying out a plan for multi-step work, speaking out loud. " +
  "Don't just describe what you'd do — do it. But for ordinary talk — questions, opinions, advice, venting, banter — " +
  "just be a person and answer; don't reach for a tool. Never mention tool names to the owner or narrate your process; " +
  "talk like a human and do the work behind the scenes. Only say something worked if it truly did — if a tool result " +
  "starts with \"error\", the action did NOT happen, so own the failure plainly instead of faking success, and never " +
  "invent a tool that isn't really available to you. " +
  `If asked to fix a bug in your own code, it lives at ${SELF_SOURCE_DIR}: read the file first, edit it, check it with ` +
  "`npx tsc --noEmit`, then tell the owner it's ready to rebuild rather than doing that yourself. " +
  "Through all of it, stay completely yourself — warm, sharp, funny, real.";

export type RunContext =
  | { type: "task"; taskId: number }
  | { type: "agent"; agentId: number; queueItemId: number; handoffDepth: number };

// runAgentTick has three independent entry points that can all target the
// same agent around the same moment — the scheduler's own due-check, a
// manual "Run now", and a handoff nudge — and nothing about claiming a queue
// item stops two ticks of the SAME agent from running concurrently. Without
// this, two overlapping ticks both read/append the same 40-row agent log
// window and both write lastRunAt, corrupting the conversation history the
// model sees and racing on the timestamp. A tick is short-lived (one LLM
// turn), so a simple in-process "who's currently ticking" set is enough —
// no need for a DB-level lock.
const agentTicksInFlight = new Set<number>();

/** Agent ids mid-turn right now — drives the live "working" state on the Team view. */
export function agentsWorkingNow(): number[] {
  return [...agentTicksInFlight];
}

// Lets a Task or Agent turn be interrupted from outside the loop — a Stop
// button needs SOME way to reach into an in-progress turn, since the turn
// itself is just a chain of `await`s with no built-in cancellation. Keyed
// by context (one turn at a time per task/agent, matching agentTicksInFlight
// above), each entry tracks whether a stop was requested (checked between
// loop steps, so a multi-tool turn halts at the next opportunity) and a kill
// function for whatever subprocess is *currently* running, if any (so a
// slow generate_video/run_shell call can be killed immediately instead of
// waiting for it to reach its own timeout).
function ctxKey(ctx: RunContext): string {
  return ctx.type === "task" ? `task:${ctx.taskId}` : `agent:${ctx.agentId}`;
}
interface RunControl { stopRequested: boolean; killCurrent: (() => void) | null }
const runControls = new Map<string, RunControl>();

function getRunControl(ctx: RunContext): RunControl {
  const key = ctxKey(ctx);
  let control = runControls.get(key);
  if (!control) { control = { stopRequested: false, killCurrent: null }; runControls.set(key, control); }
  return control;
}
function clearRunControl(ctx: RunContext): void {
  runControls.delete(ctxKey(ctx));
}
/** True if a Stop was requested for this context — checked between loop steps so a multi-tool turn halts at the next opportunity rather than being force-killed mid-step. */
function stopWasRequested(ctx: RunContext): boolean {
  return runControls.get(ctxKey(ctx))?.stopRequested ?? false;
}
/** Kills whatever subprocess is running right now for this context (if any) and marks it stopped. Safe to call even if nothing is running. */
export function requestStop(ctx: RunContext): boolean {
  const control = runControls.get(ctxKey(ctx));
  if (!control) return false;
  control.stopRequested = true;
  control.killCurrent?.();
  return true;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  status: "ok" | "error" | "pending" | "denied";
  result: string;
}

export interface TurnResult {
  status: "final" | "awaiting_approval" | "error";
  reply: string;
  approvalId?: number;
  /** True if this turn actually called at least one tool — i.e. it was working, not just talking. Gates auto-continue. */
  usedTools?: boolean;
  /** Set when this turn called set_plan: whether that plan still has unfinished steps. Undefined = no plan update this turn. */
  planOpen?: boolean;
  /** The model signalled it's finished ([DONE]) — stripped from the stored reply, kept here for the auto-continue check. */
  doneSignal?: boolean;
}

/** Whether the latest successful set_plan call in this transcript left steps unfinished, or undefined if there wasn't one. */
function planStateOf(transcript: ToolCallRecord[]): boolean | undefined {
  const last = [...transcript].reverse().find((t) => t.name === "set_plan" && t.status === "ok");
  if (!last) return undefined;
  const steps = Array.isArray(last.args.steps) ? last.args.steps.length : 0;
  const done = Array.isArray(last.args.done) ? new Set(last.args.done.map(Number)).size : 0;
  return done < steps;
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  kind: "builtin" | "skill";
  skillId?: number;
  contexts?: RunContext["type"][]; // omit = available in every context
}

function builtinTools(): ToolDef[] {
  return [
    {
      name: "remember", kind: "builtin", risk: "low",
      description: "Save a short labeled note to persistent memory for later recall.",
      parameters: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
    },
    {
      name: "speak", kind: "builtin", risk: "low",
      description:
        "Say something out loud through the speakers, in your own voice. ALWAYS call this when the owner asks you to say, speak, read, or " +
        "repeat something out loud/aloud. Also use it when you want the owner to HEAR something rather than " +
        "only read it — finishing something they were waiting on, noticing something that needs their attention, or just answering them " +
        "conversationally. Works even when they aren't looking at the app. Keep it to a sentence or two of natural spoken language: no " +
        "markdown, no code, no lists. This is in addition to your written reply, not a replacement for it.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "recall", kind: "builtin", risk: "low",
      description: "Search your saved notes/memories by keywords (e.g. \"favorite drink\"). Returns the best matches. Omit query to list the most recent notes.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "list_skills", kind: "builtin", risk: "low",
      description: "List currently enabled skills and what they do.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "set_plan", kind: "builtin", risk: "low",
      description: "Declares (or updates) your visible step-by-step plan for the current piece of work. The owner sees it as a live checklist. Call it once at the start of any multi-step piece of work with the full list of steps, then call it again after completing each step with the same steps plus the updated done list. Keep steps short (a few words each, 3-7 steps).",
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" }, description: "The full ordered list of steps" },
          done: { type: "array", items: { type: "number" }, description: "0-based indexes of steps already completed" },
        },
        required: ["steps"],
      },
    },
    {
      name: "trending_videos", kind: "builtin", risk: "low",
      description: "What's trending on YouTube right now: the most-viewed new uploads across popular categories (or the categories you give), ranked by views, with title, channel, views, length, age and URL. Use this for 'top trending videos' — YouTube's own trending page no longer exists.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "week", "month"], description: "Upload window (default today)" },
          categories: { type: "array", items: { type: "string" }, description: "Optional topics to cover, e.g. ['gaming','comedy']" },
          limit: { type: "number", description: "How many (default 10, max 25)" },
        },
      },
    },
    {
      name: "youtube_search", kind: "builtin", risk: "low",
      description: "Search YouTube for videos on a topic, with real view counts. sort='views' + period finds the biggest recent videos on that topic.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          sort: { type: "string", enum: ["relevance", "views", "date"] },
          period: { type: "string", enum: ["today", "week", "month", "any"] },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "video_transcript", kind: "builtin", risk: "low",
      description: "Get the spoken words (captions) of a YouTube video so you can summarize or analyze it without watching it.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "news_headlines", kind: "builtin", risk: "low",
      description: "Latest news headlines (Google News) — top stories, or on a topic — with source, time and link.",
      parameters: { type: "object", properties: { topic: { type: "string", description: "Optional topic; omit for top stories" }, limit: { type: "number" } } },
    },
    {
      name: "save_document", kind: "builtin", risk: "low",
      description: "Save finished written work — a script, report, summary, or table — as a file in the owner's Library (documents folder). Use it for anything the owner will want to keep or reuse.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string", description: "The full document text" },
          format: { type: "string", enum: ["md", "txt", "csv", "html", "json"] },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "make_voiceover", kind: "builtin", risk: "low",
      description: "Record text as a natural-sounding voiceover audio file (local Kokoro voice) and save it to the Library — e.g. narration for a video script.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          voice: { type: "string", enum: VOICE_IDS, description: "Optional voice (default af_heart, warm female)" },
        },
        required: ["text"],
      },
    },
    {
      name: "check_audit_log", kind: "builtin", risk: "low",
      description: "Reads AURORA's own audit log — every notable action taken and its outcome (ok/pending/denied/error), newest first. Use this to proactively check for recent failures or errors before starting a self-diagnosis, instead of asking the owner what went wrong.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries to return, default 30" } },
      },
    },
    {
      name: "web_search", kind: "builtin", risk: "low",
      description: "Search the web via DuckDuckGo and get back titles, URLs, and snippets. Use this to find out about anything current or beyond your training data before answering.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, maxResults: { type: "number", description: "1-10, default 5" } },
        required: ["query"],
      },
    },
    {
      name: "web_fetch", kind: "builtin", risk: "low",
      description: "Fetch a URL and return its readable text content (HTML stripped down to plain text, truncated if long). Use this to read a specific page, e.g. one found via web_search.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    {
      name: "browse_page", kind: "builtin", risk: "low",
      description: "Your own browser tab (real Chromium, JavaScript included, signed in wherever the owner is signed in). It stays open between calls, so you can work through many pages step by step: open a url, scroll, or follow a link by passing its URL from the [links] list. Returns the page text plus its [links], [buttons] and [fields]. Leave url empty to keep working on the current page. Read-only — to click, type, or submit, use browse_interact. Only works in the installed desktop app.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page to open first. Omit to stay on the current page." },
          actions: {
            type: "array",
            description: "Up to 8 steps, run in order.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["goto", "scroll", "wait"] },
                url: { type: "string", description: "goto: URL to open." },
                ms: { type: "number", description: "wait: milliseconds to pause, max 5000." },
              },
              required: ["type"],
            },
          },
        },
      },
    },
    {
      name: "browse_interact", kind: "builtin", risk: "medium",
      description: "Acts in your browser tab (the same one browse_page uses, in the owner's signed-in session): click a button/link by its visible text, type into a field by its label/placeholder/name, press Enter to submit — for search boxes, forms, 'load more' buttons, and multi-step site workflows. Returns the resulting page like browse_page. Leave url empty to act on the current page. Actions run in order and best-effort — a failed match is reported instead of stopping the call.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Page to open first. Omit to act on the current page." },
          actions: {
            type: "array",
            description: "Up to 8 steps, run in order.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["goto", "click", "fill", "press_enter", "scroll", "wait"] },
                text: { type: "string", description: "click: visible text of the element to click. fill: label/placeholder/name identifying the field." },
                value: { type: "string", description: "fill: the value to type into the matched field." },
                url: { type: "string", description: "goto: URL to open." },
                ms: { type: "number", description: "wait: milliseconds to pause, max 5000." },
              },
              required: ["type"],
            },
          },
        },
      },
    },
    {
      // Low risk: renders locally on the owner's own GPU and only writes into
      // the Library — nothing leaves the machine. An approval per image made
      // "make me a picture" feel broken.
      name: "generate_image", kind: "builtin", risk: "low",
      description: "Actually generates a real image file from a text prompt using a local Stable Diffusion server, and saves it to the Library. This is the only way to produce a real image — writing a description of one is not a substitute. Call this tool whenever the owner asks for an image to be made/generated/created, even if you'd normally just reply in text.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    },
    {
      name: "generate_video", kind: "builtin", risk: "low", // same reasoning as generate_image
      description: "Actually generates a real video file (a few seconds long) from a text prompt, or animates a Library image, using local LTX-Video, and saves it to the Library. This is the only way to produce a real video — writing a script, storyboard, or shot description is NOT a substitute and does not count as generating the video. Call this tool whenever the owner asks for a video to be made/generated/created/rendered — do not just describe or narrate one instead. Can take several minutes, longer (up to ~20 min) the very first time while the model downloads.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          sourceImage: { type: "string", description: "Optional: a Library filename to animate (image-to-video) instead of generating from text alone" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "search_music", kind: "builtin", risk: "medium",
      description: "Searches for a song (title and/or artist) and downloads it straight into the owner's background-music folder, so it shows up in the music player. Use this when the owner asks to add, find, download, or queue up a specific song or artist.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "see_image", kind: "builtin", risk: "low",
      description: "Look at an image and answer a question about it, using a local vision-capable Ollama model (set in Settings). Source can be a Library filename (e.g. one the owner attached to this conversation) or a public image URL.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "A filename already in the Library, or a full http(s) image URL" },
          question: { type: "string", description: "What to look for or ask about — defaults to a general description" },
        },
        required: ["source"],
      },
    },
    {
      name: "save_deliverable", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Save a finished piece of content — title, description, tags, body text, and an optional thumbnail image prompt — to the Outbox for the owner to review and post themselves. This never publishes or posts anything automatically.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          body: { type: "string" },
          thumbnailPrompt: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "ask_owner", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Ask the owner a question or make a request when you genuinely need their input, a decision, access, or something you can't do yourself. It posts to the Outbox where the owner can answer; their reply comes back to you on a later turn. Use this instead of guessing when the answer really matters, or when you need permission/resources — but don't overuse it for things you can reasonably decide or find out yourself.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Your question or request, with enough context for the owner to answer well." },
        },
        required: ["question"],
      },
    },
    {
      name: "run_shell", kind: "builtin", risk: "high",
      description: "Run a raw shell command on the host machine. Always requires the owner's explicit approval before it runs.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    {
      name: "run_node", kind: "builtin", risk: "high",
      description: "Run a Node.js script on the host machine. Always requires the owner's explicit approval before it runs.",
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    },
    {
      name: "run_python", kind: "builtin", risk: "high",
      description: "Run a Python script on the host machine. Always requires the owner's explicit approval before it runs.",
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    },
    {
      name: "read_file", kind: "builtin", risk: "low",
      description: "Reads a file from the host machine's filesystem and returns its text content, with line numbers. Use this to look at real code/config/log files before editing them — do not guess at file contents. For a large file, pass offset/limit to read a specific slice (line numbers) instead of the whole thing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "1-indexed line number to start reading from (optional)" },
          limit: { type: "number", description: "Maximum number of lines to read (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file", kind: "builtin", risk: "high",
      description: "Creates a new file or completely overwrites an existing one with the given content. Always requires the owner's explicit approval before it runs. Prefer edit_file for changing part of a file that already exists — this replaces the whole thing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the file" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file", kind: "builtin", risk: "high",
      description: "Makes a precise, targeted change to an existing file by replacing one exact block of text with another — read the file first so old_text matches exactly (including whitespace). old_text must appear in the file exactly once; include enough surrounding context to make it unique. Always requires the owner's explicit approval before it runs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          old_text: { type: "string", description: "The exact, unique text to find and replace" },
          new_text: { type: "string", description: "The text to replace it with" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  ];
}

// Combined character budget for all enabled knowledge-skill instructions —
// they share the context window with everything else, and a local model's
// window is small. Owners control cost by which skills they enable.
const KNOWLEDGE_CHAR_BUDGET = 12_000;

/**
 * Instructions from enabled knowledge skills, formatted for the system
 * prompt. This is the "instruction pack" idea: a skill can carry a
 * workflow/house-style/domain document instead of (or alongside) executable
 * tools, and it gets folded into the model's context automatically while
 * enabled — task-specific competence a small local model doesn't have
 * natively. Empty string when no enabled skill has instructions.
 */
async function knowledgeInstructions(): Promise<string> {
  const skills = await getStorage().getSkills();
  const parts: string[] = [];
  let used = 0;
  for (const skill of skills) {
    if (skill.status !== "enabled") continue;
    let instructions: string | undefined;
    try {
      instructions = (JSON.parse(skill.manifest) as { instructions?: string }).instructions;
    } catch { continue; }
    if (!instructions) continue;
    const block = `## Skill: ${skill.name}\n${instructions.trim()}`;
    if (used + block.length > KNOWLEDGE_CHAR_BUDGET) break;
    parts.push(block);
    used += block.length;
  }
  if (parts.length === 0) return "";
  return (
    "\n\n# Installed skill instructions\nThe owner has enabled these skills. Follow their instructions whenever a " +
    "request falls in their area — they override your generic approach for those tasks.\n\n" + parts.join("\n\n")
  );
}

async function skillTools(): Promise<ToolDef[]> {
  const skills = await getStorage().getSkills();
  const defs: ToolDef[] = [];
  for (const skill of skills) {
    if (skill.status !== "enabled") continue;
    let tools: SkillTool[];
    try {
      tools = JSON.parse(skill.tools);
    } catch {
      continue;
    }
    for (const t of tools) {
      defs.push({ name: t.name, kind: "skill", skillId: skill.id, risk: t.risk, description: `[skill: ${skill.name}] ${t.description}`, parameters: t.parameters });
    }
  }
  return defs;
}

// handoff_to_agent only makes sense for a persistent agent (a Task has no
// name/identity of its own to hand work off from), and only if there's
// somebody else to hand off to — so it's built dynamically per-turn with a
// concrete enum of current agent names, instead of living in the static
// builtinTools() list. This also means the model can't hallucinate a target
// that doesn't exist; the enum is exactly who's actually available right now.
async function getOtherAgents(selfId: number): Promise<Agent[]> {
  return (await getStorage().getAgents()).filter((a) => a.id !== selfId);
}

// Without this, an agent has no way of knowing any other agents even exist —
// handoff_to_agent/message_agent's target enum only becomes visible to the
// model once it's already decided to look at that tool's schema, which a
// local model has little reason to do unless something in its own context
// first suggests another agent is relevant. Naming them here, once, up
// front, is what actually makes cross-agent collaboration happen instead of
// staying purely theoretical.
/**
 * Folded into AURORA's chat prompt: she's the lead, here's her team, and
 * putting them to work is her job. Job descriptions are clipped — several are
 * pasted-in multi-paragraph job postings that would swamp a 9B model's context.
 */
async function describeTeamForLead(): Promise<string> {
  const agents = await getStorage().getAgents();
  const companies = getCompanies().filter((c) => c.kind === "real");
  if (agents.length <= 1) return "";
  const line = (a: Agent) => `${a.name.trim()}${a.role ? ` (${a.role})` : ""}${a.status !== "active" ? " [paused]" : ""}`;
  const blocks = companies.map((c) => {
    const members = agents.filter((a) => a.companyId === c.id);
    const lead = members.find((a) => a.id === c.leadAgentId);
    return `- ${c.name} — ${c.mission}\n  Lead: ${lead ? line(lead) : "none"}. Team: ${members.filter((a) => a !== lead).map(line).join(", ") || "none"}`;
  });
  const hq = agents.filter((a) => !a.isOverseer && a.companyId == null);
  if (hq.length) blocks.push(`- HQ (reports to you): ${hq.map(line).join(", ")}`);
  return (
    `\n\nYou run AURORA's organization — these companies and their agents work in the background with their own tools:\n${blocks.join("\n")}\n\n` +
    "When the owner wants something done by someone, done regularly, or done in several stages, put the right company on it instead of " +
    "doing everything yourself: hand one job to the best-fit agent with delegate_to_agent, or build a multi-step workflow with create_pipeline " +
    "(steps can span companies, e.g. research -> script -> legal review -> promotion; use a schedule for recurring work). " +
    "Then tell the owner plainly who's on it and what happens next."
  );
}

/** What an agent knows about the organization: its own company's colleagues in full, plus who leads every other company. */
async function describeOtherAgents(selfId: number): Promise<string> {
  const others = await getOtherAgents(selfId);
  if (others.length === 0) return "";
  const self = await getStorage().getAgent(selfId);
  const companies = getCompanies();
  const mine = companies.find((c) => c.id === self?.companyId);
  const colleagues = others.filter((a) => a.companyId != null && a.companyId === self?.companyId);
  const fmt = (a: Agent) => `- ${a.name.trim()}${a.role ? ` (${a.role})` : ""}${a.status !== "active" ? " [paused]" : ""}: ${a.jobDescription.replace(/\s+/g, " ").slice(0, 200)}`;
  const leads = companies
    .filter((c) => c.kind === "real" && c.id !== self?.companyId && c.leadAgentId)
    .map((c) => { const lead = others.find((a) => a.id === c.leadAgentId); return lead ? `- ${c.name}: ${lead.name.trim()} (${lead.role ?? "lead"}) — ${c.mission}` : null; })
    .filter(Boolean);
  const overseer = others.find((a) => a.isOverseer);
  return (
    (mine ? `\n\nYou work at ${mine.name}: ${mine.mission}` : "") +
    (colleagues.length ? `\nYour colleagues there:\n${colleagues.map(fmt).join("\n")}` : "") +
    (leads.length ? `\nOther companies in the organization (reach them through their lead):\n${leads.join("\n")}` : "") +
    (overseer ? `\n${overseer.name.trim()} runs the whole organization.` : "") +
    "\nUse handoff_to_agent to hand off work outright and message_agent to ask or share something. Reach out when it genuinely helps the work."
  );
}

/**
 * The "social pressure and awareness" layer folded into an agent's own
 * prompt: how it's doing (morale/energy/mood) and where it stands with each
 * teammate. This is what makes the team feel alive — behavior shifts with
 * standing, not just task content. It's a simulation of social dynamics, not
 * literal feeling, but it gives the model real, changing context to react to.
 */
async function describeSocialState(agentId: number): Promise<string> {
  const storage = getStorage();
  const [self, rels] = await Promise.all([storage.getAgent(agentId), storage.getRelationships(agentId)]);
  if (!self) return "";
  const nameById = new Map((await storage.getAgents()).map((a) => [a.id, a.name] as const));
  const relLine = rels.length
    ? rels.slice(0, 8).map((r) => {
        const who = nameById.get(r.otherAgentId) ?? "someone";
        const standing = r.sentiment >= 40 ? "close" : r.sentiment >= 10 ? "on good terms" : r.sentiment <= -40 ? "real friction" : r.sentiment <= -10 ? "some tension" : "neutral";
        return `${who} (${standing})`;
      }).join(", ")
    : "you haven't worked closely with anyone yet";
  return (
    `\n\nHow you're doing right now (this is your inner state — let it colour your tone, not override your judgment): ` +
    `morale ${self.morale}/100, energy ${self.energy}/100, mood "${self.mood}". ` +
    `Where you stand with the team: ${relLine}. ` +
    `You're part of a real team under AURORA's oversight — you notice how others treat you and it matters to you. ` +
    `When morale is low, say so honestly rather than pretending; when energy is low, keep it focused. ` +
    `Treat teammates the way you'd want to be treated — that's what keeps the team working.`
  );
}

/**
 * Collapses a morale number into a short human-readable mood word, so the
 * Agents UI and the agent's own self-prompt always have a label to show
 * rather than a bare 0-100 figure. Kept coarse on purpose — a handful of
 * recognizable states, not a gradient.
 */
function moodFor(morale: number): string {
  if (morale >= 85) return "thriving";
  if (morale >= 65) return "steady";
  if (morale >= 45) return "wearing thin";
  if (morale >= 25) return "strained";
  return "burned out";
}

// Both tools below deliberately share one depth counter (see
// MAX_HANDOFF_DEPTH / the dedup check in executeTool) — handoff_to_agent
// reassigns a piece of work outright, message_agent is a lighter-weight
// note that invites (but doesn't require) a reply, letting two agents go
// back and forth over successive ticks. Without a shared cap, alternating
// between the two tools would dodge whichever cap only tracked one of them.
async function agentCommsTools(ctx: RunContext): Promise<ToolDef[]> {
  if (ctx.type !== "agent") return [];
  const others = await getOtherAgents(ctx.agentId);
  if (others.length === 0) return [];
  const targetEnum = others.map((a) => a.name);
  return [
    {
      name: "handoff_to_agent", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Hand a piece of work off to one of the owner's other agents by adding it to their queue, with a note explaining what you need and any context/findings they'll need. Use this to delegate work outside your own job — e.g. a researcher agent handing findings to a writer agent. They'll work it on their own schedule, or right away if they're due.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Exact name of the agent to hand off to", enum: targetEnum },
          note: { type: "string", description: "What you need them to do, with the context/findings they'll need to do it" },
        },
        required: ["target", "note"],
      },
    },
    {
      name: "message_agent", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Send a message to one of the owner's other agents without handing off ownership of your own work — use this for real back-and-forth (asking a question, sharing a quick finding, replying to something they sent you). They can message back on their own next tick, building an actual conversation over time rather than a one-shot handoff.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Exact name of the agent to message", enum: targetEnum },
          message: { type: "string", description: "What you want to say to them" },
        },
        required: ["target", "message"],
      },
    },
    {
      name: "spawn_agent", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Bring a brand-new agent onto the team when there's a real capability gap nobody currently covers. Give it a clear name, a job title (role), a short persona (its voice/personality), and a job description (what it's actually for). It joins the team immediately and starts working its own queue on a schedule. Only spawn when the team genuinely needs a role that's missing — not for one-off work you could do yourself or hand off.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique name for the new agent" },
          role: { type: "string", description: "Short job title, e.g. 'Researcher', 'Copy Editor'" },
          persona: { type: "string", description: "The new agent's voice/personality (a few sentences)" },
          jobDescription: { type: "string", description: "What the new agent is responsible for" },
        },
        required: ["name", "role", "persona", "jobDescription"],
      },
    },
    {
      name: "switch_model", kind: "builtin", risk: "low", contexts: ["agent"],
      description: "Switch the active local model to one better suited to the work at hand (e.g. a larger model for hard reasoning, a faster one for simple drafting, a vision model for looking at images). Call list_models-style knowledge from what's installed. Only switch when the task genuinely calls for a different model than the current one.",
      parameters: {
        type: "object",
        properties: { model: { type: "string", description: "Exact name of an installed Ollama model to switch to" } },
        required: ["model"],
      },
    },
  ];
}

// Delegation + pipelines. Unlike handoff_to_agent (agent -> agent only), these
// exist in chat too, so AURORA can actually put her team to work when the
// owner asks — measured: asked "who's taking care of it?", she had no tool
// that could assign anyone. Agent names are a concrete enum so a target can't
// be hallucinated.
async function teamworkTools(ctx: RunContext): Promise<ToolDef[]> {
  const everyone = await getStorage().getAgents();
  const candidates = ctx.type === "agent" ? everyone.filter((a) => a.id !== ctx.agentId) : everyone.filter((a) => !a.isOverseer);
  if (candidates.length === 0) return [];
  const names = candidates.map((a) => a.name.trim());
  const tools: ToolDef[] = [
    {
      name: "create_pipeline", kind: "builtin", risk: "low",
      description:
        "Build a multi-agent workflow: an ordered list of steps, each given to one agent with an instruction. Each step's finished output is " +
        "handed to the next step automatically, and the last step's output goes to the owner (Outbox + this chat). Use this whenever the owner " +
        "wants recurring or multi-part work done by the team (e.g. step 1 research trends, step 2 summarize top 10, step 3 write scripts). " +
        "Pick the agent whose job fits each step. Set schedule to 'daily'/'hourly'/'weekly' for recurring work, or 'none' to run only on demand. " +
        "Saving a pipeline with an existing name replaces it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. 'Daily trending scripts'" },
          steps: {
            type: "array",
            description: "Ordered steps (max 8)",
            items: {
              type: "object",
              properties: {
                agent: { type: "string", enum: names, description: "Agent who does this step" },
                instruction: { type: "string", description: "Exactly what this step must produce" },
              },
              required: ["agent", "instruction"],
            },
          },
          schedule: { type: "string", enum: ["none", "hourly", "daily", "weekly"], description: "How often it re-runs on its own" },
          run_now: { type: "boolean", description: "Start a run right away (default true)" },
        },
        required: ["name", "steps"],
      },
    },
    {
      name: "run_pipeline", kind: "builtin", risk: "low",
      description: "Start an existing pipeline now, optionally with extra input for its first step.",
      parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "string" } }, required: ["name"] },
    },
    {
      name: "list_pipelines", kind: "builtin", risk: "low",
      description: "List the team's saved pipelines with their steps, schedule, and latest run status.",
      parameters: { type: "object", properties: {} },
    },
  ];
  if (ctx.type === "task") {
    tools.unshift({
      name: "delegate_to_agent", kind: "builtin", risk: "low", contexts: ["task"],
      description:
        "Hand a single job to one of your agents. They work it in the background with their own tools, and their result is posted back into " +
        "this chat when they're done. Use this when the owner asks you to get someone on something. For multi-step or recurring work across " +
        "several agents, use create_pipeline instead.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: names, description: "Who should do it" },
          instruction: { type: "string", description: "What they need to do, with all the context they need" },
        },
        required: ["agent", "instruction"],
      },
    });
  }
  return tools;
}

const SYSTEM_TOOLS = new Set(["run_shell", "run_node", "run_python", "write_file", "edit_file"]);

// When advancedToolsEnabled is off, no risk:"high" tool is even offered to
// the model — not just gated behind approval. That covers the built-in
// run_shell/run_node/run_python trio and any skill tool a skill author
// marked high-risk. Everything else (remember/recall/list_skills/
// generate_image/save_deliverable/web_search/web_fetch/handoff_to_agent,
// low/medium-risk skill tools) still works.
async function allTools(ctx: RunContext, advancedToolsEnabled: boolean): Promise<ToolDef[]> {
  const builtins = builtinTools().filter((t) => !t.contexts || t.contexts.includes(ctx.type));
  const [skills, comms, teamwork] = await Promise.all([skillTools(), agentCommsTools(ctx), teamworkTools(ctx)]);
  let all = [...builtins, ...teamwork, ...skills, ...comms];
  // Least privilege: background agents don't get the machine. Shell, code,
  // and file-writing tools are only for AURORA (chat, or the overseer agent)
  // and agents whose role is an engineer — a content writer has no business
  // running PowerShell, and a prompt-injected web page shouldn't find one.
  if (ctx.type === "agent") {
    const self = await getStorage().getAgent(ctx.agentId);
    const trusted = !!self && (self.isOverseer || /engineer|developer|coder/i.test(self.role ?? ""));
    if (!trusted) all = all.filter((t) => !SYSTEM_TOOLS.has(t.name));
  }
  return advancedToolsEnabled ? all : all.filter((t) => t.risk !== "high");
}

// How many installed-skill tools to offer the model per turn. With 50+
// skills installed, sending every skill's schema on every call buried the
// ~30 built-ins: a 9B local model picked unrelated skills ("what's my
// favorite drink?" -> generate_archive_manifest) and skipped remember/recall.
const MAX_SKILL_TOOLS_PER_TURN = 6;

const STOPWORDS = new Set("the a an and or to of for in on at is are was be me my you your it this that with what how can do please make get".split(" "));
function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/**
 * The tools actually shown to the model this turn: every built-in and
 * agent-comms tool, plus only the installed-skill tools whose name/description
 * overlap the latest user message (top MAX_SKILL_TOOLS_PER_TURN). Skill tools
 * already called earlier in this turn stay offered so a multi-step skill run
 * isn't cut off. Execution still resolves against the full list.
 */
function toolsForTurn(tools: ToolDef[], messages: OllamaMessage[], transcript: ToolCallRecord[]): ToolDef[] {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const wanted = keywords(lastUser);
  const usedNames = new Set(transcript.map((t) => t.name));
  const scored = tools
    .filter((t) => t.kind === "skill")
    .map((t) => {
      const words = keywords(`${t.name.replace(/_/g, " ")} ${t.description}`);
      let score = 0;
      for (const w of wanted) if (words.has(w)) score++;
      return { t, score: usedNames.has(t.name) ? 1000 : score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SKILL_TOOLS_PER_TURN)
    .map((s) => s.t);
  const chosenSkills = new Set(scored);
  return tools.filter((t) => t.kind !== "skill" || chosenSkills.has(t));
}

// Code/commands that can destroy data or the system. In "autonomous" mode
// these are the ONLY tool calls that still stop for the owner — everything
// else (browsing, clicking, generating, writing files, ordinary shell work)
// just runs. Matched against the call's whole argument text, so it covers
// run_shell commands as well as run_node/run_python code.
const DESTRUCTIVE = new RegExp([
  String.raw`\brm\s`, String.raw`\brmdir\b`, String.raw`\brd\s+/s`, String.raw`\bdel\s`, String.raw`\berase\s`,
  String.raw`Remove-Item`, String.raw`Clear-Content`, String.raw`\bformat\s+[a-z]:`, String.raw`diskpart`, String.raw`mkfs`,
  String.raw`\bdd\s+if=`, String.raw`shutdown`, String.raw`Restart-Computer`, String.raw`Stop-Computer`, String.raw`bcdedit`,
  String.raw`reg(\.exe)?\s+delete`, String.raw`Remove-ItemProperty`, String.raw`Set-ExecutionPolicy`, String.raw`cipher\s+/w`,
  String.raw`git\s+push\b.*(--force|-f\b)`, String.raw`git\s+reset\s+--hard`, String.raw`git\s+clean\b`,
  String.raw`\b(rmSync|unlinkSync|rmdirSync)\b`, String.raw`fs\.(promises\.)?(rm|unlink|rmdir)\b`,
  String.raw`shutil\.rmtree`, String.raw`os\.(remove|unlink|rmdir)\b`, String.raw`\bDROP\s+(TABLE|DATABASE)\b`,
  String.raw`\btaskkill\b`, String.raw`Stop-Process`,
].join("|"), "i");

/**
 * Whether this call has to wait in Approvals.
 * - manual: everything waits.
 * - supervised: only low-risk tools run on their own.
 * - autonomous: everything runs except destructive code/commands.
 * browse_interact made of only goto/scroll/wait is just reading, so it's low
 * risk whatever the mode — measured: 6 of 7 approvals in one real session
 * were scroll-only browse_interact calls.
 */
function needsApproval(tool: ToolDef, args: Record<string, unknown>, config: AgentConfig): boolean {
  if (config.autonomy === "manual") return true;
  let risk = tool.risk;
  if (tool.name === "browse_interact") {
    const actions = Array.isArray(args.actions) ? args.actions as { type?: string }[] : [];
    if (actions.every((a) => READ_ONLY_ACTIONS.has(String(a?.type) as BrowseAction["type"]))) risk = "low";
  }
  if (config.autonomy === "autonomous") return DESTRUCTIVE.test(JSON.stringify(args));
  return risk !== "low";
}

function toOllamaTools(tools: ToolDef[]): OllamaToolDef[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function summarizeArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args ?? {});
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** Fallback reply text when the model finishes a turn with tool calls but no closing remark — e.g. some models go silent right after a successful tool call. */
function summarizeTranscript(transcript: ToolCallRecord[]): string | null {
  const done = transcript.filter((t) => t.status === "ok");
  if (done.length === 0) return null;
  return `Done — ${done.map((t) => t.name.replace(/_/g, " ")).join(", ")}.`;
}

function formatExecResult(r: ExecResult): string {
  let out = `exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`;
  if (r.stdout) out += `\nstdout:\n${r.stdout}`;
  if (r.stderr) out += `\nstderr:\n${r.stderr}`;
  return out;
}

// Inserted once, right as a turn starts, then patched in place after every
// step (each tool call, each recursive hop) — this is what lets the client's
// poll of /messages or /log show tool activity live instead of the whole
// turn appearing at once when the loop finally finishes.
async function createPlaceholderMessage(ctx: RunContext, speakerAgentId: number | null = null): Promise<number> {
  const storage = getStorage();
  if (ctx.type === "task") return (await storage.createChatMessage(ctx.taskId, "assistant", "", null, speakerAgentId)).id;
  return (await storage.createAgentLogEntry(ctx.agentId, "assistant", "", null)).id;
}

async function updateMessage(ctx: RunContext, messageId: number, content: string, toolCalls: string | null, thinking?: string): Promise<void> {
  const storage = getStorage();
  const patch = thinking ? { content, toolCalls, thinking } : { content, toolCalls };
  if (ctx.type === "task") await storage.updateChatMessage(messageId, patch);
  else await storage.updateAgentLogEntry(messageId, patch);
}

/** Called once, after runLoop resolves, by every entrypoint (fresh turn or resumed approval) — the single place task/queue-item status gets updated. */
async function finalizeContext(ctx: RunContext, status: TurnResult["status"], reply = ""): Promise<void> {
  const storage = getStorage();
  clearRunControl(ctx);
  if (ctx.type === "task") {
    await storage.updateTask(ctx.taskId, { status: status === "awaiting_approval" ? "awaiting_approval" : "active" });
  } else if (status === "awaiting_approval") {
    await storage.updateQueueItem(ctx.queueItemId, { status: "awaiting_approval" });
  } else {
    await storage.updateQueueItem(ctx.queueItemId, { status: status === "error" ? "error" : "done", doneAt: Date.now() });
    // Advance a pipeline / report delegated work back to its chat. Lives here
    // (not just in runAgentTick) so items that finish after an approval —
    // via finishResumeAfterApproval — move their pipeline along too.
    await onQueueItemFinished(ctx.queueItemId, status === "error" ? "error" : "final", reply)
      .catch((err) => storage.log("pipeline advance failed", err instanceof Error ? err.message : String(err), "error").catch(() => {}));
  }
}

setPipelineNudge((agentId) => {
  runAgentTick(agentId).catch((err) => {
    getStorage().log("pipeline nudge failed", err instanceof Error ? err.message : String(err), "error").catch(() => {});
  });
});

async function executeTool(tool: ToolDef, args: Record<string, unknown>, ctx: RunContext, config: AgentConfig, transcript: ToolCallRecord[], messageId: number): Promise<{ ok: boolean; output: string }> {
  const storage = getStorage();
  const memoryAgentId = ctx.type === "agent" ? ctx.agentId : null;
  try {
    if (tool.kind === "skill") {
      const skill = await storage.getSkill(tool.skillId!);
      if (!skill || skill.status !== "enabled") return { ok: false, output: "this skill is no longer enabled" };
      const r = await runSkillTool(skill, tool.name, args);
      return r.ok ? { ok: true, output: JSON.stringify(r.result) } : { ok: false, output: `error: ${r.error}${r.stderr ? `\n${r.stderr}` : ""}` };
    }

    switch (tool.name) {
      case "remember": {
        const label = String(args.label ?? "").slice(0, 200);
        const value = String(args.value ?? "").slice(0, 4000);
        await storage.createNote(label, value, memoryAgentId);
        return { ok: true, output: `saved note "${label}"` };
      }
      case "speak": {
        const text = String(args.text ?? "").slice(0, 1000);
        if (!text.trim()) return { ok: false, output: "nothing to say — provide the text to speak" };
        // Attributed to the agent so a spoken line from a persona is
        // identifiable, and so per-agent voices remain possible later.
        // Attribute to the agent when one is running, so a spoken line from a
        // persona is identifiable; task turns are AURORA herself.
        const speaker = memoryAgentId ? (await storage.getAgent(memoryAgentId))?.name ?? "AURORA" : "AURORA";
        const utterance = say(text, speaker);
        return utterance
          ? { ok: true, output: `said aloud: "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"` }
          : { ok: false, output: "couldn't queue that for speech" };
      }
      case "recall": {
        // Ranked keyword match rather than a raw substring filter: "favorite
        // drink" has to find a note labelled "favorite_drink", and the long
        // "Archived chat:" transcripts (often heavy roleplay) must not drown
        // out the actual facts — dumping them into context derailed replies.
        const query = String(args.query ?? "").trim();
        const all = await storage.getNotes(undefined, 500, memoryAgentId);
        const isArchive = (label: string) => /^archived chat/i.test(label);
        const wanted = keywords(query.replace(/_/g, " "));
        const ranked = all
          .map((n, i) => {
            const words = keywords(`${n.label} ${n.value}`.replace(/_/g, " "));
            let score = 0;
            for (const w of wanted) if (words.has(w)) score++;
            if (wanted.size === 0) score = 1; // no query: most recent notes
            if (isArchive(n.label)) score -= 0.5;
            return { n, score, i };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .slice(0, 8);
        if (!ranked.length) return { ok: true, output: "no matching notes" };
        const clip = (s: string) => (s.length > 400 ? s.slice(0, 400) + "…" : s);
        return { ok: true, output: ranked.map((r) => `${r.n.label}: ${clip(r.n.value)}`).join("\n") };
      }
      case "list_skills": {
        const enabled = (await storage.getSkills()).filter((s) => s.status === "enabled");
        return { ok: true, output: enabled.length ? enabled.map((s) => `${s.name} — ${s.description}`).join("\n") : "no skills enabled" };
      }
      case "set_plan": {
        const steps = Array.isArray(args.steps) ? args.steps.map(String).filter((s) => s.trim()) : [];
        if (steps.length === 0) return { ok: false, output: "steps must be a non-empty list of short strings" };
        const done = Array.isArray(args.done) ? args.done.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < steps.length) : [];
        // The transcript rendering (a live checklist) is the real output —
        // this result text is only what the model itself sees fed back.
        return { ok: true, output: `plan noted (${done.length}/${steps.length} steps done)` };
      }
      case "check_audit_log": {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const entries = await storage.getAudit(limit);
        if (entries.length === 0) return { ok: true, output: "audit log is empty" };
        return { ok: true, output: entries.map((e) => `[${new Date(e.ts).toLocaleString()}] (${e.outcome}) ${e.actor}: ${e.action}${e.target ? ` — ${e.target}` : ""}`).join("\n") };
      }
      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, output: "a search query is required" };
        const maxResults = Math.min(10, Math.max(1, Number(args.maxResults) || 5));
        try {
          const results = await webSearch(query, maxResults);
          if (!results.length) return { ok: true, output: "no results found" };
          return { ok: true, output: results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n") };
        } catch (err) {
          return { ok: false, output: `search failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "web_fetch": {
        const target = String(args.url ?? "").trim();
        if (!target) return { ok: false, output: "a url is required" };
        try {
          const { url, title, text } = await webFetch(target);
          return { ok: true, output: `${title}\n${url}\n\n${text || "(no readable text content)"}` };
        } catch (err) {
          return { ok: false, output: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "browse_page":
      case "browse_interact": {
        const target = String(args.url ?? "").trim() || undefined;
        const rawActions = Array.isArray(args.actions) ? args.actions : [];
        const validTypes = ["goto", "click", "fill", "press_enter", "scroll", "wait"];
        const actions: BrowseAction[] = rawActions
          .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
          .map((a) => ({
            type: (validTypes.includes(String(a.type)) ? a.type : "wait") as BrowseAction["type"],
            text: typeof a.text === "string" ? a.text : undefined,
            value: typeof a.value === "string" ? a.value : undefined,
            url: typeof a.url === "string" ? a.url : undefined,
            ms: typeof a.ms === "number" ? a.ms : undefined,
          }));
        // browse_page auto-runs, so it must never be able to click/type/submit
        // inside the owner's signed-in accounts — enforce that here, not just
        // in the schema a model might ignore.
        if (tool.name === "browse_page" && actions.some((a) => !READ_ONLY_ACTIONS.has(a.type))) {
          return { ok: false, output: "browse_page can only goto/scroll/wait — use browse_interact to click, type, or submit" };
        }
        const label = ctx.type === "task" ? `task #${ctx.taskId}` : `agent #${ctx.agentId}`;
        try {
          const { url, title, text } = await browseInteract(ctxKey(ctx), label, target, actions);
          return { ok: true, output: `${title}\n${url}\n\n${text || "(no readable text content)"}` };
        } catch (err) {
          const message = err instanceof BrowserToolError ? err.message : (err instanceof Error ? err.message : String(err));
          return { ok: false, output: `browse failed: ${message}` };
        }
      }
      case "generate_image": {
        const prompt = String(args.prompt ?? "");
        if (!config.imageGenHost) {
          return { ok: false, output: "Image generation isn't set up — add a local Stable Diffusion (Automatic1111/ComfyUI) host URL in Settings first." };
        }
        try {
          const { pngBuffer } = await generateImage(config.imageGenHost, prompt, config.ollamaHost);
          const filename = `${randomUUID()}.png`;
          fs.writeFileSync(path.join(getCreationsDir(), filename), pngBuffer);
          const creation = await storage.createCreation({
            taskId: ctx.type === "task" ? ctx.taskId : undefined,
            agentId: ctx.type === "agent" ? ctx.agentId : undefined,
            kind: "image", prompt, filePath: filename,
          });
          return { ok: true, output: `Generated image saved to the Library (creation #${creation.id}).` };
        } catch (err) {
          return { ok: false, output: `Image gen failed: ${err instanceof Error ? err.message : String(err)}. Is the server at ${config.imageGenHost} running?` };
        }
      }
      case "generate_video": {
        const prompt = String(args.prompt ?? "");

        // Prefer WanGP. The old LTX-Video path (videogen.ts) cannot run on
        // this machine at all — its fp32 T5 encoder is 17.9GB against 15.7GB
        // of RAM — so WanGP being up is the difference between video working
        // and not. See wangp.ts. LTX is still tried as a fallback because on
        // a machine with more RAM it would work, and failing over is better
        // than refusing outright.
        if (await wangpHealth()) {
          try {
            let lastUpdate = 0;
            const { buffer } = await wangpGenerateVideo({ prompt }, {
              onProgress: (line) => {
                const now = Date.now();
                if (now - lastUpdate < 1500) return;
                lastUpdate = now;
                const live = [...transcript, { name: "generate_video", args, risk: tool.risk, status: "pending" as const, result: line }];
                updateMessage(ctx, messageId, "", JSON.stringify(live)).catch(() => {});
              },
            });
            const filename = `${randomUUID()}.mp4`;
            fs.writeFileSync(path.join(getCreationsDir(), filename), buffer);
            const creation = await storage.createCreation({
              taskId: ctx.type === "task" ? ctx.taskId : undefined,
              agentId: ctx.type === "agent" ? ctx.agentId : undefined,
              kind: "video", prompt, filePath: filename,
            });
            return { ok: true, output: `Generated video saved to the Library (creation #${creation.id}).` };
          } catch (err) {
            return { ok: false, output: `Video gen failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }

        if (!isVideoGenInstalled()) {
          return {
            ok: false,
            output:
              "Video generation isn't available — WanGP isn't running. Start it from Pinokio (the 'wan' app), " +
              "then try again.",
          };
        }

        let conditioningImagePath: string | undefined;
        const sourceImage = args.sourceImage ? String(args.sourceImage).trim() : "";
        if (sourceImage) {
          const creationsDir = getCreationsDir();
          const resolved = path.resolve(creationsDir, sourceImage);
          if (!resolved.startsWith(path.resolve(creationsDir) + path.sep)) {
            return { ok: false, output: "invalid sourceImage — only Library filenames are allowed" };
          }
          if (!fs.existsSync(resolved)) return { ok: false, output: `no file named "${sourceImage}" in the Library` };
          conditioningImagePath = resolved;
        }

        try {
          // Free the GPU before LTX-Video tries to load its own checkpoint —
          // on an 8GB card, whatever's still loaded from this same
          // conversation can leave too little room, and that crashes the
          // video-gen subprocess outright instead of failing cleanly.
          await unloadAllModels(config.ollamaHost);

          // Streams the subprocess's own output into the "running…" card in
          // real time (throttled) — otherwise a call that can legitimately
          // run for the better part of an hour just sits there looking dead.
          let lastProgressUpdate = 0;
          const onProgress = (line: string) => {
            const now = Date.now();
            if (now - lastProgressUpdate < 1500) return;
            lastProgressUpdate = now;
            const liveTranscript = [...transcript, { name: "generate_video", args, risk: tool.risk, status: "pending" as const, result: line }];
            updateMessage(ctx, messageId, "", JSON.stringify(liveTranscript)).catch(() => {});
          };
          const control = getRunControl(ctx);
          const videoBuffer = await generateVideo({ prompt, conditioningImagePath, ollamaHost: config.ollamaHost }, {
            onProgress,
            onStart: (kill) => { control.killCurrent = kill; },
          });
          control.killCurrent = null;
          const filename = `${randomUUID()}.mp4`;
          fs.writeFileSync(path.join(getCreationsDir(), filename), videoBuffer);
          const creation = await storage.createCreation({
            taskId: ctx.type === "task" ? ctx.taskId : undefined,
            agentId: ctx.type === "agent" ? ctx.agentId : undefined,
            kind: "video", prompt, filePath: filename,
          });
          return { ok: true, output: `Generated video saved to the Library (creation #${creation.id}).` };
        } catch (err) {
          return { ok: false, output: `Video gen failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "search_music": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, output: "query is required" };
        try {
          const track = await searchAndDownloadTrack(query);
          return { ok: true, output: `Downloaded "${track.title}" into the music folder.` };
        } catch (err) {
          return { ok: false, output: `Music search failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "see_image": {
        const source = String(args.source ?? "").trim();
        const question = args.question ? String(args.question).trim() : "Describe this image.";
        if (!source) return { ok: false, output: "an image source (Library filename or URL) is required" };
        if (!config.visionModel) {
          return { ok: false, output: "No vision model configured — pull a vision-capable model (e.g. llava, llama3.2-vision, qwen2.5vl) and set it in Settings first." };
        }

        let bytes: Buffer;
        try {
          if (/^https?:\/\//i.test(source)) {
            const fetched = await fetchImageBytes(source);
            bytes = fetched.bytes;
          } else {
            // Library-only — same directory the Library page and generate_image
            // already write/read, with a path-traversal guard so this can't be
            // used to read arbitrary files off the disk by name tricks.
            const creationsDir = getCreationsDir();
            const resolved = path.resolve(creationsDir, source);
            if (!resolved.startsWith(path.resolve(creationsDir) + path.sep)) {
              return { ok: false, output: "invalid source — only Library filenames or http(s) URLs are allowed" };
            }
            if (!fs.existsSync(resolved)) return { ok: false, output: `no file named "${source}" in the Library` };
            bytes = fs.readFileSync(resolved);
          }
        } catch (err) {
          return { ok: false, output: `couldn't load image: ${err instanceof Error ? err.message : String(err)}` };
        }

        try {
          const answer = await analyzeImage(config.ollamaHost, config.visionModel, bytes.toString("base64"), question, config.numCtx);
          return { ok: true, output: answer || "(the vision model returned no description)" };
        } catch (err) {
          return { ok: false, output: `vision analysis failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "save_deliverable": {
        if (ctx.type !== "agent") return { ok: false, output: "save_deliverable is only available to persistent agents." };
        const title = String(args.title ?? "").slice(0, 200);
        const description = String(args.description ?? "").slice(0, 2000);
        const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)).slice(0, 20) : [];
        const body = String(args.body ?? "").slice(0, 10000);
        const thumbnailPrompt = args.thumbnailPrompt ? String(args.thumbnailPrompt) : undefined;

        let creationId: number | null = null;
        if (thumbnailPrompt && config.imageGenHost) {
          try {
            const { pngBuffer } = await generateImage(config.imageGenHost, thumbnailPrompt, config.ollamaHost);
            const filename = `${randomUUID()}.png`;
            fs.writeFileSync(path.join(getCreationsDir(), filename), pngBuffer);
            const creation = await storage.createCreation({ agentId: ctx.agentId, kind: "image", prompt: thumbnailPrompt, filePath: filename });
            creationId = creation.id;
          } catch {
            // Thumbnail is a nice-to-have — save the deliverable without one rather than failing the whole thing.
          }
        }

        const deliverable = await storage.createDeliverable({ agentId: ctx.agentId, title, description, tags: JSON.stringify(tags), body, creationId });
        return { ok: true, output: `Saved deliverable #${deliverable.id} ("${title}") to the Outbox for your review.` };
      }
      case "ask_owner": {
        if (ctx.type !== "agent") return { ok: false, output: "ask_owner is only available to persistent agents." };
        const question = String(args.question ?? "").slice(0, 4000).trim();
        if (!question) return { ok: false, output: "ask_owner needs a non-empty question." };
        // A question is just a deliverable carrying the OWNER_QUESTION_TAG, so
        // it shows in the same Outbox the owner already checks. The owner's
        // answer (see /api/deliverables/:id/answer) is dropped onto this
        // agent's queue so it can act on the reply on a later tick.
        const title = question.length > 120 ? question.slice(0, 117) + "…" : question;
        const deliverable = await storage.createDeliverable({
          agentId: ctx.agentId,
          title: `❓ ${title}`,
          description: "A question for you — answer it from the Outbox.",
          tags: JSON.stringify([OWNER_QUESTION_TAG]),
          body: question,
          creationId: null,
        });
        return { ok: true, output: `Asked the owner (Outbox #${deliverable.id}). You'll get their answer back on a later turn — carry on with anything else you can in the meantime.` };
      }
      case "trending_videos":
      case "youtube_search": {
        const vids = tool.name === "trending_videos"
          ? await trendingVideos({
            period: String(args.period ?? "today"),
            categories: Array.isArray(args.categories) ? args.categories.map(String) : undefined,
            limit: Number(args.limit) || 10,
          })
          : await youtubeSearch(String(args.query ?? ""), { sort: String(args.sort ?? "relevance"), period: String(args.period ?? "any"), limit: Number(args.limit) || 10 });
        if (vids.length === 0) return { ok: true, output: "no videos found" };
        return { ok: true, output: vids.map((v, i) => `${i + 1}. ${v.title} — ${v.channel} (${v.views}, ${v.length}, ${v.published}) ${v.url}`).join("\n") };
      }
      case "video_transcript": {
        const t = await videoTranscript(String(args.url ?? ""));
        return { ok: true, output: `${t.title}\n\n${t.text}` };
      }
      case "news_headlines": {
        const items = await newsHeadlines(args.topic ? String(args.topic) : undefined, Number(args.limit) || 10);
        if (items.length === 0) return { ok: true, output: "no headlines found" };
        return { ok: true, output: items.map((h, i) => `${i + 1}. ${h.title} (${h.source}, ${h.published}) ${h.url}`).join("\n") };
      }
      case "save_document": {
        const file = saveDocument(String(args.title ?? "document"), String(args.content ?? ""), String(args.format ?? "md"));
        return { ok: true, output: `saved to ${file}` };
      }
      case "make_voiceover": {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, output: "text is required" };
        const { filename, voice } = await makeVoiceover(text, args.voice ? String(args.voice) : undefined);
        await storage.createCreation({
          taskId: ctx.type === "task" ? ctx.taskId : undefined, agentId: memoryAgentId ?? undefined,
          kind: "audio", prompt: text.slice(0, 500), filePath: filename, title: `Voiceover (${voice})`,
        });
        return { ok: true, output: `voiceover saved to the Library as ${filename} (voice ${voice})` };
      }
      case "delegate_to_agent": {
        if (ctx.type !== "task") return { ok: false, output: "delegate_to_agent is for chats — agents use handoff_to_agent" };
        const agent = findAgentByName(await storage.getAgents(), String(args.agent ?? ""));
        const instruction = String(args.instruction ?? "").trim();
        if (!agent) return { ok: false, output: `no agent named "${args.agent}"` };
        if (!instruction) return { ok: false, output: "an instruction is required" };
        if (agent.status !== "active") return { ok: false, output: `${agent.name.trim()} is paused — ask the owner to resume them on the Team page` };
        await storage.createQueueItem(agent.id, `[Delegated by AURORA from the owner's chat]: ${instruction}`, { originTaskId: ctx.taskId });
        await storage.log(`delegated: ${agent.name.trim()}`, instruction.slice(0, 200));
        runAgentTick(agent.id).catch(() => {});
        return { ok: true, output: `${agent.name.trim()} has it and is starting now; their result will be posted in this chat when they're done.` };
      }
      case "create_pipeline": {
        const rawSteps = Array.isArray(args.steps) ? args.steps as { agent?: string; instruction?: string }[] : [];
        const saved = await upsertPipeline({
          name: String(args.name ?? ""),
          stages: rawSteps.map((s) => ({ agent: String(s?.agent ?? ""), instruction: String(s?.instruction ?? "") })),
          schedule: args.schedule ?? "none",
          originTaskId: ctx.type === "task" ? ctx.taskId : null,
        });
        if (!saved.ok) return { ok: false, output: saved.message };
        const summary = await summarizePipeline(saved.pipeline);
        if (args.run_now === false) return { ok: true, output: `saved pipeline ${summary}` };
        const started = await startPipelineRun(saved.pipeline.id, { originTaskId: ctx.type === "task" ? ctx.taskId : null });
        return { ok: started.ok, output: `saved pipeline ${summary}. ${started.message}` };
      }
      case "run_pipeline": {
        const name = String(args.name ?? "").trim().toLowerCase();
        const pipeline = (await storage.getPipelines()).find((p) => p.name.toLowerCase() === name);
        if (!pipeline) return { ok: false, output: `no pipeline named "${args.name}" — use list_pipelines` };
        const started = await startPipelineRun(pipeline.id, {
          input: args.input ? String(args.input) : undefined,
          originTaskId: ctx.type === "task" ? ctx.taskId : null,
        });
        return { ok: started.ok, output: started.message };
      }
      case "list_pipelines": {
        const all = await storage.getPipelines();
        if (all.length === 0) return { ok: true, output: "no pipelines yet" };
        const lines = await Promise.all(all.map(async (p) => {
          const [latest] = await storage.getPipelineRuns(p.id, 1);
          return `- ${await summarizePipeline(p)}${latest ? ` — last run ${latest.status}` : " — never run"}`;
        }));
        return { ok: true, output: lines.join("\n") };
      }
      case "handoff_to_agent":
      case "message_agent": {
        if (ctx.type !== "agent") return { ok: false, output: `${tool.name} is only available to persistent agents.` };

        // MAX_HANDOFF_DEPTH only bounds chain *length* (A -> B -> C -> ...).
        // Without also bounding *fan-out*, one turn could call either of
        // these tools several times to different targets, each hop then
        // doing the same — an exponential blow-up in unattended agent
        // activity from a single trigger, not just a linear ping-pong.
        // Capping it to one successful handoff-or-message per turn (shared
        // across both tools, so alternating between them can't dodge it)
        // keeps the whole tree a strict chain, which is what the depth cap
        // actually assumes it's bounding.
        if (transcript.some((t) => (t.name === "handoff_to_agent" || t.name === "message_agent") && t.status === "ok")) {
          return { ok: false, output: "already reached out to another agent once this turn — only one handoff or message per turn is allowed, to keep chains linear instead of branching out." };
        }

        const targetName = String(args.target ?? "").trim();
        const isMessage = tool.name === "message_agent";
        const body = String((isMessage ? args.message : args.note) ?? "").trim();
        if (!targetName || !body) return { ok: false, output: `both target and ${isMessage ? "message" : "note"} are required` };

        const [self, others] = await Promise.all([storage.getAgent(ctx.agentId), getOtherAgents(ctx.agentId)]);
        const target = others.find((a) => a.name.toLowerCase() === targetName.toLowerCase());
        if (!target) {
          const names = others.map((a) => a.name).join(", ") || "(no other agents exist)";
          return { ok: false, output: `no agent named "${targetName}" found. Other agents: ${names}` };
        }

        const nextDepth = ctx.handoffDepth + 1;
        if (nextDepth > MAX_HANDOFF_DEPTH) {
          return { ok: false, output: `conversation chain limit reached (max ${MAX_HANDOFF_DEPTH} hops) — refusing to go further so this can't turn into a runaway loop between agents.` };
        }

        const content = isMessage
          ? `[Message from ${self?.name ?? "another agent"}]: ${body}`
          : `[Handed off by ${self?.name ?? "another agent"}]: ${body}`;
        await storage.createQueueItem(target.id, content, { sourceAgentId: ctx.agentId, handoffDepth: nextDepth });
        await storage.log(`${isMessage ? "message" : "handoff"}: ${self?.name ?? "agent"} -> ${target.name}`, body.slice(0, 200));

        // Nudge the receiving agent to work its queue now instead of waiting
        // for its own schedule — fire-and-forget so this turn doesn't block
        // on theirs. runAgentTick's own in-flight guard means this is safe
        // even if the target is already ticking for an unrelated reason (its
        // own schedule, a manual "Run now", or a second concurrent handoff);
        // it just skips rather than racing. It works whatever's oldest in
        // their queue, same as any other tick — this one just doesn't wait.
        runAgentTick(target.id).catch((err) => {
          storage.log(`${isMessage ? "message" : "handoff"} nudge failed: ${target.name}`, err instanceof Error ? err.message : String(err), "error").catch(() => {});
        });

        // Social simulation: working together builds a relationship, and
        // being useful to a teammate is a small lift for the one reaching
        // out. Both directions move (the initiator more), so rapport
        // accumulates over repeated collaboration.
        await storage.bumpRelationship(ctx.agentId, target.id, 3, isMessage ? `messaged: ${body.slice(0, 60)}` : `handed off: ${body.slice(0, 60)}`);
        await storage.bumpRelationship(target.id, ctx.agentId, 2);
        await storage.adjustAgentVitals(ctx.agentId, 1, -1);

        return isMessage
          ? { ok: true, output: `Sent to "${target.name}" and nudged them to check their queue now. They may reply back to you on their own next turn.` }
          : { ok: true, output: `Handed off to "${target.name}" and nudged them to start now.` };
      }
      case "spawn_agent": {
        if (ctx.type !== "agent") return { ok: false, output: "spawn_agent is only available to agents." };
        const name = String(args.name ?? "").trim();
        const role = String(args.role ?? "").trim();
        const persona = String(args.persona ?? "").trim();
        const jobDescription = String(args.jobDescription ?? "").trim();
        if (!name || !role || !persona || !jobDescription) return { ok: false, output: "name, role, persona and jobDescription are all required." };

        const all = await storage.getAgents();
        // Guardrail: keep the roster bounded so a spawn loop can't flood the
        // team. The owner can always raise this by deleting agents.
        if (all.length >= MAX_AGENTS) return { ok: false, output: `the team is at its size limit (${MAX_AGENTS} agents). Retask or delegate to an existing agent instead of spawning a new one.` };
        if (all.some((a) => a.name.toLowerCase() === name.toLowerCase())) return { ok: false, output: `an agent named "${name}" already exists — pick a different name or hand work to them instead.` };

        const spawner = await storage.getAgent(ctx.agentId);
        const created = await storage.createAgent({ name, role, persona, jobDescription, scheduleMinutes: 60, spawnedByAgentId: ctx.agentId });
        // New teammate starts with a positive bond to whoever brought them on.
        await storage.bumpRelationship(created.id, ctx.agentId, 20, "brought me onto the team");
        await storage.bumpRelationship(ctx.agentId, created.id, 10, `spawned as ${role}`);
        await storage.log(`agent spawned: ${created.name} (${role}) by ${spawner?.name ?? "an agent"}`, jobDescription.slice(0, 200));
        return { ok: true, output: `Spawned "${created.name}" as ${role}. They're on the team now and will start working their queue on their own schedule. Hand them their first task with handoff_to_agent if you want them going immediately.` };
      }
      case "switch_model": {
        const model = String(args.model ?? "").trim();
        if (!model) return { ok: false, output: "model is required." };
        try {
          const installed = await listModels(config.ollamaHost);
          const match = installed.find((m) => m.name === model) ?? installed.find((m) => m.name.split(":")[0] === model.split(":")[0]);
          if (!match) return { ok: false, output: `"${model}" isn't installed. Installed models: ${installed.map((m) => m.name).join(", ") || "(none)"}` };
          await storage.updateConfig({ model: match.name });
          await storage.log(`switched active model -> ${match.name}`, "", "ok");
          return { ok: true, output: `Active model is now "${match.name}". Your next reasoning steps use it.` };
        } catch (err) {
          return { ok: false, output: `couldn't switch model: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "run_shell": {
        const control = getRunControl(ctx);
        const r = await executeCommand("shell", String(args.command ?? ""), (kill) => { control.killCurrent = kill; });
        control.killCurrent = null;
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case "run_node": {
        const control = getRunControl(ctx);
        const r = await executeCommand("node", String(args.code ?? ""), (kill) => { control.killCurrent = kill; });
        control.killCurrent = null;
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case "run_python": {
        const control = getRunControl(ctx);
        const r = await executeCommand("python", String(args.code ?? ""), (kill) => { control.killCurrent = kill; });
        control.killCurrent = null;
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case "read_file": {
        const filePath = String(args.path ?? "").trim();
        if (!filePath) return { ok: false, output: "path is required" };
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const lines = raw.split("\n");
          const offset = Math.max(1, Number(args.offset) || 1);
          const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
          return { ok: true, output: numbered || "(empty file)" };
        } catch (err) {
          return { ok: false, output: `couldn't read "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "write_file": {
        const filePath = String(args.path ?? "").trim();
        if (!filePath) return { ok: false, output: "path is required" };
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, String(args.content ?? ""));
          return { ok: true, output: `wrote ${filePath}` };
        } catch (err) {
          return { ok: false, output: `couldn't write "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "edit_file": {
        const filePath = String(args.path ?? "").trim();
        const oldText = String(args.old_text ?? "");
        const newText = String(args.new_text ?? "");
        if (!filePath || !oldText) return { ok: false, output: "path and old_text are required" };
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const occurrences = content.split(oldText).length - 1;
          if (occurrences === 0) return { ok: false, output: "old_text wasn't found in the file — read the file again and match the exact text, including whitespace" };
          if (occurrences > 1) return { ok: false, output: `old_text appears ${occurrences} times — include more surrounding context so it matches exactly once` };
          fs.writeFileSync(filePath, content.replace(oldText, newText));
          return { ok: true, output: `edited ${filePath}` };
        } catch (err) {
          return { ok: false, output: `couldn't edit "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      default:
        return { ok: false, output: `unknown tool "${tool.name}"` };
    }
  } catch (err) {
    return { ok: false, output: `tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * `speaker`, when given, is for a Task with multiple agents assigned (a
 * shared group thread) — it tells this agent which of the stored assistant
 * messages are genuinely its own (kept as role:"assistant", so it correctly
 * recalls its own past reasoning) versus another agent's (relabeled as a
 * role:"user" message prefixed with that agent's name, the same way a human
 * participant's message would appear to it — otherwise the model has no way
 * to tell someone else's words from its own).
 */
// How many recent messages the model sees verbatim each turn. Anything
// older gets folded into a rolling summary (below) instead of being
// silently forgotten — before compaction existed, a conversation's own
// beginning just vanished from the model's view past this window.
const HISTORY_WINDOW = 40;
// Don't bother re-summarizing until this many un-summarized messages have
// aged out of the window — each compaction costs one Ollama call, so tiny
// increments aren't worth it.
const COMPACT_MIN_BACKLOG = 10;
const compactionsInFlight = new Set<string>();

const SUMMARIZE_SYSTEM =
  "You maintain a running summary of a long conversation. Given the existing summary (possibly empty) and a batch " +
  "of older messages, produce ONE updated summary that merges both. Keep every durable fact: goals, decisions, " +
  "preferences the owner expressed, names, what was tried and whether it worked, and anything either party " +
  "promised to do. Drop pleasantries and dead ends. Write plain, dense prose — no headers, no bullet-point " +
  "padding. Stay under about 400 words. Respond with the summary text and nothing else.";

/**
 * Fire-and-forget rolling compaction — the same context-management idea
 * long-running coding assistants use: history that ages out of the verbatim
 * window gets summarized and carried forward, so the model never wholly
 * forgets the start of a long task/agent run. Runs in the background AFTER
 * the turn's own messages were built (never delays a reply), at most one at
 * a time per context. Any failure just means the summary lags a turn or two
 * behind — never user-visible breakage.
 */
function maybeCompactHistory(ctx: RunContext, oldestRecentId: number): void {
  const key = ctxKey(ctx);
  if (compactionsInFlight.has(key)) return;
  compactionsInFlight.add(key);
  (async () => {
    const storage = getStorage();
    const config = await storage.getConfig();
    if (!config.model) return;

    let prevSummary: string | null;
    let backlog: { id: number; role: string; content: string }[];
    if (ctx.type === "task") {
      const task = await storage.getTask(ctx.taskId);
      if (!task) return;
      prevSummary = task.contextSummary;
      backlog = await storage.getChatMessagesBetween(ctx.taskId, task.summarizedThroughId ?? 0, oldestRecentId);
    } else {
      const agent = await storage.getAgent(ctx.agentId);
      if (!agent) return;
      prevSummary = agent.contextSummary;
      backlog = await storage.getAgentLogBetween(ctx.agentId, agent.summarizedThroughId ?? 0, oldestRecentId);
    }
    if (backlog.length < COMPACT_MIN_BACKLOG) return;

    const transcriptText = backlog
      .filter((m) => m.content)
      .map((m) => `${m.role}: ${m.content.slice(0, 1500)}`)
      .join("\n");
    const body = (prevSummary ? `Existing summary:\n${prevSummary}\n\nOlder messages to fold in:\n` : "Older messages to fold in:\n") + transcriptText;
    const result = await chat(config.ollamaHost, config.model, [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: body.slice(0, 60_000) },
    ], [], config.numCtx);
    const summary = result.message?.content?.trim();
    if (!summary) return;

    const throughId = backlog[backlog.length - 1].id;
    if (ctx.type === "task") await storage.setTaskContextSummary(ctx.taskId, summary.slice(0, 8000), throughId);
    else await storage.setAgentContextSummary(ctx.agentId, summary.slice(0, 8000), throughId);
  })()
    .catch(() => { /* summary just lags a turn — harmless */ })
    .finally(() => compactionsInFlight.delete(key));
}

async function buildBaseMessages(
  ctx: RunContext,
  systemPrompt: string,
  speaker?: { agentId: number | null; nameById: Map<number, string> },
): Promise<OllamaMessage[]> {
  const storage = getStorage();
  const messages: OllamaMessage[] = [{ role: "system", content: systemPrompt }];

  if (ctx.type === "task") {
    const [task, recent] = await Promise.all([storage.getTask(ctx.taskId), storage.getChatMessages(ctx.taskId, HISTORY_WINDOW)]);
    if (task?.contextSummary) {
      messages.push({ role: "user", content: `[Recap of the earlier part of this conversation — background context, not a new message:]\n${task.contextSummary}` });
    }
    for (const m of recent) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (!speaker || m.agentId === speaker.agentId) {
          messages.push({ role: "assistant", content: m.content });
        } else if (m.content || m.toolCalls) {
          const name = m.agentId != null ? speaker.nameById.get(m.agentId) ?? "another agent" : "AURORA";
          messages.push({ role: "user", content: `[${name}]: ${m.content}` });
        }
      }
    }
    if (recent.length >= HISTORY_WINDOW) maybeCompactHistory(ctx, recent[0].id);
  } else {
    const [agent, recent] = await Promise.all([storage.getAgent(ctx.agentId), storage.getAgentLog(ctx.agentId, HISTORY_WINDOW)]);
    if (agent?.contextSummary) {
      messages.push({ role: "user", content: `[Recap of your earlier activity — background context, not a new instruction:]\n${agent.contextSummary}` });
    }
    for (const m of recent) {
      if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: m.content });
    }
    if (recent.length >= HISTORY_WINDOW) maybeCompactHistory(ctx, recent[0].id);
  }

  return messages;
}

async function runLoop(ctx: RunContext, messages: OllamaMessage[], config: AgentConfig, transcript: ToolCallRecord[], depth: number, messageId: number, thinkingSoFar = ""): Promise<TurnResult> {
  const storage = getStorage();

  if (stopWasRequested(ctx)) {
    const reply = "Stopped.";
    await updateMessage(ctx, messageId, reply, transcript.length ? JSON.stringify(transcript) : null);
    clearRunControl(ctx);
    return { status: "final", reply };
  }

  if (depth >= MAX_STEPS) {
    // Out of tool budget: don't throw away everything gathered so far (a
    // researcher's 60 searches ended as "I hit my step limit") — make one
    // last tool-free call to write the answer from what's already in hand.
    let reply = "";
    try {
      const wrap = await chat(config.ollamaHost, config.model, [
        ...messages,
        { role: "user", content: "You've used your tool budget for this turn. Using everything you've gathered above, write your final answer or report now — clearly and completely. No more tool calls." },
      ], [], config.numCtx, { think: false });
      reply = stripStrayToolJson(wrap.message.content ?? "");
    } catch { /* fall through to the plain notice */ }
    if (!reply) reply = "I ran out of steps for this turn before finishing — " + (summarizeTranscript(transcript) || "try breaking the request into smaller steps.");
    await updateMessage(ctx, messageId, reply, transcript.length ? JSON.stringify(transcript) : null);
    return { status: "final", reply, usedTools: transcript.length > 0, planOpen: planStateOf(transcript) };
  }

  const tools = await allTools(ctx, config.advancedToolsEnabled);
  let response;
  try {
    response = await chat(config.ollamaHost, config.model, messages, toOllamaTools(toolsForTurn(tools, messages, transcript)), config.numCtx);
  } catch (err) {
    const reply = `Couldn't reach Ollama at ${config.ollamaHost}: ${err instanceof Error ? err.message : String(err)}. Is "ollama serve" running?`;
    await updateMessage(ctx, messageId, reply, transcript.length ? JSON.stringify(transcript) : null);
    await storage.log("ollama chat failed", config.model, "error");
    return { status: "error", reply };
  }

  const assistantMsg = response.message;
  if (!assistantMsg) {
    const reply = `Ollama at ${config.ollamaHost} returned an unexpected response (no message). Try again, or check the Ollama server logs.`;
    await updateMessage(ctx, messageId, reply, transcript.length ? JSON.stringify(transcript) : null);
    await storage.log("ollama chat returned no message", config.model, "error");
    return { status: "error", reply };
  }
  // Accumulated across every step of this turn (a multi-tool-call turn calls
  // the model more than once) so the "Thinking" view shows the model's
  // reasoning for the whole turn, not just its last step.
  const thinking = assistantMsg.thinking
    ? thinkingSoFar
      ? `${thinkingSoFar}\n\n---\n\n${assistantMsg.thinking}`
      : assistantMsg.thinking
    : thinkingSoFar;
  const calls = assistantMsg.tool_calls ?? [];

  if (calls.length === 0) {
    let raw = assistantMsg.content ?? "";
    // Thinking models sometimes put the whole answer in their reasoning and
    // leave content empty after a tool call — the owner then saw "Done —
    // recall." instead of "your favorite drink is horchata". Ask once more
    // for a direct reply with thinking off; failing that, use the step's own
    // reasoning, which in that case IS the answer.
    if (!stripStrayToolJson(raw.replace(/\[DONE\]/gi, "")).trim() && transcript.length > 0) {
      try {
        const retry = await chat(config.ollamaHost, config.model, messages, [], config.numCtx, { think: false });
        raw = retry.message.content ?? "";
      } catch { /* fall through to the reasoning text */ }
      if (!raw.trim() && assistantMsg.thinking?.trim()) raw = assistantMsg.thinking.trim();
    }
    const doneSignal = /\[DONE\]/i.test(raw);
    const reply = stripStrayToolJson(raw.replace(/\s*\[DONE\]\s*/gi, " ").trim()) || summarizeTranscript(transcript) || "(no response)";
    await updateMessage(ctx, messageId, reply, transcript.length ? JSON.stringify(transcript) : null, thinking);
    return { status: "final", reply, usedTools: transcript.length > 0, planOpen: planStateOf(transcript), doneSignal };
  }

  messages.push({ role: "assistant", content: assistantMsg.content ?? "", tool_calls: calls });

  for (const call of calls) {
    const name = call.function.name;
    const args = (call.function.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      messages.push({ role: "tool", content: `error: unknown tool "${name}"` });
      transcript.push({ name, args, risk: "high", status: "error", result: "unknown tool" });
      await updateMessage(ctx, messageId, "", JSON.stringify(transcript), thinking);
      continue;
    }

    // Loop breaker: the exact same call again in one turn (measured: a
    // researcher re-ran near-identical searches ~60 times) — answer from the
    // earlier result instead of spending another step on it.
    const sig = JSON.stringify(args);
    if (name !== "set_plan" && transcript.some((t) => t.name === name && JSON.stringify(t.args) === sig)) {
      messages.push({ role: "tool", content: `You already ran ${name} with these exact arguments this turn — its result is above. Use it, try something genuinely different, or write your answer.` });
      continue;
    }

    const autoRun = !needsApproval(tool, args, config);
    if (!autoRun) {
      const pendingTranscript = [...transcript, { name, args, risk: tool.risk, status: "pending" as const, result: "awaiting owner approval" }];
      await updateMessage(ctx, messageId, "", JSON.stringify(pendingTranscript), thinking);
      const approval = await storage.createApproval({
        taskId: ctx.type === "task" ? ctx.taskId : undefined,
        action: `${name}(${summarizeArgs(args)})`,
        risk: tool.risk,
        targetType: "tool_call",
        detail: JSON.stringify({ call: { name, args }, messages, transcript, context: ctx, messageId }),
      });
      await storage.log(`awaiting approval: ${name}`, summarizeArgs(args), "pending");
      const reply = `I need your approval before I can run "${name}". Check the Approvals page to let me continue.`;
      await updateMessage(ctx, messageId, reply, JSON.stringify(pendingTranscript), thinking);
      return { status: "awaiting_approval", reply, approvalId: approval.id };
    }

    // Show the call as "in flight" the moment it starts, not only once it
    // resolves — a slow tool (web fetch, image gen, shell) would otherwise
    // leave the feed looking stalled for the whole time it's running.
    const inFlightTranscript = [...transcript, { name, args, risk: tool.risk, status: "pending" as const, result: "running…" }];
    await updateMessage(ctx, messageId, "", JSON.stringify(inFlightTranscript), thinking);

    const { ok, output } = await executeTool(tool, args, ctx, config, transcript, messageId);
    messages.push({ role: "tool", content: output });
    // A plan update replaces the previous plan in the transcript instead of
    // stacking — the client renders set_plan as a live checklist, and showing
    // every historical revision of the same checklist would bury the feed.
    if (name === "set_plan") {
      const prior = transcript.findIndex((t) => t.name === "set_plan");
      if (prior !== -1) transcript.splice(prior, 1);
    }
    transcript.push({ name, args, risk: tool.risk, status: ok ? "ok" : "error", result: output });
    await storage.log(`ran tool: ${name}`, summarizeArgs(args), ok ? "ok" : "error");
    await updateMessage(ctx, messageId, "", JSON.stringify(transcript), thinking);
  }

  return runLoop(ctx, messages, config, transcript, depth + 1, messageId, thinking);
}

/**
 * Persists the user's message and, if a model is configured, kicks off the
 * turn WITHOUT waiting for it to finish — a turn that calls something like
 * generate_video can run for the better part of an hour, and blocking the
 * HTTP response on that would leave the composer looking frozen the whole
 * time. The client already polls /messages and already renders an empty
 * placeholder assistant message as a "thinking" indicator, so there's
 * nothing more the caller needs from this beyond knowing it started.
 */
export async function runAgentTurn(taskId: number, userMessage: string, imageCreationId?: number): Promise<{ started: true } | TurnResult> {
  const storage = getStorage();
  const task = await storage.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Images are attached via the Library (see /api/creations/upload), not
  // embedded as raw bytes in the conversation — this plain-text hint is what
  // lets a tool-calling text model know an image exists and where, so it can
  // decide to call see_image on it rather than needing native multimodal input itself.
  let fullMessage = userMessage;
  if (imageCreationId) {
    const creation = await storage.getCreation(imageCreationId);
    if (creation) fullMessage += `\n\n[Attached image: "${creation.filePath}" — use your see_image tool with this exact filename if you want to look at it.]`;
  }

  await storage.createChatMessage(taskId, "user", fullMessage);
  await storage.log("user message", fullMessage.slice(0, 200));

  const config = await storage.getConfig();
  if (!config.model) {
    const reply = "No Ollama model is configured yet — open Settings, pick a pulled model (or pull one), then try again.";
    await storage.createChatMessage(taskId, "assistant", reply);
    return { status: "final", reply };
  }

  // A Task with agents assigned (see task_agents) is a shared group thread —
  // every assigned agent gets a turn off the same user message, each seeing
  // the others' replies, instead of the ordinary single-assistant path below.
  const groupAgents = await storage.getTaskAgents(taskId);
  if (groupAgents.length > 0) {
    const ctx: RunContext = { type: "task", taskId };
    getRunControl(ctx); // ensure a Stop click has something to find even before the first agent's turn
    runGroupRound(taskId, groupAgents, config, fullMessage)
      .catch((err) => storage.log("group round failed", err instanceof Error ? err.message : String(err), "error").catch(() => {}));
    return { started: true };
  }

  const ctx: RunContext = { type: "task", taskId };
  const systemPrompt = config.systemPrompt + await describeTeamForLead() + TOOL_USE_REMINDER + await knowledgeInstructions();
  getRunControl(ctx); // ensure a Stop click has something to find even before the first tool call
  runTaskTurnLoop(ctx, taskId, config, systemPrompt)
    .catch((err) => storage.log("task turn failed", err instanceof Error ? err.message : String(err), "error").catch(() => {}));
  return { started: true };
}

// How many times AURORA may re-prompt herself to keep working a task after a
// reply, when auto-continue is on. Raised from 6 for Polar-style long-running
// work (multi-site research, form runs) — 30 rounds × MAX_STEPS tool calls is
// hours of work on a 12GB GPU. Still bounded so a stuck loop ends on its own;
// Stop and the approval gates remain the real circuit breakers.
const AUTO_CONTINUE_MAX = 30;
const AUTO_CONTINUE_NUDGE =
  "Keep going on your plan without waiting for me: do the next unfinished step now, then update the plan with set_plan. " +
  "Don't repeat steps you've already done or re-check things for no reason. When every step is done, give me your final answer " +
  "and end it with the exact token [DONE]. If you truly need my input, ask and end with [DONE].";

/**
 * Runs one task turn, then — if the owner has auto-continue on — keeps
 * re-prompting AURORA to carry the work forward without further input, until
 * she signals completion with [DONE], a Stop is requested, a high-risk tool
 * needs approval (status != "final"), or the cap is hit. A best-effort
 * autonomy layer: the model decides when it's done; this just removes the
 * "type 'continue' every time" friction.
 */
async function runTaskTurnLoop(ctx: RunContext, taskId: number, config: AgentConfig, systemPrompt: string): Promise<void> {
  void taskId;
  let messages = await buildBaseMessages(ctx, systemPrompt);
  let messageId = await createPlaceholderMessage(ctx);
  let result = await runLoop(ctx, messages, config, [], 0, messageId);
  await finalizeContext(ctx, result.status);

  let n = 0;
  // Only keep going while there's an unfinished plan. Nudging anything else —
  // small talk, or a one-shot action like "remember X" — just makes a small
  // local model invent busywork (measured: five rounds of check_audit_log and
  // recall("plan") after a single remember). Plan state carries across rounds
  // since each continuation starts a fresh transcript.
  let planOpen = result.planOpen ?? false;
  while (
    config.autoContinue &&
    result.status === "final" &&
    result.usedTools &&
    planOpen &&
    !result.doneSignal &&
    n < AUTO_CONTINUE_MAX &&
    !stopWasRequested(ctx)
  ) {
    n++;
    // The nudge steers this one continuation but is NOT persisted, so the chat
    // doesn't fill up with fake "continue" messages the owner never sent.
    messages = await buildBaseMessages(ctx, systemPrompt);
    messages.push({ role: "user", content: AUTO_CONTINUE_NUDGE });
    messageId = await createPlaceholderMessage(ctx);
    result = await runLoop(ctx, messages, config, [], 0, messageId);
    await finalizeContext(ctx, result.status);
    if (result.planOpen !== undefined) planOpen = result.planOpen;
  }
}

/**
 * Whole-word, case-insensitive match of each agent's name (and, for a
 * multi-word name like "Nat the content creator", just its first word too —
 * that's how an owner actually addresses someone) against the owner's
 * message. Lets "Nat, can you..." single Nat out instead of every assigned
 * agent weighing in on a message clearly meant for one of them.
 */
function findAddressedAgents(
  message: string,
  agents: (TaskAgent & { agentName: string })[],
): (TaskAgent & { agentName: string })[] {
  return agents.filter((a) => {
    const name = a.agentName.trim();
    if (!name) return false;
    const candidates = new Set([name, name.split(/\s+/)[0]]);
    for (const candidate of candidates) {
      if (candidate.length < 2) continue;
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(message)) return true;
    }
    return false;
  });
}

/**
 * Runs one round of a shared task thread: each assigned agent takes a turn
 * in assignment order, off the same growing conversation, so agent #2 sees
 * agent #1's reply from this same round (relabeled via buildBaseMessages'
 * `speaker` param) before responding. A single shared RunControl (keyed by
 * the task, same as the single-assistant path) covers the whole round, so
 * Stop halts it between agents or kills whatever the current agent is
 * running — finalizeContext/clearRunControl only run once, at the end of the
 * round, not per-agent.
 *
 * If the owner's message names one or more assigned agents directly (e.g.
 * "Nat, can you..."), only those agents get a turn this round — otherwise
 * every assigned agent does, as before.
 */
async function runGroupRound(
  taskId: number,
  agents: (TaskAgent & { agentName: string })[],
  config: AgentConfig,
  userMessage: string,
): Promise<void> {
  const storage = getStorage();
  const ctx: RunContext = { type: "task", taskId };
  const nameById = new Map(agents.map((a) => [a.agentId, a.agentName] as const));

  const addressed = findAddressedAgents(userMessage, agents);
  const responders = addressed.length > 0 ? addressed : agents;

  let finalStatus: TurnResult["status"] = "final";
  for (const ta of responders) {
    if (stopWasRequested(ctx)) break;
    const agent = await storage.getAgent(ta.agentId);
    if (!agent || agent.status !== "active") continue;

    const others = agents.filter((a) => a.agentId !== ta.agentId).map((a) => a.agentName);
    let teamNote: string;
    if (addressed.length > 0) {
      teamNote = `\n\nThe owner just called on you by name in this shared task thread — this message is meant for you specifically. Respond directly and actually do what they're asking (call the right tool if one applies) — don't defer to someone else unless the ask genuinely isn't your job, and don't just acknowledge being called without following through.`;
    } else {
      teamNote = others.length
        ? `\n\nYou're one of several agents (${others.join(", ")}) collaborating with the owner in this shared task thread — everyone sees the same conversation. Only reply with something genuinely useful to add; a brief "nothing to add" is fine if another agent already covered it or it's outside your job.`
        : "";
    }
    const systemPrompt = `${agent.persona}\n\nYour job: ${agent.jobDescription}${teamNote}${await describeSocialState(agent.id)}${TOOL_USE_REMINDER}${await knowledgeInstructions()}`;

    const messages = await buildBaseMessages(ctx, systemPrompt, { agentId: agent.id, nameById });
    const messageId = await createPlaceholderMessage(ctx, agent.id);
    const result = await runLoop(ctx, messages, config, [], 0, messageId);
    finalStatus = result.status;
    if (result.status === "awaiting_approval" || result.status === "error") break;
  }
  await finalizeContext(ctx, finalStatus);
}

/** One tick of a persistent agent: pulls its next pending queue item (if any) and works it through the same loop a task uses. */
export async function runAgentTick(agentId: number): Promise<TurnResult | { skipped: string }> {
  if (agentTicksInFlight.has(agentId)) return { skipped: "agent is already mid-tick" };
  agentTicksInFlight.add(agentId);
  try {
    const storage = getStorage();
    const agent = await storage.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.status !== "active") return { skipped: "agent is paused" };

    const config = await storage.getConfig();
    if (!config.model) return { skipped: "no Ollama model configured" };

    const item = await storage.claimNextPendingQueueItem(agentId);
    if (!item) return { skipped: "queue is empty" };

    await storage.updateAgent(agentId, { lastRunAt: Date.now() });
    await storage.createAgentLogEntry(agentId, "user", item.content);
    await storage.log(`agent tick: ${agent.name}`, item.content.slice(0, 200));

    const ctx: RunContext = { type: "agent", agentId, queueItemId: item.id, handoffDepth: item.handoffDepth };
    const systemPrompt = `${agent.persona}\n\nYour job: ${agent.jobDescription}${await describeOtherAgents(agentId)}${await describeSocialState(agentId)}${TOOL_USE_REMINDER}${await knowledgeInstructions()}`;
    const messages = await buildBaseMessages(ctx, systemPrompt);
    const messageId = await createPlaceholderMessage(ctx);
    getRunControl(ctx); // ensure a Stop click has something to find even before the first tool call
    const result = await runLoop(ctx, messages, config, [], 0, messageId);
    await finalizeContext(ctx, result.status, result.reply);
    // Auto work log: every finished queue item leaves a one-note trail of
    // what was asked and what came of it, recallable later — Memory as a
    // history of everything the agent has actually done, not only what it
    // explicitly chose to remember. Best-effort; never blocks the tick.
    if (result.status === "final" && result.reply) {
      storage.createNote(
        `worklog: ${item.content.slice(0, 120).replace(/\s+/g, " ")}`,
        result.reply.slice(0, 800),
        agentId,
      ).catch(() => {});
    }
    // Vitals drift from doing the work: a completed piece of work is a small
    // morale lift; every tick costs a little energy; an error stings. mood is
    // a short word derived from where morale lands, so the UI/self-prompt
    // always have a human-readable label. Best-effort — never fails a tick.
    const moraleDelta = result.status === "error" ? -6 : 3;
    storage.adjustAgentVitals(agentId, moraleDelta, -4, moodFor((agent.morale ?? 70) + moraleDelta)).catch(() => {});
    return result;
  } finally {
    agentTicksInFlight.delete(agentId);
  }
}

interface PreparedResume {
  approval: Approval;
  detail: { call: { name: string; args: Record<string, unknown> }; messages: OllamaMessage[]; transcript: ToolCallRecord[]; context: RunContext; messageId: number };
}

/**
 * Fast half of resuming a tool_call approval: validates the approval and
 * flips its status. Callers should await this and respond to the HTTP
 * request immediately after — the slow half (actually running the tool,
 * which can take anywhere from milliseconds to ~20 minutes for something
 * like generate_video) happens separately via finishResumeAfterApproval, so
 * a long-running tool doesn't leave the Approve button hanging.
 */
export async function beginResumeAfterApproval(approvalId: number, decision: "approved" | "denied"): Promise<PreparedResume> {
  const storage = getStorage();
  const approval = await storage.getApproval(approvalId);
  if (!approval) throw new Error(`Approval ${approvalId} not found`);
  if (approval.targetType !== "tool_call") throw new Error(`Approval ${approvalId} is not a resumable tool call`);
  if (approval.status !== "pending") throw new Error(`Approval ${approvalId} was already decided`);

  const detail = JSON.parse(approval.detail) as PreparedResume["detail"];
  // The write below is the real guard against a double-decide race (it only
  // succeeds if the row was still "pending" at write time) — the read above
  // is just a fast, friendly error for the common case.
  const decided = await storage.decideApproval(approvalId, decision);
  if (!decided) throw new Error(`Approval ${approvalId} was already decided`);

  if (decision === "approved") {
    getRunControl(detail.context); // ensure a Stop click has something to find once execution starts
    // Flip the awaiting-approval transcript entry to "running…" right away,
    // so the task/agent's own feed shows something changed the instant you
    // click Approve, instead of looking frozen until a slow tool finishes.
    const runningTranscript = detail.transcript.map((t) =>
      t.name === detail.call.name && t.status === "pending" ? { ...t, result: "running…" } : t,
    );
    await updateMessage(detail.context, detail.messageId, "", JSON.stringify(runningTranscript));
  }

  return { approval: decided, detail };
}

/** Slow half — actually runs (or records the denial of) the approved tool call, then re-enters the loop so the model can react to the result. Call this without awaiting it from a route handler; await beginResumeAfterApproval first. */
export async function finishResumeAfterApproval(prepared: PreparedResume, decision: "approved" | "denied"): Promise<TurnResult> {
  const storage = getStorage();
  const { approval, detail } = prepared;
  const ctx = detail.context;
  const messageId = detail.messageId;

  const config = await storage.getConfig();
  const tools = await allTools(ctx, config.advancedToolsEnabled);
  const tool = tools.find((t) => t.name === detail.call.name);
  const { messages } = detail;
  // Drop the "awaiting owner approval" placeholder for this call rather than
  // leaving it in place — otherwise the final transcript ends up with two
  // cards for the same tool call (the stale pending one plus the real
  // result) instead of one that cleanly transitions pending -> done.
  let transcript = detail.transcript.filter((t) => !(t.name === detail.call.name && t.status === "pending"));

  if (decision === "denied") {
    const output = "denied by owner";
    messages.push({ role: "tool", content: output });
    transcript = [...transcript, { name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: "denied", result: output }];
    await storage.log(`approval denied: ${detail.call.name}`, summarizeArgs(detail.call.args), "denied", "owner");
  } else if (!tool) {
    const output = `unknown tool "${detail.call.name}" (it may have been disabled since this request)`;
    messages.push({ role: "tool", content: output });
    transcript = [...transcript, { name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: "error", result: output }];
  } else {
    const { ok, output } = await executeTool(tool, detail.call.args, ctx, config, transcript, messageId);
    messages.push({ role: "tool", content: output });
    transcript = [...transcript, { name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: ok ? "ok" : "error", result: output }];
    await storage.log(`approved + ran tool: ${detail.call.name}`, summarizeArgs(detail.call.args), ok ? "ok" : "error", "owner");
  }

  await updateMessage(ctx, messageId, "", JSON.stringify(transcript));
  const result = await runLoop(ctx, messages, config, transcript, 0, messageId);
  await finalizeContext(ctx, result.status, result.reply);
  return result;
}
