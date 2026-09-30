// Long-form narrated video: writes a scene-by-scene script with Ollama, then
// renders each scene (a generated image with Ken Burns motion, or a short
// AI video clip looped to length) with TTS narration, and stitches
// everything into one file with ffmpeg — optionally under quiet background
// music. This is how AURORA gets to multi-minute "engaging" video: LTX-Video
// itself tops out around 4-6s per generation (see videogen.ts), so a true
// single continuous multi-minute AI shot isn't something local hardware can
// do — chaining many short, narrated scenes is the realistic path to it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chat, type OllamaMessage } from "./ollama";
import { generateImage } from "./imagegen";
import { generateVideo, getFfmpegPath, isVideoGenInstalled } from "./videogen";
import { health as wangpHealth, generateVideo as wangpGenerateVideo } from "./wangp";
import { isKokoroInstalled, synthesize as kokoroSynthesize } from "./kokoro";
import { synthesize } from "./piper";
import { getMusicDir } from "./paths";

export class StoryboardError extends Error {}

export type SceneType = "image" | "video";
export interface Scene {
  narration: string;
  visualPrompt: string;
  type: SceneType;
}

export interface StoryboardHooks {
  onProgress?: (message: string) => void;
  /** Checked between scenes — cancellation is cooperative, so Stop takes effect once the in-flight scene finishes rather than mid-render. */
  shouldStop?: () => boolean;
}

export interface GenerateStoryboardOptions {
  topic: string;
  targetMinutes: number;
  mode: "images" | "video" | "hybrid";
  orientation: "landscape" | "portrait";
  voiceId: string;
  ollamaHost: string;
  ollamaModel: string;
  imageGenHost: string;
}

export interface StoryboardResult {
  buffer: Buffer;
  sceneCount: number;
  actualSeconds: number;
}

const WORDS_PER_MINUTE = 150; // rough average narration pace, used to size the script request
const FPS = 25;

// Strips ```json fences if the model wrapped its output despite instructions not to.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

async function planScenes(host: string, model: string, topic: string, targetMinutes: number, mode: "images" | "video" | "hybrid"): Promise<Scene[]> {
  const targetWords = Math.max(60, Math.round(targetMinutes * WORDS_PER_MINUTE));
  const sceneCount = Math.max(6, Math.min(60, Math.round((targetMinutes * 60) / 7)));
  const typeInstruction =
    mode === "images" ? 'Set "type" to "image" for every scene.'
    : mode === "video" ? 'Set "type" to "video" for every scene.'
    : 'Mix "type" — use "video" for roughly 1 in 4 scenes (the most dynamic or important moments), "image" for the rest.';

  const systemPrompt =
    "You are a scriptwriter for a narrated video. Given a topic, write a scene-by-scene script for an engaging, " +
    `well-structured video totaling roughly ${targetWords} spoken words (about ${targetMinutes} minutes at a natural ` +
    `pace), split into about ${sceneCount} scenes. Respond with ONLY a JSON object (no markdown fences, no ` +
    'commentary) of the exact shape: {"scenes":[{"narration":"...","visualPrompt":"...","type":"image"}]}\n' +
    "Rules:\n" +
    '- "narration" is a natural-sounding spoken paragraph for that scene (roughly 15-30 words) — no stage directions or scene labels, just what\'s said aloud.\n' +
    '- "visualPrompt" is a short visual description for an image/video generator to depict that scene (subject, setting, mood) — not text or words to render on screen.\n' +
    `- ${typeInstruction}\n` +
    "- Keep the whole script coherent and build toward a clear point, with a real hook in the first scene and a real closing in the last.\n" +
    "- Respond with the JSON object and nothing else.";

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: topic },
  ];
  const result = await chat(host, model, messages, []);
  const jsonText = extractJson(result.message.content ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new StoryboardError("The model didn't return a valid script. Try a more specific topic, or a different model.");
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).scenes : undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new StoryboardError("The model didn't generate any scenes.");
  const scenes: Scene[] = raw
    .filter((s): s is { narration: string; visualPrompt: string; type?: string } =>
      !!s && typeof s === "object" && typeof (s as any).narration === "string" && typeof (s as any).visualPrompt === "string" && (s as any).narration.trim())
    .map((s) => ({ narration: s.narration.trim(), visualPrompt: s.visualPrompt.trim(), type: s.type === "video" ? "video" as const : "image" as const }));
  if (scenes.length === 0) throw new StoryboardError("The model's scenes were malformed.");
  return scenes;
}

