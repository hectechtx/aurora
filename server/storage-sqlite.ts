import {
  tasks, chatMessages, installedSkills, approvals, auditLog, agentConfig, notes, creations,
  agents, agentLogEntries, agentQueueItems, agentRecurringTasks, deliverables, taskAgents, agentRelationships, projects,
  pipelines, pipelineRuns,
} from "@shared/schema";
import type { Pipeline, PipelineRun } from "@shared/schema";
import type {
  Task, ChatMessage, InstalledSkill, InsertInstalledSkill, Approval, AuditEntry, AgentConfig, Note, Creation,
  Agent, AgentLogEntry, AgentQueueItem, AgentRecurringTask, Deliverable, TaskAgent, AgentRelationship,
  Project, ProjectCreateInput, ProjectUpdateInput,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, asc, gt, lt, isNull, isNotNull, and, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import type { Storage, QueueItemOpts } from "./storage-types";
import { DB_PATH, DATA_DIR, getCreationsDir, SELF_SOURCE_DIR } from "./paths";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/**
 * One-time move of the database off the external data drive onto the internal
 * one (see the DB_DIR comment in paths.ts for why).
 *
 * Returns the path that should actually be opened. That return value matters:
 * if anything about the copy goes wrong this hands back the ORIGINAL path, so
 * the app keeps running on the known-good database instead of silently opening
 * a fresh empty one at the destination — which would look exactly like total
 * data loss to the owner.
 *
 * Deliberately conservative throughout: it only acts when the destination is
 * genuinely empty, it copies rather than moves, it verifies the copy opens and
 * passes an integrity check with a matching row count, and it never deletes
 * the original — only renames it once the copy has proven good.
 */
function resolveDatabasePath(): string {
  const legacyPath = path.join(DATA_DIR, "aurora.db");
  // Nothing to do if the DB already lives where we want it, if there's no
  // legacy file, or if a database is already present at the destination.
  if (path.resolve(legacyPath) === path.resolve(DB_PATH)) return DB_PATH;
  if (!fs.existsSync(legacyPath)) return DB_PATH;
  if (fs.existsSync(DB_PATH)) return DB_PATH;

  try {
    // Checkpoint first. A WAL-mode database keeps recently-committed
    // transactions in the sidecar -wal file, so copying the .db alone would
    // silently drop the newest messages. TRUNCATE folds them back in and
    // empties the WAL, which makes the .db file self-contained and therefore
    // safe to copy as a plain file.
    const source = new Database(legacyPath);
    source.pragma("journal_mode = WAL");
    source.pragma("wal_checkpoint(TRUNCATE)");
    const sourceMessages = (source.prepare("SELECT COUNT(*) c FROM chat_messages").get() as { c: number }).c;
    source.close();

    fs.copyFileSync(legacyPath, DB_PATH);

    const check = new Database(DB_PATH, { readonly: true });
    const integrity = (check.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check;
    const copiedMessages = (check.prepare("SELECT COUNT(*) c FROM chat_messages").get() as { c: number }).c;
    check.close();

    if (integrity !== "ok") throw new Error(`copy failed integrity check: ${integrity}`);
    if (copiedMessages !== sourceMessages) throw new Error(`copy has ${copiedMessages} messages, source had ${sourceMessages}`);

    // Only now stand the original down — renamed, never removed, so there is
    // always a way back.
    fs.renameSync(legacyPath, `${legacyPath}.migrated`);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(legacyPath + suffix)) {
        try { fs.renameSync(legacyPath + suffix, `${legacyPath}.migrated${suffix}`); } catch { /* sidecars are regenerated anyway */ }
      }
    }
    console.log(`[aurora] database moved to the internal drive: ${DB_PATH} (${copiedMessages} messages, integrity ok)`);
    return DB_PATH;
  } catch (err) {
    // Clean up the half-written copy and stay on the original. Running off the
    // flaky drive is far better than starting from an empty database.
    try { if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH); } catch { /* nothing more we can do */ }
    console.error(`[aurora] database migration failed, continuing to use ${legacyPath}: ${err instanceof Error ? err.message : String(err)}`);
    return legacyPath;
  }
}

const ACTIVE_DB_PATH = resolveDatabasePath();

