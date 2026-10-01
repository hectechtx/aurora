// The "living office" layer: cheap, rule-based world upkeep every scheduler
// tick, plus occasional LLM moments where the team actually talks.
//
// Rules handle the constant stuff (resting restores energy); the model is
// only called for something worth an LLM call — two idle teammates bumping
// into each other — and only when nobody has real work waiting, so it never
// competes with actual work for the single GPU. Relationship changes come
// from these observable events, not from random numbers.
import { getStorage } from "./storage";
import { converse, think, recentThoughts, reflect, reflectionDue } from "./mind";
import type { Agent } from "@shared/schema";
import { VENUES, agentSeed, routineAt, type VenueId } from "@shared/town";

export interface Chatter { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number; venue?: VenueId }

const ENCOUNTER_EVERY_MS = 4 * 60_000;
const THOUGHT_EVERY_MS = 90_000;
const MAX_CHATTER = 20;
const recent: Chatter[] = [];
let lastEncounterAt = 0;
let lastThoughtAt = 0;
let encounterRunning = false;

export function recentChatter(withinMs = 5 * 60_000): Chatter[] {
  const cutoff = Date.now() - withinMs;
  return recent.filter((c) => c.at >= cutoff);
}

/** One world tick. `busyAgentIds` are agents mid-turn; `urgentWaiting` is true when any real work is queued. */
export async function worldTick(busyAgentIds: Set<number>, urgentWaiting: boolean): Promise<void> {
  const storage = getStorage();
  const agents = await storage.getAgents();

  // Resting restores energy — working drains it (see runAgentTick), so without
  // this every agent slowly ran to empty and stayed there.
  for (const a of agents) {
    if (busyAgentIds.has(a.id) || (a.energy ?? 100) >= 100) continue;
    await storage.adjustAgentVitals(a.id, 0, a.status === "paused" ? 3 : 2).catch(() => {});
  }
  // Time off in town lifts spirits: an idle agent whose routine has them at
  // the park, theater, rec center… gains a little morale each tick (capped so
  // leisure alone never fakes "thriving" — good work does the rest).
  for (const a of agents) {
    if (a.status !== "active" || busyAgentIds.has(a.id) || (a.morale ?? 70) >= 85) continue;
    const stop = routineAt(agentSeed(a.id));
    if (stop.kind === "venue") await storage.adjustAgentVitals(a.id, VENUES[stop.venue].morale, 0).catch(() => {});
  }

  if (encounterRunning || urgentWaiting || busyAgentIds.size > 0) return;
  const config = await storage.getConfig();
  if (!config.model) return;
  encounterRunning = true;
  try {
    // One inner-life moment per idle tick: AURORA's reflection when it's due,
    // otherwise a conversation every few minutes, otherwise a private thought.
    if (reflectionDue()) { await reflect(config.ollamaHost, config.model); return; }
    const idle = agents.filter((a) => a.status === "active" && !busyAgentIds.has(a.id));
    if (Date.now() - lastEncounterAt >= ENCOUNTER_EVERY_MS && idle.filter((a) => !a.isOverseer).length >= 2) {
      lastEncounterAt = Date.now();
      await encounter(idle.filter((a) => !a.isOverseer), agents);
    } else if (Date.now() - lastThoughtAt >= THOUGHT_EVERY_MS && idle.length) {
      lastThoughtAt = Date.now();
      // Whoever has gone longest without a thought goes next.
      const next = [...idle].sort((x, y) => (recentThoughts(x.id, 1, ["thought"])[0]?.at ?? 0) - (recentThoughts(y.id, 1, ["thought"])[0]?.at ?? 0))[0];
      await think(config.ollamaHost, config.model, next);
    }
  } catch (err) {
    await storage.log("world moment failed", err instanceof Error ? err.message : String(err), "error").catch(() => {});
  } finally {
    encounterRunning = false;
  }
}

/** Two idle teammates meet wherever the town routine has them — sometimes to gossip about a third. */
async function encounter(idle: Agent[], everyone: Agent[]): Promise<void> {
  const storage = getStorage();
  const config = await storage.getConfig();
  const a = idle[Math.floor(Math.random() * idle.length)];
  // Mostly colleagues from the same company, with the occasional cross-company encounter.
  const sameCompany = idle.filter((x) => x !== a && x.companyId != null && x.companyId === a.companyId);
  const pool = sameCompany.length && Math.random() < 0.7 ? sameCompany : idle.filter((x) => x !== a);
  const b = pool[Math.floor(Math.random() * pool.length)];
  const stop = routineAt(agentSeed(a.id));
  const venue: VenueId = stop.kind === "venue" ? stop.venue : "cafe";
  const place = VENUES[venue];
  // Gossip about someone at least one of them has real feelings about.
  let about: Agent | undefined;
  if (Math.random() < 0.4) {
    const rels = [...(await storage.getRelationships(a.id)), ...(await storage.getRelationships(b.id))].filter((r) => Math.abs(r.sentiment) >= 5 && r.otherAgentId !== a.id && r.otherAgentId !== b.id);
    const pick = rels[Math.floor(Math.random() * rels.length)];
    about = pick ? everyone.find((x) => x.id === pick.otherAgentId) : undefined;
  }
  const m = await converse(config.ollamaHost, config.model, a, b, { place: place.name, doing: place.doing, about });
  if (!m) return;
  recent.push({ agentIds: m.agentIds, lines: m.lines, at: m.at, venue });
  if (recent.length > MAX_CHATTER) recent.shift();
  await storage.log(`${about ? "gossip" : "chat"} at the ${place.name}: ${a.name.trim()} & ${b.name.trim()}`, m.lines.map((l) => l.text).join(" / ").slice(0, 200));
}
