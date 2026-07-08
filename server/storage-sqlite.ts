import {
  tasks, chatMessages, installedSkills, approvals, auditLog, agentConfig, notes, creations,
  agents, agentLogEntries, agentQueueItems, deliverables,
} from "@shared/schema";
import type {
  Task, ChatMessage, InstalledSkill, InsertInstalledSkill, Approval, AuditEntry, AgentConfig, Note, Creation,
  Agent, AgentLogEntry, AgentQueueItem, Deliverable,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, isNull, and } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import type { Storage } from "./storage-types";

const DB_PATH = process.env.AURORA_DB_PATH ?? path.resolve(process.cwd(), "data", "aurora.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS installed_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL, source_repo TEXT NOT NULL, source_ref TEXT NOT NULL, source_path TEXT NOT NULL, manifest TEXT NOT NULL, tools TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_review', risk_default TEXT NOT NULL DEFAULT 'medium', installed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL, risk TEXT NOT NULL DEFAULT 'high', status TEXT NOT NULL DEFAULT 'pending', target_type TEXT NOT NULL, target_id INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL DEFAULT 'AURORA', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT 'ok');
CREATE TABLE IF NOT EXISTS agent_config (id INTEGER PRIMARY KEY AUTOINCREMENT, ollama_host TEXT NOT NULL DEFAULT 'http://localhost:11434', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', autonomy TEXT NOT NULL DEFAULT 'supervised', image_gen_host TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER, label TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS creations (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, agent_id INTEGER, kind TEXT NOT NULL DEFAULT 'image', prompt TEXT NOT NULL, file_path TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, persona TEXT NOT NULL, job_description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', schedule_minutes INTEGER, last_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_log_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_queue_items (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, done_at INTEGER);
CREATE TABLE IF NOT EXISTS deliverables (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', body TEXT NOT NULL DEFAULT '', creation_id INTEGER, status TEXT NOT NULL DEFAULT 'ready', created_at INTEGER NOT NULL);
`);

// Columns added to pre-existing tables after their CREATE TABLE IF NOT EXISTS
// was already run on someone's DB — SQLite won't retroactively add these, so
// best-effort ALTER TABLE them in, same pattern as any other schema growth.
for (const stmt of [
  "ALTER TABLE notes ADD COLUMN agent_id INTEGER",
  "ALTER TABLE creations ADD COLUMN agent_id INTEGER",
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

  async getChatMessages(taskId: number, limit = 200): Promise<ChatMessage[]> {
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.taskId, taskId)).orderBy(desc(chatMessages.id)).limit(limit);
    return rows.reverse();
  }

  async createChatMessage(taskId: number, role: string, content: string, toolCalls: string | null = null): Promise<ChatMessage> {
    const [row] = await db.insert(chatMessages).values({ taskId, role, content, toolCalls, createdAt: Date.now() }).returning();
    return row;
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

  async updateConfig(patch: Partial<Pick<AgentConfig, "ollamaHost" | "model" | "systemPrompt" | "autonomy" | "imageGenHost">>): Promise<AgentConfig> {
    const current = await this.getConfig();
    const [row] = await db.update(agentConfig).set(patch).where(eq(agentConfig.id, current.id)).returning();
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

  async createCreation(input: { taskId?: number; agentId?: number; kind: string; prompt: string; filePath: string }): Promise<Creation> {
    const [row] = await db.insert(creations).values({
      taskId: input.taskId ?? null, agentId: input.agentId ?? null, kind: input.kind, prompt: input.prompt, filePath: input.filePath, createdAt: Date.now(),
    }).returning();
    return row;
  }

  async getCreations(limit = 200): Promise<Creation[]> {
    return db.select().from(creations).orderBy(desc(creations.id)).limit(limit);
  }

  // ---- Persistent worker agents ----
  async getAgents(): Promise<Agent[]> {
    return db.select().from(agents).orderBy(desc(agents.updatedAt));
  }

  async getAgent(id: number): Promise<Agent | undefined> {
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    return row;
  }

  async createAgent(input: { name: string; persona: string; jobDescription: string; scheduleMinutes: number | null }): Promise<Agent> {
    const now = Date.now();
    const [row] = await db.insert(agents).values({
      name: input.name, persona: input.persona, jobDescription: input.jobDescription,
      scheduleMinutes: input.scheduleMinutes, status: "active", createdAt: now, updatedAt: now,
    }).returning();
    return row;
  }

  async updateAgent(id: number, patch: Partial<Pick<Agent, "name" | "persona" | "jobDescription" | "status" | "scheduleMinutes" | "lastRunAt">>): Promise<Agent | undefined> {
    const [row] = await db.update(agents).set({ ...patch, updatedAt: Date.now() }).where(eq(agents.id, id)).returning();
    return row;
  }

  async deleteAgent(id: number): Promise<void> {
    // SQLite FKs aren't enforced here, so this has to walk every table that
    // references agentId itself — leaving any of these out just leaves
    // orphaned rows (and, for creations, orphaned files under data/creations/)
    // that outlive the agent they belonged to.
    await db.delete(agentLogEntries).where(eq(agentLogEntries.agentId, id));
    await db.delete(agentQueueItems).where(eq(agentQueueItems.agentId, id));
    await db.delete(notes).where(eq(notes.agentId, id));
    await db.delete(deliverables).where(eq(deliverables.agentId, id));
    await db.delete(creations).where(eq(creations.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
  }

  async getAgentLog(agentId: number, limit = 200): Promise<AgentLogEntry[]> {
    const rows = await db.select().from(agentLogEntries).where(eq(agentLogEntries.agentId, agentId)).orderBy(desc(agentLogEntries.id)).limit(limit);
    return rows.reverse();
  }

  async createAgentLogEntry(agentId: number, role: string, content: string, toolCalls: string | null = null): Promise<AgentLogEntry> {
    const [row] = await db.insert(agentLogEntries).values({ agentId, role, content, toolCalls, createdAt: Date.now() }).returning();
    return row;
  }

  async getAgentQueue(agentId: number): Promise<AgentQueueItem[]> {
    return db.select().from(agentQueueItems).where(eq(agentQueueItems.agentId, agentId)).orderBy(desc(agentQueueItems.id));
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
        ORDER BY id LIMIT 1
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
    };
  }

  async createQueueItem(agentId: number, content: string): Promise<AgentQueueItem> {
    const [row] = await db.insert(agentQueueItems).values({ agentId, content, status: "pending", createdAt: Date.now() }).returning();
    return row;
  }

  async updateQueueItem(id: number, patch: Partial<Pick<AgentQueueItem, "status" | "doneAt">>): Promise<AgentQueueItem | undefined> {
    const [row] = await db.update(agentQueueItems).set(patch).where(eq(agentQueueItems.id, id)).returning();
    return row;
  }

  async getDeliverables(agentId?: number): Promise<Deliverable[]> {
    if (agentId !== undefined) {
      return db.select().from(deliverables).where(eq(deliverables.agentId, agentId)).orderBy(desc(deliverables.id));
    }
    return db.select().from(deliverables).orderBy(desc(deliverables.id));
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
  }
}
