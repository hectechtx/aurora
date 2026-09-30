import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/ui/PageHeader";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { apiRequest } from "@/lib/queryClient";
import { ArrowLeft, ArrowRight, RotateCw, Globe, Sparkles, Bookmark, X } from "lucide-react";

const DEFAULT_URL = "https://www.google.com";

// Must match BROWSER_PARTITION in server/browser-tool.ts: this webview and the
// hidden pages agents drive share one persistent signed-in session, so a site
// you log into here is one AURORA's agents can work inside (Polar-style).
const BROWSER_PARTITION = "persist:aurora-web";

const SAVED_PROMPTS_KEY = "aurora.browser.savedPrompts";
const DEFAULT_PROMPTS = [
  "Summarize this page",
  "Pull the key facts from this page into a table",
  "Find contact info on this site",
];

function loadSavedPrompts(): string[] {
  try {
    const raw = localStorage.getItem(SAVED_PROMPTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : DEFAULT_PROMPTS;
  } catch {
    return DEFAULT_PROMPTS;
  }
}

function storeSavedPrompts(prompts: string[]): void {
  try { localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(prompts)); } catch { /* best-effort */ }
}

/** The subset of Electron's WebviewTag API this page actually uses — kept local rather than depending on the `electron` package from client code, which only ever runs in a renderer. */
interface WebviewEl extends HTMLElement {
  src: string;
  loadURL: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  getTitle: () => string;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Looks like a bare domain (has a dot, no spaces) -> treat as a URL; otherwise treat as a search.
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export default function Browser() {
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  const webviewRef = useRef<WebviewEl | null>(null);
  const [addressBar, setAddressBar] = useState(DEFAULT_URL);
  const [loading, setLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el || !isElectron) return;

    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      setCanGoBack(el.canGoBack());
      setCanGoForward(el.canGoForward());
    };
    const onNavigate = (e: Event) => {
      const url = (e as unknown as { url?: string }).url;
      if (url) setAddressBar(url);
    };

    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-navigate", onNavigate);
    el.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-navigate", onNavigate);
      el.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [isElectron]);

  function go(raw: string) {
    const url = normalizeUrl(raw);
    setAddressBar(url);
    webviewRef.current?.loadURL(url);
  }

  const [, navigate] = useLocation();
  const [instruction, setInstruction] = useState("");
  const [savedPrompts, setSavedPrompts] = useState<string[]>(loadSavedPrompts);
  const [asking, setAsking] = useState(false);

  // Hands the current tab + an instruction to AURORA as a new task, then jumps
  // to it. The chat request is deliberately not awaited: an agent turn can run
  // for minutes, and the server keeps working after we navigate away.
  async function askAurora(text: string) {
    const ask = text.trim();
    if (!ask || asking) return;
    setAsking(true);
    try {
      const el = webviewRef.current;
      const url = el?.getURL() || addressBar;
      const title = el?.getTitle() || url;
      const task = await apiRequest("POST", "/api/tasks", { title: `Web: ${ask.slice(0, 60)}` }).then((r) => r.json()) as { id: number };
      const message =
        `[Browser] I'm on "${title}" — ${url}\n\n${ask}\n\n` +
        `Use browse_interact on that URL to read it or act on it — it runs in my signed-in browser session, ` +
        `so you can work inside sites I'm logged into. Use web_search/web_fetch for anything else you need.`;
      void apiRequest("POST", `/api/tasks/${task.id}/chat`, { message }).catch(() => {});
      setInstruction("");
      navigate(`/tasks?task=${task.id}`);
    } finally {
      setAsking(false);
    }
  }

  function savePrompt(text: string) {
    const p = text.trim();
    if (!p || savedPrompts.includes(p)) return;
    const next = [...savedPrompts, p];
    setSavedPrompts(next);
    storeSavedPrompts(next);
  }

  function removePrompt(p: string) {
    const next = savedPrompts.filter((x) => x !== p);
    setSavedPrompts(next);
    storeSavedPrompts(next);
  }

  if (!isElectron) {
    return (
      <div className="p-8 max-w-3xl mx-auto h-screen flex items-center justify-center">
        <EmptyState
          icon={Globe}
          title="Only available in the installed desktop app"
          description="The embedded browser uses Electron's page-rendering surface, which isn't available when AURORA is opened in a regular browser tab."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-border px-6 py-4 space-y-3">
        <PageHeader title="Browser" description="A real, isolated page inside AURORA — separate from anything an agent does with web_search/web_fetch." />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => webviewRef.current?.goBack()} disabled={!canGoBack} title="Back">
            <ArrowLeft size={15} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => webviewRef.current?.goForward()} disabled={!canGoForward} title="Forward">
            <ArrowRight size={15} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => webviewRef.current?.reload()} title="Reload">
            <RotateCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
          <Input
            value={addressBar}
            onChange={(e) => setAddressBar(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") go(addressBar); }}
            placeholder="Search or enter a URL"
            className="flex-1"
          />
          <Button variant="outline" onClick={() => go(addressBar)}>Go</Button>
        </div>
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-primary shrink-0" />
          <Input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void askAurora(instruction); }}
            placeholder="Ask AURORA to do something on this page…"
            className="flex-1"
          />
          <Button variant="ghost" size="icon" onClick={() => savePrompt(instruction)} disabled={!instruction.trim()} title="Save as a quick prompt">
            <Bookmark size={14} />
          </Button>
          <Button onClick={() => void askAurora(instruction)} disabled={!instruction.trim() || asking}>Ask AURORA</Button>
        </div>
        {savedPrompts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {savedPrompts.map((p) => (
              <span key={p} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs">
                <button type="button" className="hover:text-primary" onClick={() => void askAurora(p)} title="Run on this page">{p}</button>
                <button type="button" className="opacity-50 hover:opacity-100" onClick={() => removePrompt(p)} title="Remove"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <webview ref={webviewRef as never} src={DEFAULT_URL} partition={BROWSER_PARTITION} className="w-full h-full" allowpopups="true" />
      </div>
    </div>
  );
}