/** Duration of a PCM WAV buffer, read straight from its RIFF header — no ffprobe needed. */
function wavDurationSeconds(buf: Buffer): number {
  let offset = 12; // past "RIFF" + size(4) + "WAVE"
  let sampleRate = 22050, channels = 1, bitsPerSample = 16, dataSize = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSecond > 0 ? dataSize / bytesPerSecond : 0;
}

function runFfmpeg(args: string[], timeoutMs = 180_000): Promise<void> {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return Promise.reject(new StoryboardError("ffmpeg wasn't found — set up video generation in Settings first (it bundles ffmpeg)."));
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new StoryboardError(`ffmpeg failed: ${stderr.slice(-1500) || err.message}`));
      resolve();
    });
  });
}

/** Picks a random track from the owner's configured music folder, or null if none is set up — background music is a nice-to-have, not a requirement. */
function pickMusicTrack(): string | null {
  const dir = getMusicDir();
  if (!dir) return null;
  const exts = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
  try {
    const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase()));
    if (files.length === 0) return null;
    return path.join(dir, files[Math.floor(Math.random() * files.length)]);
  } catch {
    return null;
  }
}

/**
 * Narrates one scene, routing to whichever TTS engine the chosen voice belongs
 * to. Kokoro voice ids are prefixed a/b (accent) + f/m (gender) — af_heart,
 * bm_george — which is unambiguous against Piper's locale-style ids
 * (en_US-amy-medium), so the id alone picks the engine.
 *
 * Long-form video narrated with Piper is exactly the flat, robotic delivery the
 * owner asked to get away from; Kokoro is the whole reason that work happened.
 * Falls back to Piper on failure rather than losing a multi-minute render.
 */
async function synthesizeNarration(text: string, voiceId: string): Promise<Buffer> {
  if (/^[ab][fm]_/.test(voiceId) && isKokoroInstalled()) {
    try {
      return await kokoroSynthesize(text, voiceId);
    } catch {
      // Fall through — a broken Kokoro shouldn't cost the whole video.
    }
  }
  return synthesize(text, voiceId);
}

