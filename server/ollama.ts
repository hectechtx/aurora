// Thin client for a local Ollama server (https://ollama.com). No API keys —
// this is the whole point: Ollama runs on the owner's own machine and this
// file just speaks its HTTP API.

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Base64-encoded image bytes, no "data:image/...;base64," prefix — Ollama's own multimodal format. */
  images?: string[];
  /** Reasoning-model chain-of-thought (qwen3.5, gemma4, etc.) — Ollama returns this as a separate field alongside `content` when the model supports it. Not sent back on subsequent turns, just surfaced for the owner's own "Thinking" transcript view. */
  thinking?: string;
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaChatResult {
  message: OllamaMessage;
  done: boolean;
}

import { gpuHeavyBusy, waitForGpu } from "./gpu";

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Context window AURORA asks Ollama for. This matters enormously on a single
 * consumer GPU: Ollama otherwise allocates a KV cache for the model's FULL
 * advertised context (128K+ on modern models), which balloons a 3.4GB model to
 * a ~14GB runtime footprint — most of it spilling out of 8GB of VRAM into
 * system RAM, driving the machine into constant paging. Confirmed live:
 * qwen3.5:4b went from 13.8GB total / 4.9GB on GPU at the default context to
 * comfortably GPU-resident once pinned here. 8K tokens is far more than the
 * rolling-compaction window (~40 messages) ever needs.
 */
const NUM_CTX = 8192;

/**
 * Rescues tool calls that a model emitted as plain text instead of in the
 * structured `tool_calls` field.
 *
 * Llama 3.1's native tool syntax is a bare JSON object shaped like
 * `{"type":"function","name":"x","parameters":{…}}`, and Ollama's template
 * normally parses that back out for us. It doesn't always: certain prompts
 * make the model wrap the calls in a markdown code fence, or emit several of
 * them newline-separated, and the parser gives up and hands the whole blob
 * back as `content`. The owner then sees a wall of raw JSON where the agent
 * should have acted — which is exactly what the Agents tab was showing.
 *
 * Rather than chase every template quirk, be tolerant on the way in: if there
 * are no structured tool calls but the content is (or contains) tool-call
 * JSON, convert it. This is a compatibility shim for local models, not a
 * parser for arbitrary text — it only fires when `tool_calls` is empty and
 * every extracted object has a name plus an arguments/parameters object, so
 * a reply that merely *discusses* JSON is left completely alone.
 */
export function salvageTextToolCalls(message: OllamaMessage | undefined, knownTools?: Set<string>): OllamaMessage {
  if (!message) return { role: "assistant", content: "" };
  if (message.tool_calls?.length) return message;

  const raw = message.content ?? "";
  // Strip markdown fences, which is how the model most often wraps them.
  const stripped = raw.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
  if (!stripped.startsWith("{")) return message;

  // Walk the string and pull out every balanced top-level {...} block, so
  // several concatenated/newline-separated calls all get picked up. Tracks
  // string state so a brace inside a message value doesn't break nesting.
  const blocks: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}") { if (--depth === 0 && start >= 0) blocks.push(stripped.slice(start, i + 1)); }
  }
  if (!blocks.length) return message;

  const calls: OllamaToolCall[] = [];
  for (const block of blocks) {
    let parsed: any;
    try { parsed = JSON.parse(block); } catch { return message; } // not really tool JSON — leave it be
    const name = parsed?.name ?? parsed?.function?.name;
    const args = parsed?.parameters ?? parsed?.arguments ?? parsed?.function?.arguments;
    if (typeof name !== "string" || !args || typeof args !== "object") return message;
    // Only salvage calls to tools that actually exist. Measured behaviour:
    // after a tool FAILS, the model reaches for an alternative and invents a
    // plausible-sounding name — "stablediffusion", "text_to_image" — emitted
    // as text. Converting those would manufacture calls to nothing, turning a
    // visible mess into an invisible one. Leaving them as content means the
    // owner sees the model floundering, which is the truth.
    if (knownTools && !knownTools.has(name)) return message;
    calls.push({ function: { name, arguments: args as Record<string, unknown> } });
  }

  // Content is dropped: it was the serialized calls, not anything for the owner.
  return { ...message, content: "", tool_calls: calls };
}

