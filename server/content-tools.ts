// Real-world content tools for agents — the things a content pipeline
// actually needs (find what's trending, read what a video says, follow the
// news, save finished work, record a voiceover), with no API keys.
//
// These replace leaning on the starter "skills", which are toy calculators
// (UUID generator, golden-ratio layouts) — and on YouTube's /feed/trending
// page, which YouTube removed (it now redirects to the home feed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getCreationsDir, MUSICSEARCH_DIR } from "./paths";
import { isKokoroInstalled, synthesize, KOKORO_VOICES } from "./kokoro";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const YT_DLP_EXE = path.join(MUSICSEARCH_DIR, "yt-dlp.exe");

export class ContentToolError extends Error {}

// ---- YouTube search (with real view counts) ----

// YouTube's own search-filter tokens ("sp"): sort by view count, limited to
// an upload window. Sorting by views within a window is the closest thing to
// "trending" now that the trending feed is gone.
const SORT_FILTERS: Record<string, string> = {
  "views:today": "CAMSAggC",
  "views:week": "CAMSAggD",
  "views:month": "CAMSAggE",
  "views:any": "CAM%3D",
  "date:any": "CAI%3D",
  "relevance:today": "EgIIAg%3D%3D",
  "relevance:week": "EgIIAw%3D%3D",
  "relevance:month": "EgIIBA%3D%3D",
  "relevance:any": "",
};

export interface VideoResult { title: string; channel: string; views: string; published: string; length: string; url: string }

/**
 * YouTube search with fallbacks: a long, specific query combined with a
 * sort/period filter often returns nothing at all (measured: "kids channel
 * ages 4-8 most viewed this year" + views/month -> 0), so retry without the
 * filter, then with just the query's first few keywords.
 */
export async function youtubeSearch(query: string, opts: { sort?: string; period?: string; limit?: number } = {}): Promise<VideoResult[]> {
  const first = await youtubeSearchOnce(query, opts);
  if (first.length) return first;
  const relaxed = await youtubeSearchOnce(query, { limit: opts.limit });
  if (relaxed.length) return relaxed;
  const short = query.split(/\s+/).filter((w) => w.length > 2).slice(0, 3).join(" ");
  return short && short !== query ? youtubeSearchOnce(short, opts) : [];
}

/** Searches YouTube by reading the results page's embedded data — gives view counts, which yt-dlp's flat search doesn't. */
async function youtubeSearchOnce(query: string, opts: { sort?: string; period?: string; limit?: number } = {}): Promise<VideoResult[]> {
  const sort = opts.sort === "views" || opts.sort === "date" ? opts.sort : "relevance";
  const period = sort === "date" ? "any" : (["today", "week", "month"].includes(String(opts.period)) ? String(opts.period) : "any");
  const sp = SORT_FILTERS[`${sort}:${period}`] ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${sp ? `&sp=${sp}` : ""}&hl=en&gl=US`;
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) throw new ContentToolError(`YouTube search failed (HTTP ${res.status})`);
  const html = await res.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new ContentToolError("couldn't read YouTube's results page (layout may have changed)");
  const out: VideoResult[] = [];
  const text = (t: { simpleText?: string; runs?: { text: string }[] } | undefined) => t?.simpleText ?? t?.runs?.map((r) => r.text).join("") ?? "";
  (function walk(o: unknown): void {
    if (!o || typeof o !== "object" || out.length >= limit) return;
    const rec = o as Record<string, unknown>;
    if (rec.videoRenderer) {
      const v = rec.videoRenderer as Record<string, any>;
      if (v.videoId) {
        out.push({
          title: text(v.title), channel: text(v.ownerText), views: text(v.viewCountText) || "live/unknown",
          published: text(v.publishedTimeText), length: text(v.lengthText), url: `https://www.youtube.com/watch?v=${v.videoId}`,
        });
      }
      return;
    }
    for (const k of Object.keys(rec)) walk(rec[k]);
  })(JSON.parse(m[1]));
  return out;
}

const TRENDING_CATEGORIES = ["music video", "gaming", "news", "comedy", "sports highlights", "podcast", "vlog", "movie trailer", "tech", "challenge"];

function viewsNumber(views: string): number {
  return Number(views.replace(/[^0-9]/g, "")) || 0;
}

/**
 * Approximates YouTube's (removed) trending feed: the most-viewed uploads in
 * a time window across popular categories (or the given ones), merged and
 * ranked by views.
 */
export async function trendingVideos(opts: { categories?: string[]; period?: string; limit?: number } = {}): Promise<(VideoResult & { category: string })[]> {
  const categories = opts.categories?.filter((c) => c.trim()).slice(0, 10) ?? TRENDING_CATEGORIES;
  const period = ["today", "week", "month"].includes(String(opts.period)) ? String(opts.period) : "today";
  const batches = await Promise.all(categories.map(async (category) =>
    (await youtubeSearch(category, { sort: "views", period, limit: 8 }).catch(() => [] as VideoResult[])).map((v) => ({ ...v, category }))));
  const seen = new Set<string>();
  // Livestreams flood view-sorted results (24/7 "GTA 5 LIVE" channels) and
  // aren't scriptable "videos" — keep only finished uploads.
  const isLive = (v: VideoResult) => !v.length || /^streamed\b/i.test(v.published) || /\blive\b|🔴/i.test(v.title);
  return batches.flat()
    .filter((v) => !isLive(v))
    .filter((v) => !seen.has(v.url) && seen.add(v.url))
    .sort((a, b) => viewsNumber(b.views) - viewsNumber(a.views))
    .slice(0, Math.min(Math.max(opts.limit ?? 10, 1), 25));
}

