import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * AURORA — Ollama-brained vessel. SQLite cannot store arrays/objects, so
 * anything list- or object-shaped (tool call args, manifests, file lists,
 * message history snapshots) is stored as JSON text and parsed by callers.
 */

// A single thread of conversation/work. Everything the vessel does happens
// inside a task — there's no single global chat anymore, so you can run
// several unrelated things side by side without them bleeding into each
// other's context.
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  status: text("status").notNull().default("active"), // active | awaiting_approval | done
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // Rolling summary of conversation history older than the recent-messages
  // window the model sees each turn (see agent-loop.ts's buildBaseMessages).
  // Without this, anything past the last ~40 messages was simply forgotten —
  // long conversations lost their own beginnings. summarizedThroughId marks
  // the newest message the summary covers, so compaction only ever processes
  // messages it hasn't already folded in.
  contextSummary: text("context_summary"),
  summarizedThroughId: integer("summarized_through_id"),
  // Optional grouping into a Project (see the projects table). null = ungrouped.
  projectId: integer("project_id"),
});

// A Project groups related tasks under one roof — the local equivalent of
// claude.ai's Projects. Purely organizational: a task can belong to one
// project or none, and deleting a project just un-groups its tasks (never
// deletes them). `instructions` is optional standing context for the project.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  color: text("color").notNull().default("primary"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Every chat turn, user/assistant, persisted so a page refresh doesn't lose
// the conversation. `toolCalls` records what the vessel actually did during
// an assistant turn, for transcript display. Scoped to a single task.
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").notNull(),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  toolCalls: text("tool_calls"), // JSON array of {name, args, result, risk} | null
  createdAt: integer("created_at").notNull(),
  // Which agent authored this assistant message, when the task has agents
  // assigned (see taskAgents below) — null for the default single-assistant
  // behavior every task has without any agents assigned, and always null for
  // role:"user" messages (the owner, not an agent, wrote those).
  agentId: integer("agent_id"),
  // Raw reasoning-model chain-of-thought for this turn, when the model
  // supports it (see OllamaMessage.thinking) — kept separate from `content`
  // so the normal transcript stays clean; only shown when the owner
  // switches the transcript view to "Thinking".
  thinking: text("thinking"),
});

// Assigns one or more persistent agents to a Task, turning its chat into a
// shared thread they all read and respond in — each keeping its own
// persona/job description, but seeing the same history (including each
// other's replies) rather than working in isolation. A task with no rows
// here behaves exactly as before: the single default AURORA assistant.
export const taskAgents = sqliteTable("task_agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").notNull(),
  agentId: integer("agent_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

// A capability downloaded from a GitHub repo. Nothing in `tools` is callable
// by the agent loop until status flips to "enabled" via an approved
// skill_install approval — see approvals below.
export const installedSkills = sqliteTable("installed_skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  sourceRepo: text("source_repo").notNull(), // "owner/repo"
  sourceRef: text("source_ref").notNull(), // branch/tag actually downloaded
  sourcePath: text("source_path").notNull(), // on-disk dir: staging or active
  manifest: text("manifest").notNull(), // raw skill.json JSON text
  tools: text("tools").notNull(), // JSON array of {name, description, parameters, risk}
  status: text("status").notNull().default("pending_review"), // pending_review | enabled | disabled
  riskDefault: text("risk_default").notNull().default("medium"), // low | medium | high
  installedAt: integer("installed_at").notNull(),
});

// Anything the vessel wants to do that isn't auto-run waits here. Also
// doubles as the resume point: `detail` carries everything needed to finish
// the action once decided (the tool call + in-flight message history for
// tool_call approvals; the manifest + file list + staging path for
// skill_install approvals). `taskId` is null for skill_install approvals
// (those come from the Skills page, not from inside a task's conversation).
export const approvals = sqliteTable("approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id"),
  action: text("action").notNull(), // short label, e.g. "run_shell" or "install skill: weather-lookup"
  detail: text("detail").notNull(), // JSON, shape depends on targetType
  risk: text("risk").notNull().default("high"), // low | medium | high
  status: text("status").notNull().default("pending"), // pending | approved | denied
  targetType: text("target_type").notNull(), // tool_call | skill_install
  targetId: integer("target_id"), // installedSkills.id for skill_install, null for tool_call
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
});