/**
 * Cleans a final text reply of tool-call JSON the model wrote as prose
 * instead of calling — e.g. `Here's my response: {"name": "generate_image",
 * "parameters": {"prompt": "a prompt for the image description"}}` or
 * `{"name": "None"}`. salvageTextToolCalls only converts replies that are
 * *entirely* call JSON; anything left over mid-sentence is never a real
 * action, so showing it to the owner is just noise. Only objects shaped like
 * a call (a string "name" plus parameters/arguments, or the literal "None"
 * non-call) are removed, along with the "here's my JSON response:" lead-in
 * that introduces them — a reply that merely discusses JSON is left alone.
 */
export function stripStrayToolJson(text: string): string {
  let out = text;
  let removed = false;
  // XML-ish pseudo calls some models write instead of calling (measured in a
  // pipeline's final script): <function_calls>…</function_calls>,
  // <tool_call>…</tool_call>, often inside a ```xml fence.
  const xmlCall = /```[a-z]*\s*<(function_calls|tool_call|tool_calls)>[\s\S]*?(<\/\1>\s*)?```|<(function_calls|tool_call|tool_calls)>[\s\S]*?<\/\3>/gi;
  if (xmlCall.test(out)) {
    out = out.replace(xmlCall, "");
    removed = true;
  }
  const re = /\{\s*"name"\s*:\s*"[^"]*"(?:[^{}]|\{[^{}]*\})*\}/g;
  out = out.replace(re, (block) => {
    try {
      const parsed = JSON.parse(block);
      const isCall = typeof parsed?.name === "string"
        && (parsed.name === "None" || typeof parsed.parameters === "object" || typeof parsed.arguments === "object");
      if (!isCall) return block;
      removed = true;
      return "";
    } catch {
      return block;
    }
  });
  if (!removed) return text;
  out = out.replace(/^.*\b(?:json )?(?:response|function call)\b[^\n]*:\s*$/gim, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export async function chat(host: string, model: string, messages: OllamaMessage[], tools: OllamaToolDef[], numCtx: number = NUM_CTX, opts: { think?: boolean; format?: "json"; cloudOk?: boolean } = {}): Promise<OllamaChatResult> {
  // While a heavy media job has the GPU (gpu.ts), don't fight it for VRAM:
  // background work goes to a free cloud provider if one has quota, and
  // everything else (and anything the cloud can't take) waits its turn.
  // Cloud models (":cloud") don't use the local GPU at all.
  if (gpuHeavyBusy() && !/:cloud$/.test(model)) {
    if (opts.cloudOk) {
      try {
        const { cloudChat } = await import("./cloud-llm");
        const r = await cloudChat(messages, tools, { format: opts.format });
        if (r) return { message: salvageTextToolCalls(r.message, new Set(tools.map((t) => t.function.name))), done: true };
      } catch { /* fall back to waiting for the local GPU */ }
    }
    await waitForGpu();
  }
  const body = JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, stream: false, options: { num_ctx: numCtx }, ...(opts.think !== undefined ? { think: opts.think } : {}), ...(opts.format ? { format: opts.format } : {}) });
  // On a single 8GB GPU, a burst of agent ticks can momentarily overwhelm
  // Ollama — a cold model load or VRAM pressure drops the connection, which
  // surfaces in Node as a low-level "fetch failed" (not an HTTP error). Those
  // are transient, so retry a couple of times with backoff before giving up.
  // HTTP errors (4xx/5xx with a body) are NOT retried — they're deterministic.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJson(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }, 120_000);
      return {
        message: salvageTextToolCalls(data.message, new Set(tools.map((t) => t.function.name))),
        done: data.done ?? true,
      };
    } catch (err) {
      lastErr = err;
      // Only retry genuine connection failures, not real Ollama HTTP errors.
      const msg = err instanceof Error ? err.message : String(err);
      const retriable = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|aborted|network/i.test(msg);
      if (!retriable || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function listModels(host: string): Promise<{ name: string; size: number }[]> {
  const data = await fetchJson(`${host}/api/tags`, undefined, 5_000);
  return (data.models ?? []).map((m: any) => ({ name: m.name, size: m.size }));
}

/** Whether a pulled model actually declares multimodal/vision support — Ollama's /api/show returns a `capabilities` array (e.g. ["completion","vision","tools"]) for this. Used so the Vision model picker in Settings doesn't let you pick a text-only model and get silently-wrong "no image provided" replies. */
export async function isVisionCapable(host: string, name: string): Promise<boolean> {
  try {
    const data = await fetchJson(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }, 5_000);
    return Array.isArray(data.capabilities) && data.capabilities.includes("vision");
  } catch {
    // If /api/show fails or an older Ollama doesn't return capabilities,
    // fail open — better to let a maybe-vision model through than to hide
    // every model because the capability check itself broke.
    return true;
  }
}

export async function listModelsWithVisionFlag(host: string): Promise<{ name: string; size: number; vision: boolean }[]> {
  const models = await listModels(host);
  const flags = await Promise.all(models.map((m) => isVisionCapable(host, m.name)));
  return models.map((m, i) => ({ ...m, vision: flags[i] }));
}

/**
 * Single-turn image analysis — deliberately its own call rather than folded
 * into the main tool-calling chat() loop, same reasoning as generate_image
 * being a one-shot call to its own model: a vision model doesn't need the
 * whole conversation, just the image and a question, and this lets you run
 * a small vision-only model separate from whatever's driving the actual
 * conversation.
 */
export async function analyzeImage(host: string, model: string, imageBase64: string, question: string, numCtx: number = NUM_CTX): Promise<string> {
  const data = await fetchJson(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: question || "Describe this image.", images: [imageBase64] }],
      stream: false,
      options: { num_ctx: numCtx },
    }),
  }, 120_000);
  return data.message?.content ?? "";
}

