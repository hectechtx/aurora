import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { useVoice } from "@/lib/voice";
import { useNotifications } from "@/lib/notifications";
import { setToken } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { usePullModel } from "@/lib/usePullModel";
import { PullProgress } from "@/components/ui/PullProgress";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/Badge";
import { timeAgo } from "@/lib/utils";
import {
  Volume2, ShieldAlert, LogOut, KeyRound, BellRing, Eye, Download, Check, Video, Cpu,
  FolderOpen, MessagesSquare, RefreshCw, Music2, Loader2, Mic, HardDrive, Send, Sparkles,
} from "lucide-react";

interface CuratedVoice { id: string; label: string; blurb: string; sizeMb: number; }
interface TtsStatus { installed: boolean; voices: string[]; catalog: CuratedVoice[]; }

interface VideoGenSetupStatus {
  stage: "idle" | "detecting" | "venv" | "pytorch" | "downloading" | "dependencies" | "done" | "error";
  message: string;
  done: boolean;
  error?: string;
}
interface VideoGenStatus {
  installed: boolean;
  gpu: { name: string; vramMb: number } | null;
  setup: VideoGenSetupStatus;
}

interface OllamaStatus { live: boolean; host: string; activeModel: string; models: { name: string; size: number }[]; }
// Adjuster for the Ollama context window (num_ctx) — how many tokens the model
// can hold in one turn. The default (8192) exists because the model's own
// advertised window (often 128K) balloons the KV-cache to many GB and can
// freeze a 16GB machine, so this is bounded and carries a plain-language
// warning about the memory cost of going higher.
function ContextWindowControl({ config, onCommit }: { config?: AgentConfig; onCommit: (n: number) => void }) {
  const current = config?.numCtx ?? 8192;
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  const high = draft >= 24576;
  return (
    <div className="border-t border-border pt-4 space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground">Context window — how much AURORA can hold in mind per turn</label>
        <span className="text-xs font-mono tabular-nums">{draft.toLocaleString()} tokens</span>
      </div>
      <input
        type="range" min={2048} max={32768} step={1024}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={() => draft !== current && onCommit(draft)}
        onTouchEnd={() => draft !== current && onCommit(draft)}
        onKeyUp={() => draft !== current && onCommit(draft)}
        className="w-full accent-primary"
        aria-label="Context window size in tokens"
      />
      <p className={cn("text-xs leading-relaxed", high ? "text-risk-high" : "text-muted-foreground")}>
        {high
          ? "Heads up: high values use a lot more RAM/VRAM. On 16GB RAM + 8GB VRAM this can slow things down or, at the top end, freeze the machine. Raise it only if you actually need long context."
          : "Higher = more memory of the conversation, but more RAM/VRAM used. 8,192 is the safe default; raise it if she's forgetting earlier parts of a long chat."}
      </p>
    </div>
  );
}