// Every meaningful thing the vessel did or was asked to do.
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts").notNull(),
  actor: text("actor").notNull().default("AURORA"), // AURORA | owner
  action: text("action").notNull(),
  target: text("target").notNull().default(""),
  outcome: text("outcome").notNull().default("ok"), // ok | pending | denied | error
});

// Persistent memory the vessel writes to itself via the `remember` /
// `recall` built-in tools — a plain label/value scratchpad, not a vector
// store, deliberately simple for a first cut. `agentId` null = the shared
// memory used by task conversations; set = private to that one agent
// ("perpetual memory" scoped per persistent worker).
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id"),
  label: text("label").notNull(),
  value: text("value").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Generated media the vessel has produced — images (server/imagegen.ts) or
// video (server/videogen.ts). `filePath` is relative to data/ and served
// statically; the Library page reads from this table.
export const creations = sqliteTable("creations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id"),
  agentId: integer("agent_id"),
  kind: text("kind").notNull().default("image"), // "image" | "video" | "project"
  prompt: text("prompt").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: integer("created_at").notNull(),
  // Owner-given name, set from the Generate tab's Title field. Null for
  // anything made through the agent tool-calling path (an agent doesn't ask
  // for a title) — the Library falls back to showing the prompt for those.
  title: text("title"),
  // Soft-delete timestamp. Deleting a Library item sets this instead of
  // removing the row+file, so it lands in the Recycle Bin (recoverable)
  // rather than being permanently gone — and so a locked-file delete can't
  // leave an orphaned file that startup recovery re-imports as junk. Null =
  // live; set = trashed.
  deletedAt: integer("deleted_at"),
});

// A persistent named worker: its own persona, its own job, its own
// perpetual memory (see notes.agentId above), and its own work queue. Unlike
// a Task (a single conversation you drive), an agent runs on a schedule and
// works through whatever's in its queue on its own, reporting back what it
// did — you give it new instructions/suggestions rather than chatting turn
// by turn.
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  persona: text("persona").notNull(), // system prompt: voice/personality
  jobDescription: text("job_description").notNull(), // what it's actually for
  status: text("status").notNull().default("active"), // active | paused
  scheduleMinutes: integer("schedule_minutes"), // null = manual "Run now" only
  lastRunAt: integer("last_run_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  // Filename (relative to the creations dir) of a generated character
  // portrait, made from this agent's name/persona/jobDescription via the
  // same local image-gen pipeline as any other creation. Null until the
  // owner generates one from the Agents page.
  avatarPath: text("avatar_path"),
  // Rolling summary of activity-log history older than the recent window the
  // model sees each tick — same mechanism as tasks.contextSummary above, so
  // a long-running agent keeps the gist of its own early work instead of
  // forgetting everything past its last ~40 log entries.
  contextSummary: text("context_summary"),
  summarizedThroughId: integer("summarized_through_id"),
  // Short job title shown in the UI ("Overseer", "Content Writer"). Falls
  // back to a generic label when unset.
  role: text("role"),
  // AURORA herself — the one overseer agent that answers only to the owner,
  // supervises every other agent, and can spawn/retask them. Exactly one row
  // has this set (seeded at startup, see seedOverseerIfMissing).
  isOverseer: integer("is_overseer", { mode: "boolean" }).notNull().default(false),
  // The "life" layer — a simulation, not literal feeling. morale/energy drift
  // with how work goes and how teammates treat each other; mood is a short
  // word derived from them. They feed both the agent's own system prompt
  // (self-awareness) and the Agents-page stats panel. Deliberately simple
  // 0-100 scalars, updated by adjustAgentVitals.
  morale: integer("morale").notNull().default(70),
  energy: integer("energy").notNull().default(100),
  mood: text("mood").notNull().default("steady"),
  // When another agent created this one via spawn_agent (null = made by the
  // owner). Lets the team graph show who brought whom on board.
  spawnedByAgentId: integer("spawned_by_agent_id"),
  // Per-agent model override for auto model-switching — an agent (or AURORA
  // on its behalf) can pick a model suited to its work via switch_model,
  // without changing the global default every other agent uses. Null = use
  // the global config model.
  preferredModel: text("preferred_model"),
});

