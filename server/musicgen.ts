// Local AI music generation via ACE-Step (github.com/ace-step/ACE-Step) — a
// 3.5B text+lyrics-to-music diffusion model that its authors explicitly tuned
// to run in ~8GB of VRAM (with cpu_offload), which is exactly this machine's
// class. Same install-once shape as server/videogen.ts: a private Python venv
// + PyTorch matched to the GPU + the cloned repo installed editable, then a
// small wrapper script we spawn per generation and read the .wav it writes.
//
// Like video-gen this can't be a single silent binary — a diffusion model
// needs a real Python/PyTorch/CUDA stack, so setup is multi-stage with its own
// progress channel (mirroring ollama.ts's pull-status pattern).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { MUSICGEN_DIR } from "./paths";
import { unloadAllModels } from "./ollama";
import { withHeavyGpu } from "./gpu";

const REPO_DIR = path.join(MUSICGEN_DIR, "repo");
const VENV_DIR = path.join(MUSICGEN_DIR, "venv");
const VENV_PYTHON = path.join(VENV_DIR, "Scripts", "python.exe");
const INFER_SCRIPT = path.join(MUSICGEN_DIR, "acestep_infer.py");
const CHECKPOINT_DIR = path.join(MUSICGEN_DIR, "checkpoints");
const REPO_ZIP_URL = "https://github.com/ace-step/ACE-Step/archive/refs/heads/main.zip";

export class MusicGenError extends Error {}

/** ACE-Step (via diffusers) spawns worker processes/threads; kill the whole tree so a cancelled run leaves nothing holding VRAM/RAM. Best-effort. */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
}

export interface GpuInfo { name: string; vramMb: number }

export interface MusicGenSetupStatus {
  stage: "idle" | "detecting" | "venv" | "pytorch" | "downloading" | "dependencies" | "done" | "error";
  message: string;
  done: boolean;
  error?: string;
}

let setupStatus: MusicGenSetupStatus = { stage: "idle", message: "", done: true };
let setupInFlight = false;

export function getSetupStatus(): MusicGenSetupStatus {
  return setupStatus;
}

export function isMusicGenInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(INFER_SCRIPT) && fs.existsSync(path.join(REPO_DIR, "setup.py"));
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

async function detectPythonCommand(): Promise<string> {
  const candidates = ["py -3", "python", "python3"];
  for (const candidate of candidates) {
    const [cmd, ...baseArgs] = candidate.split(" ");
    try {
      const { stdout } = await run(cmd, [...baseArgs, "--version"]);
      const match = stdout.match(/Python (\d+)\.(\d+)/);
      if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10))) return candidate;
    } catch { /* try next */ }
  }
  throw new MusicGenError("No Python 3.10+ found. Install it from python.org (check \"Add to PATH\"), then try again.");
}

export async function detectGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
    const [name, vram] = stdout.trim().split(",").map((s) => s.trim());
    if (!name) return null;
    return { name, vramMb: Number(vram) || 0 };
  } catch {
    return null;
  }
}

function spawnStep(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new MusicGenError("Step timed out.")); }, opts.timeoutMs);
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new MusicGenError(stderr.slice(-2000) || `exited with code ${code}`));
      resolve();
    });
  });
}

