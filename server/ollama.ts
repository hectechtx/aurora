// Thin client for a local Ollama server (https://ollama.com). No API keys —
// this is the whole point: Ollama runs on the owner's own machine and this
// file just speaks its HTTP API.

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
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

export async function chat(host: string, model: string, messages: OllamaMessage[], tools: OllamaToolDef[]): Promise<OllamaChatResult> {
  const data = await fetchJson(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined, stream: false }),
  }, 120_000);
  return { message: data.message, done: data.done ?? true };
}

export async function listModels(host: string): Promise<{ name: string; size: number }[]> {
  const data = await fetchJson(`${host}/api/tags`, undefined, 5_000);
  return (data.models ?? []).map((m: any) => ({ name: m.name, size: m.size }));
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
