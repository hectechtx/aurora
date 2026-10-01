// Talking characters with HuMo 1.7B (ByteDance, Apache-2.0), run through the
// ComfyUI server AURORA already uses — native nodes, no custom installs. Given
// a reference image of a character and a voice clip, it renders that
// character speaking the clip with matching lip movement. Small enough
// (3.5GB) for a 12GB card; each run covers up to ~4s, so longer voiceovers
// are rendered in chunks and joined (see talent.ts).
import fs from "node:fs";
import path from "node:path";
import { COMFYUI_DIR } from "./paths";

const MODEL = "humo_1.7B_fp16.safetensors";
const AUDIO_ENCODER = "whisper_large_v3_fp16.safetensors";
const TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
const VAE = "wan_2.1_vae.safetensors";
const MODELS_DIR = path.join(COMFYUI_DIR, "repo", "models");
const INPUT_DIR = path.join(COMFYUI_DIR, "repo", "input");
export const HUMO_FPS = 25;
/** Longest clip HuMo renders in one go (97 frames at 25fps). */
export const HUMO_MAX_SECONDS = 3.84;
const NEGATIVE =
  "blurry, low quality, static, frozen face, closed mouth, jittery, flickering, deformed, distorted face, extra limbs, bad anatomy, " +
  "watermark, text, subtitles, scene change, cut, worst quality, extra people";

export class HumoError extends Error {}

export function isHumoInstalled(): boolean {
  return [
    path.join(MODELS_DIR, "diffusion_models", MODEL),
    path.join(MODELS_DIR, "audio_encoders", AUDIO_ENCODER),
    path.join(MODELS_DIR, "text_encoders", TEXT_ENCODER),
    path.join(MODELS_DIR, "vae", VAE),
  ].every((f) => fs.existsSync(f));
}

async function json(url: string, init?: RequestInit, timeoutMs = 30_000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new HumoError(`ComfyUI ${res.status} ${res.statusText}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

async function uploadImage(host: string, png: Buffer): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), `aurora-ref-${Date.now()}.png`);
  form.append("overwrite", "true");
  const r = await json(`${host}/upload/image`, { method: "POST", body: form });
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

export interface HumoOptions {
  /** What's happening, e.g. "a young woman talking excitedly to the camera in a cozy streaming room". */
  prompt: string;
  /** The character's reference picture. */
  image: Buffer;
  /** The speech for this clip (WAV), at most ~3.8s. */
  audio: Buffer;
  /** Clip length in seconds (defaults to the audio's length). */
  seconds: number;
  width?: number;   // default 480 (vertical)
  height?: number;  // default 832
  steps?: number;   // default 30
  ollamaHost?: string;
}

/** Renders one lip-synced clip and returns the MP4 bytes (with the audio). */
export async function generateHumoClip(host: string, opts: HumoOptions): Promise<Buffer> {
  if (!isHumoInstalled()) throw new HumoError("HuMo isn't installed in ComfyUI yet.");
  if (opts.ollamaHost) {
    try { const { unloadAllModels } = await import("./ollama"); await unloadAllModels(opts.ollamaHost); } catch { /* best-effort */ }
  }
  const width = Math.round((opts.width ?? 480) / 16) * 16;
  const height = Math.round((opts.height ?? 832) / 16) * 16;
  // Wan-family latents pack time 4:1, so frame counts are 4n+1.
  const frames = Math.min(97, Math.max(9, Math.round((Math.min(opts.seconds, HUMO_MAX_SECONDS) * HUMO_FPS) / 4) * 4 + 1));
  const image = await uploadImage(host, opts.image);
  // LoadAudio reads ComfyUI's input folder, which is on this machine.
  fs.mkdirSync(INPUT_DIR, { recursive: true });
  const audioName = `aurora-voice-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`;
  fs.writeFileSync(path.join(INPUT_DIR, audioName), opts.audio);

  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: MODEL, weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 8 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: TEXT_ENCODER, type: "wan", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: VAE } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: opts.prompt, clip: ["3", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["3", 0] } },
    "7": { class_type: "LoadImage", inputs: { image } },
    "8": { class_type: "LoadAudio", inputs: { audio: audioName } },
    "9": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: AUDIO_ENCODER } },
    "10": { class_type: "AudioEncoderEncode", inputs: { audio_encoder: ["9", 0], audio: ["8", 0] } },
    "11": {
      class_type: "WanHuMoImageToVideo",
      inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["4", 0], width, height, length: frames, batch_size: 1, audio_encoder_output: ["10", 0], ref_image: ["7", 0] },
    },
    "12": {
      class_type: "KSampler",
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 31), steps: opts.steps ?? 30, cfg: 5, sampler_name: "uni_pc", scheduler: "simple", denoise: 1,
        model: ["2", 0], positive: ["11", 0], negative: ["11", 1], latent_image: ["11", 2],
      },
    },
    "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["4", 0] } },
    "14": { class_type: "CreateVideo", inputs: { images: ["13", 0], fps: HUMO_FPS, audio: ["8", 0] } },
    "15": { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: "aurora/humo", format: "mp4", codec: "h264" } },
  };

  try {
    const queued = await json(`${host}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
    const id: string | undefined = queued?.prompt_id;
    if (!id) throw new HumoError("ComfyUI didn't return a job id.");
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const history = await json(`${host}/history/${id}`, undefined, 15_000).catch(() => null);
      const entry = history?.[id];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        const msg = entry.status.messages?.find((m: any) => m[0] === "execution_error")?.[1]?.exception_message;
        throw new HumoError(`Talking clip failed: ${msg ?? "ComfyUI reported an execution error."}`);
      }
      const files = Object.values(entry.outputs ?? {}).flatMap((o: any) => [...(o.images ?? []), ...(o.videos ?? []), ...(o.gifs ?? [])]) as { filename: string; subfolder?: string; type?: string }[];
      const vid = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename));
      if (!vid) continue;
      const params = new URLSearchParams({ filename: vid.filename, subfolder: vid.subfolder ?? "", type: vid.type ?? "output" });
      const res = await fetch(`${host}/view?${params}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new HumoError(`Couldn't download the finished clip (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    }
    throw new HumoError("Talking clip timed out.");
  } finally {
    try { fs.unlinkSync(path.join(INPUT_DIR, audioName)); } catch { /* already gone */ }
  }
}