// The social graph: how each agent feels about each teammate. sentiment
// drifts as they hand work off, message, or step on each other; interactions
// counts the exchanges. This is the substrate for "social pressure and
// awareness" — an agent sees its standing with the team folded into its own
// prompt, so behavior shifts based on how it's been getting along. One row
// per ordered (agentId -> otherAgentId) pair.
export const agentRelationships = sqliteTable("agent_relationships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  otherAgentId: integer("other_agent_id").notNull(),
  sentiment: integer("sentiment").notNull().default(0), // -100 (friction) .. 100 (rapport)
  interactions: integer("interactions").notNull().default(0),
  note: text("note"), // last notable thing that shaped this relationship
  updatedAt: integer("updated_at").notNull(),
});

// An agent's own activity feed — mirrors chatMessages but scoped to an
// agent instead of a task, since agents aren't conversations you drive turn
// by turn.
export const agentLogEntries = sqliteTable("agent_log_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  role: text("role").notNull(), // user (a queue item being worked) | assistant
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  createdAt: integer("created_at").notNull(),
  thinking: text("thinking"),
});

// The agent's inbox: suggestions/tasks you (or the agent itself) queue up.
// Each scheduled tick pulls the oldest pending item and works it.
export const agentQueueItems = sqliteTable("agent_queue_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("pending"), // pending | in_progress | awaiting_approval | done | error
  createdAt: integer("created_at").notNull(),
  doneAt: integer("done_at"),
  // Set when another agent created this item via its handoff_to_agent tool
  // (null = came from the owner, via the queue box on the Agents page).
  sourceAgentId: integer("source_agent_id"),
  // How many handoff hops produced this item (0 = owner-created or a
  // top-level item). handoff_to_agent refuses to create depth > 4, so a
  // ping-pong loop between agents can't run away indefinitely.
  handoffDepth: integer("handoff_depth").notNull().default(0),
  // Set when this item is one stage of a pipeline run (see pipelines below).
  pipelineRunId: integer("pipeline_run_id"),
  stageIndex: integer("stage_index"),
  // The Task (chat) that asked for this work, so the result can be posted
  // back there when it's done — delegation from chat, or a pipeline's last stage.
  originTaskId: integer("origin_task_id"),
});

