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
import { isWanInstalled, generateWanVideo } from "./wanvideo";

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
  /** A finished script to produce instead of writing one from `topic` — its wording is kept as the narration. */
  script?: string;
  /** Burn captions (the narration, a few words at a time) into the video — what shorts/kids content expects. */
  captions?: boolean;
  /** One visual style applied to every scene (e.g. "bright colorful 3D cartoon") so a channel looks consistent. */
  visualStyle?: string;
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

async function planScenes(host: string, model: string, topic: string, targetMinutes: number, mode: "images" | "video" | "hybrid", script?: string): Promise<Scene[]> {
  const targetWords = Math.max(60, Math.round(targetMinutes * WORDS_PER_MINUTE));
  const sceneCount = Math.max(6, Math.min(60, Math.round((targetMinutes * 60) / 7)));
  if (script?.trim()) {
    // Produce an existing script (e.g. from the studio's scriptwriter)
    // rather than writing a new one — keep its words, just split it into
    // scenes and add visuals.
    topic =
      "Adapt this finished script into narrated scenes. Keep its spoken words as the narration (drop stage directions, " +
      "timestamps and speaker labels), in order, and write a visualPrompt for each scene. The script:\n\n" + script.trim().slice(0, 12_000);
  }
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
  // Thinking off + Ollama's JSON mode: a thinking model otherwise tends to put
  // the script inside its reasoning and return no parseable JSON at all.
  const result = await chat(host, model, messages, [], 8192, { think: false, format: "json" });
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

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Narration split into ~6-word captions, spread evenly across each scene's span. */
function captionsSrt(scenes: { start: number; duration: number; narration: string }[]): string {
  const cues: string[] = [];
  let n = 1;
  for (const sc of scenes) {
    const words = sc.narration.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 6) chunks.push(words.slice(i, i + 6).join(" "));
    const speak = Math.max(0.5, sc.duration - 0.6); // the scene's trailing 0.6s pad is silence
    chunks.forEach((text, i) => {
      const a = sc.start + (speak / chunks.length) * i;
      const b = sc.start + (speak / chunks.length) * (i + 1);
      cues.push(`${n++}\n${srtTime(a)} --> ${srtTime(b)}\n${text}\n`);
    });
  }
  return cues.join("\n");
}

export function runFfmpeg(args: string[], timeoutMs = 180_000, cwd?: string): Promise<void> {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return Promise.reject(new StoryboardError("ffmpeg wasn't found — set up video generation in Settings first (it bundles ffmpeg)."));
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 20, windowsHide: true, cwd }, (err, _stdout, stderr) => {
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
    // Only tracks that can actually be read: OneDrive "online-only"
    // placeholders list fine but fail to open, which made ffmpeg (and with it
    // a whole finished video render) fail with "Invalid argument".
    const readable = (f: string) => {
      try {
        const fd = fs.openSync(path.join(dir, f), "r");
        try { return fs.readSync(fd, Buffer.alloc(16), 0, 16, 0) === 16; } finally { fs.closeSync(fd); }
      } catch { return false; }
    };
    const files = fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase())).sort(() => Math.random() - 0.5);
    const pick = files.slice(0, 12).find(readable);
    return pick ? path.join(dir, pick) : null;
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
    // Play the clip once, then hold its last frame for the rest of the
    // narration — looping a 4s Wan clip visibly repeats the same motion.
    await runFfmpeg([
      "-y", "-i", clipPath, "-i", narrationPath, "-t", duration.toFixed(2),
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${FPS},tpad=stop_mode=clone:stop_duration=${Math.ceil(duration)}`,
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
  // Preferred: Wan 2.2 in ComfyUI, image-to-video — make the scene's image
  // first, then animate it (far more consistent than text-only video).
  if (isWanInstalled() && opts.imageGenHost) {
    try {
      const { pngBuffer } = await generateImage(opts.imageGenHost, scene.visualPrompt, opts.ollamaHost);
      const portrait = opts.orientation === "portrait";
      return await generateWanVideo(opts.imageGenHost, {
        prompt: `${scene.visualPrompt}. Smooth natural motion, gentle camera movement, consistent characters, no scene changes.`,
        image: pngBuffer, width: portrait ? 480 : 832, height: portrait ? 832 : 480, seconds: 4, ollamaHost: opts.ollamaHost,
      });
    } catch {
      // Fall through to WanGP / LTX, then to a still.
    }
  }
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
  if (opts.mode === "video" && !isWanInstalled() && !(await wangpHealth()) && !isVideoGenInstalled()) {
    throw new StoryboardError("Video mode needs a video backend running — start WanGP in Pinokio, or pick Slideshow/Hybrid instead.");
  }

  onProgress?.("Writing the script…");
  const planned = await planScenes(opts.ollamaHost, opts.ollamaModel, opts.topic, opts.targetMinutes, opts.mode, opts.script);
  const scenes = opts.visualStyle?.trim()
    ? planned.map((sc) => ({ ...sc, visualPrompt: `${sc.visualPrompt}, ${opts.visualStyle!.trim()}` }))
    : planned;

  const workDir = path.join(os.tmpdir(), `storyboard-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const [width, height] = opts.orientation === "portrait" ? [540, 960] : [960, 540];
  const [clipWidth, clipHeight] = opts.orientation === "portrait" ? [320, 512] : [512, 320];

  try {
    const segments: string[] = [];
    const sceneTimes: { start: number; duration: number; narration: string }[] = [];
    let actualSeconds = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (shouldStop?.()) throw new StoryboardError("Stopped by owner.");
      onProgress?.(`Rendering scene ${i + 1} of ${scenes.length}…`);
      const { segmentPath, duration } = await renderScene(scenes[i], i, workDir, opts, width, height, clipWidth, clipHeight);
      segments.push(segmentPath);
      sceneTimes.push({ start: actualSeconds, duration, narration: scenes[i].narration });
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
      try {
        await runFfmpeg([
          "-y", "-i", concatPath, "-stream_loop", "-1", "-i", musicPath,
          "-filter_complex", "[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]",
          "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", outPath,
        ], 300_000);
      } catch {
        // Music is a nice-to-have — never lose a finished render over it.
        fs.copyFileSync(concatPath, outPath);
      }
    } else {
      fs.copyFileSync(concatPath, outPath);
    }

    if (opts.captions) {
      onProgress?.("Burning in captions…");
      fs.writeFileSync(path.join(workDir, "captions.srt"), captionsSrt(sceneTimes));
      const captioned = path.join(workDir, "captioned.mp4");
      await runFfmpeg([
        "-y", "-i", outPath,
        // Relative subtitle path + cwd=workDir sidesteps the subtitles
        // filter's painful escaping of Windows drive-letter paths.
        "-vf", `subtitles=captions.srt:force_style='FontName=Arial,FontSize=${opts.orientation === "portrait" ? 13 : 18},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=0,Alignment=2,MarginV=${opts.orientation === "portrait" ? 70 : 30}'`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", captioned,
      ], 600_000, workDir);
      return { buffer: fs.readFileSync(captioned), sceneCount: scenes.length, actualSeconds };
    }

    return { buffer: fs.readFileSync(outPath), sceneCount: scenes.length, actualSeconds };
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}
