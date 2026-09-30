// Local neural text-to-speech via Piper (github.com/rhasspy/piper) — runs
// fully offline once the engine + a voice model are downloaded, no API key,
// no network calls at synthesis time. This is the "sounds more alive" voice
// option; the browser's built-in SpeechSynthesis (client/src/lib/voice.tsx)
// remains the zero-setup default.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PIPER_DIR, PIPER_VOICES_DIR } from "./paths";

fs.mkdirSync(PIPER_VOICES_DIR, { recursive: true });

const PIPER_ZIP_URL = "https://github.com/rhasspy/piper/releases/latest/download/piper_windows_amd64.zip";
const PIPER_ROOT = path.join(PIPER_DIR, "piper");
const PIPER_EXE = path.join(PIPER_ROOT, "piper.exe");
const ESPEAK_DATA_DIR = path.join(PIPER_ROOT, "espeak-ng-data");

export class PiperError extends Error {}

export interface CuratedVoice { id: string; label: string; blurb: string; sizeMb: number; }

export const CURATED_VOICES: CuratedVoice[] = [
  { id: "en_US-amy-medium", label: "Amy", blurb: "Warm, natural American voice — a solid default.", sizeMb: 63 },
  { id: "en_US-lessac-medium", label: "Lessac", blurb: "Clear, calm, neutral American voice.", sizeMb: 63 },
  { id: "en_US-ryan-high", label: "Ryan", blurb: "Natural American voice, higher quality (bigger download).", sizeMb: 114 },
  { id: "en_GB-jenny_dioco-medium", label: "Jenny", blurb: "Warm British voice — often the most lifelike of this set.", sizeMb: 63 },
];

function voiceModelPath(voiceId: string): string {
  return path.join(PIPER_VOICES_DIR, `${voiceId}.onnx`);
}

function voiceSourceUrl(voiceId: string, ext: "onnx" | "onnx.json"): string {
  const curated = CURATED_VOICES.find((v) => v.id === voiceId);
  if (!curated) throw new PiperError(`"${voiceId}" isn't one of the curated voices.`);
  const [langRegion, speaker, quality] = voiceId.split("-");
  const lang = langRegion.split("_")[0];
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${langRegion}/${speaker}/${quality}/${voiceId}.${ext}`;
}

export function isPiperEngineInstalled(): boolean {
  return fs.existsSync(PIPER_EXE);
}

export function installedVoices(): string[] {
  if (!fs.existsSync(PIPER_VOICES_DIR)) return [];
  return fs.readdirSync(PIPER_VOICES_DIR)
    .filter((f) => f.endsWith(".onnx"))
    .map((f) => f.slice(0, -".onnx".length));
}

/** Downloads the Piper engine binary + its espeak-ng phonemizer data and unzips it into PIPER_DIR. Windows-only, matching the rest of AURORA's installer tooling. */
export async function downloadAndInstallPiperEngine(): Promise<void> {
  if (process.platform !== "win32") {
    throw new PiperError("Piper auto-install is only wired up for Windows right now.");
  }

  const res = await fetch(PIPER_ZIP_URL, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) {
    throw new PiperError(`Couldn't download the Piper engine (${res.status} ${res.statusText}).`);
  }

  fs.mkdirSync(PIPER_DIR, { recursive: true });
  const zipPath = path.join(os.tmpdir(), `piper-${randomUUID()}.zip`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, buf);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${PIPER_DIR}' -Force`,
      ]);
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        code === 0 ? resolve() : reject(new PiperError(`Extracting the Piper engine failed: ${stderr || `exit code ${code}`}`));
      });
    });
  } finally {
    fs.unlinkSync(zipPath);
  }

  if (!fs.existsSync(PIPER_EXE)) {
    throw new PiperError("Piper engine extracted, but piper.exe wasn't where it was expected — the release layout may have changed.");
  }
}

export async function downloadVoice(voiceId: string): Promise<void> {
  const [onnxRes, jsonRes] = await Promise.all([
    fetch(voiceSourceUrl(voiceId, "onnx"), { redirect: "follow", signal: AbortSignal.timeout(180_000) }),
    fetch(voiceSourceUrl(voiceId, "onnx.json"), { redirect: "follow", signal: AbortSignal.timeout(60_000) }),
  ]);
  if (!onnxRes.ok || !onnxRes.body) throw new PiperError(`Couldn't download voice "${voiceId}" (${onnxRes.status} ${onnxRes.statusText}).`);
  if (!jsonRes.ok || !jsonRes.body) throw new PiperError(`Couldn't download voice "${voiceId}"'s config (${jsonRes.status} ${jsonRes.statusText}).`);

  const [onnxBuf, jsonBuf] = await Promise.all([onnxRes.arrayBuffer(), jsonRes.arrayBuffer()]);
  fs.writeFileSync(voiceModelPath(voiceId), Buffer.from(onnxBuf));
  fs.writeFileSync(`${voiceModelPath(voiceId)}.json`, Buffer.from(jsonBuf));
}

/**
 * Synthesizes text to a WAV buffer via Piper's CLI.
 *
 * This writes to a real temp file (`-f <path>`) rather than streaming to
 * stdout (`-f -`) — measured empirically (FFT spectral analysis of the
 * output) that this exact piper.exe build produces audio dominated by
 * high-frequency noise in stdout mode: ~86% of non-silent 50ms windows had
 * over half their energy above 4kHz, versus ~27% for the identical text
 * written straight to a file, which matches a normal speech spectrum. Same
 * binary, same voice, same text — the only difference was `-f -` vs
 * `-f <path>`, so this is a real bug in Piper's stdout path on this
 * platform/build, not something introduced downstream. Writing to a file
 * sidesteps it entirely and also means Piper's own header (which it can
 * seek back and correct once it knows the final length) is trustworthy, so
 * no post-hoc size patching is needed either.
 *
 * 30s cap — same ceiling as the app's other subprocess tools.
 */
export function synthesize(text: string, voiceId: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!isPiperEngineInstalled()) return reject(new PiperError("Piper engine isn't installed yet."));
    const modelPath = voiceModelPath(voiceId);
    if (!fs.existsSync(modelPath)) return reject(new PiperError(`Voice "${voiceId}" isn't downloaded yet.`));

    const outPath = path.join(os.tmpdir(), `piper-out-${randomUUID()}.wav`);
    const child = spawn(PIPER_EXE, ["-m", modelPath, "-f", outPath, "--espeak_data", ESPEAK_DATA_DIR, "-q"]);
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new PiperError("Speech synthesis timed out.")); }, 30_000);

    function cleanup() {
      fs.unlink(outPath, () => {});
    }

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); cleanup(); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { cleanup(); return reject(new PiperError(`Piper exited with an error: ${stderr || `code ${code}`}`)); }
      fs.readFile(outPath, (err, buf) => {
        cleanup();
        if (err) return reject(new PiperError(`Piper finished but its output file couldn't be read: ${err.message}`));
        resolve(buf);
      });
    });

    child.stdin.write(text);
    child.stdin.end();
  });
}
