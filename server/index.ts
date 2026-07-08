import "dotenv/config";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { createApp, log } from "./app";
import { DatabaseStorage } from "./storage-sqlite";
import { startScheduler } from "./scheduler";

// Best-effort "open this URL in the default browser" — never throws.
function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  execFile(cmd, args, () => { /* best-effort — the console log below still shows the URL */ });
}

(async () => {
  const app = await createApp(new DatabaseStorage());
  const httpServer = createServer(app);
  startScheduler();

  if (process.env.NODE_ENV !== "production") {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
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

  const requestedPort = parseInt(process.env.PORT || "4700", 10);

  async function findFreePort(port: number, attemptsLeft: number): Promise<number> {
    if (attemptsLeft <= 0) return port;
    if (await isPortTaken(port)) {
      log(`port ${port} is already in use — trying ${port + 1}...`);
      return findFreePort(port + 1, attemptsLeft - 1);
    }
    return port;
  }

  const port = await findFreePort(requestedPort, 20);

  httpServer.once("error", (err: NodeJS.ErrnoException) => {
    log(`failed to start on port ${port}: ${err.message}`);
    process.exit(1);
  });
  httpServer.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
    const url = `http://localhost:${port}`;
    log(`AURORA serving on ${url}`);
    if (port !== requestedPort) log(`(requested port ${requestedPort} was already taken)`);
    if (process.env.NODE_ENV === "production") openBrowser(url);
  });
})();
