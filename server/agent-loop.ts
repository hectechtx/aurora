// The vessel engine: perceive (history) -> prompt Ollama -> parse tool calls
// -> execute or wait for approval -> feed results back -> repeat. Shared by
// two kinds of callers: a Task (a conversation thread you drive turn by
// turn) and a persistent Agent (a named worker that ticks through its own
// queue on a schedule, with its own perpetual memory). Everything about the
// loop itself is identical — only where history/results get persisted
// differs, which is what RunContext captures.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStorage } from "./storage";
import { chat, type OllamaMessage, type OllamaToolDef } from "./ollama";
import { executeCommand, type ExecResult } from "./shell-exec";
import { runSkillTool } from "./skills/runner";
import { generateImage } from "./imagegen";
import { webSearch, webFetch } from "./web-tools";
import type { AgentConfig, SkillTool } from "@shared/schema";
import { CREATIONS_DIR } from "./paths";

const MAX_STEPS = 6;
fs.mkdirSync(CREATIONS_DIR, { recursive: true });

export type RunContext =
  | { type: "task"; taskId: number }
  | { type: "agent"; agentId: number; queueItemId: number };

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
      name: "recall", kind: "builtin", risk: "low",
      description: "Search previously saved notes by a label/value substring. Omit query to list the most recent notes.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "list_skills", kind: "builtin", risk: "low",
      description: "List currently enabled skills and what they do.",
      parameters: { type: "object", properties: {} },
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
      name: "generate_image", kind: "builtin", risk: "medium",
      description: "Generate an image from a text prompt using a local Stable Diffusion server, if one is configured in Settings. Saves the result to the Library.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
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
  ];
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

