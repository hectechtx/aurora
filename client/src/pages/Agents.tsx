import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { AuroraAvatar, UserAvatar, IdentityAvatar } from "@/components/ui/Avatar";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { AttachMenu } from "@/components/ui/AttachMenu";
import { MicButton } from "@/components/ui/MicButton";
import { ToolCallCard, type ToolCallRecord } from "@/components/ui/ToolCallCard";
import { linkify } from "@/lib/linkify";
import { readFilesForAttachment, formatAttachedFiles, type AttachedFile } from "@/lib/fileAttach";
import { cn, timeAgo, isEntryInProgress } from "@/lib/utils";
import { Bot, Plus, Play, Pause, Trash2, Send, CornerDownRight, X, ImageUp, File as FileIcon, Square, BrainCircuit, Wand2, Archive } from "lucide-react";

const MAX_IMAGE_BYTES = 15_000_000;

// Coarse mood face keyed off morale, mirroring the server's moodFor() bands
// so the icon and the mood word never disagree.
function moodEmoji(morale: number): string {
  if (morale >= 85) return "😄";
  if (morale >= 65) return "🙂";
  if (morale >= 45) return "😐";
  if (morale >= 25) return "😕";
  return "😩";
}

// 0-100 → a colour that walks red → amber → green, used for both vitals bars.
function vitalColor(v: number): string {
  if (v >= 66) return "bg-emerald-500";
  if (v >= 33) return "bg-amber-500";
  return "bg-rose-500";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
}

interface AgentItem {
  id: number; name: string; persona: string; jobDescription: string; status: string;
  scheduleMinutes: number | null; lastRunAt: number | null; createdAt: number; updatedAt: number;
  avatarPath: string | null;
  role: string | null; isOverseer: boolean; morale: number; energy: number; mood: string;
  spawnedByAgentId: number | null; preferredModel: string | null;
}
interface Relationship {
  id: number; agentId: number; otherAgentId: number; otherAgentName: string;
  sentiment: number; interactions: number; note: string | null; updatedAt: number;
}
interface AgentLogEntry { id: number; role: string; content: string; toolCalls: string | null; createdAt: number; thinking: string | null; }
interface QueueItem {
  id: number; content: string; status: string; createdAt: number; doneAt: number | null;
  sourceAgentName: string | null;
}
interface Creation { id: number; kind: string; prompt: string; filePath: string; createdAt: number; }

const SCHEDULE_OPTIONS = [
  { label: "As soon as possible (checked every minute)", value: "" },
  { label: "Every 15 minutes", value: "15" },
  { label: "Every 30 minutes", value: "30" },
  { label: "Every hour", value: "60" },
  { label: "Every 4 hours", value: "240" },
  { label: "Once a day", value: "1440" },
];

const PERSONA_PLACEHOLDER =
  "You're a funny, comedic, easygoing, chill YouTube influencer persona. You're quick with a joke, " +
  "never take yourself too seriously, and talk like a real creator hyping up their own content.";

const JOB_PLACEHOLDER =
  "Come up with video ideas, write scripts/titles/descriptions/tags, and generate a thumbnail concept " +
  "for each one. Save every finished piece with save_deliverable so the owner can review and post it.";

