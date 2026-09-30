import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea, Input, Select } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { AuthedVideo } from "@/components/ui/AuthedVideo";
import { AuthedAudio } from "@/components/ui/AuthedAudio";
import { cn } from "@/lib/utils";
import { Image as ImageIcon, Clapperboard, FolderCode, Square, FolderOpen, Loader2, Film, Music } from "lucide-react";

type Mode = "image" | "video" | "project" | "longform" | "music";

interface Creation { id: number; kind: string; prompt: string; title: string | null; filePath: string; createdAt: number; }
interface VideoJobStatus { status: "running" | "done" | "error"; lines: string[]; creation: Creation | null; error: string | null; }
interface StoryboardJobStatus { status: "running" | "done" | "error"; message: string; creation: Creation | null; error: string | null; }
interface TtsStatus { installed: boolean; voices: string[]; catalog: { id: string; label: string }[]; }

const MODES: { key: Mode; label: string; icon: typeof ImageIcon }[] = [
  { key: "image", label: "Image", icon: ImageIcon },
  { key: "video", label: "Video", icon: Clapperboard },
  { key: "longform", label: "Long-form Video", icon: Film },
  { key: "music", label: "Music", icon: Music },
  { key: "project", label: "Code Project", icon: FolderCode },
];

const VIDEO_STYLES = [
  { value: "", label: "No particular style" },
  { value: "cinematic", label: "Cinematic" },
  { value: "realistic", label: "Realistic" },
  { value: "animated", label: "Animated / cartoon" },
  { value: "anime", label: "Anime" },
  { value: "3d", label: "3D render" },
  { value: "dreamlike", label: "Dreamlike" },
];

const VIDEO_LENGTHS = [
  { value: "short", label: "Short (~1s)" },
  { value: "medium", label: "Medium (~2s)" },
  { value: "long", label: "Long (~4s)" },
];

const VIDEO_ORIENTATIONS = [
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
];

export default function Generate() {
  const [mode, setMode] = useState<Mode>("image");

  return (
    <div className="p-8 max-w-3xl mx-auto overflow-y-auto h-screen">
      <PageHeader
        title="Generate"
        description="Skip the conversation — describe exactly what you want and AURORA makes it directly, with real controls instead of guessing at what a chat message meant."
      />

      <div className="flex gap-1.5 mb-6">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={cn(
              "flex items-center gap-1.5 text-sm rounded-full border px-3.5 py-1.5 transition-colors",
              mode === m.key ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <m.icon size={14} /> {m.label}
          </button>
        ))}
      </div>

      {mode === "image" && <ImagePanel />}
      {mode === "video" && <VideoPanel />}
      {mode === "longform" && <LongFormPanel />}
      {mode === "music" && <MusicPanel />}
      {mode === "project" && <ProjectPanel />}
    </div>
  );
}

function TitleField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Title <span className="opacity-60">(optional)</span></label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Give it a name to find later in the Library" disabled={disabled} />
    </div>
  );
}

function ImagePanel() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<Creation | null>(null);

  const generate = useMutation({
    mutationFn: () => apiRequest("POST", "/api/generate/image", { prompt, title: title.trim() || undefined }).then((r) => r.json()),
    onSuccess: (creation: Creation) => setResult(creation),
    onError: (err: Error) => toast({ title: "Couldn't generate image", description: err.message, variant: "error" }),
  });

  return (
    <Card className="p-5 space-y-4">
      <TitleField value={title} onChange={setTitle} disabled={generate.isPending} />
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Prompt</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A neon-lit cyberpunk city street at night, rain-slicked pavement, cinematic lighting…"
          rows={4}
          disabled={generate.isPending}
        />
      </div>
      <Button
        variant="primary"
        onClick={() => { setResult(null); generate.mutate(); }}
        disabled={!prompt.trim() || generate.isPending}
      >
        {generate.isPending && <Loader2 size={14} className="animate-spin" />}
        {generate.isPending ? "Generating…" : "Generate image"}
      </Button>

      {result && (
        <div className="pt-2">
          <AuthedImage src={`/creations/${result.filePath}`} alt={result.title ?? result.prompt} className="w-full max-w-md rounded-lg border border-border" />
          <p className="text-xs text-muted-foreground mt-2">Saved to your Library.</p>
        </div>
      )}
    </Card>
  );
}

