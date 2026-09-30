import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { usePullModel } from "@/lib/usePullModel";
import { PullProgress } from "@/components/ui/PullProgress";
import { RefreshCw, ExternalLink, Terminal as TerminalIcon, Download, Check, Eye, Wrench } from "lucide-react";

interface OllamaStatus { live: boolean; host: string; activeModel: string; models: { name: string; size: number }[]; }

// Curated for the owner's ~8GB-VRAM class of hardware, and — critically for an
// agent app — every "tools" pick actually supports Ollama tool-calling. The
// headline 2026 leaderboard models (Kimi K2, GLM-5, DeepSeek V4, GPT-OSS 120B)
// are datacenter-scale and won't load on 8GB, so they're deliberately not here.
const CURATED_MODELS = [
  { name: "llama3.1", size: "4.7 GB", kind: "tools" as const, blurb: "Best all-round default — reliable reasoning and tool-calling." },
  { name: "qwen2.5", size: "4.7 GB", kind: "tools" as const, blurb: "Excellent reasoning + tools; strong all-rounder." },
  { name: "qwen2.5-coder", size: "4.7 GB", kind: "tools" as const, blurb: "Best local coding model that still does tools — ideal for the Engineer." },
  { name: "llama3.2", size: "2.0 GB", kind: "tools" as const, blurb: "Small & fast (3B) with tool-calling — great for lighter hardware or quick agents." },
  { name: "mistral-nemo", size: "7.1 GB", kind: "tools" as const, blurb: "Larger (12B) with excellent tool use; uses most of the 8GB." },
  { name: "llava", size: "4.7 GB", kind: "vision" as const, blurb: "Sees images — pair with a tools model above." },
  { name: "minicpm-v", size: "5.5 GB", kind: "vision" as const, blurb: "Smaller, faster vision model." },
];

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

function Shell({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-3 mb-6 text-center">
          <Logo />
          <div>
            <div className="text-lg font-semibold tracking-tight">{title}</div>
            <div className="text-sm text-muted-foreground mt-1 leading-relaxed">{description}</div>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function InstallStep({ onSkip }: { onSkip: () => void }) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ollama/install").then((r) => r.json()),
    onSuccess: () => toast({ title: "Installer launched", description: "Follow the Ollama setup window that just opened, then come back here.", variant: "success" }),
    onError: (err: Error) => toast({ title: "Couldn't launch installer", description: err.message, variant: "error" }),
  });

  async function recheck() {
    setChecking(true);
    await qc.invalidateQueries({ queryKey: ["/api/ollama/status"] });
    setChecking(false);
  }

  return (
    <Shell
      title="AURORA needs Ollama"
      description="AURORA doesn't call any paid AI service — it thinks using a model that runs entirely on this computer, through a free program called Ollama. It looks like Ollama isn't installed or running yet."
    >
      <Button variant="primary" className="w-full" onClick={() => install.mutate()} disabled={install.isPending}>
        <Download size={14} /> {install.isPending ? "Downloading…" : "Download & install Ollama"}
      </Button>
      <p className="text-xs text-muted-foreground/70 leading-relaxed">
        Downloads the official installer from ollama.com and opens it — you'll click through Ollama's own setup window yourself, nothing installs silently.
      </p>

      <div className="border-t border-border pt-4 space-y-2.5">
        <div className="flex gap-2.5 text-sm">
          <span className="shrink-0 h-5 w-5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center justify-center">·</span>
          <div>
            Prefer to do it yourself? Grab it from{" "}
            <a href="https://ollama.com" target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-1 hover:underline">
              ollama.com <ExternalLink size={11} />
            </a>{" "}
            or run
            <pre className="mt-1.5 rounded-md bg-surface border border-border px-2.5 py-2 text-xs font-mono text-muted-foreground flex items-center gap-2">
              <TerminalIcon size={12} className="shrink-0" /> ollama serve
            </pre>
          </div>
        </div>
      </div>

      <Button variant="outline" className="w-full" onClick={recheck} disabled={checking}>
        <RefreshCw size={14} className={checking ? "animate-spin" : ""} /> {checking ? "Checking…" : "I've installed it — check again"}
      </Button>

      <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
        Running Ollama on another machine or a different port?{" "}
        <button onClick={() => { setLocation("/settings"); onSkip(); }} className="text-accent hover:underline">
          Skip to Settings
        </button>{" "}
        to point AURORA at it.
      </p>
    </Shell>
  );
}

function ModelPickStep({ onSkip }: { onSkip: () => void }) {
  const { pull, pulling, pullStatus, isBusy } = usePullModel();
  const [justPulled, setJustPulled] = useState<Set<string>>(new Set());

  function handlePull(name: string) {
    pull(name);
  }

  return (
    <Shell title="Pull a model" description="Ollama is running, but no models are downloaded yet. Pick at least one — a tools model runs your everyday chat, a vision model lets AURORA look at images.">
      <div className="space-y-2">
        {CURATED_MODELS.map((m) => {
          const isThisPulling = pulling === m.name;
          const done = isThisPulling && pullStatus?.done && pullStatus.status === "success";
          return (
            <div key={m.name} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {m.kind === "vision" ? <Eye size={12} className="text-accent" /> : <Wrench size={12} className="text-accent" />}
                    {m.name}
                    <span className="text-xs text-muted-foreground font-normal">({m.size})</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{m.blurb}</div>
                </div>
                <Button
                  variant={done ? "outline" : "primary"}
                  onClick={() => handlePull(m.name)}
                  disabled={isBusy || done}
                  className="shrink-0"
                >
                  {done ? <><Check size={13} /> Pulled</> : isThisPulling ? "Pulling…" : "Pull"}
                </Button>
              </div>
              {isThisPulling && pullStatus && !pullStatus.done && <PullProgress status={pullStatus} />}
            </div>
          );
        })}
      </div>
      <button onClick={onSkip} className="text-xs text-accent hover:underline w-full text-center pt-1">
        Skip — I'll pull a model later from Settings
      </button>
    </Shell>
  );
}

export function OllamaOnboarding({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const [skippedModelPick, setSkippedModelPick] = useState(false);
  const { data: status, isLoading } = useQuery<OllamaStatus>({ queryKey: ["/api/ollama/status"], refetchInterval: 10_000 });

  if (isLoading) return null;
  if (dismissed) return <>{children}</>;
  if (!status?.live) return <InstallStep onSkip={() => setDismissed(true)} />;
  if (!skippedModelPick && status.models.length === 0) return <ModelPickStep onSkip={() => setSkippedModelPick(true)} />;

  return <>{children}</>;
}