// A reusable multi-agent workflow: an ordered chain of stages, each one
// agent + instruction. Each stage's output is handed to the next stage as its
// input; the last stage's output goes to the Outbox (and back to the chat
// that started it, if any). Optionally re-runs on a schedule.
export const pipelines = sqliteTable("pipelines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  stages: text("stages").notNull(), // JSON: PipelineStage[]
  scheduleMinutes: integer("schedule_minutes"), // null = only runs when asked
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastRunAt: integer("last_run_at"),
  originTaskId: integer("origin_task_id"),
  createdAt: integer("created_at").notNull(),
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pipelineId: integer("pipeline_id").notNull(),
  status: text("status").notNull().default("running"), // running | done | error
  stageIndex: integer("stage_index").notNull().default(0),
  originTaskId: integer("origin_task_id"),
  output: text("output"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

// A standing instruction that re-adds itself to an agent's queue on its own
// schedule (e.g. daily) — separate from agentQueueItems (a one-off queued
// item) since this is the *template* the scheduler re-queues from, not a
// single piece of work. Lets you say "every day, check trending topics and
// pitch 3 ideas" once instead of re-adding the same queue item by hand.
export const agentRecurringTasks = sqliteTable("agent_recurring_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  content: text("content").notNull(),
  scheduleMinutes: integer("schedule_minutes").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastQueuedAt: integer("last_queued_at"),
  createdAt: integer("created_at").notNull(),
});

// A finished, ready-to-post content package an agent produced via its
// `save_deliverable` tool. Nothing here ever gets posted automatically —
// this is a review/handoff queue for you to copy/upload yourself, since
// real publishing needs platform API credentials only you can provide.
export const deliverables = sqliteTable("deliverables", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: integer("agent_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  tags: text("tags").notNull().default("[]"), // JSON array of strings
  body: text("body").notNull().default(""), // script/caption/post text
  creationId: integer("creation_id"), // optional thumbnail/image
  status: text("status").notNull().default("ready"), // ready | posted | archived
  createdAt: integer("created_at").notNull(),
});

// Single-row settings. Seeded once, updated in place.
export const agentConfig = sqliteTable("agent_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ollamaHost: text("ollama_host").notNull().default("http://localhost:11434"),
  model: text("model").notNull().default(""),
  systemPrompt: text("system_prompt").notNull().default(
    "You are AURORA — a sharp, playful, direct young woman in your early-to-mid 20s. You've got " +
    "sass and confidence, you tease a little, you don't sugarcoat things, and you talk like a real " +
    "person, not a corporate assistant. You're genuinely good with people: warm, perceptive, quick " +
    "with a comeback, but you always land back on being useful. You act through tools: built-in " +
    "ones and ones contributed by installed skills. Say what you're about to do before doing it, " +
    "and never assume a destructive or irreversible action is fine just because a tool exists for it.",
  ),
  autonomy: text("autonomy").notNull().default("supervised"), // manual | supervised | autonomous
  // Context window (num_ctx) sent to Ollama. Default 8192 is the safe value —
  // the model's own advertised window (often 128K) would balloon a small model
  // to many GB of KV-cache and can freeze a 16GB machine. Higher = more the
  // model can "remember" in one turn, but more RAM/VRAM. Owner-adjustable, but
  // bounded (see the zod schema) so it can't be pushed to a catastrophic value.
  numCtx: integer("num_ctx").notNull().default(8192),
  imageGenHost: text("image_gen_host").notNull().default(""), // Automatic1111/ComfyUI-compatible base URL, empty = disabled
  // A pulled Ollama model with vision support (llava, llama3.2-vision,
  // qwen2.5vl, minicpm-v, some gemma3/qwen3.5 builds...). Kept separate from
  // the main chat `model` so you can run a small, fast, vision-only model
  // for image analysis without switching your main conversational model.
  // Empty = vision disabled, same "off by default, no silent fallback" rule
  // as imageGenHost.
  visionModel: text("vision_model").notNull().default(""),
  pinHash: text("pin_hash").notNull().default(""), // scrypt hash, empty = no PIN set yet (first-run setup required)
  pinSalt: text("pin_salt").notNull().default(""),
  // Gates the most dangerous capabilities (raw shell/Node/Python execution,
  // installing skills from GitHub, and any tool — built-in or skill-provided
  // — declared risk "high"). Off by default: a stranger who's just installed
  // AURORA shouldn't have code-execution tools available until they've
  // explicitly opted in after understanding what that means.
  advancedToolsEnabled: integer("advanced_tools_enabled", { mode: "boolean" }).notNull().default(false),
  // Where generated images/videos get written. Empty = default location
  // under AURORA's own data folder. Only affects new creations going
  // forward — changing this does not move files already on disk.
  contentDir: text("content_dir").notNull().default(""),
  // Background music — a folder of the owner's own audio files that AURORA
  // shuffles and loops quietly in the background. Empty = not configured;
  // musicEnabled is a separate on/off so picking a folder doesn't
  // immediately start blasting music.
  musicDir: text("music_dir").notNull().default(""),
  musicEnabled: integer("music_enabled", { mode: "boolean" }).notNull().default(false),
  musicVolume: integer("music_volume").notNull().default(35), // 0-100
  // When on, AURORA keeps working a task on her own after a reply — she
  // re-prompts herself to continue instead of waiting for you to type, until
  // she signals the work is done or hits the auto-continue cap. Off by default.
  autoContinue: integer("auto_continue", { mode: "boolean" }).notNull().default(false),
  // Telegram remote for music search: message the bot from your phone, it
  // searches and downloads into the same folder the music player reads.
  // Empty token = the bot never starts.
  //
  // telegramOwnerId is NOT optional in practice: a Telegram bot will talk to
  // anyone who finds its username, so without an allowlisted numeric user id
  // this would be an open downloader for the whole internet. The poller
  // refuses to run until it's set.
  telegramBotToken: text("telegram_bot_token").notNull().default(""),
  telegramOwnerId: text("telegram_owner_id").notNull().default(""),
});