interface AgentConfig {
  id: number; ollamaHost: string; model: string; visionModel: string; systemPrompt: string; autonomy: string;
  imageGenHost: string; advancedToolsEnabled: boolean; contentDir: string; numCtx: number;
  musicDir: string; musicEnabled: boolean; musicVolume: number; autoContinue: boolean;
  telegramBotToken: string; telegramOwnerId: string;
}
interface SystemInfo { version: string; electronAvailable: boolean; }
interface AgentConversationItem {
  id: number; agentId: number; sourceAgentId: number | null; content: string; status: string;
  createdAt: number; sourceAgentName: string; targetAgentName: string;
}
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
  const notifications = useNotifications();
  const { data: config } = useQuery<AgentConfig>({ queryKey: ["/api/config"] });
  const { data: status } = useQuery<OllamaStatus>({ queryKey: ["/api/ollama/status"], refetchInterval: 8000 });
  const { data: imageGenStatus } = useQuery<ImageGenStatus>({ queryKey: ["/api/imagegen/status"], refetchInterval: 8000 });

  const [host, setHost] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [pullModelName, setPullModelName] = useState("");
  const [imageGenHost, setImageGenHost] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState("");

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

  const changePin = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/change-pin", { currentPin, newPin }).then((r) => r.json()),
    onSuccess: () => {
      setCurrentPin("");
      setNewPin("");
      setPinError("");
      toast({ title: "PIN changed", variant: "success" });
    },
    onError: () => setPinError("Couldn't change PIN — check your current PIN and try again."),
  });

  const logout = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSettled: () => {
      setToken(null);
      window.location.reload();
    },
  });

  function handleChangePin(e: React.FormEvent) {
    e.preventDefault();
    setPinError("");
    if (!/^\d{4,12}$/.test(newPin)) return setPinError("New PIN must be 4-12 digits.");
    changePin.mutate();
  }

  // One-click uncensored (abliterated) model — llama3.1:8b with the refusal
  // direction removed, so fewer canned "I can't help with that" replies and
  // more personality. Same 8B size that fits the 8GB card. The pull auto-
  // selects it on completion (only this model, not free-text pulls).
  const UNCENSORED_MODEL = "mannix/llama3.1-8b-abliterated:latest";
  const { pull, pulling, pullStatus, isBusy } = usePullModel((model) => {
    if (model === UNCENSORED_MODEL) updateConfig.mutate({ model });
  });
  const hasUncensored = status?.models.some((m) => m.name === UNCENSORED_MODEL);
  const usingUncensored = config?.model === UNCENSORED_MODEL;

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Settings" description="Connect AURORA to Ollama and tune how autonomous the vessel is." />

      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-1.5 bg-background/80 backdrop-blur-sm py-1">
        {[
          ["#connection", "Connection"], ["#model", "Model"], ["#autonomy", "Autonomy"], ["#advanced", "Capabilities"],
          ["#image", "Image"], ["#voice", "Voice"], ["#hearing", "Hearing"], ["#video", "Video"], ["#godseye", "God's Eye"], ["#backups", "Backups"], ["#persona", "Persona"], ["#storage", "Storage"], ["#about", "About"],
        ].map(([href, label]) => (
          <a key={href} href={href} className="text-xs rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
            {label}
          </a>
        ))}
      </div>

      <Card id="connection" className="p-5 space-y-3 scroll-mt-16">
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

      <Card id="model" className="p-5 space-y-4 scroll-mt-16">
        <h2 className="text-sm font-medium">Model</h2>
        <Select value={config?.model ?? ""} onChange={(e) => updateConfig.mutate({ model: e.target.value })}>
          <option value="">Select a pulled model…</option>
          {status?.models.map((m) => (
            <option key={m.name} value={m.name}>{m.name} ({(m.size / 1e9).toFixed(1)} GB)</option>
          ))}
        </Select>

        <ContextWindowControl config={config} onCommit={(numCtx) => updateConfig.mutate({ numCtx })} />

        <div className="border-t border-border pt-4 space-y-2">
          <label className="text-xs text-muted-foreground">Uncensored model — llama3.1 8B abliterated (fewer refusals, more personality)</label>
          <Button
            variant={usingUncensored ? "outline" : "primary"}
            className="w-full"
            disabled={usingUncensored || isBusy}
            onClick={() => (hasUncensored ? updateConfig.mutate({ model: UNCENSORED_MODEL }) : pull(UNCENSORED_MODEL))}
          >
            {usingUncensored
              ? <><Check size={14} /> Active — running uncensored</>
              : isBusy
                ? "Getting it…"
                : hasUncensored
                  ? <><Sparkles size={14} /> Switch to uncensored model</>
                  : <><Download size={14} /> Get uncensored model (~4.7GB)</>}
          </Button>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Trade-off: it's warmer and won't refuse, but a bit weaker at using tools than plain llama3.1. Switch back anytime with the model dropdown above.
          </p>
        </div>

        <div className="border-t border-border pt-4">
          <label className="text-xs text-muted-foreground">Pull a new model — needs tool-calling support (e.g. llama3.1, qwen2.5, mistral-nemo)</label>
          <div className="flex gap-2 mt-2">
            <Input value={pullModelName} onChange={(e) => setPullModelName(e.target.value)} placeholder="llama3.1" className="flex-1" />
            <Button
              variant="primary"
              onClick={() => pull(pullModelName)}
              disabled={!pullModelName.trim() || isBusy}
            >
              Pull
            </Button>
          </div>
          {pulling && pullStatus && !pullStatus.done && <PullProgress status={pullStatus} />}
        </div>
      </Card>

      <VisionModelCard config={config} status={status} updateConfig={updateConfig} />

      <Card id="autonomy" className="p-5 space-y-3 scroll-mt-16">
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
        <label className="flex items-center justify-between gap-4 pt-1 cursor-pointer">
          <div>
            <div className="text-sm font-medium">Auto-continue</div>
            <div className="text-xs text-muted-foreground leading-relaxed">
              Let AURORA keep working a task on her own after each reply — no need to type "continue." She stops when it's done, when she needs you, or after a few steps. Approvals still apply.
            </div>
          </div>
          <Switch
            checked={!!config?.autoContinue}
            onCheckedChange={() => updateConfig.mutate({ autoContinue: !config?.autoContinue })}
            label={config?.autoContinue ? "Turn off auto-continue" : "Turn on auto-continue"}
          />
        </label>
      </Card>

      <Card id="advanced" className={cn("p-5 space-y-3 border scroll-mt-16", config?.advancedToolsEnabled ? "border-risk-high/40" : "border-border")}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <ShieldAlert size={14} className="text-risk-high" /> Advanced tools
          </h2>
          <Switch
            tone="danger"
            checked={!!config?.advancedToolsEnabled}
            onCheckedChange={() => updateConfig.mutate({ advancedToolsEnabled: !config?.advancedToolsEnabled })}
            label={config?.advancedToolsEnabled ? "Disable advanced tools" : "Enable advanced tools"}
          />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Controls whether AURORA can run raw shell/Node/Python commands on this computer, or install and run code
          downloaded from a GitHub repo. Off by default. Only turn this on if you understand that a command or a
          downloaded skill runs with your full user account's access to this machine — every use still requires
          your explicit approval, but AURORA (or a skill) can propose genuinely destructive actions.
        </p>
        {!config?.advancedToolsEnabled && (
          <p className="text-xs text-muted-foreground/70">The Terminal page and skill installation are disabled while this is off.</p>
        )}
      </Card>

      <Card id="image" className="p-5 space-y-3 scroll-mt-16">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Image generation</h2>
          <LiveDot live={!!imageGenStatus?.live} />
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Points AURORA at an Automatic1111-compatible server for its <code className="text-accent font-mono">generate_image</code> tool. Leave blank to disable — there's no paid-API fallback. Use the guided local setup below, or point this at a ComfyUI/remote host you already have running.
        </p>
        <div className="flex gap-2">
          <Input value={imageGenHost} onChange={(e) => setImageGenHost(e.target.value)} placeholder="http://localhost:8188" className="flex-1" />
          <Button variant="outline" onClick={() => updateConfig.mutate({ imageGenHost })}>Save</Button>
        </div>
      </Card>

      <ImageGenSetupCard updateConfig={updateConfig} />

      <VideoGenCard />

      <ContentStorageCard config={config} updateConfig={updateConfig} />

      <BackgroundMusicCard config={config} updateConfig={updateConfig} />

      <TelegramRemoteCard config={config} updateConfig={updateConfig} />

      <Card id="voice" className="p-5 space-y-3 scroll-mt-16">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Voice</h2>
          <Switch
            checked={voice.enabled}
            onCheckedChange={() => voice.setEnabled(!voice.enabled)}
            label={voice.enabled ? "Disable voice replies" : "Enable voice replies"}
          />
        </div>
        {!voice.supported && voice.engine === "browser" ? (
          <p className="text-xs text-muted-foreground">Your browser doesn't support speech synthesis.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {([
                { id: "browser", label: "Browser", blurb: "Built-in, zero setup. Quality depends on your OS." },
                { id: "piper", label: "Piper", blurb: "Clear and instant, but evenly-paced delivery." },
                { id: "kokoro", label: "Kokoro", blurb: "Most human — real intonation and pacing." },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => voice.setEngine(opt.id)}
                  aria-pressed={voice.engine === opt.id}
                  className={cn(
                    "rounded-md border px-3.5 py-3 text-left transition-colors duration-150",
                    voice.engine === opt.id ? "border-primary bg-primary/10" : "border-border hover:bg-surface",
                  )}
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{opt.blurb}</div>
                </button>
              ))}
            </div>

            {voice.engine === "kokoro" ? (
              <KokoroVoicePicker />
            ) : voice.engine === "browser" ? (
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
            ) : (
              <PiperVoicePicker />
            )}
          </>
        )}
      </Card>

      <Card id="godseye" className="p-5 space-y-3 scroll-mt-16">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Eye size={14} /> God's Eye
        </h2>
        <GodsEyeStatusRow />
      </Card>

      <Card id="video" className="p-5 space-y-3 scroll-mt-16">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Video size={14} /> Video generation
        </h2>
        <VideoBackend />
      </Card>

      <Card id="backups" className="p-5 space-y-3 scroll-mt-16">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <HardDrive size={14} /> Data drive &amp; backups
        </h2>
        <StorageHealth />
      </Card>

      <Card id="hearing" className="p-5 space-y-3 scroll-mt-16">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Mic size={14} /> Hearing
        </h2>
        <HearingSetup />
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium flex items-center gap-1.5">
            <BellRing size={14} /> Desktop notifications
          </h2>
          <Switch
            // Shown as off when permission has been revoked at the OS/browser
            // level, even if the setting is still "on" from before that
            // happened — a switch that visually reads as active but can never
            // actually fire is more confusing than one that reads as off.
            checked={notifications.enabled && notifications.permission !== "denied"}
            onCheckedChange={() => notifications.setEnabled(!notifications.enabled)}
            disabled={!notifications.supported || notifications.permission === "denied"}
            label={notifications.enabled ? "Disable desktop notifications" : "Enable desktop notifications"}
          />
        </div>
        {!notifications.supported ? (
          <p className="text-xs text-muted-foreground">Your browser doesn't support desktop notifications.</p>
        ) : notifications.permission === "denied" ? (
          <p className="text-xs text-muted-foreground">
            Notifications are blocked at the browser/OS level — check your notification settings for AURORA to re-enable, then flip this on.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Get a native notification when an agent finishes a deliverable or hits something that needs your approval — so unattended work stays visible even when AURORA isn't the window you're looking at.
          </p>
        )}
      </Card>

      <Card className="p-5 space-y-3">
        <h2 id="persona" className="text-sm font-medium scroll-mt-16">System prompt / persona</h2>
        <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={7} />
        <Button variant="outline" onClick={() => updateConfig.mutate({ systemPrompt })}>Save prompt</Button>
      </Card>

      <Card className="p-5 space-y-4">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <KeyRound size={14} /> Security
        </h2>
        <form onSubmit={handleChangePin} className="space-y-2.5">
          <label className="text-xs text-muted-foreground">Change PIN</label>
          <div className="flex gap-2">
            <Input
              type="password"
              inputMode="numeric"
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ""))}
              placeholder="Current PIN"
              maxLength={12}
              className="flex-1"
            />
            <Input
              type="password"
              inputMode="numeric"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
              placeholder="New PIN (4-12 digits)"
              maxLength={12}
              className="flex-1"
            />
            <Button type="submit" variant="outline" disabled={!currentPin || !newPin || changePin.isPending}>
              Update
            </Button>
          </div>
          {pinError && <p className="text-xs text-risk-high">{pinError}</p>}
        </form>

        <div className="border-t border-border pt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Sign out of this device.</p>
          <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut size={14} /> Log out
          </Button>
        </div>
      </Card>

      <AgentConversationsCard />

      <UpdateCard />
    </div>
  );
}