function VideoPanel() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");
  const [length, setLength] = useState("short");
  const [orientation, setOrientation] = useState("landscape");
  const [jobId, setJobId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/generate/video", {
        prompt,
        title: title.trim() || undefined,
        style: style || undefined,
        length,
        orientation,
      }).then((r) => r.json()),
    onSuccess: (data: { jobId: string }) => setJobId(data.jobId),
    onError: (err: Error) => toast({ title: "Couldn't start video generation", description: err.message, variant: "error" }),
  });

  const stop = useMutation({
    mutationFn: () => apiRequest("POST", `/api/generate/video/${jobId}/stop`).then((r) => r.json()),
  });

  const job = useQuery<VideoJobStatus>({
    queryKey: [`/api/generate/video/${jobId}`],
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
  });

  const running = job.data?.status === "running";

  return (
    <Card className="p-5 space-y-4">
      <TitleField value={title} onChange={setTitle} disabled={running} />
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Prompt</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A red ball bouncing on a wooden floor, slow motion, soft studio lighting…"
          rows={4}
          disabled={running}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Style</label>
          <Select value={style} onChange={(e) => setStyle(e.target.value)} disabled={running}>
            {VIDEO_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Length</label>
          <Select value={length} onChange={(e) => setLength(e.target.value)} disabled={running}>
            {VIDEO_LENGTHS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Orientation</label>
          <Select value={orientation} onChange={(e) => setOrientation(e.target.value)} disabled={running}>
            {VIDEO_ORIENTATIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/70">
        Longer clips take noticeably more time and are more likely to strain an 8GB GPU — start with Short to confirm your prompt looks right.
      </p>

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => { setJobId(null); start.mutate(); }}
          disabled={!prompt.trim() || start.isPending || running}
        >
          {running && <Loader2 size={14} className="animate-spin" />}
          {running ? "Generating…" : "Generate video"}
        </Button>
        {running && (
          <Button variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={13} /> Stop
          </Button>
        )}
      </div>

      {job.data && job.data.lines.length > 0 && (
        <div className="rounded-md bg-surface border border-border p-3 text-xs font-mono text-muted-foreground max-h-40 overflow-y-auto space-y-1">
          {job.data.lines.slice(-8).map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}

      {job.data?.status === "error" && (
        <p className="text-xs text-risk-high">{job.data.error}</p>
      )}

      {job.data?.status === "done" && job.data.creation && (
        <div className="pt-2">
          <AuthedVideo src={`/creations/${job.data.creation.filePath}`} className="w-full max-w-md rounded-lg border border-border" autoPlay loop />
          <p className="text-xs text-muted-foreground mt-2">Saved to your Library.</p>
        </div>
      )}
    </Card>
  );
}

const LONGFORM_MODES = [
  { value: "images", label: "Slideshow (fastest, most reliable)" },
  { value: "hybrid", label: "Hybrid — mostly slideshow, some AI video" },
  { value: "video", label: "AI video clips throughout (slowest)" },
];

function LongFormPanel() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [targetMinutes, setTargetMinutes] = useState("5");
  const [mode, setMode] = useState("images");
  const [orientation, setOrientation] = useState("landscape");
  const [voiceId, setVoiceId] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);

  const tts = useQuery<TtsStatus>({ queryKey: ["/api/tts/status"] });
  const installedVoices = (tts.data?.voices ?? []).map((id) => ({
    id, label: tts.data?.catalog.find((c) => c.id === id)?.label ?? id,
  }));

  const start = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/generate/storyboard", {
        topic, title: title.trim() || undefined, targetMinutes: Number(targetMinutes) || 5,
        mode, orientation, voiceId,
      }).then((r) => r.json()),
    onSuccess: (data: { jobId: string }) => setJobId(data.jobId),
    onError: (err: Error) => toast({ title: "Couldn't start", description: err.message, variant: "error" }),
  });

  const stop = useMutation({
    mutationFn: () => apiRequest("POST", `/api/generate/storyboard/${jobId}/stop`).then((r) => r.json()),
  });

  const job = useQuery<StoryboardJobStatus>({
    queryKey: [`/api/generate/storyboard/${jobId}`],
    enabled: !!jobId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 4000 : false),
  });

  const running = job.data?.status === "running";
  const noVoices = tts.data && installedVoices.length === 0;

  return (
    <Card className="p-5 space-y-4">
      <p className="text-xs text-muted-foreground/80 leading-relaxed">
        A true continuous multi-minute AI video isn't something local hardware can do in one pass — LTX-Video tops
        out around 4-6 seconds per generation. This writes a real script, narrates it, and stitches a sequence of
        scenes into one long video instead. It's slower than the other Generate modes — a 5-minute video can take
        tens of minutes to render — but it's a genuine, working path to long-form content.
      </p>

      {noVoices && (
        <p className="text-xs text-risk-high">Set up a voice for narration in Settings → Voice first.</p>
      )}

      <TitleField value={title} onChange={setTitle} disabled={running} />
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Topic</label>
        <Textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="The history of the Roman aqueducts and how they still influence engineering today…"
          rows={3}
          disabled={running}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Target length (minutes)</label>
          <Input type="number" min={1} max={20} value={targetMinutes} onChange={(e) => setTargetMinutes(e.target.value)} disabled={running} />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Orientation</label>
          <Select value={orientation} onChange={(e) => setOrientation(e.target.value)} disabled={running}>
            {VIDEO_ORIENTATIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Visual style</label>
        <Select value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}>
          {LONGFORM_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Narration voice</label>
        <Select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={running || noVoices}>
          <option value="">Pick a voice…</option>
          {installedVoices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </Select>
      </div>

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => { setJobId(null); start.mutate(); }}
          disabled={!topic.trim() || !voiceId || start.isPending || running}
        >
          {running && <Loader2 size={14} className="animate-spin" />}
          {running ? "Generating…" : "Generate long-form video"}
        </Button>
        {running && (
          <Button variant="destructive" onClick={() => stop.mutate()} disabled={stop.isPending}>
            <Square size={13} /> Stop
          </Button>
        )}
      </div>

      {job.data?.status === "running" && (
        <p className="text-xs text-muted-foreground">{job.data.message}</p>
      )}

      {job.data?.status === "error" && (
        <p className="text-xs text-risk-high">{job.data.error}</p>
      )}

      {job.data?.status === "done" && job.data.creation && (
        <div className="pt-2">
          <AuthedVideo src={`/creations/${job.data.creation.filePath}`} className="w-full max-w-md rounded-lg border border-border" muted={false} loop={false} />
          <p className="text-xs text-muted-foreground mt-2">Saved to your Library.</p>
        </div>
      )}
    </Card>
  );
}

