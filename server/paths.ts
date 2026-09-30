import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// In dev/CLI use, everything lives under ./data relative to the process cwd
// (the project root). When running packaged inside Electron, main.ts sets
// AURORA_DATA_DIR to the app's per-user userData folder before the server
// boots, since a packaged app's cwd isn't a reliable — or writable — place.
export const DATA_DIR = process.env.AURORA_DATA_DIR ?? path.resolve(process.cwd(), "data");

// The database deliberately does NOT live in DATA_DIR.
//
// DATA_DIR is on an external USB enclosure that detaches mid-session (see
// datadrive.ts). Everything else out there is bulky and replaceable — model
// checkpoints, generated media, Python venvs — but the database is small (~2MB)
// and irreplaceable, and losing access to it takes the whole app down: chat,
// agents, memory, settings. Keeping it on the internal drive means a dropout
// costs you image generation and the media library while AURORA itself keeps
// working, instead of everything failing at once.
//
// Electron sets AURORA_DB_DIR to its per-user userData folder; the fallback
// covers dev/CLI runs. AURORA_DB_PATH still wins outright if set.
export const DB_DIR = process.env.AURORA_DB_DIR
  ?? path.join(os.homedir(), "AppData", "Roaming", "AURORA", "data");

export const DB_PATH = process.env.AURORA_DB_PATH ?? path.join(DB_DIR, "aurora.db");

// Where generated images/videos live by default — overridable at runtime
// (see below) via Settings, e.g. to point at a drive with more room for
// video files. Kept mutable rather than a plain constant so the change
// applies immediately, with no app restart required.
export const DEFAULT_CREATIONS_DIR = path.join(DATA_DIR, "creations");
let currentCreationsDir = DEFAULT_CREATIONS_DIR;

export function getCreationsDir(): string {
  return currentCreationsDir;
}

/** Called once at startup with the saved config value, and again whenever it's changed via Settings. Empty/undefined resets to the default location. Throws if the directory can't be created (e.g. a drive letter that no longer exists). */
export function setCreationsDir(dir: string | null | undefined): void {
  const next = dir && dir.trim() ? dir.trim() : DEFAULT_CREATIONS_DIR;
  fs.mkdirSync(next, { recursive: true });
  currentCreationsDir = next;
}

// Background music — unlike creations, this points at the owner's own
// existing folder of audio files rather than somewhere AURORA writes to, so
// there's no sensible default and nothing gets auto-created. null = not
// configured yet.
let currentMusicDir: string | null = null;

export function getMusicDir(): string | null {
  return currentMusicDir;
}

/** Called at startup with the saved config value, and again whenever it's changed via Settings. Empty/undefined clears it. Doesn't create the directory — it's expected to already exist as the owner's real music folder. */
export function setMusicDir(dir: string | null | undefined): void {
  currentMusicDir = dir && dir.trim() ? dir.trim() : null;
}

export const SKILLS_DIR = path.join(DATA_DIR, "skills");
export const STAGING_DIR = path.join(DATA_DIR, "skills-staging");
export const PIPER_DIR = path.join(DATA_DIR, "piper");
export const PIPER_VOICES_DIR = path.join(PIPER_DIR, "voices");
// Kokoro-82M neural TTS — the natural-prosody voice engine. Its own Python
// venv, same shape as VIDEOGEN_DIR/MUSICGEN_DIR. Deliberately CPU-only (see
// kokoro.ts): the model is small enough that CPU inference is realtime, and
// keeping it off the GPU means speaking never competes with Ollama for VRAM.
export const KOKORO_DIR = path.join(DATA_DIR, "kokoro");
// Speech-to-text (faster-whisper) — AURORA's hearing. Its own venv rather
// than sharing Kokoro's: faster-whisper runs on CTranslate2, not torch, so
// bundling them would drag an unrelated 200MB dependency into each install.
export const STT_DIR = path.join(DATA_DIR, "stt");
// ComfyUI — the image-generation backend, replacing the retired Automatic1111
// install (which still lives at IMAGEGEN_DIR because ComfyUI reads its
// checkpoints from there via extra_model_paths.yaml, rather than copying ~9GB).
export const COMFYUI_DIR = path.join(DATA_DIR, "comfyui");
export const VIDEOGEN_DIR = path.join(DATA_DIR, "videogen");
export const IMAGEGEN_DIR = path.join(DATA_DIR, "imagegen");
export const MUSICSEARCH_DIR = path.join(DATA_DIR, "musicsearch");
// Local AI music generation (ACE-Step) — its own Python venv + cloned repo,
// same shape as VIDEOGEN_DIR. Kept separate so installing/uninstalling music
// generation never touches the video-gen environment.
export const MUSICGEN_DIR = path.join(DATA_DIR, "musicgen");

// A dedicated folder for songs AURORA downloads (music search / agents), kept
// separate from the owner's own music folder for tidiness but served under the
// same /music path so the player treats them as one merged library. Always
// exists (auto-created), so downloading works even before a music folder is
// configured in Settings.
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
export function getDownloadsDir(): string {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  return DOWNLOADS_DIR;
}

// Read-only, bundled with the app (not user data) — a curated set of
// ready-to-install skills shipped in the repo itself, so there's something
// real to install without needing an external GitHub repo. In dev this is
// the project's own starter-skills/ folder; a packaged build copies it
// alongside dist/public and electron/main.ts points this at that copy (see
// AURORA_STATIC_DIR for the same pattern).
export const STARTER_SKILLS_DIR = process.env.AURORA_STARTER_SKILLS_DIR ?? path.resolve(process.cwd(), "starter-skills");

// The built frontend (vite build output). In dev this is unused (Vite's own
// middleware serves it); in a packaged Electron app main.ts points this at
// the bundled resources dir since it sits alongside the app code, not cwd.
export const STATIC_DIR = process.env.AURORA_STATIC_DIR ?? path.resolve(process.cwd(), "dist/public");

// AURORA isn't publicly distributed — there's no hosted release server to
// check. It's built and shipped from this one project checkout on this one
// machine, so "check for updates" means "is there a newer installer sitting
// in this project's own release/ folder than what's currently running."
// Overridable in case the project ever moves.
export const UPDATE_SOURCE_DIR = process.env.AURORA_UPDATE_SOURCE_DIR ?? "C:\\Claude\\AURORA\\release";

// Same one-machine assumption as UPDATE_SOURCE_DIR above, one level up — this
// is where AURORA's own TypeScript source lives, so an agent asked to
// diagnose or fix a bug in AURORA itself (via read_file/edit_file/run_shell)
// knows where to actually look, instead of poking at the packaged app.asar
// it's currently running from. Deliberately NOT wired into a rebuild/restart
// of the running app — see TOOL_USE_REMINDER in agent-loop.ts for why that
// stays a manual step.
// The project now lives on the internal C: drive (moved off the failing F:
// external, which dropped out repeatedly mid-write). A mirror copy is kept at
// F:\Claude\AURORA as a backup — see the "sync:f" script in package.json — but
// C: is the working copy that gets edited and built.
export const SELF_SOURCE_DIR = process.env.AURORA_SELF_SOURCE_DIR ?? "C:\\Claude\\AURORA";
