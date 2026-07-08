// Background heartbeat that lets agents work "indefinitely" without you
// prompting them — every tick, any active agent whose schedule has elapsed
// and has something pending in its queue gets a turn. A manual "Run now"
// (see routes.ts) calls runAgentTick directly and doesn't wait for this.
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
    for (const agent of agentsList) {
      if (agent.status !== "active" || agent.scheduleMinutes == null) continue;
      const due = agent.lastRunAt == null || now - agent.lastRunAt >= agent.scheduleMinutes * 60_000;
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
