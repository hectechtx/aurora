// The "living office" layer: cheap, rule-based world upkeep every scheduler
// tick, plus occasional LLM moments where the team actually talks.
//
// Rules handle the constant stuff (resting restores energy); the model is
// only called for something worth an LLM call — two idle teammates bumping
// into each other — and only when nobody has real work waiting, so it never
// competes with actual work for the single GPU. Relationship changes come
// from these observable events, not from random numbers.
import { getStorage } from "./storage";
import { chat } from "./ollama";
import type { Agent } from "@shared/schema";

export interface Chatter { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number }

const ENCOUNTER_EVERY_MS = 10 * 60_000;
const MAX_CHATTER = 20;
const recent: Chatter[] = [];
let lastEncounterAt = 0;
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

  if (encounterRunning || urgentWaiting || busyAgentIds.size > 0) return;
  if (Date.now() - lastEncounterAt < ENCOUNTER_EVERY_MS) return;
  const idle = agents.filter((a) => a.status === "active" && !a.isOverseer && !busyAgentIds.has(a.id));
  if (idle.length < 2) return;

  lastEncounterAt = Date.now();
  encounterRunning = true;
  try {
    const i = Math.floor(Math.random() * idle.length);
    let j = Math.floor(Math.random() * (idle.length - 1));
    if (j >= i) j++;
    await encounter(idle[i], idle[j]);
  } catch (err) {
    await storage.log("world encounter failed", err instanceof Error ? err.message : String(err), "error").catch(() => {});
  } finally {
    encounterRunning = false;
  }
}

function brief(a: Agent): string {
  return `${a.name.trim()}${a.role ? ` (${a.role})` : ""} — mood ${a.mood}, energy ${a.energy}/100. Personality: ${a.persona.replace(/\s+/g, " ").slice(0, 280)}`;
}

/** Two teammates bump into each other in the lounge: one short model call writes a 2-4 line exchange in their voices. */
async function encounter(a: Agent, b: Agent): Promise<void> {
  const storage = getStorage();
  const config = await storage.getConfig();
  if (!config.model) return;
  const rel = (await storage.getRelationships(a.id)).find((r) => r.otherAgentId === b.id);
  const standing = rel ? `They've worked together ${rel.interactions} times; rapport ${rel.sentiment} on a -100..100 scale${rel.note ? ` (last: ${rel.note})` : ""}.` : "They haven't worked together much yet.";
  const [lastA] = (await storage.getAgentLog(a.id, 2)).filter((e) => e.role === "assistant").slice(-1);
  const prompt =
    `Two coworkers on an AI content team run into each other in the office lounge.\n` +
    `A: ${brief(a)}\nB: ${brief(b)}\n${standing}\n` +
    (lastA ? `${a.name.trim()} was recently working on: ${lastA.content.replace(/\s+/g, " ").slice(0, 200)}\n` : "") +
    `Write their short, natural exchange — 2 to 4 lines total, alternating, in character, about work or how they're doing. ` +
    `Format each line exactly as "A: ..." or "B: ...". No narration, no stage directions.`;
  const res = await chat(config.ollamaHost, config.model, [{ role: "user", content: prompt }], [], 2048, { think: false });
  const lines = (res.message.content ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^\**\s*(A|B)\s*\**\s*:\s*(.+)$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .slice(0, 4)
    .map((m) => ({ agentId: m[1].toUpperCase() === "A" ? a.id : b.id, text: m[2].replace(/^["“]|["”]$/g, "").slice(0, 180) }));
  if (lines.length < 2) return;
  recent.push({ agentIds: [a.id, b.id], lines, at: Date.now() });
  if (recent.length > MAX_CHATTER) recent.shift();
  await storage.bumpRelationship(a.id, b.id, 1, `chatted in the lounge`).catch(() => {});
  await storage.bumpRelationship(b.id, a.id, 1).catch(() => {});
  await storage.log(`lounge chat: ${a.name.trim()} & ${b.name.trim()}`, lines.map((l) => l.text).join(" / ").slice(0, 200));
}