// ---- Video transcripts ----

function runYtDlp(args: string[], timeoutMs: number): Promise<string> {
  if (!fs.existsSync(YT_DLP_EXE)) return Promise.reject(new ContentToolError("yt-dlp isn't installed — set up Music search in Settings first."));
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(YT_DLP_EXE, args, { windowsHide: true });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new ContentToolError("timed out")); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

/** Turns a WebVTT subtitle file into plain text, dropping timing lines and the rolling duplicates auto-captions produce. */
function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/^>>\s*/, "").trim();
    if (!line || line === "WEBVTT" || /^(Kind|Language):/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** The spoken words of a YouTube video (uploaded or auto-generated English captions), for summarizing without watching it. */
export async function videoTranscript(url: string, maxChars = 12_000): Promise<{ title: string; text: string }> {
  if (!/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url)) throw new ContentToolError("only YouTube URLs are supported");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-subs-"));
  try {
    // Exactly "en" / "en-orig": a pattern like "en.*" also matches every
    // auto-translated "en-xx" track (25+ downloads), which gets rate-limited
    // (HTTP 429). The default player client is used on purpose — the android
    // client music downloads use returns no caption tracks.
    // No --print here: it implies --simulate, which silently skips writing the
    // subtitle files. The title comes from the output filename instead.
    const out = await runYtDlp([
      url, "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-orig,en-US,en-GB", "--sub-format", "vtt",
      "--no-playlist", "--no-warnings", "-o", path.join(dir, "%(title).120B.%(ext)s"),
    ], 90_000);
    const vtts = fs.readdirSync(dir).filter((f) => f.endsWith(".vtt"));
    const vtt = vtts.find((f) => f.endsWith(".en-orig.vtt")) ?? vtts.find((f) => f.endsWith(".en.vtt")) ?? vtts[0];
    if (!vtt) throw new ContentToolError(`this video has no English captions available${/ERROR/.test(out) ? ` (${out.match(/ERROR:.*$/m)?.[0]})` : ""}`);
    const title = vtt.replace(/\.[^.]+\.vtt$/, "");
    const text = vttToText(fs.readFileSync(path.join(dir, vtt), "utf8"));
    return { title, text: text.length > maxChars ? text.slice(0, maxChars) + " …(truncated)" : text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- News ----

export interface Headline { title: string; source: string; published: string; url: string }

/** Latest headlines from Google News (RSS, no key) — overall top stories, or for a topic/search. */
export async function newsHeadlines(topic?: string, limit = 10): Promise<Headline[]> {
  const base = "https://news.google.com/rss";
  const url = topic?.trim()
    ? `${base}/search?q=${encodeURIComponent(topic.trim())}+when:2d&hl=en-US&gl=US&ceid=US:en`
    : `${base}?hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new ContentToolError(`news feed failed (HTTP ${res.status})`);
  const xml = await res.text();
  const decode = (s: string) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const pick = (block: string, tag: string) => decode(block.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s"))?.[1] ?? "");
  return [...xml.matchAll(/<item>(.*?)<\/item>/gs)].slice(0, Math.min(Math.max(limit, 1), 30)).map(([, item]) => ({
    title: pick(item, "title"), source: pick(item, "source"), published: pick(item, "pubDate"), url: pick(item, "link"),
  }));
}

// ---- Saving work ----

const DOC_EXT: Record<string, string> = { markdown: "md", md: "md", text: "txt", txt: "txt", csv: "csv", html: "html", json: "json" };

/** Saves a finished document (script, report, table) into the Library's documents folder and returns its path. */
export function saveDocument(title: string, content: string, format = "md"): string {
  const ext = DOC_EXT[format.toLowerCase()] ?? "md";
  const dir = path.join(getCreationsDir(), "documents");
  fs.mkdirSync(dir, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = path.join(dir, `${slug}-${stamp}.${ext}`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Records text as a voiceover WAV with the local Kokoro voice and returns the creations-relative filename. */
export async function makeVoiceover(text: string, voice?: string): Promise<{ filename: string; voice: string }> {
  if (!isKokoroInstalled()) throw new ContentToolError("the Kokoro voice engine isn't installed — set it up in Settings → Voice");
  const chosen = KOKORO_VOICES.some((v) => v.id === voice) ? String(voice) : "af_heart";
  const wav = await synthesize(text.slice(0, 5000), chosen);
  const filename = `voiceover-${randomUUID()}.wav`;
  fs.writeFileSync(path.join(getCreationsDir(), filename), wav);
  return { filename, voice: chosen };
}

export const VOICE_IDS = KOKORO_VOICES.map((v) => v.id);
