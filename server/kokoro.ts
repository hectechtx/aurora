// Kokoro-82M neural text-to-speech — the "sounds like a person" voice engine.
//
// Why this exists alongside piper.ts: Piper is fast and fully offline, but its
// medium-quality voices have flat, uniform prosody — the robotic sound. Kokoro
// is an 82M-parameter model with genuinely expressive intonation (real phrase
// stress, question contours, natural pacing) at ~350MB of weights.
//
// Deliberately CPU-only. Kokoro is small enough that CPU inference runs faster
// than realtime, and on an 8GB card the GPU is already spoken for by Ollama —
// see the num_ctx work in ollama.ts. Speaking should never evict the brain.
//
// The model is loaded once into a long-lived Python worker rather than spawned
// per utterance: importing torch + loading weights costs ~10-15s, which would
// make every single reply feel broken. The worker stays warm and answers
// newline-delimited JSON requests in ~0.3-1s.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { KOKORO_DIR } from "./paths";

const VENV_DIR = path.join(KOKORO_DIR, "venv");
const VENV_PYTHON = path.join(VENV_DIR, "Scripts", "python.exe");
const WORKER_SCRIPT = path.join(KOKORO_DIR, "kokoro_worker.py");

export class KokoroError extends Error {}

export interface KokoroVoice {
  id: string;
  label: string;
  blurb: string;
  accent: "American" | "British";
}

// Kokoro v1.0's voice pack, filtered to the ones that actually hold up in
// listening — the model card grades them, and anything below a B tends to
// have audible artifacts on long sentences. Ordered best-first.
export const KOKORO_VOICES: KokoroVoice[] = [
  { id: "af_heart", label: "Heart", blurb: "Warm, expressive, the most natural of the set.", accent: "American" },
  { id: "af_bella", label: "Bella", blurb: "Rich and confident, strong emotional range.", accent: "American" },
  { id: "af_nicole", label: "Nicole", blurb: "Soft and close-mic'd, almost whispered.", accent: "American" },
  { id: "af_sarah", label: "Sarah", blurb: "Bright and friendly, everyday conversational.", accent: "American" },
  { id: "af_sky", label: "Sky", blurb: "Light, youthful, quick-paced.", accent: "American" },
  { id: "am_michael", label: "Michael", blurb: "Steady, grounded male voice.", accent: "American" },
  { id: "am_fenrir", label: "Fenrir", blurb: "Deeper, more dramatic male voice.", accent: "American" },
  { id: "am_puck", label: "Puck", blurb: "Playful and animated male voice.", accent: "American" },
  { id: "bf_emma", label: "Emma", blurb: "Warm British female — very lifelike.", accent: "British" },
  { id: "bf_isabella", label: "Isabella", blurb: "Poised, articulate British female.", accent: "British" },
  { id: "bm_george", label: "George", blurb: "Classic British male, measured.", accent: "British" },
  { id: "bm_fable", label: "Fable", blurb: "Storyteller cadence, British male.", accent: "British" },
];

export function isKokoroInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(WORKER_SCRIPT);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface KokoroSetupStatus {
  running: boolean;
  step: string;
  error: string | null;
}

let setup: KokoroSetupStatus = { running: false, step: "", error: null };

export function getKokoroSetupStatus(): KokoroSetupStatus {
  return setup;
}

function spawnStep(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let tail = "";
    const timer = setTimeout(() => { child.kill(); reject(new KokoroError(`Step timed out: ${path.basename(cmd)} ${args[0] ?? ""}`)); }, timeoutMs);
    const collect = (d: Buffer) => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new KokoroError(`Step failed (exit ${code}): ${tail.slice(-600)}`));
    });
  });
}

async function detectPythonCommand(): Promise<string> {
  for (const candidate of [["py", ["-3", "--version"]], ["python", ["--version"]]] as const) {
    try {
      await spawnStep(candidate[0], [...candidate[1]], 15_000);
      return candidate[0];
    } catch { /* try the next one */ }
  }
  throw new KokoroError("Python 3 wasn't found on PATH. Install Python 3.10+ and try again.");
}

/** Fire-and-forget: the install takes several minutes (torch is a big wheel), so the route returns immediately and Settings polls getKokoroSetupStatus(). */
export function startKokoroSetup(): void {
  if (setup.running) return;
  setup = { running: true, step: "Starting…", error: null };
  runSetup()
    .then(() => { setup = { running: false, step: "Done", error: null }; })
    .catch((err) => { setup = { running: false, step: "", error: err instanceof Error ? err.message : String(err) }; });
}

async function runSetup(): Promise<void> {
  fs.mkdirSync(KOKORO_DIR, { recursive: true });

  const py = await detectPythonCommand();
  const pyBase = py === "py" ? ["-3"] : [];

  setup = { ...setup, step: "Creating Python environment…" };
  if (!fs.existsSync(VENV_PYTHON)) {
    await spawnStep(py, [...pyBase, "-m", "venv", VENV_DIR], 180_000);
  }

  setup = { ...setup, step: "Installing PyTorch (CPU)…" };
  // Explicitly the CPU index — the default PyPI wheel on Windows would also
  // be CPU, but pinning it makes the intent unambiguous and avoids pulling a
  // ~2.5GB CUDA build we'd never use.
  await spawnStep(VENV_PYTHON, [
    "-m", "pip", "install", "--upgrade",
    "torch", "--index-url", "https://download.pytorch.org/whl/cpu",
  ], 1_800_000);

  setup = { ...setup, step: "Installing Kokoro…" };
  await spawnStep(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "kokoro>=0.9.4", "soundfile"], 900_000);

  setup = { ...setup, step: "Installing the pronunciation model…" };
  // Kokoro's English G2P (misaki) leans on spaCy's en_core_web_sm, which is
  // NOT a pip dependency — it gets fetched lazily the first time a pipeline is
  // built. Left implicit, the owner's first spoken sentence stalls on a 12MB
  // download, and fails outright if they happen to be offline. Pull it now.
  await spawnStep(VENV_PYTHON, ["-m", "spacy", "download", "en_core_web_sm"], 600_000);

  setup = { ...setup, step: "Writing worker…" };
  writeWorkerScript();

  setup = { ...setup, step: "Downloading voice model…" };
  // First worker boot pulls the ~350MB weights from HuggingFace into HF_HOME
  // (which launch.cmd points at the F drive). Doing it here rather than on the
  // first spoken sentence means the first reply isn't a two-minute silence.
  await synthesize("Hello. Kokoro is ready.", "af_heart");
}

