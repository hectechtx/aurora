// Thin client for a local ComfyUI server. Same spirit as ollama.ts: no API
// keys, nothing hosted — if it isn't running, image generation reports
// unavailable rather than falling back to a paid API.
//
// This used to target Automatic1111. A1111 v1.10.1 (July 2024) has since
// rotted out from under us in two independent ways: it pins torch==2.1.2,
// which PyTorch removed from their index, and it clones
// Stability-AI/stablediffusion at startup, which Stability deleted from
// GitHub (404). Both had to be patched around just to reach a launch attempt,
// and the second has no fix that doesn't involve trusting a stranger's fork
// of deleted code. ComfyUI is actively maintained, supports the cu128 builds
// this machine's Blackwell card actually needs, and loads the same
// checkpoints — so the backend moved rather than being propped up.
//
// ComfyUI has no "just give me an image from this prompt" endpoint; it runs
// node graphs. So a minimal txt2img graph is built here per request. That's
// more verbose than A1111's txt2img call, but it's also why the GGUF/Flux and
// video node packs become available later without another rewrite.

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Image gen server ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function health(host: string): Promise<boolean> {
  if (!host) return false;
  try {
    // /system_stats is ComfyUI's cheapest always-present endpoint.
    await fetchJson(`${host}/system_stats`, undefined, 3_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * The checkpoints ComfyUI can see. Used to pick a default and to surface the
 * list in Settings.
 *
 * `throwOnUnreachable` exists because conflating "the server didn't answer"
 * with "the server has no checkpoints" produced a genuinely misleading bug:
 * when the external data drive dropped off the bus, this swallowed the
 * connection failure, returned [], and generateImage told the owner to "drop a
 * .safetensors file in models/checkpoints" — pointing at a folder on a drive
 * that no longer existed, while the real cause was hardware. Callers that can
 * report a useful error should pass true; the Settings list still degrades
 * quietly to an empty array.
 */
export async function listCheckpoints(host: string, throwOnUnreachable = false): Promise<string[]> {
  try {
    // Bumped from 5s: this endpoint serializes every loaded node's schema and
    // can genuinely take several seconds while the machine is under load.
    const info = await fetchJson(`${host}/object_info/CheckpointLoaderSimple`, undefined, 20_000);
    const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(names) ? names : [];
  } catch (err) {
    if (throwOnUnreachable) {
      throw new Error(
        `Couldn't reach the image server at ${host} to list checkpoints — is ComfyUI running, and is the drive holding its models still connected? (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    return [];
  }
}

export interface GeneratedImage {
  pngBuffer: Buffer;
}

/**
 * A minimal txt2img graph: load checkpoint → encode positive/negative prompts
 * → empty latent → sample → decode → save.
 *
 * SDXL wants 1024², SD1.5 degrades badly above ~768 (it starts duplicating
 * heads and limbs), so the resolution follows the checkpoint rather than
 * being one fixed number for both.
 */
function buildWorkflow(prompt: string, ckpt: string, seed: number) {
  const isXl = /xl/i.test(ckpt);
  const size = isXl ? 1024 : 512;
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "lowres, blurry, watermark, text, deformed", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: size, height: size, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed, steps: 20, cfg: 7, sampler_name: "euler_ancestral", scheduler: "normal", denoise: 1,
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "aurora", images: ["6", 0] } },
  };
}

/**
 * Queues a txt2img job and waits for the rendered PNG.
 *
 * `ollamaHost` matters on a single consumer GPU: an 8B model already occupies
 * ~6.9GB of an 8GB card, leaving the image model nowhere to load its weights,
 * so generation fails or crawls even though the server is up. Video gen has
 * always unloaded Ollama first (see videogen.ts); image gen didn't, which was
 * one of the reasons image calls looked "randomly" broken. Best-effort — a
 * failed unload shouldn't block the attempt.
 */
export async function generateImage(host: string, prompt: string, ollamaHost?: string): Promise<GeneratedImage> {
  if (ollamaHost) {
    try {
      const { unloadAllModels } = await import("./ollama");
      await unloadAllModels(ollamaHost);
    } catch { /* best-effort */ }
  }

  // Throws with a real diagnosis if ComfyUI is unreachable, so an empty list
  // here genuinely means "connected, but no checkpoints".
  const checkpoints = await listCheckpoints(host, true);
  if (!checkpoints.length) {
    throw new Error("ComfyUI is running but reports no checkpoints — check that the drive holding models/Stable-diffusion is connected.");
  }
  // Prefer the smaller SD1.5-class checkpoint by default: on 8GB it renders in
  // seconds where SDXL takes the better part of a minute.
  const ckpt = checkpoints.find((c) => !/xl/i.test(c)) ?? checkpoints[0];
  const seed = Math.floor(Math.random() * 2 ** 31);

  const queued = await fetchJson(`${host}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: buildWorkflow(prompt, ckpt, seed) }),
  }, 30_000);

  const promptId: string | undefined = queued?.prompt_id;
  if (!promptId) throw new Error("ComfyUI accepted the request but didn't return a job id.");

  // ComfyUI reports completion over a websocket, but polling /history keeps
  // this dependency-free and a render is seconds-to-minutes, so a 1s poll adds
  // nothing measurable. 5 minutes covers a cold SDXL load on a busy card.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const history = await fetchJson(`${host}/history/${promptId}`, undefined, 10_000).catch(() => null);
    const entry = history?.[promptId];
    if (!entry) continue;

    const status = entry.status;
    if (status?.status_str === "error") {
      const msg = status.messages?.find((m: any) => m[0] === "execution_error")?.[1]?.exception_message;
      throw new Error(`Image generation failed: ${msg ?? "ComfyUI reported an execution error."}`);
    }

    const images = Object.values(entry.outputs ?? {}).flatMap((o: any) => o.images ?? []);
    if (!images.length) continue;

    const img = images[0] as { filename: string; subfolder: string; type: string };
    const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
    const res = await fetch(`${host}/view?${params}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Couldn't download the finished image (${res.status} ${res.statusText}).`);
    return { pngBuffer: Buffer.from(await res.arrayBuffer()) };
  }

  throw new Error("Image generation timed out.");
}
