// Local text/image-to-video generation via LTX-Video's own standalone CLI
// (github.com/Lightricks/LTX-Video) — deliberately NOT via ComfyUI. LTX-Video
// ships no HTTP server of its own, but its `inference.py` + pyproject.toml
// give a real, install-once CLI path, which fits AURORA's "spawn a local
// process, read the file it wrote" pattern (same shape as server/piper.ts)
// far better than hand-authoring a ComfyUI node-graph blind.
//
// Unlike Ollama/Piper, this can't be a single silent binary download — a
// video diffusion model needs a real Python + PyTorch + CUDA stack matched to
// the owner's own GPU, so setup here is a multi-stage, longer-running
// process with its own progress channel (mirroring ollama.ts's pull-status
// pattern), not a one-shot download.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { VIDEOGEN_DIR } from "./paths";
import { unloadAllModels } from "./ollama";
import { withHeavyGpu } from "./gpu";

const REPO_DIR = path.join(VIDEOGEN_DIR, "repo");

/**
 * inference.py spawns its own multiprocessing/dataloader worker processes,
 * which are NOT children of Node's tracked `child` handle in any way Windows
 * cleans up automatically — killing just the top PID (child.kill()) leaves
 * those workers running as orphans that keep holding RAM (and sometimes
 * VRAM) indefinitely. Confirmed directly: after a crashed/killed run, a
 * leftover python.exe was still holding ~2GB of RAM minutes later,
 * accounting for most of the system's free memory. `taskkill /T` kills the
 * whole process tree rooted at the given pid; best-effort since the tree may
 * have already exited on its own by the time this runs.
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
}
const VENV_DIR = path.join(VIDEOGEN_DIR, "venv");
const VENV_PYTHON = path.join(VENV_DIR, "Scripts", "python.exe");
const FFMPEG_BINARIES_DIR = path.join(VENV_DIR, "Lib", "site-packages", "imageio_ffmpeg", "binaries");

/**
 * A full ffmpeg build rides along for free as a dependency of imageio-ffmpeg
 * (itself a dependency of imageio, which LTX-Video's own venv already
 * installs) — no separate ffmpeg install/bundling needed. Used by
 * server/storyboard.ts to stitch narrated scenes into one long-form video.
 * Filename carries a version number (e.g. "ffmpeg-win-x86_64-v7.1.exe") that
 * can change when imageio-ffmpeg updates, so this globs for it rather than
 * hardcoding the exact name.
 */
export function getFfmpegPath(): string | null {
  try {
    const match = fs.readdirSync(FFMPEG_BINARIES_DIR).find((f) => /^ffmpeg-.*\.exe$/i.test(f));
    return match ? path.join(FFMPEG_BINARIES_DIR, match) : null;
  } catch {
    return null;
  }
}
const INFERENCE_SCRIPT = path.join(REPO_DIR, "inference.py");
// The 2B distilled config — smallest/fastest official Lightricks checkpoint,
// matching what a modest (6-8GB) GPU can actually run. Deliberately the
// bfloat16 variant, not "-fp8": the fp8 config needs a separate compiled CUDA
// extension (q8_kernels, github.com/Lightricks/LTXVideo-Q8-Kernels) that has
// no pip wheel and must be built from source — exactly the setup hassle this
// integration exists to avoid. bf16 uses more VRAM but runs with nothing
// beyond what `pip install -e .[inference]` already installs. The pipeline
// config itself tells the script which HuggingFace weights to pull, so
// there's no separate checkpoint-download step to manage here — it happens
// automatically (and only once) the first time inference runs.
const PIPELINE_CONFIG = "configs/ltxv-2b-0.9.8-distilled.yaml";
const REPO_ZIP_URL = "https://github.com/Lightricks/LTX-Video/archive/refs/heads/main.zip";
const DISK_WATCH_INTERVAL_MS = 20_000;

export class VideoGenError extends Error {}

// The HuggingFace cache lives at ~/.cache/huggingface regardless of platform
// (huggingface_hub's own default, unrelated to AURORA_DATA_DIR) unless the
// owner has set HF_HOME themselves — respect that override if present.
function hfCacheRoot(): string {
  return process.env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface");
}

/**
 * Cheap recursive sum of every file's size under the HF cache — used purely
 * as an "is a download still actually happening" signal. A checkpoint
 * download's own progress bar writes nothing at all once it isn't attached
 * to a real terminal (which a spawned subprocess pipe never is), so watching
 * bytes actually land on disk is the only way to tell a genuinely slow
 * multi-gigabyte first-run download apart from a truly stuck process —
 * confirmed live: a real download here grew steadily while producing zero
 * subprocess output the entire time.
 */