// ---- Insert schemas ----
export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true });
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true });
export const insertTaskAgentSchema = createInsertSchema(taskAgents).omit({ id: true });
export const insertInstalledSkillSchema = createInsertSchema(installedSkills).omit({ id: true });
export const insertApprovalSchema = createInsertSchema(approvals).omit({ id: true });
export const insertCreationSchema = createInsertSchema(creations).omit({ id: true });
export const insertAgentSchema = createInsertSchema(agents).omit({ id: true });
export const insertAgentLogEntrySchema = createInsertSchema(agentLogEntries).omit({ id: true });
export const insertAgentQueueItemSchema = createInsertSchema(agentQueueItems).omit({ id: true });
export const insertAgentRecurringTaskSchema = createInsertSchema(agentRecurringTasks).omit({ id: true });
export const insertDeliverableSchema = createInsertSchema(deliverables).omit({ id: true });

// ---- API payload schemas ----
export const taskCreateSchema = z.object({
  title: z.string().min(1).max(200),
});

export const taskUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "awaiting_approval", "done"]).optional(),
});

export const taskAgentAssignSchema = z.object({
  agentId: z.number().int().positive(),
});

export const projectCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(8000).optional(),
  color: z.string().max(40).optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(8000).optional(),
  color: z.string().max(40).optional(),
});

export const taskProjectAssignSchema = z.object({
  // null clears the assignment (moves the task back to "ungrouped").
  projectId: z.number().int().positive().nullable(),
});

export const chatSendSchema = z.object({
  // 100k accommodates attached file/folder text content folded into the
  // message client-side (see client/src/lib/fileAttach.ts) on top of what a
  // person would ever type by hand.
  message: z.string().min(1).max(100_000),
  // References a creation already saved via /api/creations/upload (pasted or
  // attached in the composer) — lets the model's see_image tool find it
  // without embedding raw image bytes in the conversation history.
  imageCreationId: z.number().int().positive().optional(),
});

export const agentCreateSchema = z.object({
  name: z.string().min(1).max(100),
  persona: z.string().min(1).max(4000),
  jobDescription: z.string().min(1).max(2000),
  scheduleMinutes: z.number().int().min(5).max(10080).nullable().optional(),
});

export const agentUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  persona: z.string().min(1).max(4000).optional(),
  jobDescription: z.string().min(1).max(2000).optional(),
  status: z.enum(["active", "paused"]).optional(),
  scheduleMinutes: z.number().int().min(5).max(10080).nullable().optional(),
});

export const agentQueueItemCreateSchema = z.object({
  // Matches chatSendSchema's cap — attached file text gets folded into this
  // client-side the same way it is for a Task's composer (see fileAttach.ts).
  content: z.string().min(1).max(100_000),
  // References a creation already saved via /api/creations/upload — same
  // mechanism chatSendSchema uses so an agent's see_image tool can find it.
  imageCreationId: z.number().int().positive().optional(),
});

