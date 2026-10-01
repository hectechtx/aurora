// Local text/image-to-video with Wan 2.2 TI2V-5B, run through the ComfyUI
// server AURORA already uses for images (native Wan nodes, no custom nodes).
// Chosen for a 12GB card: the 5B model loads with weights cast to fp8, the
// UMT5 text encoder runs on the CPU (system RAM), and clips stay short
// (one action, ~2-5s) — image-to-video from a scene image gives far more
// consistent results than text-only video.
import fs from "node:fs";
import path from "node:path";
import { COMFYUI_DIR } from "./paths";
import { withHeavyGpu } from "./gpu";

const MODEL = "wan2.2_ti2v_5B_fp16.safetensors";
const TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
const VAE = "wan2.2_vae.safetensors";
const MODELS_DIR = path.join(COMFYUI_DIR, "repo", "models");
const FPS = 24;
const NEGATIVE =
  "blurry, low quality, static, frozen, jittery, flickering, deformed, distorted face, extra limbs, bad anatomy, " +
  "watermark, text, subtitles, scene change, cut, worst quality";

export class WanError extends Error {}

export function isWanInstalled(): boolean {
  return [
    path.join(MODELS_DIR, "diffusion_models", MODEL),
    path.join(MODELS_DIR, "text_encoders", TEXT_ENCODER),
    path.join(MODELS_DIR, "vae", VAE),
  ].every((f) => fs.existsSync(f));
}

async function json(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new WanError(`ComfyUI ${res.status} ${res.statusText}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

/** Uploads a start frame into ComfyUI's input folder and returns the name to reference. */
async function uploadImage(host: string, png: Buffer): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), `aurora-start-${Date.now()}.png`);
  form.append("overwrite", "true");
  const r = await json(`${host}/upload/image`, { method: "POST", body: form });
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

export interface WanOptions {
  prompt: string;
  /** Start frame for image-to-video — strongly recommended (consistency). */
  image?: Buffer;
  width?: number;    // multiples of 32; default 832 (landscape)
  height?: number;   // default 480
  seconds?: number;  // 1-5, default 3
  steps?: number;    // default 20
  ollamaHost?: string;
}

/** Renders one short clip and returns the MP4 bytes. */
async function generateWanVideoInner(host: string, opts: WanOptions): Promise<Buffer> {
  if (!isWanInstalled()) throw new WanError("Wan 2.2 isn't installed in ComfyUI yet.");
  if (opts.ollamaHost) {
    try { const { unloadAllModels } = await import("./ollama"); await unloadAllModels(opts.ollamaHost); } catch { /* best-effort */ }
  }
  const width = Math.round((opts.width ?? 832) / 32) * 32;
  const height = Math.round((opts.height ?? 480) / 32) * 32;
  // Wan's VAE packs time 4:1, so the frame count must be 4n+1.
  const length = Math.max(9, Math.round((Math.min(5, Math.max(1, opts.seconds ?? 3)) * FPS) / 4) * 4 + 1);
  const startImage = opts.image ? await uploadImage(host, opts.image) : null;

  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: MODEL, weight_dtype: "fp8_e4m3fn" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: TEXT_ENCODER, type: "wan", device: "cpu" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: VAE } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: opts.prompt, clip: ["3", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["3", 0] } },
    "8": { class_type: "Wan22ImageToVideoLatent", inputs: { vae: ["4", 0], width, height, length, batch_size: 1 } },
    "9": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 31), steps: opts.steps ?? 20, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1,
        model: ["2", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["8", 0],
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["4", 0] } },
    "11": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: FPS } },
    "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: "aurora/wan", format: "mp4", codec: "h264" } },
  };
  if (startImage) {
    graph["7"] = { class_type: "LoadImage", inputs: { image: startImage } };
    graph["8"].inputs.start_image = ["7", 0];
  }

  const queued = await json(`${host}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
  const id: string | undefined = queued?.prompt_id;
  if (!id) throw new WanError("ComfyUI didn't return a job id.");

  // First run also loads ~18GB of weights from disk, so allow plenty of time.
  const deadline = Date.now() + 40 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const history = await json(`${host}/history/${id}`, undefined, 15_000).catch(() => null);
    const entry = history?.[id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const msg = entry.status.messages?.find((m: any) => m[0] === "execution_error")?.[1]?.exception_message;
      throw new WanError(`Wan video failed: ${msg ?? "ComfyUI reported an execution error."}`);
    }
    const files = Object.values(entry.outputs ?? {}).flatMap((o: any) => [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]) as { filename: string; subfolder?: string; type?: string }[];
    const vid = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename));
    if (!vid) continue;
    const params = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder ?? "", type: vid.type ?? "output" });
    const res = await fetch(`${host}/view?${params}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new WanError(`Couldn't download the finished clip (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new WanError("Wan video timed out.");
}

/** Wan video with the GPU to itself (see gpu.ts) — local LLM calls wait or go to the cloud meanwhile. */
export function generateWanVideo(...args: Parameters<typeof generateWanVideoInner>): ReturnType<typeof generateWanVideoInner> {
  return withHeavyGpu("Wan video", () => generateWanVideoInner(...args)) as ReturnType<typeof generateWanVideoInner>;
}