function ContentStorageCard({ config, updateConfig }: {
  config: AgentConfig | undefined;
  updateConfig: { mutate: (patch: Partial<AgentConfig>) => void };
}) {
  const { toast } = useToast();
  const { data: sysInfo } = useQuery<SystemInfo>({ queryKey: ["/api/system/info"] });
  const [dir, setDir] = useState("");

  useEffect(() => {
    if (config) setDir(config.contentDir || "");
  }, [config?.id]);

  const browse = useMutation({
    mutationFn: () => apiRequest("POST", "/api/system/pick-folder").then((r) => r.json()),
    onSuccess: (data: { path: string | null }) => { if (data.path) setDir(data.path); },
    onError: (err: Error) => toast({ title: "Couldn't open folder picker", description: err.message, variant: "error" }),
  });

  return (
    <Card id="storage" className="p-5 space-y-3 scroll-mt-16">
      <h2 className="text-sm font-medium flex items-center gap-1.5">
        <FolderOpen size={14} /> Content storage
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Where generated images and videos get saved — point this at a different drive if you're planning to generate a lot of video. Leave blank for the default location inside AURORA's own data folder. Changing this only affects new creations; existing files stay where they are.
      </p>
      <div className="flex gap-2">
        <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Default location" className="flex-1" />
        {sysInfo?.electronAvailable && (
          <Button variant="outline" onClick={() => browse.mutate()} disabled={browse.isPending}>Browse…</Button>
        )}
        <Button variant="outline" onClick={() => updateConfig.mutate({ contentDir: dir })}>Save</Button>
      </div>
      {!sysInfo?.electronAvailable && (
        <p className="text-xs text-muted-foreground/70">Folder browsing is only available in the installed desktop app — paste a full path above instead.</p>
      )}
    </Card>
  );
}

