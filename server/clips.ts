// Short-form clipping: find the best moments of a long video (timestamped
// transcript), cut a segment, reframe it vertical (9:16), burn in captions,
// and save it to the Library — the "viral clips" workflow, done locally with
// yt-dlp + the ffmpeg that ships with video generation.
//
// Copyright: this is meant for the studio's own videos and for creators who
// explicitly allow or pay for clipping (clip campaigns). The tool description
// says so, and the clipping company's jobs require a legal check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getCreationsDir, MUSICSEARCH_DIR } from "./paths";
import { getFfmpegPath } from "./videogen";
import { runFfmpeg } from "./storyboard";

const YT_DLP_EXE = path.join(MUSICSEARCH_DIR, "yt-dlp.exe");

export class ClipError extends Error {}

function ytDlp(args: string[], timeoutMs: number): Promise<string> {
  if (!fs.existsSync(YT_DLP_EXE)) return Promise.reject(new ClipError("yt-dlp isn't installed — set up Music search in Settings first."));
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(YT_DLP_EXE, args, { windowsHide: true });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new ClipError("download timed out")); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

/** "1:02:03" / "62:03" / "3723" / "3723.5" -> seconds. */
export function parseTime(t: string | number): number {
  if (typeof t === "number") return t;
  const parts = String(t).trim().split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) throw new ClipError(`can't read time "${t}" — use seconds or mm:ss`);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fmt(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

interface Cue { start: number; end: number; text: string }

function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.split(/\r?\n\r?\n/);
  for (const b of blocks) {
    const m = b.match(/(\d+:)?(\d+):(\d+)\.(\d+)\s*-->\s*(\d+:)?(\d+):(\d+)\.(\d+)/);
    if (!m) continue;
    const toS = (h: string | undefined, mm: string, ss: string, ms: string) => (h ? Number(h.slice(0, -1)) : 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
    const text = b.split(/\r?\n/).slice(b.split(/\r?\n/).findIndex((l) => l.includes("-->")) + 1)
      .join(" ").replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const cue = { start: toS(m[1], m[2], m[3], m[4]), end: toS(m[5], m[6], m[7], m[8]), text };
    // Auto-captions repeat the previous line as a rolling window — keep only new text.
    const prev = cues[cues.length - 1];
    if (prev && cue.text.startsWith(prev.text)) cue.text = cue.text.slice(prev.text.length).trim();
    if (cue.text) cues.push(cue);
  }
  return cues;
}

async function fetchCues(url: string): Promise<{ title: string; cues: Cue[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-cues-"));
  try {
    const out = await ytDlp([url, "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig,en-US,en-GB",
      "--sub-format", "vtt", "--no-playlist", "--no-warnings", "-o", path.join(dir, "%(title).120B.%(ext)s")], 90_000);
    const vtts = fs.readdirSync(dir).filter((f) => f.endsWith(".vtt"));
    const vtt = vtts.find((f) => f.endsWith(".en-orig.vtt")) ?? vtts.find((f) => f.endsWith(".en.vtt")) ?? vtts[0];
    if (!vtt) throw new ClipError(`no English captions for this video${/ERROR:.*$/m.test(out) ? ` (${out.match(/ERROR:.*$/m)?.[0]})` : ""}`);
    return { title: vtt.replace(/\.[^.]+\.vtt$/, ""), cues: parseVtt(fs.readFileSync(path.join(dir, vtt), "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Transcript as "[m:ss] text" lines, grouped into ~20s chunks — for picking clip-worthy moments by time. */
export async function timestampedTranscript(url: string, maxChars = 14_000): Promise<string> {
  const { title, cues } = await fetchCues(url);
  const lines: string[] = [];
  let chunkStart = -1, chunk: string[] = [];
  for (const c of cues) {
    if (chunkStart < 0) chunkStart = c.start;
    chunk.push(c.text);
    if (c.end - chunkStart >= 20) { lines.push(`[${fmt(chunkStart)}] ${chunk.join(" ")}`); chunk = []; chunkStart = -1; }
  }
  if (chunk.length) lines.push(`[${fmt(chunkStart)}] ${chunk.join(" ")}`);
  const text = `${title}\n\n${lines.join("\n")}`;
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export interface ClipResult { filename: string; seconds: number }

/**
 * Cuts [start, end] out of a YouTube URL (only that section is downloaded) or
 * a Library video, optionally reframes it to vertical 1080x1920 (center crop),
 * burns in that section's captions, and saves it to the creations folder.
 */
export async function makeClip(opts: { source: string; start: string | number; end: string | number; vertical?: boolean; captions?: boolean }): Promise<ClipResult> {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) throw new ClipError("ffmpeg wasn't found — set up video generation in Settings first (it bundles ffmpeg).");
  const start = parseTime(opts.start), end = parseTime(opts.end);
  if (!(end > start)) throw new ClipError("end must be after start");
  if (end - start > 180) throw new ClipError("clips are capped at 3 minutes");
  const isUrl = /^https?:\/\//i.test(opts.source);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-clip-"));
  try {
    let input: string;
    let inputOffset = start; // where the clip starts within `input`
    if (isUrl) {
      await ytDlp([opts.source, "--download-sections", `*${start}-${end}`, "--force-keyframes-at-cuts",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4",
        "--ffmpeg-location", ffmpeg, "--no-playlist", "--no-warnings", "-o", path.join(dir, "source.%(ext)s")], 300_000);
      const src = fs.readdirSync(dir).find((f) => f.startsWith("source."));
      if (!src) throw new ClipError("couldn't download that section of the video");
      input = path.join(dir, src);
      inputOffset = 0;
    } else {
      input = path.isAbsolute(opts.source) ? opts.source : path.join(getCreationsDir(), opts.source);
      if (!fs.existsSync(input)) throw new ClipError(`no such Library file: ${opts.source}`);
    }

    const filters: string[] = [];
    if (opts.vertical !== false) filters.push("crop='min(iw,ih*9/16)':ih,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
    if (opts.captions !== false && isUrl) {
      try {
        const { cues } = await fetchCues(opts.source);
        // Merge auto-caption fragments into readable ~3s phrases (raw cues
        // often leave a lone trailing word on screen).
        const inRange: Cue[] = [];
        for (const c of cues.filter((x) => x.end > start && x.start < end)) {
          const last = inRange[inRange.length - 1];
          if (last && (last.end - last.start < 2.5 || last.text.split(" ").length < 4) && (last.text + " " + c.text).split(" ").length <= 9) {
            last.end = c.end;
            last.text = `${last.text} ${c.text}`;
          } else inRange.push({ ...c });
        }
        if (inRange.length) {
          fs.writeFileSync(path.join(dir, "clip.srt"), inRange.map((c, i) =>
            `${i + 1}\n${srtTime(Math.max(0, c.start - start))} --> ${srtTime(Math.min(end, c.end) - start)}\n${c.text}\n`).join("\n"));
          filters.push("subtitles=clip.srt:force_style='FontName=Arial,FontSize=14,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=90'");
        }
      } catch { /* no captions available — ship the clip without them */ }
    }

    const outName = `clip-${randomUUID()}.mp4`;
    const outPath = path.join(dir, "out.mp4");
    await runFfmpeg([
      "-y", "-ss", String(inputOffset), "-i", input, "-t", String(end - start),
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outPath,
    ], 600_000, dir);
    fs.copyFileSync(outPath, path.join(getCreationsDir(), outName));
    return { filename: outName, seconds: end - start };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