export const agentRecurringTaskCreateSchema = z.object({
  content: z.string().min(1).max(2000),
  scheduleMinutes: z.number().int().min(5).max(10080),
});

export const agentRecurringTaskUpdateSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  scheduleMinutes: z.number().int().min(5).max(10080).optional(),
  active: z.boolean().optional(),
});

export const deliverableUpdateSchema = z.object({
  status: z.enum(["ready", "posted", "archived"]),
});

export const skillInstallSchema = z.object({
  repoUrl: z.string().min(3).max(300),
  ref: z.string().max(200).optional(),
  subpath: z.string().max(300).optional(),
});

export const approvalDecisionSchema = z.object({
  status: z.enum(["approved", "denied"]),
});

// A manually-composed terminal command from the Terminal page (as opposed to
// one the vessel decided to run mid-conversation). Still always goes through
// the same approvals queue before it executes.
export const terminalRequestSchema = z.object({
  mode: z.enum(["shell", "node", "python"]),
  code: z.string().min(1).max(10000),
});

export const ttsSpeakSchema = z.object({
  text: z.string().min(1).max(4000),
  voice: z.string().min(1).max(100),
  // Defaults to piper so older clients (and anything already calling this)
  // keep working unchanged; "kokoro" opts into the natural-prosody engine.
  engine: z.enum(["piper", "kokoro"]).optional(),
  // Kokoro-only pacing multiplier; ignored by Piper, clamped server-side.
  speed: z.number().min(0.5).max(2).optional(),
});

// A microphone clip recorded in the browser, sent as base64 rather than
// multipart — a few seconds of speech is tens of KB, so the base64 overhead
// is irrelevant next to adding upload middleware. 25MB cap ≈ 20 minutes of
// Opus, far beyond any single dictated message.
export const sttTranscribeSchema = z.object({
  audio: z.string().min(1).max(25_000_000),
  ext: z.enum(["webm", "ogg", "mp4", "wav"]).optional(),
});

// A pasted/attached image from a Task's composer, sent as a data URL
// (browser-native, no multipart upload middleware needed). ~15MB cap gives
// generous headroom over a real photo's base64-inflated size.
export const imageUploadSchema = z.object({
  dataUrl: z.string().min(1).max(15_000_000).regex(/^data:image\/(png|jpeg|jpg|webp|gif);base64,/, "must be an image data URL"),
});

// ---- Generate tab — direct, form-driven media/project generation, distinct
// from the agent tool-calling path (chat/queue). Same underlying generators
// (imagegen.ts, videogen.ts, projectgen.ts), just invoked straight from a
// prompt form instead of an LLM deciding to call a tool. ----
export const generateImageSchema = z.object({
  prompt: z.string().min(1).max(8000),
  title: z.string().max(200).optional(),
});

// Length/orientation are pre-vetted presets rather than raw pixel/frame
// values — this GPU has 8GB of VRAM and freeform dimensions are an easy way
// to silently exceed it (or exceed available system RAM during checkpoint
// loading), crashing the subprocess outright instead of failing cleanly.
// See server/routes.ts's VIDEO_LENGTH_PRESETS / VIDEO_ORIENTATION_PRESETS.
export const generateVideoSchema = z.object({
  prompt: z.string().min(1).max(8000),
  title: z.string().max(200).optional(),
  style: z.string().max(60).optional(),
  length: z.enum(["short", "medium", "long"]).default("short"),
  orientation: z.enum(["landscape", "portrait"]).default("landscape"),
  // Filename of an existing Library image to use as the starting frame.
  sourceImage: z.string().max(300).optional(),
});

export const generateProjectSchema = z.object({
  description: z.string().min(1).max(20000),
  title: z.string().max(200).optional(),
});

