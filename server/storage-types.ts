import type {
  Task, InsertTask, ChatMessage, InstalledSkill, InsertInstalledSkill, Approval, AuditEntry,
  AgentConfig, Note, Creation, Agent, AgentLogEntry, AgentQueueItem, AgentRecurringTask, Deliverable, TaskAgent, AgentRelationship,
  Project, ProjectCreateInput, ProjectUpdateInput,
} from "@shared/schema";

export interface AppStats {
  sessions: number;
  messages: number;
  tokensEstimate: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string;
  perDay: { date: string; count: number }[];
}

// Everything the rest of the server needs from persistence. A single SQLite
// implementation backs this (see storage-sqlite.ts) — AURORA is local-only,
// so there's no hosted/serverless backend to abstract over.
export interface Storage {
  getTasks(): Promise<Task[]>;
  getTask(id: number): Promise<Task | undefined>;
  createTask(title: string): Promise<Task>;
  updateTask(id: number, patch: Partial<Pick<Task, "title" | "status">>): Promise<Task | undefined>;
  deleteTask(id: number): Promise<void>;

  getStats(): Promise<AppStats>;

  // ---- Projects (organizational grouping of tasks) ----
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(input: ProjectCreateInput): Promise<Project>;
  updateProject(id: number, patch: ProjectUpdateInput): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  setTaskProject(taskId: number, projectId: number | null): Promise<Task | undefined>;

  getChatMessages(taskId: number, limit?: number): Promise<ChatMessage[]>;
  /** Messages strictly between two ids (exclusive), oldest first — the not-yet-summarized backlog history compaction works through. */
  getChatMessagesBetween(taskId: number, afterId: number, beforeId: number, limit?: number): Promise<ChatMessage[]>;
  setTaskContextSummary(id: number, summary: string, throughId: number): Promise<void>;
  createChatMessage(taskId: number, role: string, content: string, toolCalls?: string | null, agentId?: number | null, thinking?: string | null): Promise<ChatMessage>;
  /** Lets the agent loop patch an in-progress assistant message's content/toolCalls/thinking as each step completes, instead of only writing once the whole turn is done — this is what makes tool activity show up live while AURORA is still working. */
  updateChatMessage(id: number, patch: { content?: string; toolCalls?: string | null; thinking?: string | null }): Promise<void>;
  /** Wipe a task's chat history and its rolling context summary (Clear/Archive). */
  clearChatMessages(taskId: number): Promise<void>;

  /** Agents assigned to a Task, turning its chat into a shared thread they all read and respond in. Empty for an ordinary task (the default single-assistant behavior). */
  getTaskAgents(taskId: number): Promise<(TaskAgent & { agentName: string })[]>;
  assignAgentToTask(taskId: number, agentId: number): Promise<TaskAgent>;
  unassignAgentFromTask(taskId: number, agentId: number): Promise<void>;

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
  updateConfig(patch: Partial<Pick<AgentConfig, "ollamaHost" | "model" | "systemPrompt" | "autonomy" | "numCtx" | "imageGenHost" | "visionModel" | "advancedToolsEnabled" | "contentDir" | "musicDir" | "musicEnabled" | "musicVolume" | "autoContinue" | "telegramBotToken" | "telegramOwnerId">>): Promise<AgentConfig>;
  // Deliberately separate from updateConfig — the PIN can never be set via
  // the generic config-patch route, only through the dedicated auth setup flow.
  setPin(hash: string, salt: string): Promise<AgentConfig>;

  createNote(label: string, value: string, agentId?: number | null): Promise<Note>;
  getNotes(labelFilter?: string, limit?: number, agentId?: number | null): Promise<Note[]>;
  deleteNote(id: number): Promise<void>;

  createCreation(input: { taskId?: number; agentId?: number; kind: string; prompt: string; filePath: string; title?: string | null }): Promise<Creation>;
  getCreations(limit?: number): Promise<Creation[]>;
  /** Soft-deleted items awaiting permanent removal or restore (the Recycle Bin). */
  getTrashedCreations(limit?: number): Promise<Creation[]>;
  getCreation(id: number): Promise<Creation | undefined>;
  /** Soft delete — moves to the Recycle Bin, keeps the file. */
  deleteCreation(id: number): Promise<void>;
  restoreCreation(id: number): Promise<void>;
  /** Permanent — removes the row and its file from disk. */
  deleteCreationForever(id: number): Promise<void>;

