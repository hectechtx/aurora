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

// Generated media the vessel has produced (currently images — video isn't
// wired up yet, see server/imagegen.ts). `filePath` is relative to data/
// and served statically; the Library page reads from this table.
export const creations = sqliteTable("creations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id"),
  agentId: integer("agent_id"),
  kind: text("kind").notNull().default("image"), // image (video later)
  prompt: text("prompt").notNull(),
  filePath: text("file_path").notNull(),
  createdAt: integer("created_at").notNull(),
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
  autonomy: text("autonomy").notNull().default("supervised"), // manual | supervised
  imageGenHost: text("image_gen_host").notNull().default(""), // Automatic1111/ComfyUI-compatible base URL, empty = disabled
  pinHash: text("pin_hash").notNull().default(""), // scrypt hash, empty = no PIN set yet (first-run setup required)
  pinSalt: text("pin_salt").notNull().default(""),
  // Gates the most dangerous capabilities (raw shell/Node/Python execution,
  // installing skills from GitHub, and any tool — built-in or skill-provided
  // — declared risk "high"). Off by default: a stranger who's just installed
  // AURORA shouldn't have code-execution tools available until they've
  // explicitly opted in after understanding what that means.
  advancedToolsEnabled: integer("advanced_tools_enabled", { mode: "boolean" }).notNull().default(false),
});

// ---- Insert schemas ----
export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true });
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true });
export const insertInstalledSkillSchema = createInsertSchema(installedSkills).omit({ id: true });
export const insertApprovalSchema = createInsertSchema(approvals).omit({ id: true });
export const insertCreationSchema = createInsertSchema(creations).omit({ id: true });
export const insertAgentSchema = createInsertSchema(agents).omit({ id: true });
export const insertAgentLogEntrySchema = createInsertSchema(agentLogEntries).omit({ id: true });
export const insertAgentQueueItemSchema = createInsertSchema(agentQueueItems).omit({ id: true });
export const insertDeliverableSchema = createInsertSchema(deliverables).omit({ id: true });

// ---- API payload schemas ----
export const taskCreateSchema = z.object({
  title: z.string().min(1).max(200),
});

export const taskUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "awaiting_approval", "done"]).optional(),
});

export const chatSendSchema = z.object({
  message: z.string().min(1).max(8000),
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
  content: z.string().min(1).max(2000),
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

export const agentConfigUpdateSchema = z.object({
  ollamaHost: z.string().min(3).max(300).optional(),
  model: z.string().max(200).optional(),
  systemPrompt: z.string().max(4000).optional(),
  autonomy: z.enum(["manual", "supervised"]).optional(),
  imageGenHost: z.string().max(300).optional(),
  advancedToolsEnabled: z.boolean().optional(),
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
  entrypoint: z.string().min(1).max(300),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  tools: z.array(skillToolSchema).min(1).max(20),
});

// ---- Types ----
export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
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
export type AgentLogEntry = typeof agentLogEntries.$inferSelect;
export type InsertAgentLogEntry = z.infer<typeof insertAgentLogEntrySchema>;
export type AgentQueueItem = typeof agentQueueItems.$inferSelect;
export type InsertAgentQueueItem = z.infer<typeof insertAgentQueueItemSchema>;
export type Deliverable = typeof deliverables.$inferSelect;
export type InsertDeliverable = z.infer<typeof insertDeliverableSchema>;

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type ChatSendInput = z.infer<typeof chatSendSchema>;
export type AgentCreateInput = z.infer<typeof agentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof agentUpdateSchema>;
export type AgentQueueItemCreateInput = z.infer<typeof agentQueueItemCreateSchema>;
export type DeliverableUpdateInput = z.infer<typeof deliverableUpdateSchema>;
export type SkillInstallInput = z.infer<typeof skillInstallSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type TerminalRequestInput = z.infer<typeof terminalRequestSchema>;
export type AgentConfigUpdateInput = z.infer<typeof agentConfigUpdateSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillTool = z.infer<typeof skillToolSchema>;
export type AuthSetupInput = z.infer<typeof authSetupSchema>;
export type AuthLoginInput = z.infer<typeof authLoginSchema>;
export type AuthChangePinInput = z.infer<typeof authChangePinSchema>;
