// Background heartbeat that lets agents work "indefinitely" without you
// prompting them — every tick, any active agent whose schedule has elapsed
// and has something pending in its queue gets a turn. An agent with no
// schedule set is always "due" (checked every tick) rather than sitting idle
// until someone clicks "Run now" — the schedule field only paces agents that
// opt into a slower cadence. A manual "Run now" (see routes.ts) calls
// runAgentTick directly and doesn't wait for this.
import { getStorage } from "./storage";
import { runAgentTick, agentsWorkingNow } from "./agent-loop";
import { worldTick } from "./world";
import { simulationTick } from "./simulation";
import { log } from "./app";
import { duePipelines, startPipelineRun } from "./pipelines";

const TICK_INTERVAL_MS = 60_000;

export function startScheduler(): void {
  setInterval(async () => {
    const storage = getStorage();
    let agentsList;
    try {
      agentsList = await storage.getAgents();
    } catch {
      return; // storage hiccup — try again next tick
    }

    const now = Date.now();

    // Recurring task templates re-queue themselves here, before the agent
    // due-check below — so a template due at the same moment as its agent's
    // own schedule lands in the queue in time to be picked up by this same tick.
    try {
      const due = await storage.getDueRecurringTasks();
      for (const t of due) {
        await storage.createQueueItem(t.agentId, t.content);
        await storage.updateRecurringTask(t.id, { lastQueuedAt: now });
      }
    } catch (err) {
      log(`recurring task re-queue failed: ${err instanceof Error ? err.message : String(err)}`, "scheduler");
    }

    // Scheduled pipelines kick off their first step here; later steps chain
    // on their own as each agent finishes (see pipelines.ts).
    try {
      for (const p of await duePipelines(now)) {
        const r = await startPipelineRun(p.id);
        log(`pipeline "${p.name}": ${r.message}`, "scheduler");
      }
    } catch (err) {
      log(`pipeline schedule failed: ${err instanceof Error ? err.message : String(err)}`, "scheduler");
    }

    // Work someone is waiting on — a pipeline step, a job delegated from
    // chat, a handoff — is due now, whatever the agent's own pacing is (a
    // 4-hour schedule shouldn't park step 2 of a pipeline for 4 hours), and
    // those agents go first: ticks run one at a time (one GPU), so routine
    // chores ahead of them in roster order would otherwise stall a pipeline.
    const dueAgents: { agent: (typeof agentsList)[number]; urgent: boolean }[] = [];
    for (const agent of agentsList) {
      if (agent.status !== "active") continue;
      const urgent = (await storage.getAgentQueue(agent.id))
        .some((q) => q.status === "pending" && (q.pipelineRunId != null || q.originTaskId != null || q.sourceAgentId != null));
      const due = urgent
        || agent.scheduleMinutes == null
        || agent.lastRunAt == null
        || now - agent.lastRunAt >= agent.scheduleMinutes * 60_000;
      if (due) dueAgents.push({ agent, urgent });
    }
    dueAgents.sort((a, b) => Number(b.urgent) - Number(a.urgent));

    // The simulated companies' economy (rules only, no LLM).
    try { simulationTick(now); } catch (err) { log(`simulation tick failed: ${err instanceof Error ? err.message : String(err)}`, "scheduler"); }

    // World upkeep (rest, the occasional lounge chat) — before the ticks,
    // and it skips the LLM part entirely whenever real work is waiting.
    await worldTick(new Set(agentsWorkingNow()), dueAgents.some((d) => d.urgent))
      .catch((err) => log(`world tick failed: ${err instanceof Error ? err.message : String(err)}`, "scheduler"));

    for (const { agent } of dueAgents) {
      try {
        const result = await runAgentTick(agent.id);
        if (!("skipped" in result)) log(`agent "${agent.name}" ticked: ${result.status}`, "scheduler");
      } catch (err) {
        await storage.log(`agent tick failed: ${agent.name}`, err instanceof Error ? err.message : String(err), "error");
      }
    }
  }, TICK_INTERVAL_MS);
}
