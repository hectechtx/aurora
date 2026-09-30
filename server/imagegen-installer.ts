// Guided local install + lifecycle management for AUTOMATIC1111's
// stable-diffusion-webui — unlike LTX-Video (a CLI AURORA spawns per call),
// this is a standing local HTTP server (same shape as Ollama itself):
// install it once, then start/stop it as a background process, and
// imagegen.ts's existing health()/generateImage() talk to it over HTTP at
// whatever imageGenHost points to (default http://localhost:8188).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { IMAGEGEN_DIR } from "./paths";

const REPO_DIR = path.join(IMAGEGEN_DIR, "repo");
const REPO_ZIP_URL = "https://github.com/AUTOMATIC1111/stable-diffusion-webui/archive/refs/heads/master.zip";
const WEBUI_USER_BAT = path.join(REPO_DIR, "webui-user.bat");
const DEFAULT_PORT = 8188;

export class ImageGenInstallError extends Error {}

export interface ImageGenSetupStatus {
  stage: "idle" | "detecting" | "downloading" | "dependencies" | "done" | "error";
  message: string;
  done: boolean;
  error?: string;
}

let setupStatus: ImageGenSetupStatus = { stage: "idle", message: "", done: true };
let setupInFlight = false;
let serverProcess: ChildProcess | null = null;

export function getSetupStatus(): ImageGenSetupStatus {
  return setupStatus;
}

export function isImageGenInstalled(): boolean {
  return fs.existsSync(WEBUI_USER_BAT) && fs.existsSync(path.join(REPO_DIR, "launch.py"));
}

export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ stdout });
    });
  });
}

async function detectPythonCommand(): Promise<string> {
  const candidates = ["py -3.10", "py -3", "python", "python3"];
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
  throw new ImageGenInstallError("No Python 3.10+ found on this machine. Install it from python.org (check \"Add to PATH\" during setup), then try again.");
}

/** Fire-and-forget, same polling-status pattern as videogen.ts's setup. */
export function startImageGenSetup(): void {
  if (setupInFlight) return;
  setupInFlight = true;
  runSetup()
    .then(() => { setupStatus = { stage: "done", message: "Image generation is installed. Start the server below, then add a checkpoint model.", done: true }; })
    .catch((err) => {
      setupStatus = { stage: "error", message: err instanceof Error ? err.message : String(err), done: true, error: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => { setupInFlight = false; });
}

async function runSetup(): Promise<void> {
  if (process.platform !== "win32") {
    throw new ImageGenInstallError("Image generation setup is only wired up for Windows right now.");
  }

  setupStatus = { stage: "detecting", message: "Looking for Python…", done: false };
  await detectPythonCommand();

  fs.mkdirSync(IMAGEGEN_DIR, { recursive: true });

  setupStatus = { stage: "downloading", message: "Downloading stable-diffusion-webui…", done: false };
  await downloadAndExtractRepo();

  // --api is what lets AURORA's imagegen.ts talk to it; --skip-torch-cuda-test
  // avoids a slow/flaky startup probe that isn't needed for install itself.
  // xformers is left out deliberately — it needs a matched prebuilt wheel per
  // torch/CUDA version and isn't worth the fragility for a first pass.
  fs.writeFileSync(
    WEBUI_USER_BAT,
    "@echo off\r\n\r\nset PYTHON=\r\nset GIT=\r\nset VENV_DIR=\r\nset COMMANDLINE_ARGS=--api --skip-torch-cuda-test\r\n\r\ncall webui.bat\r\n",
    "utf-8",
  );

  setupStatus = { stage: "dependencies", message: "Installing dependencies (this is the slow part — creates a private Python environment and installs PyTorch)…", done: false };
  await runFirstLaunchToInstallDeps();
}

async function downloadAndExtractRepo(): Promise<void> {
  const res = await fetch(REPO_ZIP_URL, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) throw new ImageGenInstallError(`Couldn't download stable-diffusion-webui (${res.status} ${res.statusText}).`);

  const zipPath = path.join(os.tmpdir(), `sd-webui-${randomUUID()}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const extractDir = path.join(IMAGEGEN_DIR, "extract-tmp");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`,
      ], { windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new ImageGenInstallError("Extracting the archive timed out.")); }, 120_000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new ImageGenInstallError(`Extraction exited with code ${code}`));
      });
    });
  } finally {
    fs.unlinkSync(zipPath);
  }

  const nested = fs.readdirSync(extractDir).find((f) => fs.statSync(path.join(extractDir, f)).isDirectory());
  if (!nested) throw new ImageGenInstallError("stable-diffusion-webui archive extracted but its contents weren't where expected.");

  fs.rmSync(REPO_DIR, { recursive: true, force: true });
  fs.renameSync(path.join(extractDir, nested), REPO_DIR);
  fs.rmSync(extractDir, { recursive: true, force: true });
}

/**
 * webui-user.bat's first run does the full one-time setup (venv, pip
 * installs, PyTorch download) AND then launches the server — there's no
 * separate "just install, don't launch" mode. So this runs it, waits for the
 * server to actually come up (proving setup succeeded), then kills it — the
 * venv and installed packages stay on disk, so every launch after this is fast.
 */
function runFirstLaunchToInstallDeps(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(WEBUI_USER_BAT, [], { cwd: REPO_DIR, windowsHide: true, shell: true });
    let output = "";
    let settled = false;

    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(inactivityTimer); clearTimeout(absoluteTimer); fn(); } };

    const absoluteTimer = setTimeout(
      () => { child.kill(); finish(() => reject(new ImageGenInstallError("Setup ran for over 45 minutes without the server coming up — something likely went wrong. Check your internet connection and try again."))); },
      45 * 60_000,
    );
    let inactivityTimer: NodeJS.Timeout;
    function resetInactivityTimer() {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => { child.kill(); finish(() => reject(new ImageGenInstallError("Setup produced no output for 10 minutes and looked stuck — killed it."))); },
        10 * 60_000,
      );
    }
    resetInactivityTimer();

    function onData(d: Buffer) {
      output += d.toString();
      resetInactivityTimer();
      // A1111 prints this once its HTTP server is actually listening.
      if (/Running on local URL/i.test(output)) {
        child.kill();
        finish(() => resolve());
      }
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      if (settled) return;
      finish(() => reject(new ImageGenInstallError(`Setup exited before the server came up (code ${code}): ${output.slice(-2000)}`)));
    });
  });
}

/** Starts the webui as a persistent background server. No-op if already running. */
export function startServer(): { alreadyRunning: boolean } {
  if (isServerRunning()) return { alreadyRunning: true };
  if (!isImageGenInstalled()) throw new ImageGenInstallError("Image generation isn't set up yet — run setup first.");

  serverProcess = spawn(WEBUI_USER_BAT, [], { cwd: REPO_DIR, windowsHide: true, shell: true, detached: false });
  serverProcess.on("exit", () => { serverProcess = null; });
  return { alreadyRunning: false };
}

export function stopServer(): { stopped: boolean } {
  if (!serverProcess) return { stopped: false };
  serverProcess.kill();
  serverProcess = null;
  return { stopped: true };
}

export function defaultHost(): string {
  return `http://localhost:${DEFAULT_PORT}`;
}