/** Fire-and-forget; the client polls getSetupStatus() for progress. Windows-only, matching the rest of AURORA's local-tooling installers. */
export function startMusicGenSetup(): void {
  if (setupInFlight) return;
  setupInFlight = true;
  runSetup()
    .then(() => { setupStatus = { stage: "done", message: "Music generation is ready.", done: true }; })
    .catch((err) => {
      setupStatus = { stage: "error", message: err instanceof Error ? err.message : String(err), done: true, error: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => { setupInFlight = false; });
}

async function runSetup(): Promise<void> {
  if (process.platform !== "win32") throw new MusicGenError("Music generation setup is only wired up for Windows right now.");

  setupStatus = { stage: "detecting", message: "Looking for Python and a GPU…", done: false };
  const pythonCmd = await detectPythonCommand();
  const gpu = await detectGpu();

  fs.mkdirSync(MUSICGEN_DIR, { recursive: true });
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

  setupStatus = { stage: "venv", message: "Creating a private Python environment…", done: false };
  const [pyExe, ...pyBaseArgs] = pythonCmd.split(" ");
  await spawnStep(pyExe, [...pyBaseArgs, "-m", "venv", VENV_DIR], { timeoutMs: 120_000 });

  setupStatus = { stage: "pytorch", message: gpu ? `Installing PyTorch for your ${gpu.name}…` : "No NVIDIA GPU detected — installing CPU-only PyTorch (generation will be very slow)…", done: false };
  const torchArgs = gpu
    ? ["-m", "pip", "install", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu121"]
    : ["-m", "pip", "install", "torch", "torchaudio"];
  await spawnStep(VENV_PYTHON, torchArgs, { timeoutMs: 1_200_000 });

  setupStatus = { stage: "downloading", message: "Downloading ACE-Step…", done: false };
  await downloadAndExtractRepo();

  setupStatus = { stage: "dependencies", message: "Installing ACE-Step's dependencies (this is the long part)…", done: false };
  await spawnStep(VENV_PYTHON, ["-m", "pip", "install", "-e", "."], { cwd: REPO_DIR, timeoutMs: 1_800_000 });

  writeInferenceScript();
}

async function downloadAndExtractRepo(): Promise<void> {
  const res = await fetch(REPO_ZIP_URL, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new MusicGenError(`Couldn't download ACE-Step (${res.status} ${res.statusText}).`);

  const zipPath = path.join(os.tmpdir(), `acestep-${randomUUID()}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const extractDir = path.join(MUSICGEN_DIR, "extract-tmp");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    await spawnStep("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`], { timeoutMs: 120_000 });
  } finally {
    fs.unlinkSync(zipPath);
  }

  const nested = fs.readdirSync(extractDir).find((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
  if (!nested) throw new MusicGenError("ACE-Step archive extracted but its contents weren't where expected.");
  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.renameSync(path.join(extractDir, nested), REPO_DIR);
  fs.rmSync(extractDir, { recursive: true, force: true });
}

/**
 * The wrapper we spawn per generation. Uses ACE-Step's own pipeline
 * (acestep.pipeline_ace_step.ACEStepPipeline) with cpu_offload + overlapped
 * decode so it fits ~8GB, reads a JSON job on argv, writes a wav to the given
 * path. Checkpoints auto-download into CHECKPOINT_DIR the first time.
 */
function writeInferenceScript(): void {
  const script = `import json, sys, os
from acestep.pipeline_ace_step import ACEStepPipeline

def main():
    job = json.loads(sys.argv[1])
    checkpoint_dir = job["checkpoint_dir"]
    pipe = ACEStepPipeline(
        checkpoint_dir=checkpoint_dir,
        dtype="bfloat16",
        torch_compile=False,
        cpu_offload=True,
        overlapped_decode=True,
    )
    pipe(
        audio_duration=float(job.get("duration", 60)),
        prompt=job.get("prompt", ""),
        lyrics=job.get("lyrics", ""),
        infer_step=int(job.get("infer_step", 27)),
        guidance_scale=float(job.get("guidance_scale", 15.0)),
        scheduler_type="euler",
        cfg_type="apg",
        omega_scale=10.0,
        manual_seeds=job.get("seed", None),
        guidance_interval=0.5,
        guidance_interval_decay=0.0,
        min_guidance_scale=3.0,
        use_erg_tag=True,
        use_erg_lyric=True,
        use_erg_diffusion=True,
        oss_steps=None,
        save_path=job["save_path"],
    )
    print("SAVED:" + job["save_path"], flush=True)

if __name__ == "__main__":
    main()
`;
  fs.writeFileSync(INFER_SCRIPT, script);
}

export interface GenerateMusicOptions {
  prompt: string;            // style/genre/instrument/mood tags
  lyrics?: string;           // optional lyrics (use "[inst]" for instrumental)
  durationSeconds?: number;  // 30–240
  ollamaHost?: string;       // unload Ollama right before spawning to free VRAM
}

export interface GenerateMusicHooks {
  onProgress?: (line: string) => void;
  onStart?: (kill: () => void) => void;
}

/**
 * One generation via the wrapper. First call ever can be slow (checkpoints
 * download on first use), so — like video-gen — this gives up only if the
 * process goes quiet for a long stretch, with a generous absolute ceiling.
 */
function generateMusicInner(opts: GenerateMusicOptions, hooks: GenerateMusicHooks = {}): Promise<Buffer> {
  const { onProgress, onStart } = hooks;
  return new Promise(async (resolve, reject) => {
    if (!isMusicGenInstalled()) return reject(new MusicGenError("Music generation isn't set up yet — go to Settings and run setup first."));

    if (opts.ollamaHost) {
      try { await unloadAllModels(opts.ollamaHost); } catch { /* best-effort */ }
    }

    const outPath = path.join(os.tmpdir(), `acestep-${randomUUID()}.wav`);
    const job = {
      checkpoint_dir: CHECKPOINT_DIR,
      prompt: opts.prompt,
      lyrics: opts.lyrics && opts.lyrics.trim() ? opts.lyrics : "[inst]",
      duration: Math.min(Math.max(opts.durationSeconds ?? 60, 15), 240),
      save_path: outPath,
    };

    const child = spawn(VENV_PYTHON, [INFER_SCRIPT, JSON.stringify(job)], { cwd: REPO_DIR, windowsHide: true });
    onStart?.(() => killProcessTree(child.pid));

    let stderrTail = "";
    let lastActivity = Date.now();
    const QUIET_LIMIT_MS = 15 * 60_000;   // 15 min of total silence = probably stuck
    const HARD_CEILING_MS = 60 * 60_000;  // 1 hr absolute backstop (first-run download + gen)
    const started = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - lastActivity > QUIET_LIMIT_MS || Date.now() - started > HARD_CEILING_MS) {
        clearInterval(watch);
        killProcessTree(child.pid);
        reject(new MusicGenError("Music generation stalled or timed out."));
      }
    }, 20_000);

    const onData = (d: Buffer) => {
      const s = d.toString();
      lastActivity = Date.now();
      stderrTail = (stderrTail + s).slice(-4000);
      for (const line of s.split(/\r?\n/)) if (line.trim()) onProgress?.(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => { clearInterval(watch); reject(new MusicGenError(err.message)); });
    child.on("close", (code) => {
      clearInterval(watch);
      if (code !== 0) return reject(new MusicGenError(stderrTail.slice(-1500) || `exited with code ${code}`));
      try {
        const buf = fs.readFileSync(outPath);
        fs.unlinkSync(outPath);
        resolve(buf);
      } catch {
        reject(new MusicGenError("Generation finished but no audio file was produced."));
      }
    });
  });
}

/** music with the GPU to itself (see gpu.ts) — local LLM calls wait or go to the cloud meanwhile. */
export function generateMusic(...args: Parameters<typeof generateMusicInner>): ReturnType<typeof generateMusicInner> {
  return withHeavyGpu("music", () => generateMusicInner(...args)) as ReturnType<typeof generateMusicInner>;
}
