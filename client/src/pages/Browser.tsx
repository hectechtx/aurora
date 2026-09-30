import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ArrowLeft, ArrowRight, RotateCw, Globe } from "lucide-react";

const DEFAULT_URL = "https://www.google.com";

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
      </div>
      <div className="flex-1 min-h-0">
        <webview ref={webviewRef as never} src={DEFAULT_URL} className="w-full h-full" allowpopups="true" />
      </div>
    </div>
  );
}