function getHfCacheBytesOnDisk(): number {
  let total = 0;
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // removed mid-walk (e.g. a .incomplete file finished and got renamed) — skip it
        }
      }
    }
  }
  walk(hfCacheRoot());
  return total;
}

export interface GpuInfo { name: string; vramMb: number }

export interface VideoGenSetupStatus {
  stage: "idle" | "detecting" | "venv" | "pytorch" | "downloading" | "dependencies" | "done" | "error";
  message: string;
  done: boolean;
  error?: string;
}

let setupStatus: VideoGenSetupStatus = { stage: "idle", message: "", done: true };
let setupInFlight = false;

export function getSetupStatus(): VideoGenSetupStatus {
  return setupStatus;
}

export function isVideoGenInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(INFERENCE_SCRIPT);
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

/** Tries the usual Windows Python launchers in order and returns the first that reports 3.10+. */
async function detectPythonCommand(): Promise<string> {
  const candidates = ["py -3", "python", "python3"];
  for (const candidate of candidates) {
    const [cmd, ...baseArgs] = candidate.split(" ");
    try {
      const { stdout } = await run(cmd, [...baseArgs, "--version"]);
      const match = stdout.match(/Python (\d+)\.(\d+)/);
      if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10))) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new VideoGenError("No Python 3.10+ found on this machine. Install it from python.org (check \"Add to PATH\" during setup), then try again.");
}

export async function detectGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const [name, vram] = stdout.trim().split(",").map((s) => s.trim());
    if (!name) return null;
    return { name, vramMb: Number(vram) || 0 };
  } catch {
    return null; // no nvidia-smi on PATH — either no NVIDIA GPU or drivers not installed
  }
}

function spawnStep(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new VideoGenError("Step timed out.")); }, opts.timeoutMs);
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new VideoGenError(stderr.slice(-2000) || `exited with code ${code}`));
      resolve();
    });
  });
}

