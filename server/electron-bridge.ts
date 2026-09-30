// Thin, optional bridge to Electron's main-process-only APIs (dialog, app).
// server/ code runs inside the Electron main process when launched via
// electron/main.ts (see its dynamic `import("../server/start")`), so these
// resolve to the real thing there. Under plain `npm run dev` (tsx, no
// Electron), `require("electron")` resolves to a string (the path to the
// electron binary) instead of the API object — every caller here treats
// "unavailable" as a normal, expected outcome rather than an error.
import type { App, Dialog, BrowserWindow, Shell } from "electron";

interface ElectronApis { app: App; dialog: Dialog; BrowserWindow: typeof BrowserWindow; shell: Shell }

let cached: ElectronApis | null | undefined;

export async function getElectronApis(): Promise<ElectronApis | null> {
  if (cached !== undefined) return cached;
  try {
    const electron = await import("electron");
    if (!electron.dialog || !electron.app || !electron.BrowserWindow || !electron.shell) {
      cached = null;
    } else {
      cached = { app: electron.app, dialog: electron.dialog, BrowserWindow: electron.BrowserWindow, shell: electron.shell };
    }
  } catch {
    cached = null;
  }
  return cached;
}
