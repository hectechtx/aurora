// Interactive web access for agents — beyond web_fetch's static-HTML read,
// this drives a real Chromium page via Electron's own bundled browser engine,
// so it can click buttons and fill fields on pages that need JS to render or
// respond to input. Only available when running inside Electron (the packaged
// app); a plain `npm run dev` has no browser engine to drive.
//
// Polar-style: each Task/Agent gets ONE persistent tab that survives across
// tool calls (so multi-step work — search, open a result, fill a form, keep
// going — actually carries state), runs in the owner's signed-in session, and
// can be revealed as a normal window from the Browser page so the owner can
// watch it work or take over. Idle tabs close themselves.
import type { BrowserWindow } from "electron";
import { getElectronApis } from "./electron-bridge";
import { assertPublicHost } from "./web-tools";

export interface BrowseAction {
  type: "goto" | "click" | "fill" | "press_enter" | "scroll" | "wait";
  /** click: visible text (or aria-label/placeholder) of the element to click. fill: label/placeholder/name identifying which field. */
  text?: string;
  /** fill: the value to type into the matched field. */
  value?: string;
  /** goto: the URL to open in this tab. */
  url?: string;
  /** wait: milliseconds to pause (capped) — for pages that need a moment after an action before the next one makes sense. */
  ms?: number;
}

/** Actions that only move around/read — safe to auto-run (browse_page). click/fill/press_enter can change things inside the owner's signed-in accounts, so they stay approval-gated (browse_interact). */
export const READ_ONLY_ACTIONS: ReadonlySet<BrowseAction["type"]> = new Set(["goto", "scroll", "wait"]);

export interface BrowseResult {
  url: string;
  title: string;
  text: string;
}

const NAV_TIMEOUT_MS = 20_000;
const OVERALL_TIMEOUT_MS = 60_000;
const MAX_WAIT_MS = 5_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_ACTIONS = 8;
const IDLE_CLOSE_MS = 15 * 60_000;

// Shared, persistent session between the Browser page's <webview> and the
// windows agents drive: sign in to a site once in the Browser page and agents
// act inside that same signed-in session (cookies, localStorage), instead of
// every agent call landing on a logged-out page. Must match
// BROWSER_PARTITION in client/src/pages/Browser.tsx.
export const BROWSER_PARTITION = "persist:aurora-web";

export class BrowserToolError extends Error {}

export async function isInteractiveBrowsingAvailable(): Promise<boolean> {
  return (await getElectronApis()) !== null;
}

// ---- persistent per-context tabs ----

interface Session { win: BrowserWindow; label: string; lastUsed: number }
const sessions = new Map<string, Session>();

setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    // A tab the owner is currently looking at is theirs — don't yank it away.
    if (now - s.lastUsed > IDLE_CLOSE_MS && !s.win.isVisible()) closeBrowserSession(key);
  }
}, 60_000).unref();

async function getSession(key: string, label: string): Promise<Session> {
  const electron = await getElectronApis();
  if (!electron) throw new BrowserToolError("Interactive browsing is only available in the installed desktop app.");
  const existing = sessions.get(key);
  if (existing && !existing.win.isDestroyed()) {
    existing.lastUsed = Date.now();
    return existing;
  }
  const win = new electron.BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    title: `AURORA agent — ${label}`,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: BROWSER_PARTITION },
  });
  // Keep our title rather than the page's, so the owner can tell agent windows apart.
  win.on("page-title-updated", (e) => e.preventDefault());
  // Closing a revealed window just hides it — the agent may still be mid-task.
  win.on("close", (e) => {
    if (sessions.has(key)) { e.preventDefault(); win.hide(); }
  });
  const session: Session = { win, label, lastUsed: Date.now() };
  sessions.set(key, session);
  return session;
}

export interface BrowserSessionInfo { key: string; label: string; url: string; title: string; visible: boolean; idleSeconds: number }

export function listBrowserSessions(): BrowserSessionInfo[] {
  const now = Date.now();
  return [...sessions.entries()]
    .filter(([, s]) => !s.win.isDestroyed())
    .map(([key, s]) => ({
      key,
      label: s.label,
      url: s.win.webContents.getURL(),
      title: s.win.webContents.getTitle(),
      visible: s.win.isVisible(),
      idleSeconds: Math.round((now - s.lastUsed) / 1000),
    }));
}

/** Reveals an agent's tab as a normal window so the owner can watch it, or take over and click around themselves. */
export function showBrowserSession(key: string): boolean {
  const s = sessions.get(key);
  if (!s || s.win.isDestroyed()) return false;
  s.win.show();
  s.win.focus();
  return true;
}

export function closeBrowserSession(key: string): boolean {
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  if (!s.win.isDestroyed()) s.win.destroy();
  return true;
}

// ---- in-page scripts ----
// Written as function-body strings (not closures) since they cross into the
// page's own JS context, not this Node process.

const CLICK_SCRIPT = (text: string) => `
(function() {
  const needle = ${JSON.stringify(text)}.toLowerCase();
  const candidates = Array.from(document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]'));
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
  return { ok: true, matched: label(best).slice(0, 80) };
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
    if (signature(el).includes(needle)) { best = el; break; }
  }
  if (!best) return { ok: false, message: 'no visible field matched "' + ${JSON.stringify(text)} + '"' };
  const proto = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(best, ${JSON.stringify(value)});
  best.dispatchEvent(new Event('input', { bubbles: true }));
  best.dispatchEvent(new Event('change', { bubbles: true }));
  best.focus();
  return { ok: true };
})()`;

