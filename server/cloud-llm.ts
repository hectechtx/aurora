// Cloud assist: free OpenAI-compatible LLM APIs (from the awesome-freellm-apis
// list) that take agents' background thinking while the GPU is busy with a
// heavy media job (see gpu.ts) — so video renders don't crawl and agents don't
// stall. Providers are used in order of preference, each within its own free
// limits (requests per minute/day), with a short cooldown after a refusal.
//
// Privacy: only calls explicitly marked cloud-OK go here (agents' background
// work); the owner's own chats with AURORA always stay local. Free tiers may
// log or train on what they receive, so the owner opts in per provider by
// adding a key.
import { sqlite } from "./storage-sqlite";
import { log } from "./app";
import type { OllamaMessage, OllamaToolDef, OllamaChatResult } from "./ollama";

sqlite.exec(`
CREATE TABLE IF NOT EXISTS cloud_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, rpm INTEGER NOT NULL, rpd INTEGER NOT NULL,
  priority INTEGER NOT NULL, signup_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  used_day TEXT NOT NULL DEFAULT '', used_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cloud_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// Some providers answer without a key (anonymous, low limits).
try { sqlite.exec("ALTER TABLE cloud_providers ADD COLUMN keyless INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }

/** Free tiers as published in the list (2026-10-01). Limits are the provider's own; we stay under them. */
const PRESETS = [
  { id: "groq", name: "Groq", base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", rpm: 30, rpd: 250, signup: "https://console.groq.com/keys", note: "Very fast. No credit card." },
  { id: "gemini", name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", rpm: 15, rpd: 1500, signup: "https://aistudio.google.com/apikey", note: "Big daily limit, 1M context. No credit card." },
  { id: "cerebras", name: "Cerebras", base: "https://api.cerebras.ai/v1", model: "", rpm: 10, rpd: 100, signup: "https://cloud.cerebras.ai", note: "Very fast. 1M tokens/day. No credit card." },
  { id: "mistral", name: "Mistral AI", base: "https://api.mistral.ai/v1", model: "mistral-small-latest", rpm: 2, rpd: 500, signup: "https://console.mistral.ai/api-keys", note: "No credit card." },
  { id: "openrouter", name: "OpenRouter (free models)", base: "https://openrouter.ai/api/v1", model: "", rpm: 20, rpd: 50, signup: "https://openrouter.ai/keys", note: "Many ':free' models in one place." },
  { id: "sambanova", name: "SambaNova", base: "https://api.sambanova.ai/v1", model: "", rpm: 20, rpd: 20, signup: "https://cloud.sambanova.ai", note: "DeepSeek / Llama. Registration." },
  { id: "ovh", name: "OVHcloud AI Endpoints (no key needed)", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Meta-Llama-3_3-70B-Instruct", rpm: 2, rpd: 1000, signup: "https://endpoints.ai.cloud.ovh.net", note: "Works with no account at 2 requests/min (Llama 3.3 70B). A free key raises the limit.", keyless: true },
] as const;

for (const [i, p] of PRESETS.entries()) {
  const keyless = "keyless" in p && p.keyless ? 1 : 0;
  // Keyless providers start switched OFF: sending work to an outside server is the owner's call.
  sqlite.prepare(
    `INSERT INTO cloud_providers (id, name, base_url, model, rpm, rpd, priority, signup_url, note, keyless, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET signup_url = excluded.signup_url, note = excluded.note, keyless = excluded.keyless`,
  ).run(p.id, p.name, p.base, p.model, p.rpm, p.rpd, i, p.signup, p.note, keyless, keyless ? 0 : 1);
}

interface Row {
  id: string; name: string; base_url: string; api_key: string; model: string; enabled: number; rpm: number; rpd: number;
  priority: number; signup_url: string; note: string; used_day: string; used_count: number; last_error: string; keyless: number;
}
/** Usable: switched on, and has a key or doesn't need one. */
const usable = (r: Row) => !!r.enabled && (!!r.api_key || !!r.keyless);
const authHeaders = (r: Row): Record<string, string> => (r.api_key ? { Authorization: `Bearer ${r.api_key}` } : {});

export type CloudMode = "off" | "busy";
export function getCloudMode(): CloudMode {
  const v = (sqlite.prepare("SELECT value FROM cloud_settings WHERE key = 'mode'").get() as { value: string } | undefined)?.value;
  return v === "off" ? "off" : "busy";
}
export function setCloudMode(mode: CloudMode): void {
  sqlite.prepare("INSERT INTO cloud_settings (key, value) VALUES ('mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
}

const today = () => new Date().toISOString().slice(0, 10);
const minuteHits = new Map<string, number[]>();
const cooldownUntil = new Map<string, number>();

function rows(): Row[] {
  return sqlite.prepare("SELECT * FROM cloud_providers ORDER BY priority").all() as Row[];
}

/** For the Settings page — keys are never sent back, only whether one is set. */
export function listProviders() {
  return rows().map((r) => ({
    id: r.id, name: r.name, baseUrl: r.base_url, model: r.model, enabled: !!r.enabled, hasKey: !!r.api_key, keyless: !!r.keyless,
    rpm: r.rpm, rpd: r.rpd, signupUrl: r.signup_url, note: r.note,
    usedToday: r.used_day === today() ? r.used_count : 0, lastError: r.last_error,
    coolingDown: (cooldownUntil.get(r.id) ?? 0) > Date.now(),
  }));
}

export function updateProvider(id: string, patch: { apiKey?: string; model?: string; enabled?: boolean }): void {
  if (patch.apiKey !== undefined) sqlite.prepare("UPDATE cloud_providers SET api_key = ?, last_error = '' WHERE id = ?").run(patch.apiKey.trim(), id);
  if (patch.model !== undefined) sqlite.prepare("UPDATE cloud_providers SET model = ? WHERE id = ?").run(patch.model.trim(), id);
  if (patch.enabled !== undefined) sqlite.prepare("UPDATE cloud_providers SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
}

function row(id: string): Row | undefined {
  return sqlite.prepare("SELECT * FROM cloud_providers WHERE id = ?").get(id) as Row | undefined;
}

/** The provider's model list (needs a key), so the owner can pick from what's really offered. */
export async function providerModels(id: string): Promise<string[]> {
  const r = row(id);
  if (!r || (!r.api_key && !r.keyless)) return [];
  const res = await fetch(`${r.base_url}/models`, { headers: authHeaders(r), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${r.name}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as any;
  const ids: string[] = (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name ?? "")).filter(Boolean);
  return id === "openrouter" ? ids.filter((m) => m.endsWith(":free")) : ids;
}

/** Picks a sensible chat model when none is set: big instruct models first. */
async function ensureModel(r: Row): Promise<string> {
  if (r.model) return r.model;
  const ids = await providerModels(r.id).catch(() => []);
  const chatish = ids.filter((m) => !/embed|whisper|tts|audio|image|vision-only|guard|rerank|moderation/i.test(m));
  const pick = chatish.find((m) => /70b|72b|instruct|chat|deepseek|qwen|llama/i.test(m)) ?? chatish[0] ?? "";
  if (pick) sqlite.prepare("UPDATE cloud_providers SET model = ? WHERE id = ?").run(pick, r.id);
  return pick;
}

function withinLimits(r: Row): boolean {
  if ((cooldownUntil.get(r.id) ?? 0) > Date.now()) return false;
  const usedToday = r.used_day === today() ? r.used_count : 0;
  if (usedToday >= Math.floor(r.rpd * 0.9)) return false; // keep a margin under the published limit
  const recent = (minuteHits.get(r.id) ?? []).filter((t) => Date.now() - t < 60_000);
  minuteHits.set(r.id, recent);
  return recent.length < Math.max(1, Math.floor(r.rpm * 0.8));
}

function recordUse(r: Row): void {
  minuteHits.set(r.id, [...(minuteHits.get(r.id) ?? []), Date.now()]);
  if (r.used_day === today()) sqlite.prepare("UPDATE cloud_providers SET used_count = used_count + 1, last_error = '' WHERE id = ?").run(r.id);
  else sqlite.prepare("UPDATE cloud_providers SET used_day = ?, used_count = 1, last_error = '' WHERE id = ?").run(today(), r.id);
}

/** Ollama-style messages -> OpenAI chat format (tool calls need ids there). */
function toOpenAI(messages: OllamaMessage[]): unknown[] {
  const out: unknown[] = [];
  let pending: string[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const ids = m.tool_calls.map(() => `call_${++n}`);
      pending = [...ids];
      out.push({
        role: "assistant", content: m.content || null,
        tool_calls: m.tool_calls.map((c, i) => ({ id: ids[i], type: "function", function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })),
      });
    } else if (m.role === "tool") {
      const id = pending.shift();
      out.push(id ? { role: "tool", tool_call_id: id, content: m.content } : { role: "user", content: `Tool result:\n${m.content}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function fromOpenAI(msg: any): OllamaMessage {
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  return {
    role: "assistant",
    content: typeof msg?.content === "string" ? msg.content : "",
    ...(calls.length ? {
      tool_calls: calls.map((c: any) => {
        let args: Record<string, unknown> = {};
        try { args = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : (c.function?.arguments ?? {}); } catch { /* malformed — empty args */ }
        return { function: { name: String(c.function?.name ?? ""), arguments: args } };
      }),
    } : {}),
  };
}

export function cloudAvailable(): boolean {
  return getCloudMode() !== "off" && rows().some((r) => usable(r) && withinLimits(r));
}

/**
 * One chat turn on the best free provider with quota left. Returns null when
 * none can take it (no keys, all at their limits, or all failed) — the caller
 * then waits for the local GPU instead.
 */
export async function cloudChat(messages: OllamaMessage[], tools: OllamaToolDef[], opts: { format?: "json" } = {}): Promise<(OllamaChatResult & { provider: string }) | null> {
  if (getCloudMode() === "off") return null;
  if (messages.some((m) => m.images?.length)) return null; // images stay local
  for (const r of rows()) {
    if (!usable(r) || !withinLimits(r)) continue;
    try {
      const model = await ensureModel(r);
      if (!model) continue;
      recordUse(r);
      const res = await fetch(`${r.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(r) },
        body: JSON.stringify({
          model, messages: toOpenAI(messages), temperature: 0.7,
          ...(tools.length ? { tools, tool_choice: "auto" } : {}),
          ...(opts.format === "json" ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        // Rate limit or server trouble: rest this provider a while and try the next.
        cooldownUntil.set(r.id, Date.now() + (res.status === 429 ? 5 * 60_000 : 60_000));
        sqlite.prepare("UPDATE cloud_providers SET last_error = ? WHERE id = ?").run(`${res.status} ${body}`, r.id);
        continue;
      }
      const j = (await res.json()) as any;
      const msg = j.choices?.[0]?.message;
      if (!msg) continue;
      return { message: fromOpenAI(msg), done: true, provider: `${r.name} (${model})` };
    } catch (err) {
      cooldownUntil.set(r.id, Date.now() + 60_000);
      sqlite.prepare("UPDATE cloud_providers SET last_error = ? WHERE id = ?").run(String(err instanceof Error ? err.message : err).slice(0, 200), r.id);
      log(`cloud assist: ${r.name} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

/** Settings "Test" button: one tiny request to confirm the key works. */
export async function testProvider(id: string): Promise<string> {
  const r = row(id);
  if (!r || (!r.api_key && !r.keyless)) return "add an API key first";
  const model = await ensureModel(r);
  const res = await fetch(`${r.base_url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(r) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with just: ok" }], max_tokens: 5 }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    sqlite.prepare("UPDATE cloud_providers SET last_error = ? WHERE id = ?").run(`${res.status} ${text.slice(0, 200)}`, id);
    return `failed: ${res.status} ${text.slice(0, 160)}`;
  }
  recordUse(r);
  return `works — ${model} answered`;
}
