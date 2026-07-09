import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/Button";
import { RefreshCw, ExternalLink, Terminal as TerminalIcon } from "lucide-react";

interface OllamaStatus { live: boolean; host: string; activeModel: string; models: { name: string; size: number }[]; }

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="onboard-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" stroke="url(#onboard-mark)" strokeWidth="1.6" opacity="0.4" />
      <circle cx="16" cy="16" r="8" fill="url(#onboard-mark)" />
    </svg>
  );
}

export function OllamaOnboarding({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const { data: status, isLoading } = useQuery<OllamaStatus>({ queryKey: ["/api/ollama/status"], refetchInterval: 10_000 });

  if (isLoading) return null;
  if (status?.live || dismissed) return <>{children}</>;

  async function recheck() {
    setChecking(true);
    await qc.invalidateQueries({ queryKey: ["/api/ollama/status"] });
    setChecking(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 mb-6 text-center">
          <Logo />
          <div>
            <div className="text-lg font-semibold tracking-tight">AURORA needs Ollama</div>
            <div className="text-sm text-muted-foreground mt-1 leading-relaxed">
              AURORA doesn't call any paid AI service — it thinks using a model that runs entirely on this
              computer, through a free program called Ollama. It looks like Ollama isn't running yet.
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          <div className="space-y-2.5">
            <div className="flex gap-2.5 text-sm">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">1</span>
              <div>
                <span className="text-foreground">Install Ollama</span> (free) from{" "}
                <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-1 hover:underline">
                  ollama.com <ExternalLink size={11} />
                </a>
              </div>
            </div>
            <div className="flex gap-2.5 text-sm">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">2</span>
              <div>
                <span className="text-foreground">Pull a model</span> that supports tool-calling — open a terminal and run:
                <pre className="mt-1.5 rounded-md bg-surface border border-border px-2.5 py-2 text-xs font-mono text-muted-foreground flex items-center gap-2">
                  <TerminalIcon size={12} className="shrink-0" /> ollama pull llama3.1
                </pre>
              </div>
            </div>
            <div className="flex gap-2.5 text-sm">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">3</span>
              <div className="text-foreground">Come back here — Ollama usually starts itself after install.</div>
            </div>
          </div>

          <Button variant="primary" className="w-full" onClick={recheck} disabled={checking}>
            <RefreshCw size={14} className={checking ? "animate-spin" : ""} /> {checking ? "Checking…" : "I've installed it — check again"}
          </Button>

          <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
            Running Ollama on another machine or a different port?{" "}
            <button onClick={() => { setLocation("/settings"); setDismissed(true); }} className="text-accent hover:underline">
              Skip to Settings
            </button>{" "}
            to point AURORA at it.
          </p>
        </div>
      </div>
    </div>
  );
}
