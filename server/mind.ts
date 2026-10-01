// The organization's inner life and memory.
//
// Agents: private thoughts (a first-person line in their own voice, shaped by
// their persona, mood, work and relationships), memories of the moments they
// share, and gossip — two teammates talking about a third. Each moment moves
// relationships up OR down depending on how it actually went, and the latest
// thoughts and memories go back into the agent's own prompt, so how they feel
// shows up in how they work.
//
// AURORA: a growing knowledge base. On a schedule she reflects on everything
// the organization did since last time — every agent's work, deliverables,
// failures, and the owner's own words — and keeps the facts, lessons and
// team notes worth keeping. That knowledge rides in her prompt (and the
// lessons in every agent's), and any agent can teach her with `learn`. This
// is how she gets better over time: accumulated, curated experience — the
// model's weights don't change.
//
// All of it runs only when the GPU is idle and on the small chatter model,
// except reflection, which uses the main model because quality matters there.
import { sqlite } from "./storage-sqlite";
import { getStorage } from "./storage";
import { chat } from "./ollama";
import { log } from "./app";
import type { Agent } from "@shared/schema";

sqlite.exec(`
CREATE TABLE IF NOT EXISTS agent_thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, about_agent_id INTEGER
);
CREATE INDEX IF NOT EXISTS agent_thoughts_agent ON agent_thoughts(agent_id, at);
CREATE TABLE IF NOT EXISTS aurora_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mind_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const SMALL_MODEL = "qwen3.5:4b";
export type ThoughtKind = "thought" | "memory" | "gossip";
export type KnowledgeKind = "fact" | "lesson" | "team";
export interface Thought { id: number; agentId: number; at: number; kind: ThoughtKind; text: string; aboutAgentId: number | null }
export interface Knowledge { id: number; at: number; kind: KnowledgeKind; text: string; source: string; uses: number }

function state(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM mind_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
function setState(key: string, value: string): void {
  sqlite.prepare("INSERT INTO mind_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------------- thoughts & memories ----------------

export function addThought(agentId: number, kind: ThoughtKind, text: string, aboutAgentId: number | null = null): void {
  const clean = text.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "").slice(0, 400);
  if (!clean) return;
  sqlite.prepare("INSERT INTO agent_thoughts (agent_id, at, kind, text, about_agent_id) VALUES (?, ?, ?, ?, ?)").run(agentId, Date.now(), kind, clean, aboutAgentId);
  // Keep the newest 200 per agent.
  sqlite.prepare("DELETE FROM agent_thoughts WHERE agent_id = ? AND id NOT IN (SELECT id FROM agent_thoughts WHERE agent_id = ? ORDER BY id DESC LIMIT 200)").run(agentId, agentId);
}

function toThought(r: any): Thought {
  return { id: r.id, agentId: r.agent_id, at: r.at, kind: r.kind, text: r.text, aboutAgentId: r.about_agent_id ?? null };
}

export function recentThoughts(agentId: number, limit = 5, kinds?: ThoughtKind[]): Thought[] {
  const rows = kinds?.length
    ? sqlite.prepare(`SELECT * FROM agent_thoughts WHERE agent_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`).all(agentId, ...kinds, limit)
    : sqlite.prepare("SELECT * FROM agent_thoughts WHERE agent_id = ? ORDER BY id DESC LIMIT ?").all(agentId, limit);
  return (rows as any[]).map(toThought);
}

export function teamThoughts(limit = 30): Thought[] {
  return (sqlite.prepare("SELECT * FROM agent_thoughts ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(toThought);
}

/** The agent's own recent inner life, for their system prompt. */
export function innerLifePrompt(agentId: number): string {
  const thoughts = recentThoughts(agentId, 3, ["thought"]);
  const memories = recentThoughts(agentId, 4, ["memory", "gossip"]);
  if (!thoughts.length && !memories.length) return "";
  return (
    (thoughts.length ? `\nYour recent private thoughts: ${thoughts.map((t) => `"${t.text}"`).join(" ")}` : "") +
    (memories.length ? `\nThings that happened to you lately: ${memories.map((m) => m.text).join(" | ")}` : "") +
    "\nThese are yours — let them shape your tone and how you treat people, naturally."
  );
}

function brief(a: Agent): string {
  return `${a.name.trim()}${a.role ? ` (${a.role})` : ""}, mood ${a.mood}, morale ${a.morale}/100, energy ${a.energy}/100. Personality: ${a.persona.replace(/\s+/g, " ").slice(0, 300)}`;
}

async function standing(a: Agent, b: Agent): Promise<number> {
  return (await getStorage().getRelationships(a.id)).find((r) => r.otherAgentId === b.id)?.sentiment ?? 0;
}

function relWord(s: number): string {
  return s >= 40 ? "close friends" : s >= 10 ? "friendly" : s <= -40 ? "real friction" : s <= -10 ? "some tension" : "neutral";
}

/** One private thought for one agent, in their own voice. */
export async function think(host: string, fallbackModel: string, a: Agent): Promise<string | null> {
  const storage = getStorage();
  const [lastWork] = (await storage.getAgentLog(a.id, 3)).filter((e) => e.role === "assistant").slice(-1);
  const rels = (await storage.getRelationships(a.id)).slice(0, 4);
  const others = new Map((await storage.getAgents()).map((x) => [x.id, x.name.trim()] as const));
  const people = rels.map((r) => `${others.get(r.otherAgentId) ?? "someone"} (${relWord(r.sentiment)})`).join(", ");
  const mem = recentThoughts(a.id, 3, ["memory", "gossip"]).map((m) => m.text).join(" | ");
  const prompt =
    `You are ${brief(a)}\n` +
    (lastWork ? `What you were just working on: ${lastWork.content.replace(/\s+/g, " ").slice(0, 220)}\n` : "") +
    (people ? `People in your life at work: ${people}\n` : "") +
    (mem ? `Recent moments: ${mem}\n` : "") +
    "Write ONE private inner thought you're having right now — first person, 1-2 sentences, fully in character and true to your personality and mood. " +
    "It can be about your work, a teammate, a feeling, a worry, a hope, or something you want. No quotes, no narration, no hashtags.";
  const res = await chat(host, SMALL_MODEL, [{ role: "user", content: prompt }], [], 2048, { think: false })
    .catch(() => chat(host, fallbackModel, [{ role: "user", content: prompt }], [], 2048, { think: false }));
  const text = (res.message.content ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  if (text.length < 8) return null;
  addThought(a.id, "thought", text);
  return text;
}

export interface Moment { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number; venue?: string; about?: number }

/**
 * Two teammates talk — sometimes about a third ("gossip"). The model also
 * reports how it went, and that moves the relationship either way.
 */
export async function converse(host: string, fallbackModel: string, a: Agent, b: Agent, opts: { place: string; doing: string; about?: Agent }): Promise<Moment | null> {
  const storage = getStorage();
  const ab = await standing(a, b);
  const aboutLine = opts.about
    ? `They end up talking about their teammate ${opts.about.name.trim()} (${opts.about.role ?? "agent"}). A feels ${relWord(await standing(a, opts.about))} toward them; B feels ${relWord(await standing(b, opts.about))}. ` +
      "It's workplace gossip — opinions and impressions about work and personality, nothing cruel, nothing invented about private life.\n"
    : "";
  const prompt =
    `Two coworkers run into each other at the ${opts.place} (${opts.doing}).\n` +
    `A: ${brief(a)}\nB: ${brief(b)}\nRight now they're ${relWord(ab)}.\n` + aboutLine +
    "Write their short natural exchange — 2 to 4 lines, alternating, each fully in character (personality, mood, how they feel about each other). " +
    'Format each line exactly as "A: ..." or "B: ...". Then a last line exactly "TONE: warm", "TONE: neutral" or "TONE: tense" for how it went.';
  const res = await chat(host, SMALL_MODEL, [{ role: "user", content: prompt }], [], 2048, { think: false })
    .catch(() => chat(host, fallbackModel, [{ role: "user", content: prompt }], [], 2048, { think: false }));
  const raw = res.message.content ?? "";
  const lines = raw.split(/\r?\n/)
    .map((l) => l.trim().match(/^\**\s*(A|B)\s*\**\s*:\s*(.+)$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .slice(0, 4)
    .map((m) => ({ agentId: m[1].toUpperCase() === "A" ? a.id : b.id, text: m[2].replace(/^["“]|["”]$/g, "").slice(0, 180) }));
  if (lines.length < 2) return null;
  const tone = /TONE:\s*warm/i.test(raw) ? "warm" : /TONE:\s*tense/i.test(raw) ? "tense" : "neutral";
  const delta = tone === "warm" ? 3 : tone === "tense" ? -3 : 1;
  const where = `at the ${opts.place}`;
  const gist = lines.map((l) => l.text).join(" / ").slice(0, 160);
  if (opts.about) {
    await storage.bumpRelationship(a.id, b.id, delta + 1, `gossiped about ${opts.about.name.trim()} ${where}`).catch(() => {});
    await storage.bumpRelationship(b.id, a.id, delta + 1).catch(() => {});
    // Sharing a take on someone colours how you see them a little.
    const towards = tone === "tense" ? -1 : (await standing(a, opts.about)) >= 0 ? 1 : -1;
    await storage.bumpRelationship(a.id, opts.about.id, towards).catch(() => {});
    await storage.bumpRelationship(b.id, opts.about.id, towards).catch(() => {});
    addThought(a.id, "gossip", `Talked with ${b.name.trim()} about ${opts.about.name.trim()} ${where}: "${gist}"`, opts.about.id);
    addThought(b.id, "gossip", `Talked with ${a.name.trim()} about ${opts.about.name.trim()} ${where}: "${gist}"`, opts.about.id);
  } else {
    await storage.bumpRelationship(a.id, b.id, delta, `${tone} chat ${where}`).catch(() => {});
    await storage.bumpRelationship(b.id, a.id, delta).catch(() => {});
    addThought(a.id, "memory", `A ${tone} chat with ${b.name.trim()} ${where}: "${gist}"`, b.id);
    addThought(b.id, "memory", `A ${tone} chat with ${a.name.trim()} ${where}: "${gist}"`, a.id);
  }
  const lift = tone === "warm" ? 2 : tone === "tense" ? -2 : 1;
  await storage.adjustAgentVitals(a.id, lift, 0).catch(() => {});
  await storage.adjustAgentVitals(b.id, lift, 0).catch(() => {});
  return { agentIds: [a.id, b.id], lines, at: Date.now(), about: opts.about?.id };
}

// ---------------- AURORA's knowledge ----------------

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}
function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function toKnowledge(r: any): Knowledge {
  return { id: r.id, at: r.at, kind: r.kind, text: r.text, source: r.source, uses: r.uses };
}

export function listKnowledge(limit = 200, kind?: KnowledgeKind): Knowledge[] {
  const rows = kind
    ? sqlite.prepare("SELECT * FROM aurora_knowledge WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
    : sqlite.prepare("SELECT * FROM aurora_knowledge ORDER BY id DESC LIMIT ?").all(limit);
  return (rows as any[]).map(toKnowledge);
}

/** Saves a fact/lesson — or, if she already knows it, reinforces the existing one instead of duplicating it. */
export function addKnowledge(kind: KnowledgeKind, text: string, source: string): "new" | "reinforced" | "skipped" {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (clean.length < 12) return "skipped";
  const same = listKnowledge(400, kind).find((k) => overlap(k.text, clean) >= 0.75);
  if (same) {
    sqlite.prepare("UPDATE aurora_knowledge SET uses = uses + 1, at = ? WHERE id = ?").run(Date.now(), same.id);
    return "reinforced";
  }
  sqlite.prepare("INSERT INTO aurora_knowledge (at, kind, text, source, uses) VALUES (?, ?, ?, ?, 1)").run(Date.now(), kind, clean, source.slice(0, 120));
  return "new";
}

export function forgetKnowledge(id: number): void {
  sqlite.prepare("DELETE FROM aurora_knowledge WHERE id = ?").run(id);
}

export function searchKnowledge(query: string, limit = 10): Knowledge[] {
  const q = words(query);
  return listKnowledge(1000)
    .map((k) => { let s = 0; for (const w of words(k.text)) if (q.has(w)) s++; return { k, s }; })
    .filter((r) => r.s > 0 || !q.size)
    .sort((a, b) => b.s - a.s || b.k.uses - a.k.uses)
    .slice(0, limit)
    .map((r) => r.k);
}

/** Most important first: reinforced often, then recent. */
function ranked(kind: KnowledgeKind, n: number): Knowledge[] {
  return (sqlite.prepare("SELECT * FROM aurora_knowledge WHERE kind = ? ORDER BY uses DESC, id DESC LIMIT ?").all(kind, n) as any[]).map(toKnowledge);
}

/** What AURORA knows, for her own prompt. */
export function auroraKnowledgePrompt(budget = 3200): string {
  const sections: [string, Knowledge[]][] = [
    ["Facts you know (about the owner, the business, the projects)", ranked("fact", 25)],
    ["Lessons you've learned (do these)", ranked("lesson", 25)],
    ["What you know about your team", ranked("team", 20)],
  ];
  let out = "", used = 0;
  for (const [title, items] of sections) {
    if (!items.length) continue;
    let block = `\n## ${title}\n`;
    for (const k of items) {
      const line = `- ${k.text}\n`;
      if (used + block.length + line.length > budget) break;
      block += line;
    }
    used += block.length;
    out += block;
  }
  return out ? `\n\n# Your accumulated knowledge (you built this from experience — trust it, and keep adding to it with learn)${out}` : "";
}

/** The organization's top lessons, for every agent's prompt. */
export function teamLessonsPrompt(n = 6): string {
  const lessons = ranked("lesson", n);
  return lessons.length ? `\n\nLessons the organization has learned (follow them):\n${lessons.map((k) => `- ${k.text}`).join("\n")}` : "";
}

const REFLECT_EVERY_MS = 3 * 60 * 60 * 1000;
let reflecting = false;

export function reflectionStatus(): { lastAt: number | null; running: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const r of sqlite.prepare("SELECT kind, COUNT(*) n FROM aurora_knowledge GROUP BY kind").all() as { kind: string; n: number }[]) counts[r.kind] = r.n;
  const last = state("last_reflect_at");
  return { lastAt: last ? Number(last) : null, running: reflecting, counts };
}

export function reflectionDue(): boolean {
  const last = Number(state("last_reflect_at") ?? 0);
  return Date.now() - last > REFLECT_EVERY_MS;
}

/**
 * AURORA looks back over everything since her last reflection and keeps what
 * matters. Returns a one-line summary.
 */
export async function reflect(host: string, model: string): Promise<string> {
  if (reflecting) return "already reflecting";
  reflecting = true;
  try {
    const since = Number(state("last_reflect_at") ?? 0) || Date.now() - 3 * 24 * 60 * 60 * 1000;
    const storage = getStorage();
    const names = new Map((await storage.getAgents()).map((a) => [a.id, a.name.trim()] as const));
    const owner = (sqlite.prepare("SELECT content FROM chat_messages WHERE role = 'user' AND created_at > ? ORDER BY id DESC LIMIT 25").all(since) as { content: string }[])
      .map((r) => `- ${r.content.replace(/\s+/g, " ").slice(0, 300)}`);
    const work = (sqlite.prepare("SELECT agent_id, content FROM agent_log_entries WHERE role = 'assistant' AND created_at > ? ORDER BY id DESC LIMIT 40").all(since) as { agent_id: number; content: string }[])
      .map((r) => `- ${names.get(r.agent_id) ?? "agent"}: ${r.content.replace(/\s+/g, " ").slice(0, 220)}`);
    const delivered = (sqlite.prepare("SELECT agent_id, title, status FROM deliverables WHERE created_at > ? ORDER BY id DESC LIMIT 25").all(since) as { agent_id: number; title: string; status: string }[])
      .map((r) => `- ${names.get(r.agent_id) ?? "agent"} delivered "${r.title}" (${r.status})`);
    const failures = (sqlite.prepare("SELECT actor, action, target FROM audit_log WHERE outcome = 'error' AND ts > ? ORDER BY id DESC LIMIT 25").all(since) as { actor: string; action: string; target: string }[])
      .map((r) => `- ${r.actor}: ${r.action} ${String(r.target).replace(/\s+/g, " ").slice(0, 160)}`);
    if (!owner.length && !work.length && !delivered.length && !failures.length) {
      setState("last_reflect_at", String(Date.now()));
      return "nothing new to reflect on";
    }
    const known = listKnowledge(60).map((k) => `- (${k.kind}) ${k.text}`).join("\n");
    const prompt =
      "You are AURORA, the lead of an AI organization, doing your regular reflection: look back at what happened and keep what will make you and the team better.\n\n" +
      (owner.length ? `What the owner said:\n${owner.join("\n")}\n\n` : "") +
      (work.length ? `What the agents did:\n${work.join("\n")}\n\n` : "") +
      (delivered.length ? `What was delivered:\n${delivered.join("\n")}\n\n` : "") +
      (failures.length ? `What failed:\n${failures.join("\n")}\n\n` : "") +
      (known ? `What you already know (don't repeat these):\n${known}\n\n` : "") +
      'Respond with ONLY JSON: {"facts":["..."],"lessons":["..."],"team":["..."],"diary":"..."}\n' +
      "- facts: durable facts about the owner (preferences, goals), the business and projects. Only what's clearly supported above.\n" +
      "- lessons: concrete, reusable 'do this / avoid that' rules learned from what worked or failed (e.g. tool problems and the fix).\n" +
      "- team: who is good at what, who struggles with what, who works well together.\n" +
      "- diary: one or two sentences in your own voice about how you feel about the organization right now.\n" +
      "Max 6 items per list, each one short sentence. Empty lists are fine. Never invent anything.";
    const res = await chat(host, model, [{ role: "user", content: prompt }], [], 16384, { think: false, format: "json" });
    let parsed: any = {};
    try { parsed = JSON.parse((res.message.content ?? "").replace(/```(?:json)?|```/g, "").trim()); } catch { /* keep empty */ }
    let added = 0, reinforced = 0;
    for (const kind of ["facts", "lessons", "team"] as const) {
      for (const item of (Array.isArray(parsed[kind]) ? parsed[kind] : []).slice(0, 6)) {
        const r = addKnowledge(kind === "facts" ? "fact" : kind === "lessons" ? "lesson" : "team", String(item), "reflection");
        if (r === "new") added++; else if (r === "reinforced") reinforced++;
      }
    }
    const aurora = (await storage.getAgents()).find((a) => a.isOverseer);
    if (aurora && typeof parsed.diary === "string") addThought(aurora.id, "thought", parsed.diary);
    setState("last_reflect_at", String(Date.now()));
    const summary = `reflected: ${added} new things learned, ${reinforced} reinforced`;
    await storage.log("AURORA reflection", summary).catch(() => {});
    return summary;
  } catch (err) {
    log(`reflection failed: ${err instanceof Error ? err.message : String(err)}`);
    return `reflection failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    reflecting = false;
  }
}