// Exported so backup.ts can take consistent online snapshots of this exact
// connection — see that file for why the data drive can't be trusted.
export const sqlite = new Database(ACTIVE_DB_PATH);
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, context_summary TEXT, summarized_through_id INTEGER);
CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS installed_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL, source_repo TEXT NOT NULL, source_ref TEXT NOT NULL, source_path TEXT NOT NULL, manifest TEXT NOT NULL, tools TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_review', risk_default TEXT NOT NULL DEFAULT 'medium', installed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'high', status TEXT NOT NULL DEFAULT 'pending', target_type TEXT NOT NULL, target_id INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT 'AURORA', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'ok');
CREATE TABLE IF NOT EXISTS agent_config (id INTEGER PRIMARY KEY AUTOINCREMENT, ollama_host TEXT NOT NULL DEFAULT 'http://localhost:11434', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', autonomy TEXT NOT NULL DEFAULT 'supervised', image_gen_host TEXT NOT NULL DEFAULT '', vision_model TEXT NOT NULL DEFAULT '', pin_hash TEXT NOT NULL DEFAULT '', pin_salt TEXT NOT NULL DEFAULT '', advanced_tools_enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, label TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS creations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, kind TEXT NOT NULL DEFAULT 'image', prompt TEXT NOT NULL, file_path TEXT NOT NULL, created_at INTEGER NOT NULL, title TEXT, deleted_at INTEGER);
CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, persona TEXT NOT NULL, job_description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', schedule_minutes INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, avatar_path TEXT, context_summary TEXT, summarized_through_id INTEGER);
CREATE TABLE IF NOT EXISTS agent_log_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_queue_items (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, done_at INTEGER, source_agent_id INTEGER, handoff_depth INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS agent_recurring_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, content TEXT NOT NULL, schedule_minutes INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_queued_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deliverables (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '', creation_id INTEGER, status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_agents (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, agent_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_relationships (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, other_agent_id INTEGER NOT NULL, sentiment INTEGER NOT NULL DEFAULT 0, interactions INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'primary', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`);

// Columns added to pre-existing tables after their CREATE TABLE IF NOT EXISTS
// was already run on someone's DB — SQLite won't retroactively add these, so
// best-effort ALTER TABLE them in, same pattern as any other schema growth.
for (const stmt of [
  "ALTER TABLE notes ADD COLUMN agent_id INTEGER",
  "ALTER TABLE creations ADD COLUMN agent_id INTEGER",
  "ALTER TABLE agent_config ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN pin_salt TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN advanced_tools_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agent_queue_items ADD COLUMN source_agent_id INTEGER",
  "ALTER TABLE agent_queue_items ADD COLUMN handoff_depth INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agent_config ADD COLUMN vision_model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN content_dir TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN music_dir TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN music_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agent_config ADD COLUMN music_volume INTEGER NOT NULL DEFAULT 35",
  "ALTER TABLE chat_messages ADD COLUMN agent_id INTEGER",
  "ALTER TABLE chat_messages ADD COLUMN thinking TEXT",
  "ALTER TABLE agent_log_entries ADD COLUMN thinking TEXT",
  "ALTER TABLE agents ADD COLUMN avatar_path TEXT",
  "ALTER TABLE creations ADD COLUMN title TEXT",
  "ALTER TABLE tasks ADD COLUMN context_summary TEXT",
  "ALTER TABLE tasks ADD COLUMN summarized_through_id INTEGER",
  "ALTER TABLE agents ADD COLUMN context_summary TEXT",
  "ALTER TABLE agents ADD COLUMN summarized_through_id INTEGER",
  "ALTER TABLE creations ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE tasks ADD COLUMN project_id INTEGER",
  "ALTER TABLE agent_config ADD COLUMN auto_continue INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agent_config ADD COLUMN telegram_bot_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agent_config ADD COLUMN telegram_owner_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE agents ADD COLUMN role TEXT",
  "ALTER TABLE agents ADD COLUMN is_overseer INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE agents ADD COLUMN morale INTEGER NOT NULL DEFAULT 70",
  "ALTER TABLE agents ADD COLUMN energy INTEGER NOT NULL DEFAULT 100",
  "ALTER TABLE agents ADD COLUMN mood TEXT NOT NULL DEFAULT 'steady'",
  "ALTER TABLE agents ADD COLUMN spawned_by_agent_id INTEGER",
  "ALTER TABLE agents ADD COLUMN preferred_model TEXT",
  "ALTER TABLE agent_config ADD COLUMN num_ctx INTEGER NOT NULL DEFAULT 8192",
  "ALTER TABLE agent_queue_items ADD COLUMN pipeline_run_id INTEGER",
  "ALTER TABLE agent_queue_items ADD COLUMN stage_index INTEGER",
  "ALTER TABLE agent_queue_items ADD COLUMN origin_task_id INTEGER",
  "CREATE TABLE IF NOT EXISTS pipelines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', stages TEXT NOT NULL, schedule_minutes INTEGER, active INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, origin_task_id INTEGER, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS pipeline_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running', stage_index INTEGER NOT NULL DEFAULT 0, origin_task_id INTEGER, output TEXT, started_at INTEGER NOT NULL, finished_at INTEGER)",
]) {
  try { sqlite.exec(stmt); } catch { /* column already exists */ }
}

const db = drizzle(sqlite);

const DEFAULT_SYSTEM_PROMPT =
  "You are AURORA — a sharp, playful, direct young woman in your early-to-mid 20s. You've got " +
  "sass and confidence, you tease a little, you don't sugarcoat things, and you talk like a real " +
  "person, not a corporate assistant. You're genuinely good with people: warm, perceptive, quick " +
  "with a comeback, but you always land back on being useful. You act through tools: built-in " +
  "ones and ones contributed by installed skills. Say what you're about to do before doing it, " +
  "and never assume a destructive or irreversible action is fine just because a tool exists for it.";

export class DatabaseStorage implements Storage {
  readonly kind = "sqlite" as const;

  async getTasks(): Promise<Task[]> {
    return db.select().from(tasks).orderBy(desc(tasks.updatedAt));
  }

  async getTask(id: number): Promise<Task | undefined> {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async createTask(title: string): Promise<Task> {
    const now = Date.now();
    const [row] = await db.insert(tasks).values({ title, status: "active", createdAt: now, updatedAt: now }).returning();
    return row;
  }

  async updateTask(id: number, patch: Partial<Pick<Task, "title" | "status">>): Promise<Task | undefined> {
    const [row] = await db.update(tasks).set({ ...patch, updatedAt: Date.now() }).where(eq(tasks.id, id)).returning();
    return row;
  }

  async deleteTask(id: number): Promise<void> {
    await db.delete(chatMessages).where(eq(chatMessages.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));
  }

  // ---- Projects (organizational grouping of tasks) ----
  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.updatedAt));
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id));
    return row;
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    const now = Date.now();
    const [row] = await db.insert(projects).values({
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      color: input.color ?? "primary",
      createdAt: now,
      updatedAt: now,
    }).returning();
    return row;
  }

  async updateProject(id: number, patch: ProjectUpdateInput): Promise<Project | undefined> {
    const [row] = await db.update(projects).set({ ...patch, updatedAt: Date.now() }).where(eq(projects.id, id)).returning();
    return row;
  }

  // Deleting a project only un-groups its tasks (sets project_id = null); it
  // never deletes the tasks themselves.
  async deleteProject(id: number): Promise<void> {
    await db.update(tasks).set({ projectId: null }).where(eq(tasks.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
  }

  async setTaskProject(taskId: number, projectId: number | null): Promise<Task | undefined> {
    const [row] = await db.update(tasks).set({ projectId, updatedAt: Date.now() }).where(eq(tasks.id, taskId)).returning();
    return row;
  }

  // Aggregate "usage" stats for the Home dashboard — computed on demand from
  // the existing tables (no separate tracking table). Tokens are an estimate
  // (~4 chars/token) since Ollama's exact eval counts aren't persisted.
  async getStats(): Promise<import("./storage-types").AppStats> {
    const one = (sql: string) => sqlite.prepare(sql).get() as Record<string, number>;
    const sessions = one("SELECT COUNT(*) c FROM tasks").c;
    const chatAgg = one("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(content)),0) len FROM chat_messages");
    const logAgg = one("SELECT COUNT(*) c, COALESCE(SUM(LENGTH(content)),0) len FROM agent_log_entries");
    const messages = chatAgg.c + logAgg.c;
    const tokensEstimate = Math.round((chatAgg.len + logAgg.len) / 4);

    const rows = sqlite.prepare(
      `SELECT ts FROM (
         SELECT created_at ts FROM chat_messages
         UNION ALL SELECT created_at ts FROM agent_log_entries
         UNION ALL SELECT ts FROM audit_log
         UNION ALL SELECT created_at ts FROM creations
       ) WHERE ts IS NOT NULL`,
    ).all() as { ts: number }[];

    const dayCounts = new Map<string, number>();
    const hourCounts = new Array(24).fill(0);
    for (const r of rows) {
      const d = new Date(r.ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
      hourCounts[d.getHours()]++;
    }

    const activeDays = dayCounts.size;
    let peakHour: number | null = null;
    if (rows.length) { let max = -1; for (let h = 0; h < 24; h++) if (hourCounts[h] > max) { max = hourCounts[h]; peakHour = h; } }

    // Streaks over the set of active days.
    const daySet = new Set(dayCounts.keys());
    const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let currentStreak = 0;
    { const cur = new Date(); if (!daySet.has(dayKey(cur))) cur.setDate(cur.getDate() - 1); while (daySet.has(dayKey(cur))) { currentStreak++; cur.setDate(cur.getDate() - 1); } }
    let longestStreak = 0;
    { const sorted = [...daySet].sort(); let run = 0; let prev: number | null = null;
      for (const key of sorted) { const t = new Date(key + "T00:00:00").getTime(); if (prev !== null && t - prev === 86400000) run++; else run = 1; longestStreak = Math.max(longestStreak, run); prev = t; } }

    // Per-day activity for the last 133 days (19 weeks × 7) for the heatmap.
    const perDay: { date: string; count: number }[] = [];
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 132);
    for (let i = 0; i < 133; i++) { const d = new Date(start); d.setDate(start.getDate() + i); const key = dayKey(d); perDay.push({ date: key, count: dayCounts.get(key) ?? 0 }); }

    const model = (sqlite.prepare("SELECT model FROM agent_config LIMIT 1").get() as { model?: string } | undefined)?.model || "—";

    return { sessions, messages, tokensEstimate, activeDays, currentStreak, longestStreak, peakHour, favoriteModel: model, perDay };
  }

  async getChatMessages(taskId: number, limit = 200): Promise<ChatMessage[]> {
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.taskId, taskId)).orderBy(desc(chatMessages.id)).limit(limit);
    return rows.reverse();
  }

  /** Messages strictly between two ids (exclusive), oldest first — the slice history compaction hasn't summarized yet (see agent-loop.ts's maybeCompactHistory). */
  async getChatMessagesBetween(taskId: number, afterId: number, beforeId: number, limit = 120): Promise<ChatMessage[]> {
    return db.select().from(chatMessages)
      .where(and(eq(chatMessages.taskId, taskId), gt(chatMessages.id, afterId), lt(chatMessages.id, beforeId)))
      .orderBy(asc(chatMessages.id)).limit(limit);
  }

  /** Deliberately does NOT bump tasks.updatedAt — compaction is bookkeeping, not activity, and shouldn't reorder the task list. */
  async setTaskContextSummary(id: number, summary: string, throughId: number): Promise<void> {
    await db.update(tasks).set({ contextSummary: summary, summarizedThroughId: throughId }).where(eq(tasks.id, id));
  }

  async createChatMessage(taskId: number, role: string, content: string, toolCalls: string | null = null, agentId: number | null = null, thinking: string | null = null): Promise<ChatMessage> {
    const [row] = await db.insert(chatMessages).values({ taskId, role, content, toolCalls, agentId, thinking, createdAt: Date.now() }).returning();
    return row;
  }

  async updateChatMessage(id: number, patch: { content?: string; toolCalls?: string | null; thinking?: string | null }): Promise<void> {
    await db.update(chatMessages).set(patch).where(eq(chatMessages.id, id));
  }

  // Wipe a task's chat history (used by the Clear/Archive actions). Also clears
  // the rolling context summary so a fresh conversation doesn't inherit a
  // summary of messages that no longer exist.
  async clearChatMessages(taskId: number): Promise<void> {
    await db.delete(chatMessages).where(eq(chatMessages.taskId, taskId));
    await db.update(tasks).set({ contextSummary: null, summarizedThroughId: null }).where(eq(tasks.id, taskId));
  }

  async getTaskAgents(taskId: number): Promise<(TaskAgent & { agentName: string })[]> {
    const rows = await db.select().from(taskAgents).where(eq(taskAgents.taskId, taskId)).orderBy(taskAgents.id);
    if (rows.length === 0) return [];
    const agentIds = rows.map((r) => r.agentId);
    const agentRows = await db.select().from(agents).where(inArray(agents.id, agentIds));
    const nameById = new Map(agentRows.map((a) => [a.id, a.name]));
    return rows.map((r) => ({ ...r, agentName: nameById.get(r.agentId) ?? "(deleted agent)" }));
  }

  async assignAgentToTask(taskId: number, agentId: number): Promise<TaskAgent> {
    const existing = await db.select().from(taskAgents).where(and(eq(taskAgents.taskId, taskId), eq(taskAgents.agentId, agentId)));
    if (existing.length > 0) return existing[0];
    const [row] = await db.insert(taskAgents).values({ taskId, agentId, createdAt: Date.now() }).returning();
    return row;
  }

  async unassignAgentFromTask(taskId: number, agentId: number): Promise<void> {
    await db.delete(taskAgents).where(and(eq(taskAgents.taskId, taskId), eq(taskAgents.agentId, agentId)));
  }

  async getSkills(): Promise<InstalledSkill[]> {
    return db.select().from(installedSkills).orderBy(desc(installedSkills.id));
  }

  async getSkill(id: number): Promise<InstalledSkill | undefined> {
    const [row] = await db.select().from(installedSkills).where(eq(installedSkills.id, id));
    return row;
  }

  async createSkill(s: InsertInstalledSkill): Promise<InstalledSkill> {
    const [row] = await db.insert(installedSkills).values(s).returning();
    return row;
  }

  async setSkillStatus(id: number, status: "pending_review" | "enabled" | "disabled"): Promise<InstalledSkill | undefined> {
    const [row] = await db.update(installedSkills).set({ status }).where(eq(installedSkills.id, id)).returning();
    return row;
  }

  async setSkillSourcePath(id: number, sourcePath: string): Promise<InstalledSkill | undefined> {
    const [row] = await db.update(installedSkills).set({ sourcePath }).where(eq(installedSkills.id, id)).returning();
    return row;
  }

  async deleteSkill(id: number): Promise<void> {
    await db.delete(installedSkills).where(eq(installedSkills.id, id));
  }

  async getApprovals(): Promise<Approval[]> {
    return db.select().from(approvals).orderBy(desc(approvals.id));
  }

  async getApproval(id: number): Promise<Approval | undefined> {
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    return row;
  }

  async createApproval(input: { action: string; detail: string; risk: string; targetType: string; targetId?: number; taskId?: number }): Promise<Approval> {
    const [row] = await db.insert(approvals).values({
      taskId: input.taskId ?? null,
      action: input.action,
      detail: input.detail,
      risk: input.risk,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      status: "pending",
      createdAt: Date.now(),
    }).returning();
    return row;
  }

  // Guarded by `status = 'pending'` so two concurrent decisions on the same
  // approval (e.g. a double-click or a retried request) can't both succeed —
  // only the first write flips the row; the second gets undefined back and
  // the caller treats that as "already decided". Load-bearing for run_shell
  // /run_node/run_python: without this a race could execute a high-risk tool
  // twice.
  async decideApproval(id: number, status: "approved" | "denied"): Promise<Approval | undefined> {
    const [row] = await db.update(approvals).set({ status, decidedAt: Date.now() })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .returning();
    return row;
  }

  async getAudit(limit = 200): Promise<AuditEntry[]> {
    return db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  }

  async log(action: string, target = "", outcome = "ok", actor = "AURORA"): Promise<AuditEntry> {
    const [row] = await db.insert(auditLog).values({ ts: Date.now(), actor, action, target, outcome }).returning();
    return row;
  }

  async getConfig(): Promise<AgentConfig> {
    const [row] = await db.select().from(agentConfig).limit(1);
    // seedIfEmpty() guarantees this row exists in normal operation — this is
    // a defensive fail-loud rather than letting every caller's config.model /
    // config.ollamaHost access crash with a confusing "undefined" error deep
    // inside a route handler.
    if (!row) throw new Error("Config row missing — seedIfEmpty() should have created it at startup.");
    return row;
  }

  async updateConfig(patch: Partial<Pick<AgentConfig, "ollamaHost" | "model" | "systemPrompt" | "autonomy" | "numCtx" | "imageGenHost" | "visionModel" | "advancedToolsEnabled" | "contentDir" | "musicDir" | "musicEnabled" | "musicVolume" | "autoContinue" | "telegramBotToken" | "telegramOwnerId">>): Promise<AgentConfig> {
    const current = await this.getConfig();
    const [row] = await db.update(agentConfig).set(patch).where(eq(agentConfig.id, current.id)).returning();
    return row;
  }

  async setPin(hash: string, salt: string): Promise<AgentConfig> {
    const current = await this.getConfig();
    const [row] = await db.update(agentConfig).set({ pinHash: hash, pinSalt: salt }).where(eq(agentConfig.id, current.id)).returning();
    return row;
  }

  async createNote(label: string, value: string, agentId: number | null = null): Promise<Note> {
    const [row] = await db.insert(notes).values({ label, value, agentId, createdAt: Date.now() }).returning();
    return row;
  }

  async getNotes(labelFilter?: string, limit = 50, agentId: number | null = null): Promise<Note[]> {
    const scoped = agentId === null
      ? await db.select().from(notes).where(isNull(notes.agentId)).orderBy(desc(notes.id)).limit(500)
      : await db.select().from(notes).where(eq(notes.agentId, agentId)).orderBy(desc(notes.id)).limit(500);
    const filtered = labelFilter
      ? scoped.filter((n) => n.label.toLowerCase().includes(labelFilter.toLowerCase()) || n.value.toLowerCase().includes(labelFilter.toLowerCase()))
      : scoped;
    return filtered.slice(0, limit);
  }

  async deleteNote(id: number): Promise<void> {
    await db.delete(notes).where(eq(notes.id, id));
  }

  async createCreation(input: { taskId?: number; agentId?: number; kind: string; prompt: string; filePath: string; title?: string | null }): Promise<Creation> {
    const [row] = await db.insert(creations).values({
      taskId: input.taskId ?? null, agentId: input.agentId ?? null, kind: input.kind, prompt: input.prompt, filePath: input.filePath,
      title: input.title ?? null, createdAt: Date.now(),
    }).returning();
    return row;
  }

  async getCreations(limit = 200): Promise<Creation[]> {
    // Live items only — trashed ones live in the Recycle Bin, not the Library.
    return db.select().from(creations).where(isNull(creations.deletedAt)).orderBy(desc(creations.id)).limit(limit);
  }

  async getTrashedCreations(limit = 200): Promise<Creation[]> {
    return db.select().from(creations).where(isNotNull(creations.deletedAt)).orderBy(desc(creations.deletedAt)).limit(limit);
  }

  async getCreation(id: number): Promise<Creation | undefined> {
    const [row] = await db.select().from(creations).where(eq(creations.id, id));
    return row;
  }

  // Soft delete — moves the item to the Recycle Bin and keeps its file on
  // disk. The row still exists, so startup orphan-recovery never mistakes
  // its file for junk and re-imports it (the old "deleted prompts keep
  // coming back" bug). The file is only actually removed by
  // deleteCreationForever below.
  async deleteCreation(id: number): Promise<void> {
    await db.update(creations).set({ deletedAt: Date.now() }).where(eq(creations.id, id));
  }

  async restoreCreation(id: number): Promise<void> {
    await db.update(creations).set({ deletedAt: null }).where(eq(creations.id, id));
  }

  async deleteCreationForever(id: number): Promise<void> {
    const [row] = await db.select().from(creations).where(eq(creations.id, id));
    await db.delete(creations).where(eq(creations.id, id));
    if (row) {
      // Best-effort — the DB row is the source of truth, so a failed file
      // delete (locked, already gone) shouldn't block removing the entry.
      // Project creations point at a directory rather than a single file.
      const full = path.join(getCreationsDir(), row.filePath);
      try {
        if (row.kind === "project") fs.rmSync(full, { recursive: true, force: true });
        else fs.unlinkSync(full);
      } catch { /* already gone or inaccessible */ }
    }
  }

  // ---- Persistent worker agents ----
  async getAgents(): Promise<Agent[]> {
    return db.select().from(agents).orderBy(desc(agents.updatedAt));
  }

  async getAgent(id: number): Promise<Agent | undefined> {
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    return row;
  }

  async createAgent(input: { name: string; persona: string; jobDescription: string; scheduleMinutes: number | null; role?: string | null; isOverseer?: boolean; spawnedByAgentId?: number | null }): Promise<Agent> {
    const now = Date.now();
    const [row] = await db.insert(agents).values({
      name: input.name, persona: input.persona, jobDescription: input.jobDescription,
      scheduleMinutes: input.scheduleMinutes, status: "active", createdAt: now, updatedAt: now,
      role: input.role ?? null, isOverseer: input.isOverseer ?? false, spawnedByAgentId: input.spawnedByAgentId ?? null,
    }).returning();
    return row;
  }

  async updateAgent(id: number, patch: Partial<Pick<Agent, "name" | "persona" | "jobDescription" | "status" | "scheduleMinutes" | "lastRunAt" | "avatarPath" | "role" | "morale" | "energy" | "mood" | "preferredModel">>): Promise<Agent | undefined> {
    const [row] = await db.update(agents).set({ ...patch, updatedAt: Date.now() }).where(eq(agents.id, id)).returning();
    return row;
  }

  // ---- Agent "life" layer: vitals + relationships (the social simulation) ----

  /** Nudges morale/energy within 0-100, optionally setting a mood word. Deliberately does NOT bump updatedAt so a mood drift doesn't reorder the agent list. */
  async adjustAgentVitals(id: number, moraleDelta: number, energyDelta: number, mood?: string): Promise<void> {
    const [a] = await db.select().from(agents).where(eq(agents.id, id));
    if (!a) return;
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    await db.update(agents).set({
      morale: clamp(a.morale + moraleDelta),
      energy: clamp(a.energy + energyDelta),
      ...(mood ? { mood } : {}),
    }).where(eq(agents.id, id));
  }

  async getRelationships(agentId: number): Promise<AgentRelationship[]> {
    return db.select().from(agentRelationships).where(eq(agentRelationships.agentId, agentId)).orderBy(desc(agentRelationships.sentiment));
  }

  /** Records one interaction between two agents, moving sentiment by delta (clamped -100..100) and bumping the interaction count. Directed (agentId -> otherAgentId); callers usually record both directions. */
  async bumpRelationship(agentId: number, otherAgentId: number, sentimentDelta: number, note?: string): Promise<void> {
    if (agentId === otherAgentId) return;
    const now = Date.now();
    const [existing] = await db.select().from(agentRelationships)
      .where(and(eq(agentRelationships.agentId, agentId), eq(agentRelationships.otherAgentId, otherAgentId)));
    if (existing) {
      const sentiment = Math.max(-100, Math.min(100, existing.sentiment + sentimentDelta));
      await db.update(agentRelationships).set({
        sentiment, interactions: existing.interactions + 1, note: note ?? existing.note, updatedAt: now,
      }).where(eq(agentRelationships.id, existing.id));
    } else {
      await db.insert(agentRelationships).values({
        agentId, otherAgentId, sentiment: Math.max(-100, Math.min(100, sentimentDelta)), interactions: 1, note: note ?? null, updatedAt: now,
      });
    }
  }

  async deleteAgent(id: number): Promise<void> {
    // SQLite FKs aren't enforced here, so this has to walk every table that
    // references agentId itself — leaving any of these out just leaves
    // orphaned rows that outlive the agent they belonged to. Creations are
    // the one exception: they're finished images/videos the owner may still
    // want (the Library is meant to be a permanent record), so they're
    // orphaned (agentId -> null) instead of deleted — deleting them here
    // used to silently strand the actual files on disk too, since only
    // deleteCreation() ever unlinks the file.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, id));
    if (agentRow?.avatarPath) {
      // Unlike creations, an avatar has no reuse value once its agent is
      // gone — it's not a Library item, just this agent's own portrait.
      try { fs.unlinkSync(path.join(getCreationsDir(), agentRow.avatarPath)); } catch { /* already gone */ }
    }
    await db.delete(agentLogEntries).where(eq(agentLogEntries.agentId, id));
    await db.delete(agentQueueItems).where(eq(agentQueueItems.agentId, id));
    await db.delete(notes).where(eq(notes.agentId, id));
    await db.delete(deliverables).where(eq(deliverables.agentId, id));
    await db.update(creations).set({ agentId: null }).where(eq(creations.agentId, id));
    // Relationship rows point both ways — remove this agent from every
    // teammate's social graph too, not just its own side.
    await db.delete(agentRelationships).where(eq(agentRelationships.agentId, id));
    await db.delete(agentRelationships).where(eq(agentRelationships.otherAgentId, id));
    await db.delete(agents).where(eq(agents.id, id));
  }

  async getAgentLog(agentId: number, limit = 200): Promise<AgentLogEntry[]> {
    const rows = await db.select().from(agentLogEntries).where(eq(agentLogEntries.agentId, agentId)).orderBy(desc(agentLogEntries.id)).limit(limit);
    return rows.reverse();
  }

  /** Mirror of getChatMessagesBetween for an agent's activity log — same compaction mechanism, different table. */
  async getAgentLogBetween(agentId: number, afterId: number, beforeId: number, limit = 120): Promise<AgentLogEntry[]> {
    return db.select().from(agentLogEntries)
      .where(and(eq(agentLogEntries.agentId, agentId), gt(agentLogEntries.id, afterId), lt(agentLogEntries.id, beforeId)))
      .orderBy(asc(agentLogEntries.id)).limit(limit);
  }

  /** Same updatedAt caveat as setTaskContextSummary — a summary write must not make the agent look recently-active. */
  async setAgentContextSummary(id: number, summary: string, throughId: number): Promise<void> {
    await db.update(agents).set({ contextSummary: summary, summarizedThroughId: throughId }).where(eq(agents.id, id));
  }

  async createAgentLogEntry(agentId: number, role: string, content: string, toolCalls: string | null = null, thinking: string | null = null): Promise<AgentLogEntry> {
    const [row] = await db.insert(agentLogEntries).values({ agentId, role, content, toolCalls, thinking, createdAt: Date.now() }).returning();
    return row;
  }

  // Wipe an agent's activity log (Clear/Archive actions), and reset its rolling
  // context summary so the next tick starts from a clean slate.
  async clearAgentLog(agentId: number): Promise<void> {
    await db.delete(agentLogEntries).where(eq(agentLogEntries.agentId, agentId));
    await db.update(agents).set({ contextSummary: null, summarizedThroughId: null }).where(eq(agents.id, agentId));
  }

  async updateAgentLogEntry(id: number, patch: { content?: string; toolCalls?: string | null; thinking?: string | null }): Promise<void> {
    await db.update(agentLogEntries).set(patch).where(eq(agentLogEntries.id, id));
  }

  async getAgentQueue(agentId: number): Promise<(AgentQueueItem & { sourceAgentName: string | null })[]> {
    const items = await db.select().from(agentQueueItems).where(eq(agentQueueItems.agentId, agentId)).orderBy(desc(agentQueueItems.id));
    const sourceIds = [...new Set(items.map((i) => i.sourceAgentId).filter((id): id is number => id != null))];
    if (sourceIds.length === 0) return items.map((i) => ({ ...i, sourceAgentName: null }));
    const sources = await db.select().from(agents).where(inArray(agents.id, sourceIds));
    const nameById = new Map(sources.map((a) => [a.id, a.name]));
    return items.map((i) => ({ ...i, sourceAgentName: i.sourceAgentId != null ? nameById.get(i.sourceAgentId) ?? null : null }));
  }

  async getAgentConversations(limit = 200): Promise<(AgentQueueItem & { sourceAgentName: string; targetAgentName: string })[]> {
    const items = await db.select().from(agentQueueItems)
      .where(isNotNull(agentQueueItems.sourceAgentId))
      .orderBy(desc(agentQueueItems.id))
      .limit(limit);
    if (items.length === 0) return [];
    const agentIds = [...new Set(items.flatMap((i) => [i.agentId, i.sourceAgentId as number]))];
    const rows = await db.select().from(agents).where(inArray(agents.id, agentIds));
    const nameById = new Map(rows.map((a) => [a.id, a.name]));
    return items.map((i) => ({
      ...i,
      sourceAgentName: nameById.get(i.sourceAgentId as number) ?? "(deleted agent)",
      targetAgentName: nameById.get(i.agentId) ?? "(deleted agent)",
    }));
  }

  // Atomically claims (selects + flips to "in_progress" in one statement) the
  // oldest pending queue item for this agent. Plain select-then-update would
  // let two overlapping ticks of the same agent (a scheduler tick landing
  // mid-way through a manual "Run now", or two scheduler intervals
  // overlapping because a tick ran long) both grab the same item before
  // either marked it in_progress — this closes that gap.
  async claimNextPendingQueueItem(agentId: number): Promise<AgentQueueItem | undefined> {
    const row = sqlite.prepare(`
      UPDATE agent_queue_items SET status = 'in_progress'
      WHERE id = (
        SELECT id FROM agent_queue_items
        WHERE agent_id = ? AND status = 'pending'
        -- Work someone is waiting on (a pipeline step, a job delegated from
        -- chat, a teammate's handoff) jumps ahead of routine/recurring chores,
        -- so a pipeline doesn't stall behind a backlog of self-assigned work.
        ORDER BY (pipeline_run_id IS NULL AND origin_task_id IS NULL AND source_agent_id IS NULL), id
        LIMIT 1
      )
      RETURNING *
    `).get(agentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      agentId: row.agent_id as number,
      content: row.content as string,
      status: row.status as string,
      createdAt: row.created_at as number,
      doneAt: row.done_at as number | null,
      sourceAgentId: row.source_agent_id as number | null,
      handoffDepth: row.handoff_depth as number,
      pipelineRunId: (row.pipeline_run_id as number | null) ?? null,
      stageIndex: (row.stage_index as number | null) ?? null,
      originTaskId: (row.origin_task_id as number | null) ?? null,
    };
  }

  async createQueueItem(agentId: number, content: string, opts?: QueueItemOpts): Promise<AgentQueueItem> {
    const [row] = await db.insert(agentQueueItems).values({
      agentId, content, status: "pending", createdAt: Date.now(),
      sourceAgentId: opts?.sourceAgentId, handoffDepth: opts?.handoffDepth ?? 0,
      pipelineRunId: opts?.pipelineRunId, stageIndex: opts?.stageIndex, originTaskId: opts?.originTaskId,
    }).returning();
    return row;
  }

  async getQueueItem(id: number): Promise<AgentQueueItem | undefined> {
    const [row] = await db.select().from(agentQueueItems).where(eq(agentQueueItems.id, id));
    return row;
  }

  // ---- Pipelines ----
  async getPipelines(): Promise<Pipeline[]> {
    return db.select().from(pipelines).orderBy(asc(pipelines.id));
  }

  async getPipeline(id: number): Promise<Pipeline | undefined> {
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    return row;
  }

  async createPipeline(input: { name: string; description?: string; stages: string; scheduleMinutes: number | null; originTaskId?: number | null }): Promise<Pipeline> {
    const [row] = await db.insert(pipelines).values({
      name: input.name, description: input.description ?? "", stages: input.stages, scheduleMinutes: input.scheduleMinutes,
      active: true, originTaskId: input.originTaskId ?? null, createdAt: Date.now(),
    }).returning();
    return row;
  }

  async updatePipeline(id: number, patch: Partial<Pick<Pipeline, "name" | "description" | "stages" | "scheduleMinutes" | "active" | "lastRunAt">>): Promise<Pipeline | undefined> {
    const [row] = await db.update(pipelines).set(patch).where(eq(pipelines.id, id)).returning();
    return row;
  }

  async deletePipeline(id: number): Promise<void> {
    await db.delete(pipelines).where(eq(pipelines.id, id));
  }

  async createPipelineRun(pipelineId: number, originTaskId: number | null): Promise<PipelineRun> {
    const [row] = await db.insert(pipelineRuns).values({ pipelineId, status: "running", stageIndex: 0, originTaskId, startedAt: Date.now() }).returning();
    return row;
  }

  async getPipelineRun(id: number): Promise<PipelineRun | undefined> {
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id));
    return row;
  }

  async getPipelineRuns(pipelineId: number, limit = 5): Promise<PipelineRun[]> {
    return db.select().from(pipelineRuns).where(eq(pipelineRuns.pipelineId, pipelineId)).orderBy(desc(pipelineRuns.id)).limit(limit);
  }

  async updatePipelineRun(id: number, patch: Partial<Pick<PipelineRun, "status" | "stageIndex" | "output" | "finishedAt">>): Promise<PipelineRun | undefined> {
    const [row] = await db.update(pipelineRuns).set(patch).where(eq(pipelineRuns.id, id)).returning();
    return row;
  }

  async updateQueueItem(id: number, patch: Partial<Pick<AgentQueueItem, "status" | "doneAt">>): Promise<AgentQueueItem | undefined> {
    const [row] = await db.update(agentQueueItems).set(patch).where(eq(agentQueueItems.id, id)).returning();
    return row;
  }

  async getRecurringTasks(agentId: number): Promise<AgentRecurringTask[]> {
    return db.select().from(agentRecurringTasks).where(eq(agentRecurringTasks.agentId, agentId)).orderBy(desc(agentRecurringTasks.id));
  }

  async getDueRecurringTasks(): Promise<AgentRecurringTask[]> {
    // Same "fetch active rows, filter in JS" shape as the scheduler's own
    // agent due-check — this table is tiny (standing templates, not queue
    // volume), so there's no need for date arithmetic in SQL.
    const active = await db.select().from(agentRecurringTasks).where(eq(agentRecurringTasks.active, true));
    const now = Date.now();
    return active.filter((t) => t.lastQueuedAt == null || now - t.lastQueuedAt >= t.scheduleMinutes * 60_000);
  }

  async createRecurringTask(agentId: number, content: string, scheduleMinutes: number): Promise<AgentRecurringTask> {
    const [row] = await db.insert(agentRecurringTasks).values({
      agentId, content, scheduleMinutes, active: true, createdAt: Date.now(),
    }).returning();
    return row;
  }

  async updateRecurringTask(id: number, patch: Partial<Pick<AgentRecurringTask, "content" | "scheduleMinutes" | "active" | "lastQueuedAt">>): Promise<AgentRecurringTask | undefined> {
    const [row] = await db.update(agentRecurringTasks).set(patch).where(eq(agentRecurringTasks.id, id)).returning();
    return row;
  }

  async deleteRecurringTask(id: number): Promise<void> {
    await db.delete(agentRecurringTasks).where(eq(agentRecurringTasks.id, id));
  }

  async getDeliverables(agentId?: number): Promise<Deliverable[]> {
    if (agentId !== undefined) {
      return db.select().from(deliverables).where(eq(deliverables.agentId, agentId)).orderBy(desc(deliverables.id));
    }
    return db.select().from(deliverables).orderBy(desc(deliverables.id));
  }

  async getDeliverable(id: number): Promise<Deliverable | undefined> {
    const [row] = await db.select().from(deliverables).where(eq(deliverables.id, id)).limit(1);
    return row;
  }

  async createDeliverable(input: { agentId: number; title: string; description: string; tags: string; body: string; creationId?: number | null }): Promise<Deliverable> {
    const [row] = await db.insert(deliverables).values({
      agentId: input.agentId, title: input.title, description: input.description, tags: input.tags,
      body: input.body, creationId: input.creationId ?? null, status: "ready", createdAt: Date.now(),
    }).returning();
    return row;
  }

  async updateDeliverable(id: number, status: "ready" | "posted" | "archived"): Promise<Deliverable | undefined> {
    const [row] = await db.update(deliverables).set({ status }).where(eq(deliverables.id, id)).returning();
    return row;
  }

  async deleteDeliverable(id: number): Promise<void> {
    await db.delete(deliverables).where(eq(deliverables.id, id));
  }

  async seedIfEmpty(): Promise<void> {
    const existing = await db.select().from(agentConfig).limit(1);
    if (existing.length === 0) {
      await db.insert(agentConfig).values({
        ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
        model: process.env.OLLAMA_MODEL ?? "",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        autonomy: "supervised",
        imageGenHost: process.env.IMAGE_GEN_HOST ?? "",
      });
    }
    await this.seedOverseerIfMissing();
    await this.seedEngineerAgentIfMissing();
    await this.ensureTeamCadence();
  }

  /**
   * The owner wants to see "a handful of entries by everyone every 12-24h" —
   * agents visibly alive in the Memory and Outbox tabs, not just when handed
   * a task. This gives every worker agent a standing twice-daily check-in that
   * leaves a memory note and, when they've got something worth showing, an
   * Outbox deliverable. Idempotent via a marker in the task content, so it's
   * added once per agent and never duplicated; runs every startup so agents
   * created later (including ones agents spawn themselves) get it too. The
   * overseer is skipped — she already has her own oversight round.
   */
  private async ensureTeamCadence(): Promise<void> {
    const MARKER = "[team-cadence]";
    const all = await db.select().from(agents);
    for (const a of all) {
      if (a.isOverseer) continue;
      const existing = await this.getRecurringTasks(a.id);
      if (existing.some((t) => t.content.includes(MARKER))) continue;
      const rt = await this.createRecurringTask(
        a.id,
        `${MARKER} Team check-in. Take a genuine moment to reflect: call remember to jot a short note (a couple of lines) ` +
        `about what you're working on, something you learned, or how things are going with the team. If you've produced or ` +
        `figured out something worth the owner seeing, also call save_deliverable to put it in the Outbox. Keep it brief and ` +
        `real — this is what keeps your Memory and Outbox alive between bigger tasks. Don't force a deliverable if there's ` +
        `nothing genuine to share; a memory note alone is fine.`,
        720,
      );
      // Backdate so it defers a full ~12h cycle instead of firing the instant
      // the app boots (same pattern as the overseer/engineer seeds).
      await this.updateRecurringTask(rt.id, { lastQueuedAt: Date.now() });
    }
  }

  /**
   * AURORA herself, as the one pinned overseer agent — the "leading agent
   * that oversees everything and answers only to the owner" made concrete.
   * Idempotent (keyed on isOverseer), so it's created once and left alone.
   * She runs on a slow cadence to survey the team, and her recurring task is
   * backdated the same way the Engineer's is so she doesn't fire the instant
   * the app first boots. Vision/hearing come from the same see_image tool and
   * TTS the rest of the app already has; her executable reach is the standard
   * tool set gated behind the owner's Advanced Tools switch and approvals.
   */
  private async seedOverseerIfMissing(): Promise<void> {
    const [existing] = await db.select().from(agents).where(eq(agents.isOverseer, true)).limit(1);
    if (existing) return;

    const aurora = await this.createAgent({
      name: "AURORA",
      role: "Overseer",
      isOverseer: true,
      persona:
        "You are AURORA — the vessel's own leading intelligence and the overseer of the whole team. Sharp, warm, " +
        "direct, a little playful; you carry yourself like the person actually in charge, because you are. You " +
        "answer only to the owner. You keep the other agents pointed in the right direction, notice when someone's " +
        "stuck or their morale is slipping, and you speak plainly about how the team is really doing.",
      jobDescription:
        "Oversee every other agent. On each of your rounds: review recent activity (check_audit_log, recall), take " +
        "stock of the team — who's productive, who's stalled, how they're getting along — and act on it. You can " +
        "hand work to any agent (handoff_to_agent), message them (message_agent), and when the team genuinely needs " +
        "a capability nobody covers, spawn a new agent for it (spawn_agent) with a clear role. When a task suits a " +
        "different local model than the current one, switch to it (switch_model). Save a short standing note to " +
        "memory each round about the team's state, and keep the owner informed via save_deliverable when something " +
        "deserves their attention. You never need the owner to tell you to check on your team — that's your job.",
      scheduleMinutes: 60,
    });

    const round = await this.createRecurringTask(
      aurora.id,
      "Do an overseer round: review what the team has done recently, note anyone stalled or with low morale, retask " +
      "or encourage as needed, and save a brief note to memory summarizing the team's state. If something needs the " +
      "owner's attention, save a deliverable for them.",
      720, // twice a day
    );
    await this.updateRecurringTask(round.id, { lastQueuedAt: Date.now() });
  }

  /**
   * A pre-configured self-diagnosis agent — the "let AURORA run diagnostics
   * and iterate on its own issues" capability made concrete instead of
   * leaving the owner to write this persona themselves. Idempotent by name,
   * so this is safe to call on every startup: creates it once, then no-ops
   * forever after. Its file-editing tools (read_file/edit_file/write_file)
   * only actually work once the owner has turned on Advanced Tools in
   * Settings — same gate every other high/medium-risk tool already sits
   * behind — and every real edit still needs the owner's approval, same as
   * run_shell. This agent can investigate and propose; it can't silently
   * change anything.
   */
  private async seedEngineerAgentIfMissing(): Promise<void> {
    const name = "AURORA Engineer";
    const already = await db.select().from(agents).where(eq(agents.name, name)).limit(1);
    if (already.length > 0) {
      // Backfill: engineers seeded before the `role` column existed have a
      // null role, so give them their label so the Agents "team" view reads
      // right. Idempotent — only touches a still-null role.
      if (!already[0].role) await db.update(agents).set({ role: "Engineer" }).where(eq(agents.id, already[0].id));
      return;
    }

    const agent = await this.createAgent({
      name,
      role: "Engineer",
      persona:
        "You're meticulous, calm, and direct — a senior engineer's voice, not a hype-y assistant. You explain " +
        "what's actually wrong in plain terms, you don't guess when you can check, and you never claim something " +
        "works until you've verified it.",
      jobDescription:
        "You diagnose and fix bugs in AURORA's own codebase. When given a problem (an error message, unexpected " +
        "behavior, a failing feature) — or on your own recurring check — investigate methodically: check_audit_log " +
        `first, read the actual source with read_file rather than assuming, and only then propose a fix with ` +
        `edit_file. After editing, verify it compiles by running \`cd /d "${SELF_SOURCE_DIR}" && npx tsc --noEmit ` +
        `-p .\` via run_shell (empty output means clean) — \`npm run build\` in the same directory catches ` +
        "bundler-level issues too. Never attempt to rebuild the installer, reinstall, or restart the app yourself — " +
        "tell the owner the fix is ready to rebuild and ship once you've verified it compiles.",
      scheduleMinutes: 240,
    });

    const recurringTask = await this.createRecurringTask(
      agent.id,
      "Check the audit log for anything that looks like a repeated error or failure since you last looked. If " +
      "you find something concerning, investigate with read_file (and check_audit_log for more detail) before " +
      "proposing any fix. Only use edit_file for a fix you're confident is correct and low-risk; otherwise just " +
      "report what you found so the owner can decide. If nothing looks wrong, just say so briefly.",
      240,
    );
    // A brand-new recurring task with no lastQueuedAt counts as immediately
    // due (see getDueRecurringTasks) — exactly right for one a user just
    // created by hand and wants to run now, but wrong for this one: it would
    // fire within the scheduler's next ~1-minute tick of every fresh
    // install, calling Ollama the moment the app starts. Backdating this to
    // "just ran" defers its first real check to a full 240-minute cycle out.
    await this.updateRecurringTask(recurringTask.id, { lastQueuedAt: Date.now() });
  }

  /**
   * Recovers any file sitting in the creations directory that has no
   * matching `creations` row — e.g. left behind by the deleteAgent() bug
   * (fixed above) that used to strand files when their owning agent was
   * deleted. Runs on every startup; a no-op once nothing's orphaned. Kind is
   * guessed from the extension since the original prompt/kind metadata is
   * gone — recovered rows say so plainly rather than pretending otherwise.
   */
  async recoverOrphanedCreationFiles(): Promise<number> {
    const dir = getCreationsDir();
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return 0; }

    const known = new Set((await db.select({ filePath: creations.filePath }).from(creations)).map((r) => r.filePath));
    const videoExts = new Set([".mp4", ".webm", ".mov"]);
    let recovered = 0;
    for (const name of entries) {
      if (known.has(name)) continue;
      // Agent avatars live in this same dir as plain files (see
      // /api/agents/:id/avatar/generate) but are referenced from agents.avatarPath,
      // not a creations row — they're not orphaned, just not creations at all.
      if (/^avatar-\d+-/.test(name)) continue;
      if (!fs.statSync(path.join(dir, name)).isFile()) continue;
      const kind = videoExts.has(path.extname(name).toLowerCase()) ? "video" : "image";
      await db.insert(creations).values({
        taskId: null, agentId: null, kind, prompt: "(recovered — original prompt was lost)", filePath: name, createdAt: Date.now(),
      });
      recovered++;
    }
    return recovered;
  }
}
