import { createServer } from "node:http";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { createApp, log } from "./app";
import { DatabaseStorage, sqlite } from "./storage-sqlite";
import { startBackups } from "./backup";
import { startDataDriveWatch } from "./datadrive";
import { startScheduler } from "./scheduler";
import { startComfyUi } from "./comfyui";
import { startTelegramBot } from "./telegram";
import { repairSkillPaths } from "./skills/runner";
import { seedOrganization } from "./companies";
import { ensureTalents } from "./talent";
import { ensureCompanyPipelines } from "./org-pipelines";
import { SKILLS_DIR } from "./paths";

// Best-effort "open this URL in the default browser" — never throws.
function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  execFile(cmd, args, () => { /* best-effort — the console log below still shows the URL */ });
}

// Probe with a real TCP connection rather than trusting listen()'s own
// EADDRINUSE — on some Windows setups two processes can bind the "same"
// port without the OS ever raising an error, silently splitting traffic.
function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ port, host: "127.0.0.1" });
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
}

async function findFreePort(port: number, attemptsLeft: number): Promise<number> {
  if (attemptsLeft <= 0) return port;
  if (await isPortTaken(port)) {
    log(`port ${port} is already in use — trying ${port + 1}...`);
    return findFreePort(port + 1, attemptsLeft - 1);
  }
  return port;
}

export interface StartServerOptions {
  /** Pop a system browser tab once listening. The CLI wants this by default; Electron passes false since it opens its own window instead. */
  openBrowser?: boolean;
}

/** Boots the Express app + scheduler and starts listening on 127.0.0.1. Shared by the CLI entrypoint (index.ts) and the Electron main process. */
export async function startServer(opts: StartServerOptions = {}): Promise<{ port: number }> {
  const shouldOpenBrowser = opts.openBrowser ?? true;

  const storage = new DatabaseStorage();
  const repairedSkills = await repairSkillPaths(storage).catch(() => 0);
  if (repairedSkills) log(`skills: repointed ${repairedSkills} skill folder(s) to ${SKILLS_DIR}`);
  const app = await createApp(storage);
  const httpServer = createServer(app);
  // First run of the companies layer: assign agents, hire the new roles, found
  // the simulated companies. No-op once companies exist.
  await seedOrganization().catch((err) => log(`organization seed failed: ${err instanceof Error ? err.message : String(err)}`));
  try { ensureTalents(); } catch (err) { log(`talent roster failed: ${err instanceof Error ? err.message : String(err)}`); }
  await ensureCompanyPipelines().catch((err) => log(`company pipelines failed: ${err instanceof Error ? err.message : String(err)}`));
  startScheduler();
  // Long-poll loop for the Telegram music remote. No-ops until a bot token
  // AND an owner id are set in Settings, and picks them up without a restart.
  startTelegramBot(storage);
  // Fire-and-forget: ComfyUI takes ~30s to become ready and nothing needs it
  // until the owner asks for an image, so don't make AURORA's own startup wait
  // on it. Failures are logged and swallowed inside startComfyUi().
  void startComfyUi();
  // The data drive is an external enclosure that intermittently drops off the
  // bus mid-session; these snapshots land on the internal drive so losing it
  // costs at most half an hour of work. See backup.ts.
  startBackups(sqlite);
  startDataDriveWatch();

  if (process.env.NODE_ENV !== "production") {
    // A literal "./vite" specifier here would let esbuild statically resolve
    // and inline server/vite.ts (and vite.config.ts, and the "vite" package
    // itself) into the production bundle — and since a single-outfile esbuild
    // build can't code-split a dynamic import, it hoists that inlined
    // module's imports into unconditional top-level `import` statements,
    // which Node then tries to resolve at startup even though this branch
    // never runs in production. "vite" is a devDependency, so it isn't in a
    // packaged app's node_modules and that resolution throws. Building the
    // specifier at runtime keeps esbuild from statically determining the
    // import target, so it leaves this as a genuine dynamic import instead
    // of bundling it.
    const viteModuleSpecifier = "./vite";
    const { setupVite } = await import(viteModuleSpecifier);
    await setupVite(httpServer, app);
  }

  const requestedPort = parseInt(process.env.PORT || "4700", 10);
  const port = await findFreePort(requestedPort, 20);

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      log(`failed to start on port ${port}: ${err.message}`);
      reject(err);
    });
    // Local-only by design — AURORA has no auth on the raw TCP layer beyond
    // the PIN gate in the app itself, and its tools (shell exec, GitHub code
    // install) are too dangerous to ever be reachable from other devices on
    // the same network. Binding 0.0.0.0 here would do exactly that.
    httpServer.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const url = `http://localhost:${port}`;
      log(`AURORA serving on ${url}`);
      if (port !== requestedPort) log(`(requested port ${requestedPort} was already taken)`);
      if (process.env.NODE_ENV === "production" && shouldOpenBrowser) openBrowser(url);
      resolve({ port });
    });
  });
}
