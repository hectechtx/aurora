// Multi-agent workflows ("pipelines") and one-off delegation from chat.
//
// A pipeline is an ordered chain of stages, each one agent + instruction.
// Running it queues stage 1 on its agent; when that agent finishes, its reply
// becomes the input of stage 2 on the next agent, and so on. The last stage's
// output lands in the Outbox (as a deliverable) and is posted back into the
// chat that asked for it. Built on the ordinary agent queue, so every stage
// gets the same tools, approval gating, Stop button, and Team-view visibility
// as any other agent work.
//
// Delegation is the one-stage case: AURORA hands a job to an agent from a
// chat, and the agent's result is posted back into that chat when it's done.
import { getStorage } from "./storage";
import type { Agent, AgentQueueItem, Pipeline, PipelineStage } from "@shared/schema";
import { addWorldEvent, getCompany } from "./companies";

export const MAX_PIPELINE_STAGES = 8;
// A run "running" for longer than this is assumed dead (crash, restart mid-stage)
// so its schedule isn't blocked forever.
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
const MAX_HANDOVER_CHARS = 6000;

// Set by agent-loop at startup — kept as an injected callback rather than an
// import so this module and agent-loop don't import each other.
let nudgeAgent: (agentId: number) => void = () => {};
export function setPipelineNudge(fn: (agentId: number) => void): void {
  nudgeAgent = fn;
}

export function parseStages(p: Pipeline): PipelineStage[] {
  try {
    const raw = JSON.parse(p.stages) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is PipelineStage => !!s && typeof s === "object" && Number.isInteger((s as PipelineStage).agentId) && typeof (s as PipelineStage).instruction === "string")
      .slice(0, MAX_PIPELINE_STAGES);
  } catch {
    return [];
  }
}

export const SCHEDULE_WORDS: Record<string, number | null> = { none: null, once: null, manual: null, hourly: 60, daily: 1440, weekly: 10080 };

/** "daily" / "hourly" / "weekly" / "none" / a number of minutes -> minutes or null. */
export function parseSchedule(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(5, Math.min(10080, Math.round(value)));
  const s = String(value ?? "").trim().toLowerCase();
  if (s in SCHEDULE_WORDS) return SCHEDULE_WORDS[s];
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.min(10080, Math.round(n))) : null;
}

export function describeSchedule(minutes: number | null): string {
  if (!minutes) return "on demand";
  if (minutes === 60) return "hourly";
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  return `every ${minutes} min`;
}

/** Case-insensitive agent lookup by full name, or by first word ("Nat" for "Nat the content creator"). */
export function findAgentByName(agents: Agent[], name: string): Agent | undefined {
  const want = name.trim().toLowerCase();
  if (!want) return undefined;
  return agents.find((a) => a.name.trim().toLowerCase() === want)
    ?? agents.find((a) => a.name.trim().toLowerCase().split(/\s+/)[0] === want.split(/\s+/)[0]);
}

function stageContent(pipeline: Pipeline, stages: PipelineStage[], index: number, input: string | null): string {
  const isLast = index === stages.length - 1;
  let c = `[Pipeline "${pipeline.name}" — step ${index + 1} of ${stages.length}]\n${stages[index].instruction}`;
  if (input) c += `\n\n--- Input from the previous step ---\n${input.slice(0, MAX_HANDOVER_CHARS)}`;
  c += `\n\nDo this step completely yourself, using your tools as needed. Then reply with your finished output only — ` +
    (isLast ? "it goes to the owner as the final result, so make it complete and polished." : "it is handed to the next step as its input.");
  return c;
}

async function postToChat(taskId: number | null | undefined, agentId: number | null, text: string): Promise<void> {
  if (!taskId) return;
  const storage = getStorage();
  if (!(await storage.getTask(taskId))) return; // chat was deleted since
  await storage.createChatMessage(taskId, "assistant", text, null, agentId);
}