function BackgroundMusicCard({ config, updateConfig }: {
  config: AgentConfig | undefined;
  updateConfig: { mutate: (patch: Partial<AgentConfig>) => void };
}) {
  const { toast } = useToast();
  const { data: sysInfo } = useQuery<SystemInfo>({ queryKey: ["/api/system/info"] });
  const [dir, setDir] = useState("");

  useEffect(() => {
    if (config) setDir(config.musicDir || "");
  }, [config?.id]);

  const { data: tracks = [] } = useQuery<string[]>({
    queryKey: ["/api/music/tracks"],
    enabled: !!config?.musicDir,
  });

  const browse = useMutation({
    mutationFn: () => apiRequest("POST", "/api/system/pick-folder").then((r) => r.json()),
    onSuccess: (data: { path: string | null }) => { if (data.path) setDir(data.path); },
    onError: (err: Error) => toast({ title: "Couldn't open folder picker", description: err.message, variant: "error" }),
  });

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Music2 size={14} /> Background music
        </h2>
        <Switch
          checked={!!config?.musicEnabled}
          onCheckedChange={() => updateConfig.mutate({ musicEnabled: !config?.musicEnabled })}
          disabled={!config?.musicDir}
          label="Background music"
        />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Point this at a folder of your own music and AURORA will shuffle and loop it quietly in the background while you work. Nothing is bundled or downloaded — it's entirely your own files.
      </p>
      <div className="flex gap-2">
        <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="e.g. C:\Users\you\Music\Metal" className="flex-1" />
        {sysInfo?.electronAvailable && (
          <Button variant="outline" onClick={() => browse.mutate()} disabled={browse.isPending}>Browse…</Button>
        )}
        <Button variant="outline" onClick={() => updateConfig.mutate({ musicDir: dir })}>Save</Button>
      </div>
      {config?.musicDir && (
        <p className="text-xs text-muted-foreground/70">{tracks.length} track{tracks.length === 1 ? "" : "s"} found (mp3, wav, ogg, m4a, flac).</p>
      )}
      {!sysInfo?.electronAvailable && (
        <p className="text-xs text-muted-foreground/70">Folder browsing is only available in the installed desktop app — paste a full path above instead.</p>
      )}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground w-14 shrink-0">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={config?.musicVolume ?? 35}
          onChange={(e) => updateConfig.mutate({ musicVolume: Number(e.target.value) })}
          className="flex-1 accent-primary"
        />
        <span className="text-xs text-muted-foreground w-8 text-right">{config?.musicVolume ?? 35}%</span>
      </div>
    </Card>
  );
}

/**
 * Telegram remote for music search. Both fields are required before the
 * poller will run: a bot answers anyone who finds its username, so without
 * the owner id this would be an open downloader for the whole internet.
 */
function TelegramRemoteCard({ config, updateConfig }: {
  config: AgentConfig | undefined;
  updateConfig: { mutate: (patch: Partial<AgentConfig>) => void };
}) {
  const [token, setToken] = useState("");
  const [ownerId, setOwnerId] = useState("");

  useEffect(() => {
    if (config) {
      setToken(config.telegramBotToken || "");
      setOwnerId(config.telegramOwnerId || "");
    }
  }, [config?.id]);

  const live = Boolean(config?.telegramBotToken && config?.telegramOwnerId);

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Send size={14} /> Telegram music remote
        </h2>
        <span className={`text-xs ${live ? "text-emerald-500" : "text-muted-foreground/70"}`}>
          {live ? "● listening" : "not connected"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Text a song title to your own Telegram bot from anywhere and it searches, then you tap a
        result to download it straight into your music folder. AURORA only makes outbound requests,
        so this needs no port forwarding and nothing is exposed to the internet.
      </p>
      <ol className="text-xs text-muted-foreground/80 space-y-1 list-decimal list-inside">
        <li>Message <span className="font-mono">@BotFather</span> on Telegram → <span className="font-mono">/newbot</span> → copy the token.</li>
        <li>Message <span className="font-mono">@userinfobot</span> → copy your numeric user id.</li>
      </ol>
      <div className="space-y-2">
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Bot token — 123456789:AAE..."
          type="password"
          className="font-mono text-xs"
        />
        <div className="flex gap-2">
          <Input
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            placeholder="Your Telegram user id — e.g. 87654321"
            className="flex-1 font-mono text-xs"
          />
          <Button
            variant="outline"
            onClick={() => updateConfig.mutate({ telegramBotToken: token.trim(), telegramOwnerId: ownerId.trim() })}
          >
            Save
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/70">
        Only your user id can talk to the bot — messages from anyone else are ignored without a reply.
        Clear the token to stop it.
      </p>
    </Card>
  );
}

