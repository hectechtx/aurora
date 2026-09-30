// Video generation via WanGP (github.com/deepbeepmeep/Wan2GP), spoken to over
// its MCP API.
//
// This replaces the direct LTX-Video path in videogen.ts, which cannot run on
// this machine at all: LTX's pipeline config uses a T5-XXL text encoder stored
// as fp32 — 9.4GB + 8.5GB of shards, 17.9GB total, against 15.7GB of system
// RAM. It dies at "Loading checkpoint shards: 50%", killed by the OS with no
// traceback, and no resolution or frame-count reduction helps because the
// encoder loads before any of that matters.
//
// WanGP solves the same problem properly: quantized weights, aggressive
// CPU offloading, and small models (t2v_1.3B is 1.3B params against LTX's
// 22B). Verified end to end on this hardware — a real 832x480 h264 clip.
//
// IMPORTANT: WanGP's MCP server is off by default. Its Pinokio launcher runs
// `python wgp.py --multiple-images`; the flags below have to be appended to
// that command in F:\pinokio\api\wan\start.js for any of this to work:
//   --mcp --mcp-transport streamable-http --mcp-host 127.0.0.1 --mcp-port 7866
// Without them there's no practical programmatic control at all — the Gradio
// surface exposes 582 auto-generated endpoints with no clean generation entry
// point, and synthetic clicks on its Generate button do nothing.
import fs from "node:fs";

export class WanGpError extends Error {}

// Trailing slash matters: /mcp issues a 307 redirect, which turns a POST into
// a GET on some clients and silently loses the body.
export const DEFAULT_WANGP_HOST = "http://127.0.0.1:7866/mcp/";

// Small, text-only, and proven on this box. The 14B/22B models exist in the
// same catalogue but are a poor default for 8GB VRAM + 15.7GB RAM.
export const DEFAULT_MODEL = "t2v_1.3B";

let requestId = 1;

async function mcpCall(host: string, name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(host, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new WanGpError(`WanGP ${res.status} ${res.statusText}`);

  const payload = await res.json();
  if (payload.error) throw new WanGpError(payload.error.message ?? "WanGP returned an error");

  const blocks = payload?.result?.content ?? [];
  const text = blocks[0]?.text;
  if (typeof text !== "string") throw new WanGpError("WanGP returned an unexpected response shape.");

  // The tool reports its own failures as plain text rather than a JSON-RPC
  // error, so a parse failure here is usually a real message worth surfacing.
  try {
    return JSON.parse(text);
  } catch {
    throw new WanGpError(text.slice(0, 300));
  }
}

/** Whether WanGP's MCP server is reachable. Cheap enough to call on a status route. */
export async function health(host = DEFAULT_WANGP_HOST): Promise<boolean> {
  try {
    const res = await fetch(host, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "aurora", version: "1.0" } },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return j?.result?.serverInfo?.name === "WanGP";
  } catch {
    return false;
  }
}

export interface GenerateVideoOptions {
  prompt: string;
  model?: string;
  /** WanGP wants "WIDTHxHEIGHT". 832x480 is the native size for t2v_1.3B. */
  resolution?: string;
  /** Frames, not seconds — 16 frames ≈ 1s. 33 ≈ 2s, which is a sane default on this hardware. */
  frames?: number;
  steps?: number;
  seed?: number;
}

export interface GenerateVideoHooks {
  /** Progress text for the "running…" card, so a multi-minute render doesn't look dead. */
  onProgress?: (line: string) => void;
}

/**
 * Submits a generation and waits for the finished file, returning its bytes.
 *
 * The first call for any given model downloads its weights (~10GB for
 * t2v_1.3B), which can take a long time with no visible GPU activity — hence
 * the generous ceiling and the progress plumbing.
 */
export async function generateVideo(
  opts: GenerateVideoOptions,
  hooks: GenerateVideoHooks = {},
  host = DEFAULT_WANGP_HOST,
): Promise<{ buffer: Buffer; filePath: string }> {
  // The argument really is `source` — passing `settings` fails Pydantic
  // validation with "Field required [type=missing]".
  const source: Record<string, unknown> = {
    model_type: opts.model ?? DEFAULT_MODEL,
    prompt: opts.prompt,
    resolution: opts.resolution ?? "832x480",
    video_length: opts.frames ?? 33,
    num_inference_steps: opts.steps ?? 15,
  };
  if (opts.seed !== undefined) source.seed = opts.seed;

  const started = await mcpCall(host, "wangp_generate", { source }, 120_000);
  const jobId: string | undefined = started?.job_id;
  if (!jobId) throw new WanGpError("WanGP accepted the request but didn't return a job id.");

  // 45 minutes: a first-run weight download plus a render legitimately takes
  // far longer than a warm generation, and killing a working job because a
  // fixed wall-clock elapsed is exactly the mistake videogen.ts had to fix.
  const deadline = Date.now() + 45 * 60_000;
  let lastProgress = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));

    let job: any;
    try {
      job = await mcpCall(host, "wangp_get_job", { job_id: jobId }, 30_000);
    } catch {
      continue; // transient — keep polling rather than abandoning a live job
    }

    // Surface the newest real progress event, throttled.
    const events: any[] = job?.events ?? [];
    const progress = [...events].reverse().find((e) => e.kind === "progress");
    if (progress && hooks.onProgress && Date.now() - lastProgress > 4_000) {
      lastProgress = Date.now();
      const d = progress.data ?? {};
      hooks.onProgress(`${d.status ?? d.raw_phase ?? "working"}${d.progress != null ? ` (${d.progress}%)` : ""}`);
    }

    if (!job?.done) continue;

    const result = job.result ?? {};
    if (result.success === false || (result.errors ?? []).length) {
      throw new WanGpError(`Video generation failed: ${(result.errors ?? []).join("; ") || "WanGP reported a failure."}`);
    }
    if (result.cancelled) throw new WanGpError("Video generation was cancelled.");

    const files: string[] = result.generated_files ?? [];
    if (!files.length) throw new WanGpError("WanGP finished but produced no video file.");

    const filePath = files[0];
    // WanGP writes into its own outputs folder; AURORA copies the bytes into
    // the Library rather than referencing a path inside another app's tree.
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, filePath };
  }

  // Best-effort: don't leave a runaway job occupying the GPU.
  try { await mcpCall(host, "wangp_cancel_job", { job_id: jobId }, 10_000); } catch { /* ignore */ }
  throw new WanGpError("Video generation timed out.");
}