export async function startPipelineRun(pipelineId: number, opts: { input?: string; originTaskId?: number | null } = {}): Promise<{ ok: boolean; message: string }> {
  const storage = getStorage();
  const pipeline = await storage.getPipeline(pipelineId);
  if (!pipeline) return { ok: false, message: "pipeline not found" };
  const stages = parseStages(pipeline);
  if (stages.length === 0) return { ok: false, message: `pipeline "${pipeline.name}" has no stages` };

  const first = await storage.getAgent(stages[0].agentId);
  if (!first) return { ok: false, message: `step 1's agent no longer exists — edit the pipeline` };
  if (first.status !== "active") return { ok: false, message: `${first.name.trim()} (step 1) is paused — resume them on the Team page first` };

  const originTaskId = opts.originTaskId ?? pipeline.originTaskId ?? null;
  const run = await storage.createPipelineRun(pipeline.id, originTaskId);
  await storage.updatePipeline(pipeline.id, { lastRunAt: Date.now() });
  await storage.createQueueItem(first.id, stageContent(pipeline, stages, 0, opts.input?.trim() || null), {
    pipelineRunId: run.id, stageIndex: 0, originTaskId: originTaskId ?? undefined,
  });
  await storage.log(`pipeline started: ${pipeline.name}`, `run #${run.id}, step 1 -> ${first.name.trim()}`);
  nudgeAgent(first.id);
  return { ok: true, message: `started "${pipeline.name}" — step 1 of ${stages.length} is with ${first.name.trim()}` };
}

/** Called whenever an agent finishes (or fails) a queue item. Advances its pipeline, or reports a delegated job back to its chat. */
export async function onQueueItemFinished(queueItemId: number, status: "final" | "error", reply: string): Promise<void> {
  const storage = getStorage();
  const item: AgentQueueItem | undefined = await storage.getQueueItem(queueItemId);
  if (!item) return;
  const agent = await storage.getAgent(item.agentId);
  const agentName = agent?.name.trim() ?? "An agent";

  if (item.pipelineRunId == null) {
    if (item.originTaskId) {
      const ask = item.content.replace(/^\[[^\]]*\]:?\s*/, "").split("\n")[0].slice(0, 120);
      await postToChat(item.originTaskId, item.agentId, status === "error"
        ? `**${agentName}** couldn't finish "${ask}": ${reply || "something went wrong"}`
        : `**${agentName}** finished "${ask}":\n\n${reply}`);
    }
    return;
  }

  const run = await storage.getPipelineRun(item.pipelineRunId);
  if (!run || run.status !== "running") return;
  const pipeline = await storage.getPipeline(run.pipelineId);
  if (!pipeline) return;
  const stages = parseStages(pipeline);
  const index = item.stageIndex ?? 0;

  if (status === "error") {
    await storage.updatePipelineRun(run.id, { status: "error", output: reply, finishedAt: Date.now() });
    await storage.log(`pipeline failed: ${pipeline.name}`, `step ${index + 1} (${agentName})`, "error");
    await postToChat(run.originTaskId, item.agentId, `Pipeline **${pipeline.name}** stopped at step ${index + 1} (${agentName}): ${reply || "error"}`);
    return;
  }

  // A stage can end the run honestly when there's genuinely nothing to work
  // on (e.g. no studio videos exist yet to clip) — instead of later stages
  // inventing inputs (measured: a clip scout made up two source videos).
  if (/^\W*NOTHING TO DO/i.test(reply.trim())) {
    await storage.updatePipelineRun(run.id, { status: "done", output: reply, finishedAt: Date.now() });
    await storage.log(`pipeline skipped: ${pipeline.name}`, `step ${index + 1} (${agentName}): ${reply.slice(0, 160)}`);
    await postToChat(run.originTaskId, item.agentId, `Pipeline **${pipeline.name}** had nothing to do this time — ${agentName}: ${reply.replace(/^\W*NOTHING TO DO\W*/i, "")}`);
    return;
  }

  const next = index + 1;
  if (next < stages.length) {
    const nextAgent = await storage.getAgent(stages[next].agentId);
    if (!nextAgent || nextAgent.status !== "active") {
      const why = nextAgent ? `${nextAgent.name.trim()} is paused` : "its agent no longer exists";
      await storage.updatePipelineRun(run.id, { status: "error", output: reply, finishedAt: Date.now() });
      await postToChat(run.originTaskId, item.agentId, `Pipeline **${pipeline.name}** stopped before step ${next + 1}: ${why}.`);
      return;
    }
    await storage.updatePipelineRun(run.id, { stageIndex: next });
    await storage.createQueueItem(nextAgent.id, stageContent(pipeline, stages, next, reply), {
      pipelineRunId: run.id, stageIndex: next, originTaskId: run.originTaskId ?? undefined, sourceAgentId: item.agentId,
    });
    await storage.log(`pipeline step: ${pipeline.name}`, `step ${next + 1} -> ${nextAgent.name.trim()}`);
    if (agent) await storage.bumpRelationship(item.agentId, nextAgent.id, 2, `pipeline "${pipeline.name}"`).catch(() => {});
    nudgeAgent(nextAgent.id);
    return;
  }

  // Last stage done: deliver.
  await storage.updatePipelineRun(run.id, { status: "done", output: reply, finishedAt: Date.now() });
  const stamp = new Date().toLocaleString();
  await storage.createDeliverable({
    agentId: item.agentId,
    title: `${pipeline.name} — ${stamp}`,
    description: `Final output of the "${pipeline.name}" pipeline (${stages.length} step${stages.length === 1 ? "" : "s"}).`,
    tags: JSON.stringify(["pipeline"]),
    body: reply,
  });
  await storage.log(`pipeline done: ${pipeline.name}`, `run #${run.id}`);
  const company = agent?.companyId != null ? getCompany(agent.companyId) : undefined;
  addWorldEvent("delivered", `${company?.name ?? "AURORA HQ"} delivered "${pipeline.name}" (${stages.length} step${stages.length === 1 ? "" : "s"}, finished by ${agentName}).`, company?.id ?? null);
  await postToChat(run.originTaskId, item.agentId, `Pipeline **${pipeline.name}** is done — the result is in your Outbox too.\n\n${reply}`);
}