async function renderScene(
  scene: Scene, index: number, workDir: string,
  opts: GenerateStoryboardOptions, width: number, height: number, clipWidth: number, clipHeight: number,
): Promise<{ segmentPath: string; duration: number }> {
  const narrationBuf = await synthesizeNarration(scene.narration, opts.voiceId);
  const narrationPath = path.join(workDir, `narr-${index}.wav`);
  fs.writeFileSync(narrationPath, narrationBuf);
  const duration = Math.max(2, wavDurationSeconds(narrationBuf) + 0.6);
  const segmentPath = path.join(workDir, `scene-${index}.mp4`);

  const clipBuffer = scene.type === "video" ? await renderSceneClip(scene, clipWidth, clipHeight, opts) : null;
  if (clipBuffer) {
    const clipPath = path.join(workDir, `clip-${index}.mp4`);
    fs.writeFileSync(clipPath, clipBuffer);
    // The AI clip is only ~1s — loop it to fill the narration's duration
    // rather than freezing on the last frame, so there's still motion
    // throughout the scene.
    await runFfmpeg([
      "-y", "-stream_loop", "-1", "-i", clipPath, "-i", narrationPath, "-t", duration.toFixed(2),
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${FPS}`,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", segmentPath,
    ]);
  } else {
    const { pngBuffer } = await generateImage(opts.imageGenHost, scene.visualPrompt, opts.ollamaHost);
    const imgPath = path.join(workDir, `img-${index}.png`);
    fs.writeFileSync(imgPath, pngBuffer);
    // Slow Ken Burns zoom over a 2x-oversized source frame (softer/steadier
    // than zoompan driving straight off the source resolution).
    await runFfmpeg([
      "-y", "-loop", "1", "-i", imgPath, "-i", narrationPath, "-t", duration.toFixed(2),
      "-filter_complex",
      `[0:v]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},` +
      `zoompan=z='min(zoom+0.0012,1.2)':d=1:s=${width}x${height}:fps=${FPS},format=yuv420p[v]`,
      "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", segmentPath,
    ]);
  }
  return { segmentPath, duration };
}

/**
 * Renders one animated scene clip, preferring WanGP.
 *
 * The LTX path below cannot run on this machine — its fp32 T5 encoder is
 * 17.9GB against 15.7GB of RAM, and it dies at "Loading checkpoint shards:
 * 50%". That failure is what surfaced in the Long-form Video panel as a wall
 * of red text. WanGP does the same job within the available memory.
 *
 * Returns null rather than throwing when no video backend is usable, so the
 * caller falls back to a Ken Burns still instead of failing the whole render —
 * one unavailable clip shouldn't cost the owner a multi-minute video.
 */
async function renderSceneClip(
  scene: Scene, clipWidth: number, clipHeight: number, opts: GenerateStoryboardOptions,
): Promise<Buffer | null> {
  if (await wangpHealth()) {
    try {
      // WanGP takes frame counts, and its resolution string wants even dims.
      const { buffer } = await wangpGenerateVideo({
        prompt: scene.visualPrompt,
        resolution: `${clipWidth}x${clipHeight}`,
        frames: 25,
      });
      return buffer;
    } catch {
      // Fall through to LTX, then to a still.
    }
  }
  if (isVideoGenInstalled()) {
    try {
      return await generateVideo({ prompt: scene.visualPrompt, width: clipWidth, height: clipHeight, numFrames: 25, ollamaHost: opts.ollamaHost });
    } catch {
      return null;
    }
  }
  return null;
}

export async function generateStoryboard(opts: GenerateStoryboardOptions, hooks: StoryboardHooks = {}): Promise<StoryboardResult> {
  const { onProgress, shouldStop } = hooks;
  // Pure-video mode needs *a* working clip generator; hybrid/slideshow can
  // always fall back to stills.
  if (opts.mode === "video" && !(await wangpHealth()) && !isVideoGenInstalled()) {
    throw new StoryboardError("Video mode needs a video backend running — start WanGP in Pinokio, or pick Slideshow/Hybrid instead.");
  }

  onProgress?.("Writing the script…");
  const scenes = await planScenes(opts.ollamaHost, opts.ollamaModel, opts.topic, opts.targetMinutes, opts.mode);

  const workDir = path.join(os.tmpdir(), `storyboard-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const [width, height] = opts.orientation === "portrait" ? [540, 960] : [960, 540];
  const [clipWidth, clipHeight] = opts.orientation === "portrait" ? [320, 512] : [512, 320];

  try {
    const segments: string[] = [];
    let actualSeconds = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (shouldStop?.()) throw new StoryboardError("Stopped by owner.");
      onProgress?.(`Rendering scene ${i + 1} of ${scenes.length}…`);
      const { segmentPath, duration } = await renderScene(scenes[i], i, workDir, opts, width, height, clipWidth, clipHeight);
      segments.push(segmentPath);
      actualSeconds += duration;
    }

    onProgress?.("Assembling the final video…");
    const listPath = path.join(workDir, "concat.txt");
    fs.writeFileSync(listPath, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    const concatPath = path.join(workDir, "concat.mp4");
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", concatPath], 300_000);

    const musicPath = pickMusicTrack();
    const outPath = path.join(workDir, "final.mp4");
    if (musicPath) {
      onProgress?.("Mixing in background music…");
      await runFfmpeg([
        "-y", "-i", concatPath, "-stream_loop", "-1", "-i", musicPath,
        "-filter_complex", "[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", outPath,
      ], 300_000);
    } else {
      fs.copyFileSync(concatPath, outPath);
    }

    return { buffer: fs.readFileSync(outPath), sceneCount: scenes.length, actualSeconds };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}