function AgentConversationsCard() {
  const { data: conversations = [], isLoading } = useQuery<AgentConversationItem[]>({
    queryKey: ["/api/agents/conversations"],
    refetchInterval: 15_000,
  });

  return (
    <Card className="p-5 space-y-3">
      <h2 className="text-sm font-medium flex items-center gap-1.5">
        <MessagesSquare size={14} /> Agent conversations
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Every handoff and message your agents have sent each other, newest first.
      </p>
      {isLoading && <Skeleton className="h-16 w-full" />}
      {!isLoading && conversations.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No agent-to-agent messages yet.</p>
      )}
      {conversations.length > 0 && (
        <div className="max-h-80 overflow-y-auto space-y-2">
          {conversations.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{c.sourceAgentName} → {c.targetAgentName}</span>
                <StatusBadge status={c.status} />
              </div>
              <p className="text-muted-foreground mt-1.5 whitespace-pre-wrap">{c.content}</p>
              <p className="text-muted-foreground/70 mt-1.5">{timeAgo(c.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function UpdateCard() {
  const { toast } = useToast();
  const { data: sysInfo } = useQuery<SystemInfo>({ queryKey: ["/api/system/info"] });
  const { data: updateStatus, isLoading: checking } = useQuery<{ available: boolean; builtAt?: number }>({
    queryKey: ["/api/system/update-check"],
    enabled: !!sysInfo?.electronAvailable,
    refetchInterval: 60_000,
  });

  const applyUpdate = useMutation({
    mutationFn: () => apiRequest("POST", "/api/system/apply-update").then((r) => r.json()),
    onSuccess: () => toast({ title: "Installing update…", description: "AURORA will close and reopen shortly.", variant: "success" }),
    onError: (err: Error) => toast({ title: "Couldn't apply update", description: err.message, variant: "error" }),
  });

  if (!sysInfo?.electronAvailable) {
    return (
      <Card id="about" className="p-5 space-y-2 scroll-mt-16">
        <h2 className="text-sm font-medium flex items-center gap-1.5"><RefreshCw size={14} /> Update &amp; about</h2>
        <p className="text-xs text-muted-foreground leading-relaxed">Only available in the installed desktop app.</p>
      </Card>
    );
  }

  return (
    <Card id="about" className="p-5 space-y-3 scroll-mt-16">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5"><RefreshCw size={14} /> Update &amp; about</h2>
        <span className="text-xs text-muted-foreground font-mono">v{sysInfo.version}</span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        {checking && "Checking for a newer build…"}
        {!checking && updateStatus?.available && `A newer build is ready (built ${timeAgo(updateStatus.builtAt ?? 0)}) — one click installs and restarts, no files to find.`}
        {!checking && !updateStatus?.available && "You're on the latest build."}
      </p>
      {updateStatus?.available && (
        <Button variant="primary" onClick={() => applyUpdate.mutate()} disabled={applyUpdate.isPending}>
          {applyUpdate.isPending ? "Installing…" : "Update & restart"}
        </Button>
      )}
    </Card>
  );
}

interface ImageGenSetupStatus { stage: string; message: string; done: boolean; error?: string; }
interface ImageGenInstallStatus { installed: boolean; serverRunning: boolean; setup: ImageGenSetupStatus; defaultHost: string; }

function ImageGenSetupCard({ updateConfig }: { updateConfig: { mutate: (patch: Partial<AgentConfig>) => void } }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: status } = useQuery<ImageGenInstallStatus>({
    queryKey: ["/api/imagegen/setup-status"],
    refetchInterval: (query) => (query.state.data?.setup.done === false ? 2000 : 8000),
  });

  const startSetup = useMutation({
    mutationFn: () => apiRequest("POST", "/api/imagegen/setup").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/imagegen/setup-status"] }),
    onError: (err: Error) => toast({ title: "Couldn't start setup", description: err.message, variant: "error" }),
  });

  const startServer = useMutation({
    mutationFn: () => apiRequest("POST", "/api/imagegen/server/start").then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/imagegen/setup-status"] });
      if (status?.defaultHost) updateConfig.mutate({ imageGenHost: status.defaultHost });
      toast({ title: "Starting the image generation server…", description: "First start after install can take a minute or two.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't start server", description: err.message, variant: "error" }),
  });

  const stopServer = useMutation({
    mutationFn: () => apiRequest("POST", "/api/imagegen/server/stop").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/imagegen/setup-status"] }),
    onError: (err: Error) => toast({ title: "Couldn't stop server", description: err.message, variant: "error" }),
  });

  const setup = status?.setup;
  const inProgress = !!setup && !setup.done;
  const failed = setup?.stage === "error";

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Download size={14} /> Local image generation setup
        </h2>
        {status?.installed && <span className="text-xs text-risk-low font-medium">Installed</span>}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Installs <code className="text-accent font-mono">AUTOMATIC1111/stable-diffusion-webui</code> locally, under this same app. First-time setup creates a private Python environment and installs PyTorch (several minutes to tens of minutes). Unlike video generation, this runs as a standing local server — start it before generating, and it keeps running in the background until you stop it.
      </p>

      {!status?.installed && inProgress && (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">{setup.message}</div>
          <div className="h-1 w-full rounded-full bg-surface overflow-hidden">
            <div className="h-full bg-primary animate-pulse" style={{ width: "60%" }} />
          </div>
        </div>
      )}

      {!status?.installed && !inProgress && (
        <>
          {failed && <p className="text-xs text-risk-high">{setup?.message}</p>}
          <Button variant="primary" onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>
            <Download size={14} /> {failed ? "Retry setup" : "Install"}
          </Button>
        </>
      )}

      {status?.installed && (
        <>
          <div className="flex items-center gap-2">
            {status.serverRunning ? (
              <Button variant="outline" onClick={() => stopServer.mutate()} disabled={stopServer.isPending}>
                Stop server
              </Button>
            ) : (
              <Button variant="primary" onClick={() => startServer.mutate()} disabled={startServer.isPending}>
                Start server
              </Button>
            )}
            <span className={cn("text-xs", status.serverRunning ? "text-risk-low" : "text-muted-foreground")}>
              {status.serverRunning ? "Running" : "Stopped"}
            </span>
          </div>
          <p className="text-xs text-risk-medium leading-relaxed">
            One more step: place a Stable Diffusion checkpoint (a <code className="text-accent font-mono">.safetensors</code> file — e.g. from Hugging Face or Civitai) into the webui's <code className="text-accent font-mono">models/Stable-diffusion</code> folder. Generation will fail with a clear error until it has at least one model to use — this is a licensing/size call AURORA won't make for you automatically.
          </p>
        </>
      )}
    </Card>
  );
}

function VideoGenCard() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: status } = useQuery<VideoGenStatus>({
    queryKey: ["/api/videogen/status"],
    refetchInterval: (query) => (query.state.data?.setup.done === false ? 2000 : 15_000),
  });

  const startSetup = useMutation({
    mutationFn: () => apiRequest("POST", "/api/videogen/setup").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/videogen/status"] }),
    onError: (err: Error) => toast({ title: "Couldn't start setup", description: err.message, variant: "error" }),
  });

  const setup = status?.setup;
  const inProgress = !!setup && !setup.done;
  const failed = setup?.stage === "error";

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Video size={14} /> Video generation
        </h2>
        {status?.installed && <span className="text-xs text-risk-low font-medium">Ready</span>}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Local text/image-to-video via <code className="text-accent font-mono">LTX-Video</code> — no ComfyUI, no remote host. First-time setup installs a private Python + PyTorch environment (several minutes to tens of minutes depending on your connection and GPU); the model checkpoint itself downloads automatically the first time you actually generate something.
      </p>

      {status?.gpu ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Cpu size={12} /> {status.gpu.name} · {(status.gpu.vramMb / 1024).toFixed(1)} GB VRAM
        </div>
      ) : (
        <p className="text-xs text-risk-medium leading-relaxed">
          No NVIDIA GPU detected — generation will fall back to CPU, which is extremely slow (potentially tens of minutes per clip). This is worth setting up only if you have an NVIDIA card.
        </p>
      )}

      {status?.installed ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Ask AURORA to generate a video from any task — it'll use its <code className="text-accent font-mono">generate_video</code> tool automatically.
        </p>
      ) : inProgress ? (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground capitalize">{setup.message}</div>
          <div className="h-1 w-full rounded-full bg-surface overflow-hidden">
            <div className="h-full bg-primary animate-pulse" style={{ width: "60%" }} />
          </div>
        </div>
      ) : (
        <>
          {failed && <p className="text-xs text-risk-high">{setup?.message}</p>}
          <Button variant="primary" onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>
            <Download size={14} /> {failed ? "Retry setup" : "Set up video generation"}
          </Button>
        </>
      )}
    </Card>
  );
}

