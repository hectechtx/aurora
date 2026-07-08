import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useVoice } from "@/lib/voice";
import { cn } from "@/lib/utils";
import { Volume2 } from "lucide-react";

interface OllamaStatus { live: boolean; host: string; activeModel: string; models: { name: string; size: number }[]; }
interface AgentConfig { id: number; ollamaHost: string; model: string; systemPrompt: string; autonomy: string; imageGenHost: string; }
interface ImageGenStatus { live: boolean; host: string; }

function LiveDot({ live }: { live: boolean }) {
  return (
    <span className={cn("text-xs flex items-center gap-1.5 font-medium", live ? "text-risk-low" : "text-risk-high")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-risk-low" : "bg-risk-high")} />
      {live ? "Live" : "Offline"}
    </span>
  );
}

export default function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voice = useVoice();
  const { data: config } = useQuery<AgentConfig>({ queryKey: ["/api/config"] });
  const { data: status } = useQuery<OllamaStatus>({ queryKey: ["/api/ollama/status"], refetchInterval: 8000 });
  const { data: imageGenStatus } = useQuery<ImageGenStatus>({ queryKey: ["/api/imagegen/status"], refetchInterval: 8000 });

  const [host, setHost] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [pullModelName, setPullModelName] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const [imageGenHost, setImageGenHost] = useState("");

  useEffect(() => {
    if (config) {
      setHost(config.ollamaHost);
      setSystemPrompt(config.systemPrompt);
      setImageGenHost(config.imageGenHost);
    }
  }, [config?.id]);

  const updateConfig = useMutation({
    mutationFn: (patch: Partial<AgentConfig>) => apiRequest("PATCH", "/api/config", patch).then((r) => r.json()),
    onSuccess: (_data, patch) => {
      qc.invalidateQueries({ queryKey: ["/api/config"] });
      qc.invalidateQueries({ queryKey: ["/api/ollama/status"] });
      qc.invalidateQueries({ queryKey: ["/api/imagegen/status"] });
      if (!("model" in patch) && !("autonomy" in patch)) toast({ title: "Saved", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't save", description: err.message, variant: "error" }),
  });

  const pull = useMutation({
    mutationFn: (model: string) => apiRequest("POST", "/api/ollama/pull", { model }).then((r) => r.json()),
    onSuccess: (_data, model) => setPulling(model),
    onError: (err: Error) => toast({ title: "Couldn't start pull", description: err.message, variant: "error" }),
  });

  const { data: pullStatus } = useQuery<{ status: string; completed?: number; total?: number; done: boolean; error?: string }>({
    queryKey: [`/api/ollama/pull-status?model=${encodeURIComponent(pulling ?? "")}`],
    enabled: !!pulling,
    refetchInterval: (q) => (q.state.data?.done ? false : 1500),
  });

  useEffect(() => {
    if (pullStatus?.done && pulling) {
      qc.invalidateQueries({ queryKey: ["/api/ollama/status"] });
      if (pullStatus.status === "success") toast({ title: `Pulled "${pulling}"`, description: "Select it above to start using it.", variant: "success" });
      if (pullStatus.status === "error") toast({ title: "Pull failed", description: pullStatus.error, variant: "error" });
    }
  }, [pullStatus?.done]);

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Settings" description="Connect AURORA to Ollama and tune how autonomous the vessel is." />

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Ollama connection</h2>
          <LiveDot live={!!status?.live} />
        </div>
        <div className="flex gap-2">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="http://localhost:11434" className="flex-1" />
          <Button variant="outline" onClick={() => updateConfig.mutate({ ollamaHost: host })}>Save</Button>
        </div>
        {!status?.live && (
          <p className="text-xs text-muted-foreground">
            Can't reach Ollama. Install it from ollama.com and run <code className="text-accent font-mono">ollama serve</code>, or check the host above.
          </p>
        )}
      </Card>

      <Card className="p-5 space-y-4">
        <h2 className="text-sm font-medium">Model</h2>
        <Select value={config?.model ?? ""} onChange={(e) => updateConfig.mutate({ model: e.target.value })}>
          <option value="">Select a pulled model…</option>
          {status?.models.map((m) => (
            <option key={m.name} value={m.name}>{m.name} ({(m.size / 1e9).toFixed(1)} GB)</option>
          ))}
        </Select>

        <div className="border-t border-border pt-4">
          <label className="text-xs text-muted-foreground">Pull a new model — needs tool-calling support (e.g. llama3.1, qwen2.5, mistral-nemo)</label>
          <div className="flex gap-2 mt-2">
            <Input value={pullModelName} onChange={(e) => setPullModelName(e.target.value)} placeholder="llama3.1" className="flex-1" />
            <Button
              variant="primary"
              onClick={() => pull.mutate(pullModelName)}
              disabled={!pullModelName.trim() || (!!pulling && !pullStatus?.done)}
            >
              Pull
            </Button>
          </div>
          {pulling && pullStatus && !pullStatus.done && (
            <div className="mt-2.5 space-y-1">
              <div className="text-xs text-muted-foreground">
                {pullStatus.status}
                {pullStatus.total ? ` — ${Math.round(((pullStatus.completed ?? 0) / pullStatus.total) * 100)}%` : ""}
              </div>
              {pullStatus.total && (
                <div className="h-1 w-full rounded-full bg-surface overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.round(((pullStatus.completed ?? 0) / pullStatus.total) * 100))}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium">Autonomy</h2>
        <div className="grid grid-cols-2 gap-2">
          {(["manual", "supervised"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => updateConfig.mutate({ autonomy: mode })}
              aria-pressed={config?.autonomy === mode}
              className={cn(
                "rounded-md border px-3.5 py-3 text-left transition-colors duration-150",
                config?.autonomy === mode ? "border-primary bg-primary/10" : "border-border hover:bg-surface",
              )}
            >
              <div className="text-sm font-medium capitalize">{mode}</div>
              <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {mode === "manual" ? "Every tool call waits for your approval." : "Low-risk tools auto-run; shell/skill-install/high-risk still wait."}
              </div>
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Image generation</h2>
          <LiveDot live={!!imageGenStatus?.live} />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Point this at a local Automatic1111 or ComfyUI server (with the Automatic1111-compatible API enabled) to let AURORA generate images via its <code className="text-accent font-mono">generate_image</code> tool. Leave blank to disable — there's no paid-API fallback.
        </p>
        <div className="flex gap-2">
          <Input value={imageGenHost} onChange={(e) => setImageGenHost(e.target.value)} placeholder="http://localhost:7860" className="flex-1" />
          <Button variant="outline" onClick={() => updateConfig.mutate({ imageGenHost })}>Save</Button>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Voice</h2>
          <button
            onClick={() => voice.setEnabled(!voice.enabled)}
            role="switch"
            aria-checked={voice.enabled}
            aria-label={voice.enabled ? "Disable voice replies" : "Enable voice replies"}
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors duration-150",
              voice.enabled ? "bg-primary" : "bg-surface border border-border",
            )}
          >
            <span className={cn("absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150", voice.enabled && "translate-x-4")} />
          </button>
        </div>
        {!voice.supported ? (
          <p className="text-xs text-muted-foreground">Your browser doesn't support speech synthesis.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Spoken replies via your browser's built-in text-to-speech — free and local, no API keys. Voice quality depends on what your OS ships.
            </p>
            <div className="flex gap-2">
              <Select value={voice.voiceURI ?? ""} onChange={(e) => voice.setVoiceURI(e.target.value)} className="flex-1">
                {voice.voices.length === 0 && <option value="">Loading voices…</option>}
                {voice.voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                ))}
              </Select>
              <Button variant="outline" onClick={() => voice.speak("Hey, this is what I sound like.")}>
                <Volume2 size={14} /> Test
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium">System prompt / persona</h2>
        <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={7} />
        <Button variant="outline" onClick={() => updateConfig.mutate({ systemPrompt })}>Save prompt</Button>
      </Card>
    </div>
  );
}
