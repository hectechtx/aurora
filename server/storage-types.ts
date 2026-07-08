import type {
  Task, InsertTask, ChatMessage, InstalledSkill, InsertInstalledSkill, Approval, AuditEntry,
  AgentConfig, Note, Creation, Agent, AgentLogEntry, AgentQueueItem, Deliverable,
} from "@shared/schema";

// Everything the rest of the server needs from persistence. A single SQLite
// implementation backs this (see storage-sqlite.ts) — AURORA is local-only,
// so there's no hosted/serverless backend to abstract over.
export interface Storage {
  getTasks(): Promise<Task[]>;
  getTask(id: number): Promise<Task | undefined>;
  createTask(title: string): Promise<Task>;
  updateTask(id: number, patch: Partial<Pick<Task, "title" | "status">>): Promise<Task | undefined>;
  deleteTask(id: number): Promise<void>;

  getChatMessages(taskId: number, limit?: number): Promise<ChatMessage[]>;
  createChatMessage(taskId: number, role: string, content: string, toolCalls?: string | null): Promise<ChatMessage>;

  getSkills(): Promise<InstalledSkill[]>;
  getSkill(id: number): Promise<InstalledSkill | undefined>;
  createSkill(s: InsertInstalledSkill): Promise<InstalledSkill>;
  setSkillStatus(id: number, status: "pending_review" | "enabled" | "disabled"): Promise<InstalledSkill | undefined>;
  setSkillSourcePath(id: number, sourcePath: string): Promise<InstalledSkill | undefined>;
  deleteSkill(id: number): Promise<void>;

  getApprovals(): Promise<Approval[]>;
  getApproval(id: number): Promise<Approval | undefined>;
  createApproval(input: {
    action: string; detail: string; risk: string; targetType: string; targetId?: number; taskId?: number;
  }): Promise<Approval>;
  decideApproval(id: number, status: "approved" | "denied"): Promise<Approval | undefined>;

  getAudit(limit?: number): Promise<AuditEntry[]>;
  log(action: string, target?: string, outcome?: string, actor?: string): Promise<AuditEntry>;

  getConfig(): Promise<AgentConfig>;
  updateConfig(patch: Partial<Pick<AgentConfig, "ollamaHost" | "model" | "systemPrompt" | "autonomy" | "imageGenHost">>): Promise<AgentConfig>;

  createNote(label: string, value: string, agentId?: number | null): Promise<Note>;
  getNotes(labelFilter?: string, limit?: number, agentId?: number | null): Promise<Note[]>;
  deleteNote(id: number): Promise<void>;

  createCreation(input: { taskId?: number; agentId?: number; kind: string; prompt: string; filePath: string }): Promise<Creation>;
  getCreations(limit?: number): Promise<Creation[]>;

  // ---- Persistent worker agents ----
  getAgents(): Promise<Agent[]>;
  getAgent(id: number): Promise<Agent | undefined>;
  createAgent(input: { name: string; persona: string; jobDescription: string; scheduleMinutes: number | null }): Promise<Agent>;
  updateAgent(id: number, patch: Partial<Pick<Agent, "name" | "persona" | "jobDescription" | "status" | "scheduleMinutes" | "lastRunAt">>): Promise<Agent | undefined>;
  deleteAgent(id: number): Promise<void>;

  getAgentLog(agentId: number, limit?: number): Promise<AgentLogEntry[]>;
  createAgentLogEntry(agentId: number, role: string, content: string, toolCalls?: string | null): Promise<AgentLogEntry>;

  getAgentQueue(agentId: number): Promise<AgentQueueItem[]>;
  /** Atomically selects and marks "in_progress" the oldest pending queue item for this agent, so two overlapping ticks of the same agent can't both claim it. */
  claimNextPendingQueueItem(agentId: number): Promise<AgentQueueItem | undefined>;
  createQueueItem(agentId: number, content: string): Promise<AgentQueueItem>;
  updateQueueItem(id: number, patch: Partial<Pick<AgentQueueItem, "status" | "doneAt">>): Promise<AgentQueueItem | undefined>;

  getDeliverables(agentId?: number): Promise<Deliverable[]>;
  createDeliverable(input: { agentId: number; title: string; description: string; tags: string; body: string; creationId?: number | null }): Promise<Deliverable>;
  updateDeliverable(id: number, status: "ready" | "posted" | "archived"): Promise<Deliverable | undefined>;
  deleteDeliverable(id: number): Promise<void>;

  seedIfEmpty(): Promise<void>;
}