function writeWorkerScript(): void {
  // Kokoro's KPipeline yields (graphemes, phonemes, audio) per chunk; long
  // text comes back as several chunks that have to be concatenated. lang_code
  // is derived from the voice prefix — 'a' = American, 'b' = British — which
  // is Kokoro's own naming convention, and passing the wrong one produces
  // correct words with the wrong accent's phonemes.
  const script = `import sys, json, os
import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24000
_pipelines = {}

def pipeline_for(voice):
    code = voice[0] if voice and voice[0] in ("a", "b") else "a"
    if code not in _pipelines:
        _pipelines[code] = KPipeline(lang_code=code)
    return _pipelines[code]

def to_numpy(audio):
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    return np.asarray(audio, dtype=np.float32)

print(json.dumps({"event": "ready"}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id")
        voice = req.get("voice", "af_heart")
        speed = float(req.get("speed", 1.0))
        chunks = [to_numpy(a) for _, _, a in pipeline_for(voice)(req["text"], voice=voice, speed=speed)]
        if not chunks:
            raise RuntimeError("Kokoro produced no audio for that text.")
        audio = chunks[0] if len(chunks) == 1 else np.concatenate(chunks)
        sf.write(req["out"], audio, SAMPLE_RATE)
        print(json.dumps({"event": "done", "id": req_id}), flush=True)
    except Exception as exc:
        print(json.dumps({"event": "error", "id": req_id, "error": str(exc)}), flush=True)
`;
  fs.writeFileSync(WORKER_SCRIPT, script, "utf8");
}

// ---------------------------------------------------------------------------
// The long-lived worker
// ---------------------------------------------------------------------------

interface Pending { resolve: (outPath: string) => void; reject: (err: Error) => void; out: string; timer: NodeJS.Timeout }

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady: Promise<void> | null = null;
const pending = new Map<string, Pending>();

function failAll(err: Error): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function startWorker(): Promise<void> {
  if (workerReady) return workerReady;
  if (!isKokoroInstalled()) return Promise.reject(new KokoroError("Kokoro isn't installed yet."));

  workerReady = new Promise<void>((resolve, reject) => {
    const child = spawn(VENV_PYTHON, [WORKER_SCRIPT], {
      cwd: KOKORO_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    worker = child;

    // Generous: the very first boot downloads the weights before printing ready.
    const bootTimer = setTimeout(() => {
      child.kill();
      reject(new KokoroError("Kokoro's voice engine didn't finish starting up in time."));
    }, 600_000);

    let stdoutBuf = "";
    let stderrTail = "";

    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; } // torch/HF chatter on stdout
        if (msg.event === "ready") { clearTimeout(bootTimer); resolve(); continue; }
        const p = msg.id ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.event === "done") p.resolve(p.out);
        else p.reject(new KokoroError(msg.error || "Kokoro failed to synthesize that."));
      }
    });

    child.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    child.on("error", (err) => {
      clearTimeout(bootTimer);
      worker = null; workerReady = null;
      failAll(err);
      reject(err);
    });

    // A crashed worker must not wedge the engine forever — clearing the cached
    // promise means the next speak() attempt transparently starts a fresh one.
    child.on("close", (code) => {
      clearTimeout(bootTimer);
      worker = null; workerReady = null;
      const err = new KokoroError(`Kokoro's voice engine stopped (exit ${code}). ${stderrTail.slice(-400)}`);
      failAll(err);
      reject(err);
    });
  });

  return workerReady;
}

/** Stops the worker (used when uninstalling or shutting down). Safe to call when nothing is running. */
export function stopKokoroWorker(): void {
  worker?.kill();
  worker = null;
  workerReady = null;
  failAll(new KokoroError("Kokoro's voice engine was stopped."));
}

/**
 * Synthesizes text to a 24kHz WAV buffer. `speed` is Kokoro's own pacing
 * multiplier — the practical range is ~0.7 (slow, deliberate) to ~1.3
 * (brisk); outside that the prosody starts to distort, so it's clamped.
 */
export async function synthesize(text: string, voice: string, speed = 1.0): Promise<Buffer> {
  await startWorker();
  const child = worker;
  if (!child) throw new KokoroError("Kokoro's voice engine isn't running.");

  const id = randomUUID();
  const out = path.join(os.tmpdir(), `kokoro-${id}.wav`);
  const clamped = Math.min(1.3, Math.max(0.7, speed));

  const outPath = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new KokoroError("Speech synthesis timed out."));
    }, 120_000);
    pending.set(id, { resolve, reject, out, timer });
    child.stdin.write(JSON.stringify({ id, text, voice, speed: clamped, out }) + "\n");
  });

  try {
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(outPath).catch(() => {});
  }
}
