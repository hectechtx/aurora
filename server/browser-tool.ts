// Interactive web access for agents — beyond web_fetch's static-HTML read,
// this drives a real (hidden) Chromium page via Electron's own bundled
// browser engine, so it can click buttons and fill fields on pages that
// need JS to render or respond to input. Only available when running inside
// Electron (the packaged app); a plain `npm run dev` has no browser engine
// to drive.
import { getElectronApis } from "./electron-bridge";
import { assertPublicHost } from "./web-tools";

export interface BrowseAction {
  type: "click" | "fill" | "wait";
  /** click: visible text (or aria-label/placeholder) of the element to click. fill: label/placeholder/name identifying which field. */
  text?: string;
  /** fill: the value to type into the matched field. */
  value?: string;
  /** wait: milliseconds to pause (capped) — for pages that need a moment after an action before the next one makes sense. */
  ms?: number;
}

export interface BrowseResult {
  url: string;
  title: string;
  text: string;
}

const NAV_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 45_000;
const MAX_WAIT_MS = 5_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_ACTIONS = 8;

// Shared, persistent session between the Browser page's <webview> and the
// hidden windows agents drive — Polar-style: sign in to a site once in the
// Browser page and agents act inside that same signed-in session (cookies,
// localStorage), instead of every agent call landing on a logged-out page.
// Must match BROWSER_PARTITION in client/src/pages/Browser.tsx. Clicks/fills
// in that session stay approval-gated (browse_interact is risk "medium").
export const BROWSER_PARTITION = "persist:aurora-web";

export class BrowserToolError extends Error {}

export async function isInteractiveBrowsingAvailable(): Promise<boolean> {
  return (await getElectronApis()) !== null;
}

// Runs inside the hidden page itself via executeJavaScript — finds the best
// match among clickable elements by visible text and clicks it. Written as
// a function body string (not a closure) since it crosses into the page's
// own JS context, not this Node process.
const CLICK_SCRIPT = (text: string) => `
(function() {
  const needle = ${JSON.stringify(text)}.toLowerCase();
  const candidates = Array.from(document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button]'));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().toLowerCase();
  let best = null;
  for (const el of candidates) {
    if (!visible(el)) continue;
    const l = label(el);
    if (!l) continue;
    if (l === needle) { best = el; break; }
    if (!best && l.includes(needle)) best = el;
  }
  if (!best) return { ok: false, message: 'no visible clickable element matched "' + ${JSON.stringify(text)} + '"' };
  best.scrollIntoView({ block: 'center' });
  best.click();
  return { ok: true, matched: label(best) };
})()`;

const FILL_SCRIPT = (text: string, value: string) => `
(function() {
  const needle = ${JSON.stringify(text)}.toLowerCase();
  const fields = Array.from(document.querySelectorAll('input, textarea'));
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.innerText || '';
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.innerText || '';
    return '';
  };
  const signature = (el) => [labelFor(el), el.placeholder, el.name, el.getAttribute('aria-label')].filter(Boolean).join(' ').toLowerCase();
  let best = null;
  for (const el of fields) {
    if (!visible(el) || el.disabled) continue;
    const s = signature(el);
    if (s.includes(needle)) { best = el; break; }
  }
  if (!best) return { ok: false, message: 'no visible field matched "' + ${JSON.stringify(text)} + '"' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(best, ${JSON.stringify(value)});
  best.dispatchEvent(new Event('input', { bubbles: true }));
  best.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`;

const EXTRACT_SCRIPT = `({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT_CHARS}) })`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Navigates a hidden Electron page to `url`, runs at most MAX_ACTIONS click/fill/wait steps against it in order, then returns the resulting page's text. Each action is best-effort — a failed match is reported in the returned text rather than throwing, so the model can see what actually happened and adjust. */
export async function browseInteract(url: string, actions: BrowseAction[]): Promise<BrowseResult> {
  const electron = await getElectronApis();
  if (!electron) throw new BrowserToolError("Interactive browsing is only available in the installed desktop app.");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserToolError("invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserToolError("only http/https URLs are supported");
  }
  await assertPublicHost(parsed.hostname);

  const win = new electron.BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: BROWSER_PARTITION },
  });

  const notes: string[] = [];
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        win.webContents.once("did-finish-load", () => resolve());
        win.webContents.once("did-fail-load", (_e, code, desc) => reject(new BrowserToolError(`page failed to load: ${desc} (${code})`)));
        win.loadURL(parsed.toString()).catch(reject);
      }),
      sleep(NAV_TIMEOUT_MS).then(() => { throw new BrowserToolError("page load timed out"); }),
    ]);

    const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;
    for (const action of actions.slice(0, MAX_ACTIONS)) {
      if (Date.now() > overallDeadline) { notes.push("stopped early — overall time budget exceeded"); break; }
      if (action.type === "wait") {
        await sleep(Math.min(action.ms ?? 1000, MAX_WAIT_MS));
        continue;
      }
      if (action.type === "click" && action.text) {
        const result = await win.webContents.executeJavaScript(CLICK_SCRIPT(action.text)) as { ok: boolean; message?: string; matched?: string };
        notes.push(result.ok ? `clicked "${result.matched}"` : result.message ?? "click failed");
        await sleep(600); // let navigation/DOM updates settle before the next action or extraction
        continue;
      }
      if (action.type === "fill" && action.text) {
        const result = await win.webContents.executeJavaScript(FILL_SCRIPT(action.text, action.value ?? "")) as { ok: boolean; message?: string };
        notes.push(result.ok ? `filled "${action.text}"` : result.message ?? "fill failed");
        continue;
      }
    }

    const page = await win.webContents.executeJavaScript(EXTRACT_SCRIPT) as { url: string; title: string; text: string };
    const actionLog = notes.length ? `[actions: ${notes.join("; ")}]\n\n` : "";
    return { url: page.url, title: page.title, text: actionLog + page.text };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
