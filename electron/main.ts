import { app, BrowserWindow, Tray, Menu, shell, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("AURORA");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let isQuitting = false;

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // AURORA's server code resolves data/static paths from these env vars
    // (see server/paths.ts) — a packaged app's cwd isn't a reliable, or
    // writable, place, so point it at Electron's per-user data folder and
    // the app's own bundled resources instead.
    process.env.NODE_ENV = "production";
    process.env.AURORA_DATA_DIR = path.join(app.getPath("userData"), "data");
    process.env.AURORA_STATIC_DIR = path.resolve(__dirname, "../public");

    // Deliberately a dynamic import, evaluated only now that the env vars
    // above are set — server/paths.ts reads them at module-load time, and a
    // static top-level import here would resolve (and be hoisted) before
    // this callback ever runs, silently falling back to cwd-relative paths.
    let port: number;
    try {
      const { startServer } = await import("../server/start");
      ({ port } = await startServer({ openBrowser: false }));
    } catch (err) {
      console.error("AURORA failed to start:", err);
      app.quit();
      return;
    }

    const iconPath = path.join(__dirname, "assets", "tray.png");
    const appIcon = nativeImage.createFromPath(iconPath);

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      title: "AURORA",
      icon: appIcon,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL(`http://127.0.0.1:${port}`);

    // Keep external links (e.g. the "ollama.com" link on the first-run
    // onboarding screen) out of the app window — open them in the user's
    // real browser instead of a bare, chrome-less popup.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) shell.openExternal(url);
      return { action: "deny" };
    });

    // AURORA keeps agents ticking and the approval queue alive in the
    // background — closing the window is "hide", not "quit". Only the
    // tray's Quit item actually stops the vessel.
    mainWindow.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });

    tray = new Tray(appIcon.resize({ width: 16, height: 16 }));
    tray.setToolTip("AURORA");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show AURORA", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: "separator" },
      { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
  });

  // Stay alive in the tray — matches AURORA's "persistent local vessel"
  // model. Only the tray menu's Quit (which sets isQuitting) truly exits.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => { isQuitting = true; });
}
