// Background heartbeat that lets agents work "indefinitely" without you
// prompting them — every tick, any active agent whose schedule has elapsed
// and has something pending in its queue gets a turn. An agent with no
// schedule set is always "due" (checked every tick) rather than sitting idle
// until someone clicks "Run now" — the schedule field only paces agents that
// opt into a slower cadence. A manual "Run now" (see routes.ts) calls
// runAgentTick directly and doesn't wait for this.
import { getStorage } from "./storage";
import { runAgentTick } from "./agent-loop";
import { log } from "./app";

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

    for (const agent of agentsList) {
      if (agent.status !== "active") continue;
      const due = agent.scheduleMinutes == null
        || agent.lastRunAt == null
        || now - agent.lastRunAt >= agent.scheduleMinutes * 60_000;
      if (!due) continue;

      try {
        const result = await runAgentTick(agent.id);
        if (!("skipped" in result)) log(`agent "${agent.name}" ticked: ${result.status}`, "scheduler");
      } catch (err) {
        await storage.log(`agent tick failed: ${agent.name}`, err instanceof Error ? err.message : String(err), "error");
      }
    }
  }, TICK_INTERVAL_MS);
}
