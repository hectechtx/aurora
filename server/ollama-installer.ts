// Downloads the real Ollama installer from ollama.com and launches it —
// deliberately not silent. AURORA's job stops at "fetch the official
// installer and open it"; the actual install happens through Ollama's own
// installer UI, same as if you'd downloaded and double-clicked it yourself.
// This is intentionally NOT exposed as an agent tool anywhere — it's wired
// to a single button on the first-run onboarding screen the human clicks,
// never something the model can trigger on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const OFFICIAL_INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

export class OllamaInstallError extends Error {}

export async function downloadAndLaunchOllamaInstaller(): Promise<void> {
  if (process.platform !== "win32") {
    throw new OllamaInstallError("Auto-install is only wired up for Windows right now — grab Ollama from https://ollama.com for your platform.");
  }

  const res = await fetch(OFFICIAL_INSTALLER_URL, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) {
    throw new OllamaInstallError(`Couldn't download the installer from ollama.com (${res.status} ${res.statusText}).`);
  }

  const dest = path.join(os.tmpdir(), `OllamaSetup-${randomUUID()}.exe`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);

  // Detached, not silent — the real Ollama installer window opens and the
  // owner clicks through it themselves, exactly like a manual download.
  const child = spawn(dest, [], { detached: true, stdio: "ignore" });
  child.unref();
}