function VisionModelCard({ config, status, updateConfig }: {
  config: AgentConfig | undefined;
  status: OllamaStatus | undefined;
  updateConfig: { mutate: (patch: Partial<AgentConfig>) => void };
}) {
  // Separate, lower-frequency query — checking vision support costs one
  // /api/show call per pulled model, so it doesn't ride along on the
  // few-second status poll.
  const { data: visionData } = useQuery<{ models: { name: string; size: number; vision: boolean }[] }>({
    queryKey: ["/api/ollama/vision-models"],
    refetchInterval: 30_000,
  });

  const visionNames = visionData ? new Set(visionData.models.filter((m) => m.vision).map((m) => m.name)) : null;
  // Fail open while the capability check hasn't loaded yet (or errored) —
  // showing every pulled model beats showing none. Once it's loaded, only
  // models Ollama itself reports as vision-capable are selectable, which is
  // what actually prevents the "no image was provided" confusion: picking a
  // text-only model here used to silently "work" (tool ran fine) while the
  // model just couldn't see anything.
  const eligible = status?.models.filter((m) => visionNames === null || visionNames.has(m.name)) ?? [];
  const noneEligible = visionNames !== null && status && status.models.length > 0 && eligible.length === 0;

  return (
    <Card className="p-5 space-y-4">
      <h2 className="text-sm font-medium flex items-center gap-1.5">
        <Eye size={14} /> Vision model
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        A separate multimodal model AURORA calls when you attach an image or use its <code className="text-accent font-mono">see_image</code> tool — most tool-calling models can't see images directly. Try <code className="text-accent font-mono">llava</code>, <code className="text-accent font-mono">llama3.2-vision</code>, or <code className="text-accent font-mono">minicpm-v</code>.
      </p>
      {noneEligible && (
        <p className="text-xs text-risk-medium leading-relaxed">
          None of your pulled models report vision support — picking one anyway would just get you replies like "no image was provided." Pull a vision-capable model above first.
        </p>
      )}
      <Select value={config?.visionModel ?? ""} onChange={(e) => updateConfig.mutate({ visionModel: e.target.value })}>
        <option value="">None — image attachments will be disabled</option>
        {eligible.map((m) => (
          <option key={m.name} value={m.name}>{m.name} ({(m.size / 1e9).toFixed(1)} GB)</option>
        ))}
      </Select>
    </Card>
  );
}