  // ---- Persistent worker agents ----
  getAgents(): Promise<Agent[]>;
  getAgent(id: number): Promise<Agent | undefined>;
  createAgent(input: { name: string; persona: string; jobDescription: string; scheduleMinutes: number | null; role?: string | null; isOverseer?: boolean; spawnedByAgentId?: number | null }): Promise<Agent>;
  updateAgent(id: number, patch: Partial<Pick<Agent, "name" | "persona" | "jobDescription" | "status" | "scheduleMinutes" | "lastRunAt" | "avatarPath" | "role" | "morale" | "energy" | "mood" | "preferredModel">>): Promise<Agent | undefined>;
  // ---- Agent "life" layer: vitals + social relationships ----
  adjustAgentVitals(id: number, moraleDelta: number, energyDelta: number, mood?: string): Promise<void>;
  getRelationships(agentId: number): Promise<AgentRelationship[]>;
  bumpRelationship(agentId: number, otherAgentId: number, sentimentDelta: number, note?: string): Promise<void>;
  deleteAgent(id: number): Promise<void>;

  getAgentLog(agentId: number, limit?: number): Promise<AgentLogEntry[]>;
  /** Mirror of getChatMessagesBetween for an agent's activity log — same compaction mechanism, different table. */
  getAgentLogBetween(agentId: number, afterId: number, beforeId: number, limit?: number): Promise<AgentLogEntry[]>;
  setAgentContextSummary(id: number, summary: string, throughId: number): Promise<void>;
  createAgentLogEntry(agentId: number, role: string, content: string, toolCalls?: string | null, thinking?: string | null): Promise<AgentLogEntry>;
  /** Wipe an agent's activity log and rolling context summary (Clear/Archive). */
  clearAgentLog(agentId: number): Promise<void>;
  updateAgentLogEntry(id: number, patch: { content?: string; toolCalls?: string | null; thinking?: string | null }): Promise<void>;

  /** Includes sourceAgentName (resolved server-side) for items created via a handoff, so the client can show "handed off from X" without a second round trip. */
  getAgentQueue(agentId: number): Promise<(AgentQueueItem & { sourceAgentName: string | null })[]>;
  /** Every handoff_to_agent / message_agent exchange across every agent, newest first — the raw material for the Settings "agent conversations" archive. */
  getAgentConversations(limit?: number): Promise<(AgentQueueItem & { sourceAgentName: string; targetAgentName: string })[]>;
  /** Atomically selects and marks "in_progress" the oldest pending queue item for this agent, so two overlapping ticks of the same agent can't both claim it. */
  claimNextPendingQueueItem(agentId: number): Promise<AgentQueueItem | undefined>;
  createQueueItem(agentId: number, content: string, opts?: { sourceAgentId?: number; handoffDepth?: number }): Promise<AgentQueueItem>;
  updateQueueItem(id: number, patch: Partial<Pick<AgentQueueItem, "status" | "doneAt">>): Promise<AgentQueueItem | undefined>;

  getRecurringTasks(agentId: number): Promise<AgentRecurringTask[]>;
  /** Active recurring tasks across every agent whose schedule has come due — the scheduler's own tick pattern, mirrored at this layer instead of loading every task and filtering in JS. */
  getDueRecurringTasks(): Promise<AgentRecurringTask[]>;
  createRecurringTask(agentId: number, content: string, scheduleMinutes: number): Promise<AgentRecurringTask>;
  updateRecurringTask(id: number, patch: Partial<Pick<AgentRecurringTask, "content" | "scheduleMinutes" | "active" | "lastQueuedAt">>): Promise<AgentRecurringTask | undefined>;
  deleteRecurringTask(id: number): Promise<void>;

  getDeliverables(agentId?: number): Promise<Deliverable[]>;
  getDeliverable(id: number): Promise<Deliverable | undefined>;
  createDeliverable(input: { agentId: number; title: string; description: string; tags: string; body: string; creationId?: number | null }): Promise<Deliverable>;
  updateDeliverable(id: number, status: "ready" | "posted" | "archived"): Promise<Deliverable | undefined>;
  deleteDeliverable(id: number): Promise<void>;

  seedIfEmpty(): Promise<void>;
  /** Reunites any creations-dir file with no matching DB row (see deleteAgent's old file-stranding bug) back into the Library. Cheap, safe to run every startup. */
  recoverOrphanedCreationFiles(): Promise<number>;
}