/** Fire-and-forget, mirrors ollama.ts's pullModel — the client polls getSetupStatus() for progress. Windows-only, matching the rest of AURORA's local-tooling installers. */
export function startVideoGenSetup(): void {
  if (setupInFlight) return;
  setupInFlight = true;
  runSetup()
    .then(() => { setupStatus = { stage: "done", message: "Video generation is ready.", done: true }; })
    .catch((err) => {
      setupStatus = { stage: "error", message: err instanceof Error ? err.message : String(err), done: true, error: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => { setupInFlight = false; });
}

async function runSetup(): Promise<void> {
  if (process.platform !== "win32") {
    throw new VideoGenError("Video generation setup is only wired up for Windows right now.");
  }

  setupStatus = { stage: "detecting", message: "Looking for Python and a GPU…", done: false };
  const pythonCmd = await detectPythonCommand();
  const gpu = await detectGpu();

  fs.mkdirSync(VIDEOGEN_DIR, { recursive: true });

  setupStatus = { stage: "venv", message: "Creating a private Python environment…", done: false };
  const [pyExe, ...pyBaseArgs] = pythonCmd.split(" ");
  await spawnStep(pyExe, [...pyBaseArgs, "-m", "venv", VENV_DIR], { timeoutMs: 120_000 });

  setupStatus = { stage: "pytorch", message: gpu ? `Installing PyTorch for your ${gpu.name}…` : "No NVIDIA GPU detected — installing CPU-only PyTorch (generation will be slow)…", done: false };
  const torchArgs = gpu
    ? ["-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cu121"]
    : ["-m", "pip", "install", "torch"];
  await spawnStep(VENV_PYTHON, torchArgs, { timeoutMs: 900_000 });

  setupStatus = { stage: "downloading", message: "Downloading LTX-Video…", done: false };
  await downloadAndExtractRepo();

  setupStatus = { stage: "dependencies", message: "Installing LTX-Video's dependencies…", done: false };
  await spawnStep(VENV_PYTHON, ["-m", "pip", "install", "-e", ".[inference]"], { cwd: REPO_DIR, timeoutMs: 900_000 });
}

async function downloadAndExtractRepo(): Promise<void> {
  const res = await fetch(REPO_ZIP_URL, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) throw new VideoGenError(`Couldn't download LTX-Video (${res.status} ${res.statusText}).`);

  const zipPath = path.join(os.tmpdir(), `ltx-video-${randomUUID()}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const extractDir = path.join(VIDEOGEN_DIR, "extract-tmp");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await spawnStep("powershell.exe", [
      "-NoProfile", "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], { timeoutMs: 120_000 });
  } finally {
    fs.unlinkSync(zipPath);
  }

  // GitHub's branch-zip always nests everything under "<repo>-<branch>/".
  const nested = fs.readdirSync(extractDir).find((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
  if (!nested) throw new VideoGenError("LTX-Video archive extracted but its contents weren't where expected.");

  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.renameSync(path.join(extractDir, nested), REPO_DIR);
  fs.rmSync(extractDir, { recursive: true, force: true });
  disablePromptEnhancer();
}

/**
 * The pipeline config's prompt-enhancement step (confirmed via
 * ltx_video/inference.py: `enhance_prompt = threshold > 0 and
 * prompt_word_count < threshold`) triggers on SHORT prompts, not long ones —
 * the opposite of what the option name suggests. Since ordinary prompts
 * (including every one of AURORA's own presets) are well under the 120-word
 * threshold, this fired on nearly every generation, loading two extra
 * multi-GB models (a Florence-2 image captioner and a Llama-3.2-3B text
 * model) on top of the already-loaded video model — a one-time ~30+ minute
 * download the first time, and a hard VRAM-exhaustion crash with zero
 * traceback every time after, confirmed directly against this exact
 * checkpoint. Setting the threshold to 0 makes `enhance_prompt` always
 * false, skipping this entirely. Best-effort: if the config's shape ever
 * changes upstream, this just leaves prompt enhancement as-is rather than
 * failing setup outright.
 */
function disablePromptEnhancer(): void {
  const configPath = path.join(REPO_DIR, PIPELINE_CONFIG);
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    const patched = text.replace(/^prompt_enhancement_words_threshold:\s*\d+/m, "prompt_enhancement_words_threshold: 0");
    if (patched !== text) fs.writeFileSync(configPath, patched);
  } catch {
    /* best-effort — worst case prompt enhancement stays on */
  }
}

export interface GenerateVideoOptions {
  prompt: string;
  conditioningImagePath?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  /**
   * When set, Ollama is unloaded again right here — immediately before the
   * subprocess spawns — not just once by the caller earlier in the request.
   * Checkpoint loading is fast (a few seconds) once the process actually
   * gets there, but getting there (script startup, imports) takes ~10-15s,
   * and an unload done only at the top of the request left a real window
   * where ordinary chat use during that gap could reload a model and starve
   * the checkpoint load of VRAM again — confirmed happening live even after
   * the caller-side unload was already in place.
   */
  ollamaHost?: string;
}

export interface GenerateVideoHooks {
  /** Called with the latest output line as it arrives — piped through to the tool-call transcript so "running…" shows real activity instead of sitting static for the better part of an hour. */
  onProgress?: (line: string) => void;
  /** Called once the subprocess actually starts, with a function that kills it — lets a Stop button reach in and cancel a run that's already in flight. */
  onStart?: (kill: () => void) => void;
}

/**
 * Runs one generation via inference.py and returns the resulting video
 * bytes. First call ever made can be very slow — the pipeline config
 * downloads its HuggingFace checkpoint the first time it's used — so
 * timing out on a fixed wall-clock duration was killing genuinely-working
 * runs (a big checkpoint download plus a render can legitimately take well
 * over 20 minutes on a modest connection/GPU). Instead this only gives up
 * if the process goes quiet for a while (likely actually stuck), with a
 * generous absolute ceiling as a last-resort backstop.
 */
function generateVideoInner(opts: GenerateVideoOptions, hooks: GenerateVideoHooks = {}): Promise<Buffer> {
  const { onProgress, onStart } = hooks;
  return new Promise(async (resolve, reject) => {
    if (!isVideoGenInstalled()) return reject(new VideoGenError("Video generation isn't set up yet — go to Settings and run setup first."));

    // Last possible moment before the subprocess exists — see
    // GenerateVideoOptions.ollamaHost for why this can't just live in the
    // caller. Best-effort: a failure here shouldn't block the actual run.
    if (opts.ollamaHost) {
      try { await unloadAllModels(opts.ollamaHost); } catch { /* best-effort */ }
    }

    const outDir = path.join(os.tmpdir(), `ltx-out-${randomUUID()}`);
    fs.mkdirSync(outDir, { recursive: true });

    const args = [
      // Unbuffered stdout/stderr — without this, Python block-buffers output
      // that isn't attached to a real terminal (which a spawned pipe never
      // is), so tqdm's download/step progress can sit in an internal buffer
      // for many minutes with nothing actually reaching Node. That starves
      // the inactivity timer below of the very "still working" signal it
      // needs, and a perfectly healthy multi-minute checkpoint download or
      // render gets killed as "looked stuck" even though it wasn't.
      "-u",
      INFERENCE_SCRIPT,
      "--prompt", opts.prompt,
      "--pipeline_config", PIPELINE_CONFIG,
      "--output_path", outDir,
      "--width", String(opts.width ?? 512),
      "--height", String(opts.height ?? 320),
      "--num_frames", String(opts.numFrames ?? 97),
    ];
    if (opts.conditioningImagePath) {
      args.push("--conditioning_media_paths", opts.conditioningImagePath, "--conditioning_start_frames", "0");
    }

    const child = spawn(VENV_PYTHON, args, {
      cwd: REPO_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let output = "";
    let settled = false;
    const INACTIVITY_LIMIT_MS = 10 * 60_000;
    const ABSOLUTE_LIMIT_MS = 90 * 60_000;
    let inactivityTimer: NodeJS.Timeout;

    function cleanup() {
      fs.rm(outDir, { recursive: true, force: true }, () => {});
    }

    function finish(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      clearTimeout(absoluteTimer);
      clearInterval(diskWatcher);
      killProcessTree(child.pid);
      cleanup();
      reject(err);
    }

    onStart?.(() => finish(new VideoGenError("Stopped by owner.")));

    const absoluteTimer = setTimeout(
      () => finish(new VideoGenError("Video generation ran for over 90 minutes without finishing — killed it. Try a shorter/smaller clip, or check the GPU isn't falling back to CPU.")),
      ABSOLUTE_LIMIT_MS,
    );
    function resetInactivityTimer() {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => finish(new VideoGenError("Video generation produced no output for 10 minutes and looked stuck — killed it.")),
        INACTIVITY_LIMIT_MS,
      );
    }
    resetInactivityTimer();

    // The first-ever run downloads several GB of HuggingFace checkpoints
    // (the LTX-Video weights, a text encoder, a prompt-enhancer LLM…), and
    // that download's own progress bar writes nothing to stdout/stderr at
    // all once it's not attached to a real terminal — which a spawned pipe
    // never is. Without this, the inactivity timer above only ever sees
    // silence during a download and kills a perfectly healthy multi-hour
    // fetch as "looked stuck". Polling the actual bytes-on-disk in the HF
    // cache directly observes real progress regardless of what the
    // subprocess does or doesn't print.
    let lastCacheBytes = getHfCacheBytesOnDisk();
    const diskWatcher = setInterval(() => {
      const now = getHfCacheBytesOnDisk();
      if (now > lastCacheBytes) {
        const deltaMb = ((now - lastCacheBytes) / (1024 * 1024)).toFixed(0);
        lastCacheBytes = now;
        resetInactivityTimer();
        onProgress?.(`Downloading model files… (+${deltaMb} MB in the last ${DISK_WATCH_INTERVAL_MS / 1000}s, ${(now / (1024 * 1024 * 1024)).toFixed(1)} GB cached so far)`);
      }
    }, DISK_WATCH_INTERVAL_MS);

    function onData(d: Buffer) {
      output += d.toString();
      resetInactivityTimer();
      if (onProgress) {
        // HuggingFace download bars and LTX-Video's own step logging both
        // rewrite a single line with \r — the last non-empty line is the
        // actual current status, not the whole accumulated dump.
        const lines = output.split(/[\r\n]+/).filter((l) => l.trim());
        if (lines.length) onProgress(lines[lines.length - 1].slice(0, 300));
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { if (!settled) { settled = true; clearTimeout(inactivityTimer); clearTimeout(absoluteTimer); clearInterval(diskWatcher); killProcessTree(child.pid); cleanup(); reject(err); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      clearTimeout(absoluteTimer);
      clearInterval(diskWatcher);
      // The top process has already exited by the time "close" fires, but a
      // crash (an uncaught Python exception, like the OOM/paging-file error
      // this is guarding against) doesn't reliably take its multiprocessing
      // workers down with it — sweep for any orphans left under this pid.
      killProcessTree(child.pid);
      if (code !== 0) { cleanup(); return reject(new VideoGenError(`LTX-Video exited with an error: ${output.slice(-2000) || `code ${code}`}`)); }
      const files = fs.readdirSync(outDir).filter((f) => !fs.statSync(path.join(outDir, f)).isDirectory());
      if (files.length === 0) { cleanup(); return reject(new VideoGenError("LTX-Video finished but didn't write an output file.")); }
      const buf = fs.readFileSync(path.join(outDir, files[0]));
      cleanup();
      resolve(buf);
    });
  });
}

/** LTX video with the GPU to itself (see gpu.ts) — local LLM calls wait or go to the cloud meanwhile. */
export function generateVideo(...args: Parameters<typeof generateVideoInner>): ReturnType<typeof generateVideoInner> {
  return withHeavyGpu("LTX video", () => generateVideoInner(...args)) as ReturnType<typeof generateVideoInner>;
}
