// Finds and downloads a single track into the owner's background-music
// folder — the "search for a song" idea, stripped down to its non-Telegram,
// single-user essentials from github.com/BitOpenCode/Pocket-Sound-V2-n8n-Telegram
// (an n8n Telegram bot). No playlists-within-playlists, no referral/coin
// system, no admin panel, no paid tiers — those are all Telegram-bot
// concepts that don't apply to a local single-user app. Just: search, grab
// one track, drop it in the folder the music player already reads from.
//
// Uses yt-dlp's standalone Windows binary (same "download once, run
// forever" pattern as server/piper.ts's engine) plus the ffmpeg that
// already rides along with video generation (see videogen.ts's
// getFfmpegPath) for the audio conversion step.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MUSICSEARCH_DIR, getDownloadsDir } from "./paths";
import { getFfmpegPath } from "./videogen";

const YT_DLP_EXE = path.join(MUSICSEARCH_DIR, "yt-dlp.exe");
const YT_DLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

export class MusicSearchError extends Error {}

export function isYtDlpInstalled(): boolean {
  return fs.existsSync(YT_DLP_EXE);
}

export async function installYtDlp(): Promise<void> {
  fs.mkdirSync(MUSICSEARCH_DIR, { recursive: true });
  const res = await fetch(YT_DLP_URL, { redirect: "follow" });
  if (!res.ok) throw new MusicSearchError(`Couldn't download yt-dlp (HTTP ${res.status}).`);
  fs.writeFileSync(YT_DLP_EXE, Buffer.from(await res.arrayBuffer()));
}

export interface DownloadedTrack {
  filename: string;
  title: string;
}

export interface TrackCandidate {
  id: string;
  title: string;
  uploader: string;
  duration: number; // seconds; 0 when unknown
}

/**
 * Lists candidate tracks for a query WITHOUT downloading anything, so the
 * owner picks the right one instead of blind-grabbing the first hit.
 * --flat-playlist keeps this fast (metadata only, no per-video extraction).
 */
export function searchTracks(query: string, limit = 8): Promise<TrackCandidate[]> {
  if (!isYtDlpInstalled()) return Promise.reject(new MusicSearchError("Music search isn't set up yet — install it in Settings first."));
  const n = Math.min(Math.max(limit, 1), 20);
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${n}:${query}`,
      "--flat-playlist", "--no-warnings", "--ignore-errors",
      // Tab-separated so titles containing "|" or "-" don't break parsing.
      "--print", "%(id)s\t%(title)s\t%(uploader)s\t%(duration)s",
    ];
    let out = "", err = "";
    const child = spawn(YT_DLP_EXE, args, { windowsHide: true });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new MusicSearchError("Search timed out.")); }, 60_000);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new MusicSearchError(`Search failed: ${err.slice(-500) || `code ${code}`}`));
      const results = out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const [id, title, uploader, duration] = line.split("\t");
        return { id: id ?? "", title: title ?? "(untitled)", uploader: uploader ?? "", duration: Number(duration) || 0 };
      }).filter((r) => r.id);
      resolve(results);
    });
  });
}

/** Downloads one specific candidate (by video id) as an mp3 into the downloads folder. */
export function downloadTrackById(videoId: string): Promise<DownloadedTrack> {
  if (!/^[a-zA-Z0-9_-]{5,20}$/.test(videoId)) return Promise.reject(new MusicSearchError("Invalid track id."));
  return runDownload(`https://www.youtube.com/watch?v=${videoId}`);
}

/**
 * Searches for one track and downloads the top hit — the one-shot path
 * (agents/Settings). Tries YouTube first, then falls back to SoundCloud.
 * YouTube is the richer catalogue but the one that actively fights downloaders
 * (403s, rotating player requirements); SoundCloud rarely blocks and covers a
 * lot of the same music, so it's a reliable second source when YouTube balks.
 */
export async function searchAndDownloadTrack(query: string): Promise<DownloadedTrack> {
  try {
    return await runDownload(`ytsearch1:${query}`);
  } catch (ytErr) {
    try {
      return await runDownload(`scsearch1:${query}`);
    } catch {
      // Surface the YouTube error — it's usually the more informative one, and
      // the owner expects YouTube to be the primary source.
      throw ytErr;
    }
  }
}

/**
 * Shared download step. `target` is either a `ytsearch1:` query (top hit) or a
 * concrete video URL (a candidate the owner picked from search results).
 */
function runDownload(target: string): Promise<DownloadedTrack> {
  if (!isYtDlpInstalled()) return Promise.reject(new MusicSearchError("Music search isn't set up yet — install it in Settings first."));
  // Downloads always land in the dedicated downloads folder (auto-created),
  // which is served alongside the owner's own music folder — so this works
  // even if no music folder has been configured yet.
  const musicDir = getDownloadsDir();
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return Promise.reject(new MusicSearchError("Set up local video generation in Settings first — it bundles the ffmpeg this needs to convert audio."));

  return new Promise((resolve, reject) => {
    const outTemplate = path.join(musicDir, "%(title).150B.%(ext)s");
    const args = [
      target,
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--ffmpeg-location", ffmpeg,
      "--no-playlist", "--windows-filenames",
      // YouTube started returning HTTP 403 on downloads through the default
      // ("web") player client, which now also demands an external JS runtime
      // to compute signatures. The `android` client sidesteps both — it returns
      // working download URLs with no JS runtime needed. `web` is kept as a
      // fallback for the occasional video the android client can't serve.
      "--extractor-args", "youtube:player_client=android,web",
      "-o", outTemplate,
      "--print", "after_move:filepath",
    ];
    let output = "";
    const child = spawn(YT_DLP_EXE, args, { windowsHide: true });
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new MusicSearchError("Search/download timed out.")); }, 120_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new MusicSearchError(`yt-dlp failed: ${output.slice(-1000) || `code ${code}`}`));
      const lines = output.trim().split("\n").filter(Boolean);
      const filePath = lines[lines.length - 1];
      if (!filePath || !fs.existsSync(filePath)) return reject(new MusicSearchError("Download finished but the file wasn't found."));
      resolve({ filename: path.basename(filePath), title: path.basename(filePath, path.extname(filePath)) });
    });
  });
}