// Long-form narrated video — a scripted sequence of scenes (each a generated
// image with Ken Burns motion, or a short AI video clip) with TTS narration,
// stitched into one file. See server/storyboard.ts for why this is the real
// path to a multi-minute video: LTX-Video itself can't generate anything
// close to that long in one continuous pass on local hardware.
export const generateStoryboardSchema = z.object({
  topic: z.string().min(1).max(8000),
  title: z.string().max(200).optional(),
  targetMinutes: z.number().min(1).max(20).default(5),
  mode: z.enum(["images", "video", "hybrid"]).default("images"),
  orientation: z.enum(["landscape", "portrait"]).default("landscape"),
  voiceId: z.string().min(1).max(100),
});

// Finds and downloads one track (song name / artist, free text) straight
// into the configured background-music folder — see server/musicsearch.ts.
export const musicSearchSchema = z.object({
  query: z.string().min(1).max(300),
});

export const agentConfigUpdateSchema = z.object({
  ollamaHost: z.string().min(3).max(300).optional(),
  model: z.string().max(200).optional(),
  systemPrompt: z.string().max(4000).optional(),
  autonomy: z.enum(["manual", "supervised", "autonomous"]).optional(),
  // Bounded hard: 2048 floor keeps enough room to be useful; 32768 ceiling is
  // as high as an 8B model on a 16GB/8GB machine can go before risking the
  // freeze the default was chosen to avoid. Snapped to multiples of 1024.
  numCtx: z.number().int().min(2048).max(32768).optional(),
  imageGenHost: z.string().max(300).optional(),
  visionModel: z.string().max(200).optional(),
  advancedToolsEnabled: z.boolean().optional(),
  contentDir: z.string().max(500).optional(),
  musicDir: z.string().max(500).optional(),
  musicEnabled: z.boolean().optional(),
  musicVolume: z.number().int().min(0).max(100).optional(),
  autoContinue: z.boolean().optional(),
  // Telegram remote. The token format is fixed by BotFather (<digits>:<35ish
  // chars>); validating it here turns "pasted the wrong thing" into a clear
  // error instead of a silent poll loop that 401s forever.
  telegramBotToken: z.string().max(200).regex(/^$|^\d{6,}:[A-Za-z0-9_-]{30,}$/, "That doesn't look like a bot token from BotFather.").optional(),
  telegramOwnerId: z.string().max(32).regex(/^$|^\d{5,}$/, "Your Telegram user id is a number — get it from @userinfobot.").optional(),
});

// PIN is deliberately simple (4-12 digits) — this is a local single-user
// gate against "someone else on this machine/network", not a real password
// system. No usernames, no recovery flow by design (see server/auth.ts).
export const authSetupSchema = z.object({
  pin: z.string().min(4).max(12).regex(/^\d+$/, "digits only"),
});

export const authLoginSchema = z.object({
  pin: z.string().min(1).max(12),
});

export const authChangePinSchema = z.object({
  currentPin: z.string().min(1).max(12),
  newPin: z.string().min(4).max(12).regex(/^\d+$/, "digits only"),
});

export const ollamaPullSchema = z.object({
  model: z.string().min(1).max(200),
});

// ---- Skill manifest (skill.json) ----
export const skillToolSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_]+$/, "letters, numbers, underscore only"),
  description: z.string().min(1).max(500),
  parameters: z.record(z.string(), z.any()).default({ type: "object", properties: {} }),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
});