export default function Agents() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: agentsList = [], isLoading } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"], refetchInterval: 5000 });

  useEffect(() => {
    if (selectedId === null && !creating && agentsList.length > 0) setSelectedId(agentsList[0].id);
  }, [agentsList.length]);

  const deleteAgent = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${id}`).then((r) => r.json()),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      if (selectedId === id) setSelectedId(null);
      toast({ title: "Agent deleted", variant: "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete agent", description: err.message, variant: "error" }),
  });

  const selected = agentsList.find((a) => a.id === selectedId);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <Button variant="primary" className="w-full" onClick={() => { setCreating(true); setSelectedId(null); }}>
            <Plus size={14} /> New Agent
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="p-3 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}
          {!isLoading && agentsList.length === 0 && (
            <div className="p-6">
              <EmptyState icon={Bot} title="No agents yet" description="Create one to give it a persistent job." />
            </div>
          )}
          {agentsList.map((a) => (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => { setSelectedId(a.id); setCreating(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(a.id); setCreating(false); } }}
              className={cn(
                "group flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-border-subtle text-sm transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                selectedId === a.id ? "bg-primary/10" : "hover:bg-surface",
              )}
            >
              <IdentityAvatar name={a.name} avatarPath={a.avatarPath} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium" title={a.name}>{a.name}</span>
                  {a.isOverseer && <span title="Overseer">👑</span>}
                  <span title={`Mood: ${a.mood}`}>{moodEmoji(a.morale)}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-muted-foreground">
                    {a.scheduleMinutes ? `every ${a.scheduleMinutes}m` : "checks every minute"}
                  </span>
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteAgent.mutate(a.id); }}
                title="Delete agent"
                aria-label="Delete agent"
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-risk-high shrink-0 transition-opacity"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {creating && <NewAgentForm onDone={(id) => { setCreating(false); setSelectedId(id); }} onCancel={() => setCreating(false)} />}
        {!creating && selected && <AgentDetail agent={selected} />}
        {!creating && !selected && (
          <div className="h-full flex items-center justify-center">
            <EmptyState icon={Bot} title="Nothing selected" description="Pick an agent on the left, or create a new one." />
          </div>
        )}
      </div>
    </div>
  );
}

function NewAgentForm({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [schedule, setSchedule] = useState("");

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/agents", {
      name, persona, jobDescription, scheduleMinutes: schedule ? Number(schedule) : null,
    }).then((r) => r.json()),
    onSuccess: (agent: AgentItem) => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: `"${agent.name}" is ready`, description: "Give it something to do below.", variant: "success" });
      onDone(agent.id);
    },
    onError: (err: Error) => toast({ title: "Couldn't create agent", description: err.message, variant: "error" }),
  });

  return (
    <div className="p-8 max-w-2xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Give it a name, a personality, and a job. It'll work through its queue on its own schedule using the same tools AURORA already has.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Riley the YouTube Persona" />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Persona / voice</label>
        <Textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} placeholder={PERSONA_PLACEHOLDER} />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Job description</label>
        <Textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} rows={4} placeholder={JOB_PLACEHOLDER} />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Schedule</label>
        <Select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="max-w-xs">
          {SCHEDULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <p className="text-xs text-muted-foreground/70">It works through its queue on its own, right when you give it something to do — this just controls how often it re-checks in case anything else shows up (e.g. a recurring task, or a handoff from another agent).</p>
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => create.mutate()} disabled={!name.trim() || !persona.trim() || !jobDescription.trim() || create.isPending}>
          Create Agent
        </Button>
      </div>
    </div>
  );
}

function AgentDetail({ agent }: { agent: AgentItem }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"activity" | "team" | "recurring" | "memory">("activity");
  const [viewMode, setViewMode] = useState<"response" | "thinking">("response");
  const [suggestion, setSuggestion] = useState("");
  const [attachedImage, setAttachedImage] = useState<Creation | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const toggleStatus = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/agents/${agent.id}`, { status: agent.status === "active" ? "paused" : "active" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
    onError: (err: Error) => toast({ title: "Couldn't update agent", description: err.message, variant: "error" }),
  });

  const stop = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agents/${agent.id}/stop`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/log`] }),
    onError: (err: Error) => toast({ title: "Couldn't stop", description: err.message, variant: "error" }),
  });

  const clearLog = useMutation({
    mutationFn: (archive: boolean) => apiRequest("POST", `/api/agents/${agent.id}/log/clear`, { archive }).then((r) => r.json()),
    onSuccess: (_d, archive) => {
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/log`] });
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/memory`] });
      toast({ title: archive ? "Chat archived to Memory & cleared" : "Chat cleared", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't clear chat", description: err.message, variant: "error" }),
  });

  const generateAvatar = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agents/${agent.id}/avatar/generate`).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      toast({ title: "Avatar generated", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't generate avatar", description: err.message, variant: "error" }),
  });

  // Same queryKey as ActivityFeed's own log query below — TanStack Query
  // dedupes identical keys into one shared subscription, so this doesn't add
  // a second poll, it just lets the header read the same live data to know
  // whether to show Stop.
  const { data: log = [] } = useQuery<AgentLogEntry[]>({ queryKey: [`/api/agents/${agent.id}/log`] });
  const agentActive = isEntryInProgress(log[log.length - 1]);

  const uploadImage = useMutation({
    mutationFn: (dataUrl: string) => apiRequest("POST", "/api/creations/upload", { dataUrl }).then((r) => r.json()),
    onSuccess: (creation: Creation) => setAttachedImage(creation),
    onError: (err: Error) => toast({ title: "Couldn't attach image", description: err.message, variant: "error" }),
  });

  const addSuggestion = useMutation({
    mutationFn: ({ content, imageCreationId }: { content: string; imageCreationId?: number }) =>
      apiRequest("POST", `/api/agents/${agent.id}/queue`, { content, imageCreationId }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/queue`] });
      setSuggestion("");
      setAttachedImage(null);
      setAttachedFiles([]);
    },
    onError: (err: Error) => toast({ title: "Couldn't add to queue", description: err.message, variant: "error" }),
  });

  async function attachImage(file: File | null | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    if (file.size > MAX_IMAGE_BYTES) return toast({ title: "Image too large", description: "Max 15MB.", variant: "error" });
    const dataUrl = await readFileAsDataUrl(file);
    uploadImage.mutate(dataUrl);
  }

  async function attachFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const { files, skipped } = await readFilesForAttachment(fileList);
    if (files.length) setAttachedFiles((prev) => [...prev, ...files]);
    if (skipped.length) {
      toast({
        title: `Skipped ${skipped.length} item${skipped.length > 1 ? "s" : ""}`,
        description: skipped.slice(0, 3).join(", ") + (skipped.length > 3 ? "…" : ""),
        variant: "default",
      });
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    attachImage(item.getAsFile());
  }

  function handleSend() {
    const imageCreationId = attachedImage?.id;
    const filesBlock = formatAttachedFiles(attachedFiles);
    const baseText = suggestion.trim() || (imageCreationId ? "What's in this image?" : filesBlock ? "Take a look at the attached file(s)." : "");
    const content = baseText + filesBlock;
    if (!content.trim() || addSuggestion.isPending) return;
    addSuggestion.mutate({ content, imageCreationId });
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-6 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          <div className="relative shrink-0 group/avatar">
            <IdentityAvatar name={agent.name} avatarPath={agent.avatarPath} className="h-12 w-12 text-base" />
            <button
              onClick={() => generateAvatar.mutate()}
              disabled={generateAvatar.isPending}
              title={agent.avatarPath ? "Regenerate avatar" : "Generate an avatar"}
              aria-label={agent.avatarPath ? "Regenerate avatar" : "Generate an avatar"}
              className="absolute inset-0 rounded-full flex items-center justify-center bg-background/80 opacity-0 group-hover/avatar:opacity-100 transition-opacity disabled:opacity-100"
            >
              <Wand2 size={16} className={cn("text-foreground", generateAvatar.isPending && "animate-pulse")} />
            </button>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-semibold truncate" title={agent.name}>{agent.name}</h1>
              <StatusBadge status={agent.status} />
              {agent.isOverseer && (
                <span className="text-[11px] rounded-full bg-primary/15 text-primary border border-primary/30 px-2 py-0.5 font-medium">Overseer</span>
              )}
              {agent.role && !agent.isOverseer && (
                <span className="text-[11px] rounded-full bg-surface text-muted-foreground border border-border px-2 py-0.5">{agent.role}</span>
              )}
              <span className="text-[11px] rounded-full bg-surface border border-border px-2 py-0.5 text-muted-foreground" title="Current mood, driven by morale">
                {moodEmoji(agent.morale)} {agent.mood}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2 max-w-xl" title={agent.jobDescription}>{agent.jobDescription}</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {agent.scheduleMinutes ? `Checks its queue every ${agent.scheduleMinutes} min` : "Checks its queue every minute"}
              {agent.lastRunAt ? ` · last ran ${timeAgo(agent.lastRunAt)}` : " · hasn't run yet"}
            </p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => {
              const next = viewMode === "response" ? "thinking" : "response";
              setViewMode(next);
              toast({ title: `Switched transcript view to ${next === "thinking" ? "Thinking" : "Response"}`, variant: "default" });
            }}
            title={viewMode === "thinking" ? "Show the final responses" : "Show the model's raw reasoning"}
            className={cn(
              "flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1.5 transition-colors shrink-0 self-center",
              viewMode === "thinking" ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <BrainCircuit size={13} /> Thinking
          </button>
          {tab === "activity" && log.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={() => clearLog.mutate(true)} disabled={clearLog.isPending} title="Save this chat to Memory, then clear it">
                <Archive size={13} /> Archive
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { if (confirm("Clear this agent's chat without archiving? This can't be undone.")) clearLog.mutate(false); }}
                disabled={clearLog.isPending}
                title="Clear this chat without saving"
              >
                <Trash2 size={13} /> Clear
              </Button>
            </>
          )}
          {agentActive && (
            <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square size={13} /> Stop
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => toggleStatus.mutate()} disabled={toggleStatus.isPending}>
            {agent.status === "active" ? <><Pause size={13} /> Pause</> : <><Play size={13} /> Resume</>}
          </Button>
        </div>
      </header>

      <div className="border-b border-border px-6">
        <div className="flex gap-1" role="tablist">
          {(["activity", "team", "recurring", "memory"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2.5 text-sm capitalize border-b-2 transition-colors -mb-px",
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "activity" && (
        <>
          <ActivityFeed agentId={agent.id} live={agentActive} viewMode={viewMode} />
          <div className="border-t border-border p-4">
            {(attachedImage || uploadImage.isPending || attachedFiles.length > 0) && (
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                {uploadImage.isPending && (
                  <div className="h-14 w-14 rounded-md border border-border bg-surface animate-pulse flex items-center justify-center">
                    <ImageUp size={16} className="text-muted-foreground" />
                  </div>
                )}
                {attachedImage && (
                  <div className="relative">
                    <AuthedImage src={`/creations/${attachedImage.filePath}`} alt="Attached" className="h-14 w-14 rounded-md border border-border object-cover" />
                    <button
                      onClick={() => setAttachedImage(null)}
                      title="Remove image"
                      aria-label="Remove image"
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center text-muted-foreground hover:text-risk-high"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )}
                {attachedFiles.map((f) => (
                  <div key={f.id} className="relative flex items-center gap-1.5 rounded-md border border-border bg-surface pl-2.5 pr-6 py-2 text-xs max-w-[200px]">
                    <FileIcon size={13} className="text-muted-foreground shrink-0" />
                    <span className="truncate" title={f.name}>{f.name}</span>
                    <button
                      onClick={() => setAttachedFiles((prev) => prev.filter((x) => x.id !== f.id))}
                      title="Remove file"
                      aria-label="Remove file"
                      className="absolute top-1 right-1 h-4 w-4 rounded-full flex items-center justify-center text-muted-foreground hover:text-risk-high"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { attachImage(e.target.files?.[0]); e.target.value = ""; }}
              />
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => { attachFiles(e.target.files); e.target.value = ""; }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { attachFiles(e.target.files); e.target.value = ""; }}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
              <AttachMenu
                disabled={uploadImage.isPending}
                onPickImage={() => imageInputRef.current?.click()}
                onPickFile={() => fileInputRef.current?.click()}
                onPickFolder={() => folderInputRef.current?.click()}
              />
              <MicButton
                onTranscript={(text) => setSuggestion((prev) => (prev ? `${prev} ${text}` : text))}
                onError={(message) => toast({ title: "Couldn't hear that", description: message, variant: "error" })}
              />
              <Textarea
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                onPaste={handlePaste}
                placeholder="Give it something to do… (paste an image to attach it)"
                rows={2}
                className="flex-1"
              />
              <Button
                variant="primary"
                size="icon"
                onClick={handleSend}
                disabled={addSuggestion.isPending || (!suggestion.trim() && !attachedImage && attachedFiles.length === 0)}
                className="self-end h-[38px]"
              >
                <Send size={15} />
              </Button>
            </div>
          </div>
        </>
      )}
      {tab === "team" && (
        <div className="flex-1 overflow-y-auto p-6" role="tabpanel">
          <AgentVitalsTeam agent={agent} />
        </div>
      )}
      {tab === "recurring" && (
        <div className="flex-1 overflow-y-auto p-6" role="tabpanel">
          <AgentRecurringTasks agentId={agent.id} />
        </div>
      )}
      {tab === "memory" && (
        <div className="flex-1 overflow-y-auto p-6" role="tabpanel">
          <AgentMemory agentId={agent.id} />
        </div>
      )}
    </div>
  );
}

type FeedItem =
  | { kind: "log"; id: string; createdAt: number; entry: AgentLogEntry }
  | { kind: "pending"; id: string; createdAt: number; item: QueueItem };

function ActivityFeed({ agentId, live, viewMode }: { agentId: number; live: boolean; viewMode: "response" | "thinking" }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Snappier while the agent is actively working a turn, so tool calls show
  // up close to when they actually happen instead of in occasional jumps.
  const interval = live ? 1200 : 4000;
  const { data: log = [], isLoading: logLoading } = useQuery<AgentLogEntry[]>({ queryKey: [`/api/agents/${agentId}/log`], refetchInterval: interval });
  const { data: queue = [], isLoading: queueLoading } = useQuery<QueueItem[]>({ queryKey: [`/api/agents/${agentId}/queue`], refetchInterval: interval });

  // A queue item's content gets echoed into the log as a "user" entry the
  // moment it starts processing — so once it's done, showing both would just
  // duplicate the same message. Only items still waiting get a card of their
  // own; everything else lives in the log timeline.
  const pending = queue.filter((q) => q.status !== "done");

  const feed: FeedItem[] = [
    ...log.map((entry): FeedItem => ({ kind: "log", id: `log-${entry.id}`, createdAt: entry.createdAt, entry })),
    ...pending.map((item): FeedItem => ({ kind: "pending", id: `pending-${item.id}`, createdAt: item.createdAt, item })),
  ].sort((a, b) => a.createdAt - b.createdAt);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed.length]);

  if (logLoading || queueLoading) return <div className="flex-1 p-6"><Skeleton className="h-16 w-2/3" /></div>;
  if (feed.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={Bot} title="Nothing yet" description="Give it something to do below, or wait for its next scheduled run." />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {feed.map((f) => f.kind === "pending" ? (
          <div key={f.id} className="flex animate-in items-end gap-2 justify-end">
            <div className="max-w-lg rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-primary/15 rounded-tr-sm opacity-70">
              {f.item.sourceAgentName && (
                <div className="flex items-center gap-1 text-xs text-accent mb-1">
                  <CornerDownRight size={12} /> handed off from {f.item.sourceAgentName}
                </div>
              )}
              <div className="whitespace-pre-wrap">{linkify(f.item.content)}</div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 mt-1.5">
                <StatusBadge status={f.item.status} /> · queued {timeAgo(f.item.createdAt)}
              </div>
            </div>
            <UserAvatar className="h-7 w-7 mb-1" />
          </div>
        ) : (
          <LogBubble key={f.id} entry={f.entry} viewMode={viewMode} />
        ))}
      </div>
    </div>
  );
}

function LogBubble({ entry, viewMode }: { entry: AgentLogEntry; viewMode: "response" | "thinking" }) {
  const isUser = entry.role === "user";
  let toolCalls: ToolCallRecord[] = [];
  if (entry.toolCalls) {
    try { toolCalls = JSON.parse(entry.toolCalls); } catch { /* skip malformed */ }
  }
  const showThinking = viewMode === "thinking" && !isUser;
  return (
    <div className={cn("flex animate-in items-end gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && <AuroraAvatar className="h-7 w-7 mb-1" />}
      <div className={cn(
        "max-w-lg rounded-xl px-4 py-2.5 text-sm leading-relaxed",
        isUser ? "bg-primary/15 rounded-tr-sm" : "bg-card border border-border rounded-tl-sm",
        showThinking && "border-dashed",
      )}>
        {showThinking ? (
          <div className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {entry.thinking || "(no reasoning captured for this entry — the model may not support it, or the turn is still running)"}
          </div>
        ) : (
          <>
            {entry.content && <div className="whitespace-pre-wrap">{linkify(entry.content)}</div>}
            {toolCalls.length > 0 && (
              <div className="mt-3 space-y-2 border-t border-border pt-2.5">
                {toolCalls.map((tc, i) => <ToolCallCard key={i} tc={tc} />)}
              </div>
            )}
          </>
        )}
        {!showThinking && !entry.content && toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
            </span>
          </div>
        )}
        <div className="text-[11px] text-muted-foreground/70 mt-1.5">{timeAgo(entry.createdAt)}</div>
      </div>
      {isUser && <UserAvatar className="h-7 w-7 mb-1" />}
    </div>
  );
}

interface RecurringTask { id: number; content: string; scheduleMinutes: number; active: boolean; lastQueuedAt: number | null; createdAt: number; }

const RECURRING_SCHEDULE_OPTIONS = SCHEDULE_OPTIONS.filter((o) => o.value !== "");

function AgentRecurringTasks({ agentId }: { agentId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [content, setContent] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState(RECURRING_SCHEDULE_OPTIONS[RECURRING_SCHEDULE_OPTIONS.length - 1].value);

  const { data: tasksList = [], isLoading } = useQuery<RecurringTask[]>({ queryKey: [`/api/agents/${agentId}/recurring`] });

  const create = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agents/${agentId}/recurring`, { content, scheduleMinutes: Number(scheduleMinutes) }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/agents/${agentId}/recurring`] });
      setContent("");
      toast({ title: "Recurring task added", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't add recurring task", description: err.message, variant: "error" }),
  });

  const toggleActive = useMutation({
    mutationFn: (task: RecurringTask) => apiRequest("PATCH", `/api/agents/${agentId}/recurring/${task.id}`, { active: !task.active }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/agents/${agentId}/recurring`] }),
    onError: (err: Error) => toast({ title: "Couldn't update recurring task", description: err.message, variant: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/agents/${agentId}/recurring/${id}`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/agents/${agentId}/recurring`] }),
    onError: (err: Error) => toast({ title: "Couldn't delete recurring task", description: err.message, variant: "error" }),
  });

  const scheduleLabel = (mins: number) => RECURRING_SCHEDULE_OPTIONS.find((o) => Number(o.value) === mins)?.label ?? `Every ${mins} min`;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">Add a recurring task</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          A standing instruction that adds itself to this agent's queue on its own — e.g. "check trending topics and pitch 3 video ideas," re-added automatically instead of you doing it by hand each time.
        </p>
        <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} placeholder="What should it do, every time?" />
        <div className="flex gap-2">
          <Select value={scheduleMinutes} onChange={(e) => setScheduleMinutes(e.target.value)} className="flex-1">
            {RECURRING_SCHEDULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <Button variant="primary" onClick={() => create.mutate()} disabled={!content.trim() || create.isPending}>
            Add
          </Button>
        </div>
      </Card>

      {isLoading && <div className="space-y-2"><Skeleton className="h-16 w-full" /></div>}
      {!isLoading && tasksList.length === 0 && (
        <EmptyState icon={Bot} title="No recurring tasks" description="Add one above to give this agent a standing daily (or hourly, etc.) instruction." />
      )}
      {tasksList.map((t) => (
        <Card key={t.id} className={cn("p-3", !t.active && "opacity-60")}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm whitespace-pre-wrap">{t.content}</p>
              <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                <StatusBadge status={t.active ? "active" : "paused"} />
                {scheduleLabel(t.scheduleMinutes)}
                {t.lastQueuedAt ? ` · last queued ${timeAgo(t.lastQueuedAt)}` : " · not queued yet"}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => toggleActive.mutate(t)} disabled={toggleActive.isPending}>
                {t.active ? "Pause" : "Resume"}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => remove.mutate(t.id)} disabled={remove.isPending}>
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function VitalBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{v}/100</span>
      </div>
      <div className="h-2 rounded-full bg-surface overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-500", vitalColor(v))} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

const STANDINGS: { min: number; label: string; cls: string }[] = [
  { min: 40, label: "close", cls: "text-emerald-500" },
  { min: 10, label: "on good terms", cls: "text-emerald-400" },
  { min: -9, label: "neutral", cls: "text-muted-foreground" },
  { min: -39, label: "some tension", cls: "text-amber-500" },
  { min: -100, label: "real friction", cls: "text-rose-500" },
];
function standingFor(sentiment: number) {
  return STANDINGS.find((s) => sentiment >= s.min) ?? STANDINGS[STANDINGS.length - 1];
}

function AgentVitalsTeam({ agent }: { agent: AgentItem }) {
  // Live so morale/energy visibly move as the agent works and interacts.
  const { data: agents = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"], refetchInterval: 5000 });
  const fresh = agents.find((a) => a.id === agent.id) ?? agent;
  const { data: rels = [], isLoading } = useQuery<Relationship[]>({
    queryKey: [`/api/agents/${agent.id}/relationships`], refetchInterval: 5000,
  });
  const spawnedBy = fresh.spawnedByAgentId != null ? agents.find((a) => a.id === fresh.spawnedByAgentId) : undefined;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Vitals</h3>
          <span className="text-xs rounded-full bg-surface border border-border px-2 py-0.5 text-muted-foreground">
            {moodEmoji(fresh.morale)} feeling {fresh.mood}
          </span>
        </div>
        <VitalBar label="Morale" value={fresh.morale} />
        <VitalBar label="Energy" value={fresh.energy} />
        <p className="text-xs text-muted-foreground/70 leading-relaxed">
          Morale lifts when work lands and colleagues treat this agent well, and dips on errors or friction; energy drains as it works and recovers while idle. These shape the tone it takes on each run — it's a living simulation, not a literal feeling.
        </p>
      </Card>

      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-medium">Standing on the team</h3>
        {fresh.isOverseer && (
          <p className="text-xs text-primary/90 leading-relaxed">
            This is AURORA, the overseer — she leads the team, coordinates handoffs, and answers only to you.
          </p>
        )}
        {spawnedBy && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Spawned by <span className="font-medium text-foreground">{spawnedBy.name}</span> to fill a needed role.
          </p>
        )}
        {fresh.role && (
          <p className="text-xs text-muted-foreground">Role: <span className="text-foreground">{fresh.role}</span></p>
        )}
        {fresh.preferredModel && (
          <p className="text-xs text-muted-foreground">Prefers model: <span className="text-foreground font-mono">{fresh.preferredModel}</span></p>
        )}

        {isLoading && <Skeleton className="h-10 w-full" />}
        {!isLoading && rels.length === 0 && (
          <p className="text-xs text-muted-foreground/70">Hasn't worked closely with anyone yet — relationships build as agents hand off work and message each other.</p>
        )}
        {rels.length > 0 && (
          <div className="space-y-2 pt-1">
            {rels.sort((a, b) => b.sentiment - a.sentiment).map((r) => {
              const s = standingFor(r.sentiment);
              return (
                <div key={r.id} className="flex items-center gap-3">
                  <IdentityAvatar name={r.otherAgentName} avatarPath={null} className="h-7 w-7 text-xs" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm truncate">{r.otherAgentName}</span>
                      <span className={cn("text-xs font-medium", s.cls)}>{s.label}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground/70">
                      {r.interactions} interaction{r.interactions === 1 ? "" : "s"}
                      {r.note ? ` · ${r.note}` : ""}
                    </div>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground shrink-0">{r.sentiment > 0 ? "+" : ""}{r.sentiment}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function AgentMemory({ agentId }: { agentId: number }) {
  const { data: notes = [], isLoading } = useQuery<{ id: number; label: string; value: string; createdAt: number }[]>({
    queryKey: [`/api/agents/${agentId}/memory`],
  });
  if (isLoading) return <div className="space-y-2 max-w-2xl"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>;
  if (notes.length === 0) return <EmptyState icon={Bot} title="No memory yet" description="This agent's own private notes will show up here as it learns things." />;
  return (
    <div className="space-y-2 max-w-2xl">
      {notes.map((n) => (
        <Card key={n.id} className="p-3">
          <div className="text-sm font-medium">{n.label}</div>
          <div className="text-sm text-muted-foreground mt-0.5">{n.value}</div>
          <div className="text-xs text-muted-foreground/70 mt-1.5">{timeAgo(n.createdAt)}</div>
        </Card>
      ))}
    </div>
  );
}