const MUSIC_DURATIONS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "1 minute" },
  { value: "120", label: "2 minutes" },
  { value: "180", label: "3 minutes" },
  { value: "240", label: "4 minutes" },
];

interface MusicGenStatus { installed: boolean; setup: { stage: string; message: string; done: boolean; error?: string }; }

function MusicPanel() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [duration, setDuration] = useState("60");
  const [result, setResult] = useState<Creation | null>(null);

  const status = useQuery<MusicGenStatus>({
    queryKey: ["/api/musicgen/status"],
    refetchInterval: (query) => (query.state.data && !query.state.data.installed && !query.state.data.setup.done ? 2500 : false),
  });

  const setup = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicgen/setup").then((r) => r.json()),
    onError: (err: Error) => toast({ title: "Couldn't start setup", description: err.message, variant: "error" }),
  });

  const generate = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicgen/generate", {
      prompt, lyrics: lyrics.trim() || undefined, durationSeconds: Number(duration), title: title.trim() || undefined,
    }).then((r) => r.json()),
    onSuccess: (c: Creation) => { setResult(c); toast({ title: "Song generated", description: "Saved to your Library.", variant: "success" }); },
    onError: (err: Error) => toast({ title: "Couldn't generate music", description: err.message, variant: "error" }),
  });

  if (status.isLoading) return <Card className="p-5"><Loader2 className="animate-spin" size={16} /></Card>;

  // Not installed yet — show the one-time setup gate (mirrors video gen).
  if (status.data && !status.data.installed) {
    const s = status.data.setup;
    const installing = setup.isPending || (!s.done && s.stage !== "idle");
    return (
      <Card className="p-5 space-y-3">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Music size={15} /> Local music generation (ACE-Step)</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          A one-time setup installs ACE-Step (a 3.5B text-to-music model tuned to run on ~8GB GPUs) into its own Python environment on your F drive. It downloads several GB the first time, so it takes a while — you can keep using the rest of AURORA meanwhile.
        </p>
        {s.stage !== "idle" && (
          <div className="rounded-md bg-surface border border-border p-3 text-xs text-muted-foreground">
            {installing && <Loader2 size={13} className="animate-spin inline mr-1.5" />}
            {s.message || s.stage}
            {s.error && <span className="text-risk-high"> — {s.error}</span>}
          </div>
        )}
        <Button variant="primary" onClick={() => setup.mutate()} disabled={installing}>
          {installing ? "Setting up…" : "Set up music generation"}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-5 space-y-4">
      <TitleField value={title} onChange={setTitle} disabled={generate.isPending} />
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Style / description</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="upbeat synthwave, driving bassline, 80s drums, nostalgic, instrumental…"
          rows={3}
          disabled={generate.isPending}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Lyrics <span className="text-muted-foreground/60">(optional — leave blank for instrumental)</span></label>
        <Textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          placeholder={"[verse]\nDriving through the neon night\n[chorus]\nWe are electric, we are alive"}
          rows={4}
          disabled={generate.isPending}
        />
      </div>
      <div className="max-w-xs">
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Length</label>
        <Select value={duration} onChange={(e) => setDuration(e.target.value)} disabled={generate.isPending}>
          {MUSIC_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </Select>
      </div>
      <p className="text-xs text-muted-foreground/70">
        The first generation also downloads the model checkpoints, so it can take several minutes. Later runs are much faster.
      </p>
      <Button variant="primary" onClick={() => { setResult(null); generate.mutate(); }} disabled={!prompt.trim() || generate.isPending}>
        {generate.isPending && <Loader2 size={14} className="animate-spin" />}
        {generate.isPending ? "Generating… (this can take a while)" : "Generate song"}
      </Button>

      {result && (
        <div className="pt-2 space-y-2">
          <AuthedAudio src={`/creations/${result.filePath}`} className="w-full" />
          <p className="text-xs text-muted-foreground">Saved to your Library.</p>
        </div>
      )}
    </Card>
  );
}

function ProjectPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<(Creation & { fileCount: number }) | null>(null);

  const generate = useMutation({
    mutationFn: () => apiRequest("POST", "/api/generate/project", { description, title: title.trim() || undefined }).then((r) => r.json()),
    onSuccess: (creation) => {
      setResult(creation);
      qc.invalidateQueries({ queryKey: ["/api/creations"] });
    },
    onError: (err: Error) => toast({ title: "Couldn't generate project", description: err.message, variant: "error" }),
  });

  const filesQuery = useQuery<{ files: string[] }>({
    queryKey: [`/api/creations/${result?.id}/project-files`],
    enabled: !!result,
  });

  const reveal = useMutation({
    mutationFn: () => apiRequest("POST", `/api/creations/${result?.id}/reveal`).then((r) => r.json()),
    onError: (err: Error) => toast({ title: "Couldn't open folder", description: err.message, variant: "error" }),
  });

  return (
    <Card className="p-5 space-y-4">
      <TitleField value={title} onChange={setTitle} disabled={generate.isPending} />
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">What do you want built?</label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A small Python CLI tool that renames files in a folder by their EXIF date. Include a README."
          rows={5}
          disabled={generate.isPending}
        />
        <p className="text-xs text-muted-foreground/70 mt-1.5">
          Built by your main chat model in one pass — keep it scoped to a small, focused project for the best results.
        </p>
      </div>
      <Button
        variant="primary"
        onClick={() => { setResult(null); generate.mutate(); }}
        disabled={!description.trim() || generate.isPending}
      >
        {generate.isPending && <Loader2 size={14} className="animate-spin" />}
        {generate.isPending ? "Building…" : "Generate project"}
      </Button>

      {result && (
        <div className="pt-2 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{result.fileCount} file{result.fileCount === 1 ? "" : "s"} generated</p>
            <Button variant="outline" size="sm" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
              <FolderOpen size={13} /> Open folder
            </Button>
          </div>
          {filesQuery.data && (
            <ul className="rounded-md bg-surface border border-border p-3 text-xs font-mono text-muted-foreground max-h-48 overflow-y-auto space-y-1">
              {filesQuery.data.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
