// Starts ComfyUI (the image-generation backend) alongside AURORA.
//
// Without this, image generation silently fails after every reboot until
// somebody remembers to launch ComfyUI by hand — which is exactly the kind of
// invisible half-broken state that made image gen look "randomly" unreliable
// for so long. ComfyUI is a plain Python process, so AURORA can own its
// lifecycle the same way it already owns the video-gen subprocess.
//
// Deliberately best-effort and non-blocking: a missing or broken ComfyUI must
// never stop AURORA itself from starting. If it can't come up, image
// generation reports unavailable (see imagegen.ts health()) and everything
// else works normally.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { COMFYUI_DIR } from "./paths";
import { log } from "./app";

const REPO_DIR = path.join(COMFYUI_DIR, "repo");
const VENV_PYTHON = path.join(REPO_DIR, "venv", "Scripts", "python.exe");
const MAIN_SCRIPT = path.join(REPO_DIR, "main.py");
// Overwritten each launch — this is for diagnosing "why didn't it come up
// this time", not a historical record.
export const LOG_PATH = path.join(COMFYUI_DIR, "comfyui.log");

export const COMFYUI_PORT = 8188;

let child: ChildProcess | null = null;

export function isComfyUiInstalled(): boolean {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(MAIN_SCRIPT);
}

/** True if something is already listening — an externally-launched ComfyUI, or a leftover from a previous run. */
function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ port, host: "127.0.0.1" });
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Launches ComfyUI if it's installed and not already running. Returns
 * immediately — the server takes ~30s to become ready, and nothing in AURORA
 * needs it until the owner actually asks for an image, by which point it's up.
 */
export async function startComfyUi(): Promise<void> {
  if (!isComfyUiInstalled()) {
    log("comfyui: not installed — image generation will report unavailable");
    return;
  }
  if (await isPortTaken(COMFYUI_PORT)) {
    log(`comfyui: already running on ${COMFYUI_PORT}`);
    return;
  }

  try {
    // ComfyUI's startup output goes to a log file rather than being discarded.
    // The first version of this used stdio:"ignore", which meant a ComfyUI
    // that failed to boot produced total silence — precisely the invisible
    // half-broken state this module exists to prevent. It's also too chatty to
    // interleave into AURORA's own log, hence a file rather than inheriting.
    let stdio: "ignore" | ["ignore", number, number] = "ignore";
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      const fd = fs.openSync(LOG_PATH, "w");
      stdio = ["ignore", fd, fd];
    } catch {
      // The log lives on the same flaky external drive as everything else; if
      // it can't be opened, still start ComfyUI rather than refusing to run.
    }

    child = spawn(VENV_PYTHON, ["main.py", "--port", String(COMFYUI_PORT), "--listen", "127.0.0.1"], {
      cwd: REPO_DIR,
      windowsHide: true,
      stdio,
      // Force UTF-8 so model names with non-ASCII characters don't crash its logger.
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    child.on("error", (err) => {
      log(`comfyui: failed to start — ${err.message}`);
      child = null;
    });
    child.on("exit", (code) => {
      // Point at the log rather than just the code — the reason is always in
      // there, and a bare exit number sends you hunting.
      if (code !== 0 && code !== null) log(`comfyui: exited with code ${code} — see ${LOG_PATH}`);
      child = null;
    });

    log(`comfyui: starting on ${COMFYUI_PORT}`);
  } catch (err) {
    log(`comfyui: failed to start — ${err instanceof Error ? err.message : String(err)}`);
    child = null;
  }
}

/** Stops the ComfyUI process we started. No-op if it was already running externally or never launched. */
export function stopComfyUi(): void {
  child?.kill();
  child = null;
}