// Page text plus a compact map of what's actionable on it — links with their
// URLs (so a read-only caller can follow one via goto), buttons, and fields —
// so the model picks real targets instead of guessing labels.
const EXTRACT_SCRIPT = `(function() {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
  const links = []; const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (links.length >= 40) break;
    if (!visible(a) || !a.href.startsWith('http') || seen.has(a.href)) continue;
    const t = clean(a.innerText || a.getAttribute('aria-label'));
    if (!t) continue;
    seen.add(a.href); links.push('- ' + t + ' -> ' + a.href);
  }
  const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).filter(visible)
    .map((b) => clean(b.innerText || b.value || b.getAttribute('aria-label'))).filter(Boolean).slice(0, 25);
  const fields = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select')).filter(visible)
    .map((f) => clean([f.getAttribute('aria-label'), f.placeholder, f.name, f.type].filter(Boolean).join(' / '))).filter(Boolean).slice(0, 20);
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT_CHARS}),
    links: links.join('\\n'),
    buttons: buttons.join(' | '),
    fields: fields.join(' | '),
  };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkedUrl(raw: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserToolError(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserToolError("only http/https URLs are supported");
  }
  await assertPublicHost(parsed.hostname);
  return parsed.toString();
}

async function load(win: BrowserWindow, url: string): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      win.webContents.once("did-finish-load", () => resolve());
      win.webContents.once("did-fail-load", (_e, code, desc) => reject(new BrowserToolError(`page failed to load: ${desc} (${code})`)));
      win.loadURL(url).catch(reject);
    }),
    sleep(NAV_TIMEOUT_MS).then(() => { throw new BrowserToolError("page load timed out"); }),
  ]);
}

/** After a click/Enter that may have kicked off a navigation, give the page a moment and then wait (bounded) for it to finish loading. */
async function settle(win: BrowserWindow): Promise<void> {
  await sleep(600);
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (win.webContents.isLoading() && Date.now() < deadline) await sleep(250);
}

/**
 * Runs up to MAX_ACTIONS steps in this context's persistent tab (opening
 * `url` first if given), then returns the resulting page's text and a map of
 * its links/buttons/fields. Without `url`, continues on whatever page the tab
 * is already on. Each action is best-effort — a failed match is reported in
 * the returned text rather than throwing, so the model can see what actually
 * happened and adjust.
 */
export async function browseInteract(sessionKey: string, label: string, url: string | undefined, actions: BrowseAction[]): Promise<BrowseResult> {
  const { win } = await getSession(sessionKey, label);

  if (url) await load(win, await checkedUrl(url));
  else if (!win.webContents.getURL()) throw new BrowserToolError("no page is open in this tab yet — pass a url first");

  const notes: string[] = [];
  const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;
  for (const action of actions.slice(0, MAX_ACTIONS)) {
    if (Date.now() > overallDeadline) { notes.push("stopped early — overall time budget exceeded"); break; }
    try {
      switch (action.type) {
        case "goto":
          if (!action.url) { notes.push("goto skipped — no url"); break; }
          await load(win, await checkedUrl(action.url));
          notes.push(`opened ${action.url}`);
          break;
        case "wait":
          await sleep(Math.min(action.ms ?? 1000, MAX_WAIT_MS));
          break;
        case "scroll":
          await win.webContents.executeJavaScript("window.scrollBy(0, Math.round(window.innerHeight * 0.9))");
          await sleep(400);
          notes.push("scrolled down");
          break;
        case "click": {
          if (!action.text) { notes.push("click skipped — no text"); break; }
          const r = await win.webContents.executeJavaScript(CLICK_SCRIPT(action.text)) as { ok: boolean; message?: string; matched?: string };
          notes.push(r.ok ? `clicked "${r.matched}"` : r.message ?? "click failed");
          await settle(win);
          break;
        }
        case "fill": {
          if (!action.text) { notes.push("fill skipped — no field text"); break; }
          const r = await win.webContents.executeJavaScript(FILL_SCRIPT(action.text, action.value ?? "")) as { ok: boolean; message?: string };
          notes.push(r.ok ? `filled "${action.text}"` : r.message ?? "fill failed");
          break;
        }
        case "press_enter":
          // Real key events on the focused element (fill focuses its field), so
          // search boxes and forms submit the way they would for a person.
          win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          notes.push("pressed Enter");
          await settle(win);
          break;
      }
    } catch (err) {
      notes.push(`${action.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const page = await win.webContents.executeJavaScript(EXTRACT_SCRIPT) as { url: string; title: string; text: string; links: string; buttons: string; fields: string };
  sessions.get(sessionKey)!.lastUsed = Date.now();
  const parts = [
    notes.length ? `[actions: ${notes.join("; ")}]` : "",
    page.text,
    page.links ? `\n[links]\n${page.links}` : "",
    page.buttons ? `\n[buttons] ${page.buttons}` : "",
    page.fields ? `\n[fields] ${page.fields}` : "",
  ].filter(Boolean);
  return { url: page.url, title: page.title, text: parts.join("\n\n") };
}