/** Pipelines whose schedule has come due and that aren't already mid-run. */
export async function duePipelines(now = Date.now()): Promise<Pipeline[]> {
  const storage = getStorage();
  const due: Pipeline[] = [];
  for (const p of await storage.getPipelines()) {
    if (!p.active || !p.scheduleMinutes) continue;
    if (p.lastRunAt && now - p.lastRunAt < p.scheduleMinutes * 60_000) continue;
    const [latest] = await storage.getPipelineRuns(p.id, 1);
    if (latest?.status === "running" && now - latest.startedAt < STALE_RUN_MS) continue;
    due.push(p);
  }
  return due;
}

/** Creates (or, if one with the same name exists, replaces) a pipeline from agent names + instructions. */
export async function upsertPipeline(input: {
  name: string; description?: string; stages: { agent: string; instruction: string }[]; schedule: unknown; originTaskId: number | null;
}): Promise<{ ok: true; pipeline: Pipeline } | { ok: false; message: string }> {
  const storage = getStorage();
  const name = input.name.trim().slice(0, 100);
  if (!name) return { ok: false, message: "a pipeline name is required" };
  if (!input.stages.length) return { ok: false, message: "a pipeline needs at least one step" };
  if (input.stages.length > MAX_PIPELINE_STAGES) return { ok: false, message: `at most ${MAX_PIPELINE_STAGES} steps per pipeline` };
  const agents = await storage.getAgents();
  const stages: PipelineStage[] = [];
  for (const [i, s] of input.stages.entries()) {
    const agent = findAgentByName(agents, s.agent ?? "");
    if (!agent) return { ok: false, message: `step ${i + 1}: no agent named "${s.agent}". Agents: ${agents.map((a) => a.name.trim()).join(", ")}` };
    const instruction = String(s.instruction ?? "").trim();
    if (!instruction) return { ok: false, message: `step ${i + 1} needs an instruction` };
    stages.push({ agentId: agent.id, instruction: instruction.slice(0, 2000) });
  }
  const scheduleMinutes = parseSchedule(input.schedule);
  const existing = (await storage.getPipelines()).find((p) => p.name.toLowerCase() === name.toLowerCase());
  const pipeline = existing
    ? await storage.updatePipeline(existing.id, { stages: JSON.stringify(stages), scheduleMinutes, description: input.description ?? existing.description, active: true })
    : await storage.createPipeline({ name, description: input.description, stages: JSON.stringify(stages), scheduleMinutes, originTaskId: input.originTaskId });
  if (!pipeline) return { ok: false, message: "couldn't save the pipeline" };
  await storage.log(`pipeline ${existing ? "updated" : "created"}: ${name}`, `${stages.length} steps, ${describeSchedule(scheduleMinutes)}`);
  return { ok: true, pipeline };
}

/** One-line human summary of a pipeline: "Daily trends (daily): Riley → Nat → ALI". */
export async function summarizePipeline(p: Pipeline): Promise<string> {
  const storage = getStorage();
  const names = await Promise.all(parseStages(p).map(async (s) => (await storage.getAgent(s.agentId))?.name.trim() ?? "?"));
  return `${p.name} (${describeSchedule(p.scheduleMinutes)}${p.active ? "" : ", paused"}): ${names.join(" → ")}`;
}