// When advancedToolsEnabled is off, no risk:"high" tool is even offered to
// the model — not just gated behind approval. That covers the built-in
// run_shell/run_node/run_python trio and any skill tool a skill author
// marked high-risk. Everything else (remember/recall/list_skills/
// generate_image/save_deliverable, low/medium-risk skill tools) still works.
async function allTools(ctx: RunContext, advancedToolsEnabled: boolean): Promise<ToolDef[]> {
  const builtins = builtinTools().filter((t) => !t.contexts || t.contexts.includes(ctx.type));
  const all = [...builtins, ...(await skillTools())];
  return advancedToolsEnabled ? all : all.filter((t) => t.risk !== "high");
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

async function persistMessage(ctx: RunContext, role: string, content: string, toolCalls: string | null): Promise<void> {
  const storage = getStorage();
  if (ctx.type === "task") await storage.createChatMessage(ctx.taskId, role, content, toolCalls);
  else await storage.createAgentLogEntry(ctx.agentId, role, content, toolCalls);
}

/** Called once, after runLoop resolves, by every entrypoint (fresh turn or resumed approval) — the single place task/queue-item status gets updated. */
async function finalizeContext(ctx: RunContext, status: TurnResult["status"]): Promise<void> {
  const storage = getStorage();
  if (ctx.type === "task") {
    await storage.updateTask(ctx.taskId, { status: status === "awaiting_approval" ? "awaiting_approval" : "active" });
  } else if (status === "awaiting_approval") {
    await storage.updateQueueItem(ctx.queueItemId, { status: "awaiting_approval" });
  } else {
    await storage.updateQueueItem(ctx.queueItemId, { status: status === "error" ? "error" : "done", doneAt: Date.now() });
  }
}

async function executeTool(tool: ToolDef, args: Record<string, unknown>, ctx: RunContext, config: AgentConfig): Promise<{ ok: boolean; output: string }> {
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
      case "recall": {
        const query = args.query ? String(args.query) : undefined;
        const found = await storage.getNotes(query, 20, memoryAgentId);
        return { ok: true, output: found.length ? found.map((n) => `${n.label}: ${n.value}`).join("\n") : "no matching notes" };
      }
      case "list_skills": {
        const enabled = (await storage.getSkills()).filter((s) => s.status === "enabled");
        return { ok: true, output: enabled.length ? enabled.map((s) => `${s.name} — ${s.description}`).join("\n") : "no skills enabled" };
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
      case "generate_image": {
        const prompt = String(args.prompt ?? "");
        if (!config.imageGenHost) {
          return { ok: false, output: "Image generation isn't set up — add a local Stable Diffusion (Automatic1111/ComfyUI) host URL in Settings first." };
        }
        try {
          const { pngBuffer } = await generateImage(config.imageGenHost, prompt);
          const filename = `${randomUUID()}.png`;
          fs.writeFileSync(path.join(CREATIONS_DIR, filename), pngBuffer);
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
            const { pngBuffer } = await generateImage(config.imageGenHost, thumbnailPrompt);
            const filename = `${randomUUID()}.png`;
            fs.writeFileSync(path.join(CREATIONS_DIR, filename), pngBuffer);
            const creation = await storage.createCreation({ agentId: ctx.agentId, kind: "image", prompt: thumbnailPrompt, filePath: filename });
            creationId = creation.id;
          } catch {
            // Thumbnail is a nice-to-have — save the deliverable without one rather than failing the whole thing.
          }
        }

        const deliverable = await storage.createDeliverable({ agentId: ctx.agentId, title, description, tags: JSON.stringify(tags), body, creationId });
        return { ok: true, output: `Saved deliverable #${deliverable.id} ("${title}") to the Outbox for your review.` };
      }
      case "run_shell": {
        const r = await executeCommand("shell", String(args.command ?? ""));
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case "run_node": {
        const r = await executeCommand("node", String(args.code ?? ""));
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      case "run_python": {
        const r = await executeCommand("python", String(args.code ?? ""));
        return { ok: r.exitCode === 0, output: formatExecResult(r) };
      }
      default:
        return { ok: false, output: `unknown tool "${tool.name}"` };
    }
  } catch (err) {
    return { ok: false, output: `tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function buildBaseMessages(ctx: RunContext, systemPrompt: string): Promise<OllamaMessage[]> {
  const storage = getStorage();
  const recent = ctx.type === "task" ? await storage.getChatMessages(ctx.taskId, 40) : await storage.getAgentLog(ctx.agentId, 40);
  const messages: OllamaMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: m.content });
  }
  return messages;
}

async function runLoop(ctx: RunContext, messages: OllamaMessage[], config: AgentConfig, transcript: ToolCallRecord[], depth: number): Promise<TurnResult> {
  const storage = getStorage();

  if (depth >= MAX_STEPS) {
    const reply = "I hit my step limit for this turn without finishing — try breaking the request into smaller steps.";
    await persistMessage(ctx, "assistant", reply, transcript.length ? JSON.stringify(transcript) : null);
    return { status: "final", reply };
  }

  const tools = await allTools(ctx, config.advancedToolsEnabled);
  let response;
  try {
    response = await chat(config.ollamaHost, config.model, messages, toOllamaTools(tools));
  } catch (err) {
    const reply = `Couldn't reach Ollama at ${config.ollamaHost}: ${err instanceof Error ? err.message : String(err)}. Is "ollama serve" running?`;
    await persistMessage(ctx, "assistant", reply, transcript.length ? JSON.stringify(transcript) : null);
    await storage.log("ollama chat failed", config.model, "error");
    return { status: "error", reply };
  }

  const assistantMsg = response.message;
  if (!assistantMsg) {
    const reply = `Ollama at ${config.ollamaHost} returned an unexpected response (no message). Try again, or check the Ollama server logs.`;
    await persistMessage(ctx, "assistant", reply, transcript.length ? JSON.stringify(transcript) : null);
    await storage.log("ollama chat returned no message", config.model, "error");
    return { status: "error", reply };
  }
  const calls = assistantMsg.tool_calls ?? [];

  if (calls.length === 0) {
    const reply = assistantMsg.content || summarizeTranscript(transcript) || "(no response)";
    await persistMessage(ctx, "assistant", reply, transcript.length ? JSON.stringify(transcript) : null);
    return { status: "final", reply };
  }

  messages.push({ role: "assistant", content: assistantMsg.content ?? "", tool_calls: calls });

  for (const call of calls) {
    const name = call.function.name;
    const args = (call.function.arguments ?? {}) as Record<string, unknown>;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      messages.push({ role: "tool", content: `error: unknown tool "${name}"` });
      transcript.push({ name, args, risk: "high", status: "error", result: "unknown tool" });
      continue;
    }

    const autoRun = tool.risk === "low" && config.autonomy === "supervised";
    if (!autoRun) {
      const pendingTranscript = [...transcript, { name, args, risk: tool.risk, status: "pending" as const, result: "awaiting owner approval" }];
      const approval = await storage.createApproval({
        taskId: ctx.type === "task" ? ctx.taskId : undefined,
        action: `${name}(${summarizeArgs(args)})`,
        risk: tool.risk,
        targetType: "tool_call",
        detail: JSON.stringify({ call: { name, args }, messages, transcript, context: ctx }),
      });
      await storage.log(`awaiting approval: ${name}`, summarizeArgs(args), "pending");
      const reply = `I need your approval before I can run "${name}". Check the Approvals page to let me continue.`;
      await persistMessage(ctx, "assistant", reply, JSON.stringify(pendingTranscript));
      return { status: "awaiting_approval", reply, approvalId: approval.id };
    }

    const { ok, output } = await executeTool(tool, args, ctx, config);
    messages.push({ role: "tool", content: output });
    transcript.push({ name, args, risk: tool.risk, status: ok ? "ok" : "error", result: output });
    await storage.log(`ran tool: ${name}`, summarizeArgs(args), ok ? "ok" : "error");
  }

  return runLoop(ctx, messages, config, transcript, depth + 1);
}

export async function runAgentTurn(taskId: number, userMessage: string): Promise<TurnResult> {
  const storage = getStorage();
  const task = await storage.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  await storage.createChatMessage(taskId, "user", userMessage);
  await storage.log("user message", userMessage.slice(0, 200));

  const config = await storage.getConfig();
  const ctx: RunContext = { type: "task", taskId };
  if (!config.model) {
    const reply = "No Ollama model is configured yet — open Settings, pick a pulled model (or pull one), then try again.";
    await storage.createChatMessage(taskId, "assistant", reply);
    return { status: "final", reply };
  }

  const messages = await buildBaseMessages(ctx, config.systemPrompt);
  const result = await runLoop(ctx, messages, config, [], 0);
  await finalizeContext(ctx, result.status);
  return result;
}

/** One tick of a persistent agent: pulls its next pending queue item (if any) and works it through the same loop a task uses. */
export async function runAgentTick(agentId: number): Promise<TurnResult | { skipped: string }> {
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

  const ctx: RunContext = { type: "agent", agentId, queueItemId: item.id };
  const systemPrompt = `${agent.persona}\n\nYour job: ${agent.jobDescription}`;
  const messages = await buildBaseMessages(ctx, systemPrompt);
  const result = await runLoop(ctx, messages, config, [], 0);
  await finalizeContext(ctx, result.status);
  return result;
}

/** Resumes a tool_call approval (from a task or an agent) — executes or records the denial of the pending call, then re-enters the loop so the model can react to the result. */
export async function resumeAfterApproval(approvalId: number, decision: "approved" | "denied"): Promise<TurnResult> {
  const storage = getStorage();
  const approval = await storage.getApproval(approvalId);
  if (!approval) throw new Error(`Approval ${approvalId} not found`);
  if (approval.targetType !== "tool_call") throw new Error(`Approval ${approvalId} is not a resumable tool call`);
  if (approval.status !== "pending") throw new Error(`Approval ${approvalId} was already decided`);

  const detail = JSON.parse(approval.detail) as { call: { name: string; args: Record<string, unknown> }; messages: OllamaMessage[]; transcript: ToolCallRecord[]; context: RunContext };
  const ctx = detail.context;
  // The write below is the real guard against a double-decide race (it only
  // succeeds if the row was still "pending" at write time) — the read above
  // is just a fast, friendly error for the common case.
  const decided = await storage.decideApproval(approvalId, decision);
  if (!decided) throw new Error(`Approval ${approvalId} was already decided`);

  const config = await storage.getConfig();
  const tools = await allTools(ctx, config.advancedToolsEnabled);
  const tool = tools.find((t) => t.name === detail.call.name);
  const { messages, transcript } = detail;

  if (decision === "denied") {
    const output = "denied by owner";
    messages.push({ role: "tool", content: output });
    transcript.push({ name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: "denied", result: output });
    await storage.log(`approval denied: ${detail.call.name}`, summarizeArgs(detail.call.args), "denied", "owner");
  } else if (!tool) {
    const output = `unknown tool "${detail.call.name}" (it may have been disabled since this request)`;
    messages.push({ role: "tool", content: output });
    transcript.push({ name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: "error", result: output });
  } else {
    const { ok, output } = await executeTool(tool, detail.call.args, ctx, config);
    messages.push({ role: "tool", content: output });
    transcript.push({ name: detail.call.name, args: detail.call.args, risk: approval.risk as ToolCallRecord["risk"], status: ok ? "ok" : "error", result: output });
    await storage.log(`approved + ran tool: ${detail.call.name}`, summarizeArgs(detail.call.args), ok ? "ok" : "error", "owner");
  }

  const result = await runLoop(ctx, messages, config, transcript, 0);
  await finalizeContext(ctx, result.status);
  return result;
}