interface GodsEyeStatus { live: boolean; url: string }

function GodsEyeStatusRow() {
  const { data } = useQuery<GodsEyeStatus>({ queryKey: ["/api/godseye/status"], refetchInterval: 10000 });
  if (!data) return <p className="text-xs text-muted-foreground">Checking…</p>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Globe server <span className="font-mono text-muted-foreground">{data.url}</span></span>
        <LiveDot live={data.live} />
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        A live 3D globe of public open-source intelligence — aircraft, ships, satellites, earthquakes, fires. It's a separate
        local app; start it with <span className="font-mono">npm run dev</span> in its folder, then open the God's Eye tab.
        Runs keyless; optional API keys go in its own settings.
      </p>
    </div>
  );
}

interface WanGpStatus { live: boolean; host: string; model: string }

function VideoBackend() {
  const { data } = useQuery<WanGpStatus>({ queryKey: ["/api/videogen/wangp/status"], refetchInterval: 10000 });
  if (!data) return <p className="text-xs text-muted-foreground">Checking…</p>;

  return (
    <div className="space-y-2">
      <div className={cn("rounded-md border p-3", data.live ? "border-border" : "border-border")}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">WanGP</span>
          <LiveDot live={data.live} />
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          Model <span className="font-mono">{data.model}</span> · <span className="font-mono break-all">{data.host}</span>
        </div>
      </div>
      {data.live ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          <Check size={12} className="inline mr-1 text-primary" />
          Video generation is available. Ask AURORA to make a video and it renders here.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Not reachable. Start the <span className="font-mono">wan</span> app in Pinokio. Its MCP API must be enabled —
          the launcher's start command needs <span className="font-mono">--mcp --mcp-transport streamable-http --mcp-port 7866</span>.
          Until then, video requests will say so rather than failing silently.
        </p>
      )}
    </div>
  );
}

interface StorageStatus {
  drive: { available: boolean; lastSeenAt: number; dataDir: string };
  backups: { file: string; sizeBytes: number; takenAt: number }[];
  backupDir: string;
}

function StorageHealth() {
  const { data } = useQuery<StorageStatus>({ queryKey: ["/api/system/storage"], refetchInterval: 15000 });
  if (!data) return <p className="text-xs text-muted-foreground">Checking…</p>;

  const newest = data.backups[0];
  return (
    <div className="space-y-3">
      <div className={cn("rounded-md border p-3", data.drive.available ? "border-border" : "border-destructive bg-destructive/10")}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Data drive</span>
          <LiveDot live={data.drive.available} />
        </div>
        <div className="text-xs text-muted-foreground mt-1 font-mono break-all">{data.drive.dataDir}</div>
        {!data.drive.available && (
          <p className="text-xs text-destructive mt-2 leading-relaxed">
            The drive holding AURORA's data has disconnected. Chat, image generation and the library will all fail until it's back —
            check the enclosure's cable and power. Your latest backup is safe on the internal drive.
          </p>
        )}
      </div>

      <div className="rounded-md border border-border p-3 space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Automatic backups</span>
          <span className="text-xs text-muted-foreground">every 30 min · last 10 kept</span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Snapshots of the database are written to the internal drive, so losing the external one costs at most half an hour of work.
        </p>
        <div className="text-xs text-muted-foreground font-mono break-all">{data.backupDir}</div>
        {newest ? (
          <p className="text-xs text-muted-foreground pt-1">
            <Check size={12} className="inline mr-1 text-primary" />
            Most recent: {timeAgo(newest.takenAt)} ({(newest.sizeBytes / 1e6).toFixed(1)} MB) · {data.backups.length} kept
          </p>
        ) : (
          <p className="text-xs text-muted-foreground pt-1">No backups taken yet — the first runs shortly after startup.</p>
        )}
      </div>
    </div>
  );
}

interface SttStatus { installed: boolean; setup: { running: boolean; step: string; error: string | null } }

function HearingSetup() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: status } = useQuery<SttStatus>({ queryKey: ["/api/stt/status"], refetchInterval: 3000 });

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/stt/install").then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/stt/status"] });
      toast({ title: "Installing speech recognition", description: "A couple of minutes — it downloads a local Whisper model.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't start the install", description: err.message, variant: "error" }),
  });

  if (!status) return <p className="text-xs text-muted-foreground">Checking…</p>;

  if (status.installed) {
    return (
      <p className="text-xs text-muted-foreground leading-relaxed">
        <Check size={12} className="inline mr-1 text-primary" />
        Ready. The microphone button in any chat composer records what you say and transcribes it here on this machine —
        nothing is sent anywhere.
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Lets you talk to AURORA instead of typing. Uses a local Whisper model (~150MB) rather than the browser's built-in
        speech recognition, which would upload your microphone audio to Google.
      </p>
      {status.setup.error && <p className="text-xs text-destructive leading-relaxed">{status.setup.error}</p>}
      {status.setup.running ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> {status.setup.step}
        </div>
      ) : (
        <Button variant="primary" onClick={() => install.mutate()} disabled={install.isPending}>
          <Download size={14} /> {status.setup.error ? "Try again" : "Install speech recognition"}
        </Button>
      )}
    </div>
  );
}