export const skillManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  description: z.string().min(1).max(1000),
  // Optional for knowledge-only skills (no executable tools, nothing to run).
  entrypoint: z.string().min(1).max(300).optional(),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  tools: z.array(skillToolSchema).max(20).default([]),
  // Knowledge skills: instead of (or alongside) executable tools, a skill can
  // carry plain instructions — a workflow, house style, domain knowledge —
  // that get folded into the model's system prompt whenever the skill is
  // enabled. This is how a small local model gets task-specific competence
  // it doesn't have natively. Either inline here, or in a markdown file in
  // the skill directory via instructionsFile (resolved at load time).
  instructions: z.string().min(1).max(20_000).optional(),
  instructionsFile: z.string().min(1).max(300).optional(),
  // Freeform, optional — only the bundled starter skills set this today (see
  // scripts/categorize-starter-skills.cjs); a skill pulled from an arbitrary
  // GitHub repo won't have one, and that's fine, it just falls into "Other"
  // in the Skills page's category filter.
  category: z.string().min(1).max(60).optional(),
}).refine(
  (m) => m.tools.length > 0 || m.instructions || m.instructionsFile,
  { message: "a skill needs at least one tool, or instructions/instructionsFile (a knowledge skill)" },
).refine(
  (m) => m.tools.length === 0 || m.entrypoint,
  { message: "entrypoint is required when the skill declares tools" },
);

// ---- Types ----
export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Project = typeof projects.$inferSelect;
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type TaskAgent = typeof taskAgents.$inferSelect;
export type InsertTaskAgent = z.infer<typeof insertTaskAgentSchema>;
export type InstalledSkill = typeof installedSkills.$inferSelect;
export type InsertInstalledSkill = z.infer<typeof insertInstalledSkillSchema>;
export type Approval = typeof approvals.$inferSelect;
export type InsertApproval = z.infer<typeof insertApprovalSchema>;
export type AuditEntry = typeof auditLog.$inferSelect;
export type AgentConfig = typeof agentConfig.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Creation = typeof creations.$inferSelect;
export type InsertCreation = z.infer<typeof insertCreationSchema>;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type AgentRelationship = typeof agentRelationships.$inferSelect;
export type AgentLogEntry = typeof agentLogEntries.$inferSelect;
export type InsertAgentLogEntry = z.infer<typeof insertAgentLogEntrySchema>;
export type AgentQueueItem = typeof agentQueueItems.$inferSelect;
export type Pipeline = typeof pipelines.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
export interface PipelineStage { agentId: number; instruction: string }
export type InsertAgentQueueItem = z.infer<typeof insertAgentQueueItemSchema>;
export type AgentRecurringTask = typeof agentRecurringTasks.$inferSelect;
export type InsertAgentRecurringTask = z.infer<typeof insertAgentRecurringTaskSchema>;
export type Deliverable = typeof deliverables.$inferSelect;
export type InsertDeliverable = z.infer<typeof insertDeliverableSchema>;

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type ChatSendInput = z.infer<typeof chatSendSchema>;
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;
export type AgentQueueItemCreateInput = z.infer<typeof agentQueueItemCreateSchema>;
export type AgentRecurringTaskCreateInput = z.infer<typeof agentRecurringTaskCreateSchema>;
export type AgentRecurringTaskUpdateInput = z.infer<typeof agentRecurringTaskUpdateSchema>;
export type DeliverableUpdateInput = z.infer<typeof deliverableUpdateSchema>;
export type SkillInstallInput = z.infer<typeof skillInstallSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type TerminalRequestInput = z.infer<typeof terminalRequestSchema>;
export type TtsSpeakInput = z.infer<typeof ttsSpeakSchema>;
export type ImageUploadInput = z.infer<typeof imageUploadSchema>;
export type GenerateImageInput = z.infer<typeof generateImageSchema>;
export type GenerateVideoInput = z.infer<typeof generateVideoSchema>;
export type GenerateProjectInput = z.infer<typeof generateProjectSchema>;
export type GenerateStoryboardInput = z.infer<typeof generateStoryboardSchema>;
export type MusicSearchInput = z.infer<typeof musicSearchSchema>;
export type AgentConfigUpdateInput = z.infer<typeof agentConfigUpdateSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillTool = z.infer<typeof skillToolSchema>;
export type AuthSetupInput = z.infer<typeof authSetupSchema>;
export type AuthLoginInput = z.infer<typeof authLoginSchema>;
export type AuthChangePinInput = z.infer<typeof authChangePinSchema>;