async function unloadModel(host: string, model: string): Promise<void> {
  await fetchJson(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }, 20_000);
}

/**
 * Forces Ollama to unload every model it currently has resident in VRAM,
 * right away instead of waiting out each one's normal keep-alive idle
 * timeout. Needed before video generation: on a single consumer GPU,
 * whatever's still loaded (the main chat model, but also possibly the
 * vision model, or a stale model left over from a config change) can leave
 * too little free VRAM for LTX-Video's checkpoint, which crashes hard (no
 * Python traceback, just a dead process) rather than failing cleanly — see
 * server/videogen.ts callers. Queries /api/ps rather than assuming
 * config.model is the only thing that could be loaded, since it isn't
 * always. Best-effort throughout: if this fails, video gen still runs, it
 * just risks the same VRAM contention.
 */
export async function unloadAllModels(host: string): Promise<void> {
  try {
    const data = await fetchJson(`${host}/api/ps`, undefined, 5_000);
    const names: string[] = (data.models ?? []).map((m: any) => m.name).filter(Boolean);
    await Promise.all(names.map((name) => unloadModel(host, name).catch(() => {})));
  } catch {
    /* best-effort */
  }
}

export async function health(host: string): Promise<boolean> {
  try {
    await fetchJson(`${host}/api/tags`, undefined, 3_000);
    return true;
  } catch {
    return false;
  }
}

// Pull progress is kept in-memory only — single-user local app, no need to
// persist it, and it's meaningless after a restart anyway.
export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
}

const pullState = new Map<string, PullProgress>();

export function getPullStatus(model: string): PullProgress | undefined {
  return pullState.get(model);
}

export async function pullModel(host: string, model: string): Promise<void> {
  pullState.set(model, { status: "starting", done: false });
  try {
    const res = await fetch(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama ${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          pullState.set(model, { status: obj.status ?? "working", completed: obj.completed, total: obj.total, done: false });
        } catch { /* ignore malformed progress line */ }
      }
    }
    pullState.set(model, { status: "success", done: true });
  } catch (err) {
    pullState.set(model, { status: "error", done: true, error: err instanceof Error ? err.message : String(err) });
  }
}