interface KokoroVoice { id: string; label: string; blurb: string; accent: string }
interface KokoroStatus { installed: boolean; voices: KokoroVoice[]; setup: { running: boolean; step: string; error: string | null } }

function KokoroVoicePicker() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voice = useVoice();
  // Polled faster than the Piper card because the install is long and
  // multi-step — the owner should see it move through PyTorch → Kokoro →
  // model download rather than stare at one frozen label.
  const { data: status } = useQuery<KokoroStatus>({ queryKey: ["/api/tts/kokoro/status"], refetchInterval: 3000 });

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tts/kokoro/install").then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tts/kokoro/status"] });
      toast({ title: "Installing Kokoro", description: "This takes a few minutes — it downloads PyTorch and the voice model.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't start the Kokoro install", description: err.message, variant: "error" }),
  });

  if (!status) return <p className="text-xs text-muted-foreground">Checking…</p>;

  if (!status.installed) {
    return (
      <div className="space-y-2.5">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Kokoro-82M is the natural-sounding voice — real emphasis, question intonation and pacing instead of Piper's even delivery.
          It sets up its own Python environment and downloads about 350MB of model weights. Runs on the CPU, so it never takes VRAM from your models.
        </p>
        {status.setup.error && <p className="text-xs text-destructive leading-relaxed">{status.setup.error}</p>}
        {status.setup.running ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={13} className="animate-spin" /> {status.setup.step}
          </div>
        ) : (
          <Button variant="primary" onClick={() => install.mutate()} disabled={install.isPending}>
            <Download size={14} /> {status.setup.error ? "Try again" : "Install Kokoro voices"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {status.voices.map((v) => {
        const isSelected = voice.kokoroVoice === v.id;
        return (
          <div key={v.id} className={cn("rounded-md border p-3", isSelected ? "border-primary bg-primary/10" : "border-border")}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {v.label} <span className="text-xs text-muted-foreground font-normal">({v.accent})</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{v.blurb}</div>
              </div>
              <Button
                variant={isSelected ? "outline" : "primary"}
                size="sm"
                onClick={() => voice.setKokoroVoice(v.id)}
                className="shrink-0"
              >
                {isSelected ? <><Check size={13} /> Selected</> : "Use this voice"}
              </Button>
            </div>
          </div>
        );
      })}

      <div className="rounded-md border border-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Pace</span>
          <span className="text-xs text-muted-foreground tabular-nums">{voice.kokoroSpeed.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.7}
          max={1.3}
          step={0.05}
          value={voice.kokoroSpeed}
          onChange={(e) => voice.setKokoroSpeed(Number(e.target.value))}
          className="w-full accent-primary"
          aria-label="Speaking pace"
        />
        <p className="text-xs text-muted-foreground">Slower reads more deliberate; faster reads more casual.</p>
      </div>

      <Button variant="outline" className="w-full" onClick={() => voice.speak("Hey — this is what I actually sound like now. Better, isn't it?")}>
        <Volume2 size={14} /> Test
      </Button>
      <p className="text-xs text-muted-foreground">The first line after a restart takes a few seconds while the model loads; everything after is quick.</p>
    </div>
  );
}

function PiperVoicePicker() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voice = useVoice();
  const { data: status } = useQuery<TtsStatus>({ queryKey: ["/api/tts/status"], refetchInterval: 5000 });

  const installEngine = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tts/install").then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tts/status"] });
      toast({ title: "Voice engine installed", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't install voice engine", description: err.message, variant: "error" }),
  });

  const installVoice = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/tts/voices/${id}/install`).then((r) => r.json()),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["/api/tts/status"] });
      voice.setPiperVoice(id);
      toast({ title: "Voice downloaded", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't download voice", description: err.message, variant: "error" }),
  });

  if (!status?.installed) {
    return (
      <div className="space-y-2.5">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Downloads the Piper engine (~25MB) from its GitHub release — runs fully offline afterward, no API key, no data leaves this machine.
        </p>
        <Button variant="primary" onClick={() => installEngine.mutate()} disabled={installEngine.isPending}>
          <Download size={14} /> {installEngine.isPending ? "Downloading…" : "Download voice engine"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {status.catalog.map((v) => {
        const isInstalled = status.voices.includes(v.id);
        const isSelected = voice.piperVoice === v.id;
        const isInstallingThis = installVoice.isPending && installVoice.variables === v.id;
        return (
          <div key={v.id} className={cn("rounded-md border p-3", isSelected ? "border-primary bg-primary/10" : "border-border")}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{v.label} <span className="text-xs text-muted-foreground font-normal">({v.sizeMb} MB)</span></div>
                <div className="text-xs text-muted-foreground mt-0.5">{v.blurb}</div>
              </div>
              {isInstalled ? (
                <Button
                  variant={isSelected ? "outline" : "primary"}
                  size="sm"
                  onClick={() => voice.setPiperVoice(v.id)}
                  className="shrink-0"
                >
                  {isSelected ? <><Check size={13} /> Selected</> : "Use this voice"}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => installVoice.mutate(v.id)} disabled={installVoice.isPending} className="shrink-0">
                  {isInstallingThis ? "Downloading…" : <><Download size={13} /> Download</>}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {voice.piperVoice && (
        <Button variant="outline" className="w-full" onClick={() => voice.speak("Hey, this is what I sound like now.")}>
          <Volume2 size={14} /> Test
        </Button>
      )}
    </div>
  );
}
