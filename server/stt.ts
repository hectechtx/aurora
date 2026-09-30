// Local speech-to-text via faster-whisper — this is AURORA's hearing.
//
// The browser has a built-in SpeechRecognition API, but in Chromium it ships
// your microphone audio to Google's servers to be transcribed. That's exactly
// the trade AURORA exists to avoid, so hearing gets the same treatment as
// every other capability here: a local model, in a local venv, with nothing
// leaving the machine.
//
// faster-whisper rather than openai-whisper because it runs on CTranslate2
// instead of torch — int8 CPU inference transcribes a short utterance in well
// under a second and the install is a fraction of the size. Like kokoro.ts,
// the model is loaded once into a long-lived worker; reloading per utterance
// would add ~5s of dead air to every spoken sentence.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { STT_DIR } from "./paths";
import { getFfmpegPath } from "./videogen";

const VENV_DIR = path.join(STT_DIR, "venv");
const VENV_PYTHON = path.join(VENV_DIR, "Scripts", "python.exe");
const WORKER_SCRIPT = path.join(STT_DIR, "stt_worker.py");

// base.en is the sweet spot for dictation on CPU: noticeably more accurate
// than tiny on real speech, still transcribes faster than realtime, ~150MB.
const MODEL_NAME = "base.en";

export class SttError extends Error {}

export function isSttInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(WORKER_SCRIPT);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface SttSetupStatus { running: boolean; step: string; error: string | null }

let setup: SttSetupStatus = { running: false, step: "", error: null };

export function getSttSetupStatus(): SttSetupStatus {
  return setup;
}

function spawnStep(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let tail = "";
    const timer = setTimeout(() => { child.kill(); reject(new SttError(`Step timed out: ${path.basename(cmd)}`)); }, timeoutMs);
    const collect = (d: Buffer) => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new SttError(`Step failed (exit ${code}): ${tail.slice(-600)}`));
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
  throw new SttError("Python 3 wasn't found on PATH. Install Python 3.10+ and try again.");
}

/** Fire-and-forget, same shape as startKokoroSetup(); Settings polls getSttSetupStatus(). */
export function startSttSetup(): void {
  if (setup.running) return;
  setup = { running: true, step: "Starting…", error: null };
  runSetup()
    .then(() => { setup = { running: false, step: "Done", error: null }; })
    .catch((err) => { setup = { running: false, step: "", error: err instanceof Error ? err.message : String(err) }; });
}

async function runSetup(): Promise<void> {
  fs.mkdirSync(STT_DIR, { recursive: true });

  const py = await detectPythonCommand();
  const pyBase = py === "py" ? ["-3"] : [];

  setup = { ...setup, step: "Creating Python environment…" };
  if (!fs.existsSync(VENV_PYTHON)) {
    await spawnStep(py, [...pyBase, "-m", "venv", VENV_DIR], 180_000);
  }

  setup = { ...setup, step: "Installing faster-whisper…" };
  await spawnStep(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "faster-whisper"], 900_000);

  setup = { ...setup, step: "Writing worker…" };
  writeWorkerScript();

  setup = { ...setup, step: "Downloading speech model…" };
  // Boot the worker once so the model downloads now rather than on the first
  // thing the owner tries to say.
  await startWorker();
}

function writeWorkerScript(): void {
  const script = `import sys, json
from faster_whisper import WhisperModel

model = WhisperModel("${MODEL_NAME}", device="cpu", compute_type="int8")
print(json.dumps({"event": "ready"}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id")
        # vad_filter drops the silence around a push-to-talk clip, which both
        # speeds things up and stops Whisper hallucinating words into the gaps.
        segments, _ = model.transcribe(req["path"], beam_size=5, vad_filter=True)
        text = "".join(seg.text for seg in segments).strip()
        print(json.dumps({"event": "done", "id": req_id, "text": text}), flush=True)
    except Exception as exc:
        print(json.dumps({"event": "error", "id": req_id, "error": str(exc)}), flush=True)
`;
  fs.writeFileSync(WORKER_SCRIPT, script, "utf8");
}

// ---------------------------------------------------------------------------
// The long-lived worker
// ---------------------------------------------------------------------------

interface Pending { resolve: (text: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

let worker: ChildProcessWithoutNullStreams | null = null;
let workerReady: Promise<void> | null = null;
const pending = new Map<string, Pending>();

function failAll(err: Error): void {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function startWorker(): Promise<void> {
  if (workerReady) return workerReady;
  if (!fs.existsSync(VENV_PYTHON) || !fs.existsSync(WORKER_SCRIPT)) {
    return Promise.reject(new SttError("Speech recognition isn't installed yet."));
  }

  workerReady = new Promise<void>((resolve, reject) => {
    const child = spawn(VENV_PYTHON, [WORKER_SCRIPT], {
      cwd: STT_DIR,
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
    worker = child;

    // Generous — the first boot downloads the model before printing ready.
    const bootTimer = setTimeout(() => {
      child.kill();
      reject(new SttError("The speech recognizer didn't finish starting up in time."));
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
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === "ready") { clearTimeout(bootTimer); resolve(); continue; }
        const p = msg.id ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.event === "done") p.resolve(msg.text ?? "");
        else p.reject(new SttError(msg.error || "Couldn't transcribe that."));
      }
    });

    child.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    child.on("error", (err) => {
      clearTimeout(bootTimer);
      worker = null; workerReady = null;
      failAll(err); reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(bootTimer);
      worker = null; workerReady = null;
      const err = new SttError(`The speech recognizer stopped (exit ${code}). ${stderrTail.slice(-400)}`);
      failAll(err); reject(err);
    });
  });

  return workerReady;
}

export function stopSttWorker(): void {
  worker?.kill();
  worker = null;
  workerReady = null;
  failAll(new SttError("The speech recognizer was stopped."));
}

/** Converts browser-recorded audio (webm/ogg/mp4) to the 16kHz mono WAV Whisper wants, using the ffmpeg binary that came with the video-gen install. */
function toWav(inputPath: string): Promise<string> {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return Promise.reject(new SttError("ffmpeg isn't available — install video generation, which bundles it."));
  const outPath = `${inputPath}.wav`;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outPath], { windowsHide: true });
    let tail = "";
    const timer = setTimeout(() => { child.kill(); reject(new SttError("Audio conversion timed out.")); }, 60_000);
    child.stderr.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-1000); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(outPath) : reject(new SttError(`Couldn't decode that audio: ${tail.slice(-300)}`));
    });
  });
}

/** Transcribes a recorded audio clip. `audio` is whatever the browser's MediaRecorder produced. */
export async function transcribe(audio: Buffer, ext = "webm"): Promise<string> {
  await startWorker();
  const child = worker;
  if (!child) throw new SttError("The speech recognizer isn't running.");

  const rawPath = path.join(os.tmpdir(), `stt-${randomUUID()}.${ext}`);
  await fs.promises.writeFile(rawPath, audio);

  let wavPath: string | null = null;
  try {
    wavPath = await toWav(rawPath);
    const id = randomUUID();
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new SttError("Transcription timed out.")); }, 120_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, path: wavPath }) + "\n");
    });
  } finally {
    fs.promises.unlink(rawPath).catch(() => {});
    if (wavPath) fs.promises.unlink(wavPath).catch(() => {});
  }
}
