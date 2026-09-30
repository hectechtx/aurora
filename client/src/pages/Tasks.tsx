import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
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
import { useVoice } from "@/lib/voice";
import { Plus, Send, Trash2, MessagesSquare, Sparkles, Volume2, VolumeX, X, ImageUp, File as FileIcon, Square, BrainCircuit, Archive } from "lucide-react";

interface TaskItem { id: number; title: string; status: string; createdAt: number; updatedAt: number; }
interface ChatMessage { id: number; role: string; content: string; toolCalls: string | null; createdAt: number; agentId: number | null; thinking: string | null; }
interface Creation { id: number; kind: string; prompt: string; filePath: string; createdAt: number; }
interface AgentItem { id: number; name: string; status: string; }
interface TaskAgentItem { id: number; taskId: number; agentId: number; agentName: string; createdAt: number; }

const ATTACHED_IMAGE_RE = /\n\n\[Attached image: "([^"]+)" — use your see_image tool[^\]]*\]$/;
const MAX_IMAGE_BYTES = 15_000_000;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
}

export default function Tasks() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voice = useVoice();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [input, setInput] = useState("");
  const [viewMode, setViewMode] = useState<"response" | "thinking">("response");
  const [attachedImage, setAttachedImage] = useState<Creation | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const spokenBaseline = useRef<Map<number, number>>(new Map());

  const { data: tasksList = [], isLoading: tasksLoading } = useQuery<TaskItem[]>({ queryKey: ["/api/tasks"], refetchInterval: 4000 });

  useEffect(() => {
    if (selectedId === null && tasksList.length > 0) setSelectedId(tasksList[0].id);
  }, [tasksList.length]);

  const createTask = useMutation({
    mutationFn: (title: string) => apiRequest("POST", "/api/tasks", { title }).then((r) => r.json()),
    onSuccess: (task: TaskItem) => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      setSelectedId(task.id);
      setNewTitle("");
    },
    onError: (err: Error) => toast({ title: "Couldn't create task", description: err.message, variant: "error" }),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/tasks/${id}`).then((r) => r.json()),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      if (selectedId === id) setSelectedId(null);
    },
    onError: (err: Error) => toast({ title: "Couldn't delete task", description: err.message, variant: "error" }),
  });

  const send = useMutation({
    mutationFn: ({ message, imageCreationId }: { message: string; imageCreationId?: number }) =>
      apiRequest("POST", `/api/tasks/${selectedId}/chat`, { message, imageCreationId }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/messages`] });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
    },
  });

  const uploadImage = useMutation({
    mutationFn: (dataUrl: string) => apiRequest("POST", "/api/creations/upload", { dataUrl }).then((r) => r.json()),
    onSuccess: (creation: Creation) => setAttachedImage(creation),
    onError: (err: Error) => toast({ title: "Couldn't attach image", description: err.message, variant: "error" }),
  });

  const { data: messages = [], isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: [`/api/tasks/${selectedId}/messages`],
    enabled: selectedId !== null,
    // Snappier while AURORA is actively working a turn, so tool calls show up
    // close to when they actually happen rather than in occasional jumps.
    // The turn itself runs server-side in the background, so this reads off
    // the last message's own state rather than the send request's status.
    refetchInterval: (query) => {
      const msgs = query.state.data;
      return isEntryInProgress(msgs?.[msgs.length - 1]) ? 1200 : 4000;
    },
  });

  const turnActive = isEntryInProgress(messages[messages.length - 1]);

  const stop = useMutation({
    mutationFn: () => apiRequest("POST", `/api/tasks/${selectedId}/stop`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/messages`] }),
    onError: (err: Error) => toast({ title: "Couldn't stop", description: err.message, variant: "error" }),
  });

  const clearChat = useMutation({
    mutationFn: (archive: boolean) => apiRequest("POST", `/api/tasks/${selectedId}/chat/clear`, { archive }).then((r) => r.json()),
    onSuccess: (_d, archive) => {
      qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/messages`] });
      toast({ title: archive ? "Chat archived to Memory & cleared" : "Chat cleared", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't clear chat", description: err.message, variant: "error" }),
  });

  const { data: allAgents = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"] });
  const { data: taskAgents = [] } = useQuery<TaskAgentItem[]>({
    queryKey: [`/api/tasks/${selectedId}/agents`],
    enabled: selectedId !== null,
  });
  const agentNameById = new Map(taskAgents.map((ta) => [ta.agentId, ta.agentName]));

  const assignAgent = useMutation({
    mutationFn: (agentId: number) => apiRequest("POST", `/api/tasks/${selectedId}/agents`, { agentId }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/agents`] }),
    onError: (err: Error) => toast({ title: "Couldn't add agent", description: err.message, variant: "error" }),
  });

  const unassignAgent = useMutation({
    mutationFn: (agentId: number) => apiRequest("DELETE", `/api/tasks/${selectedId}/agents/${agentId}`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/agents`] }),
    onError: (err: Error) => toast({ title: "Couldn't remove agent", description: err.message, variant: "error" }),
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // Speak newly-arrived assistant replies only — never replay a task's
  // existing history when you switch to it or when polling refetches.
  useEffect(() => {
    if (selectedId === null || messages.length === 0) return;
    const last = messages[messages.length - 1];
    const baseline = spokenBaseline.current.get(selectedId);
    if (baseline === undefined) {
      spokenBaseline.current.set(selectedId, last.id);
      return;
    }
    if (last.role === "assistant" && last.id > baseline && voice.enabled) {
      voice.speak(last.content);
    }
    spokenBaseline.current.set(selectedId, last.id);
  }, [messages, selectedId, voice.enabled]);

  function handleCreate() {
    const title = newTitle.trim();
    if (!title || createTask.isPending) return;
    createTask.mutate(title);
  }

  function handleSend() {
    const imageCreationId = attachedImage?.id;
    const filesBlock = formatAttachedFiles(attachedFiles);
    const baseText = input.trim() || (imageCreationId ? "What's in this image?" : filesBlock ? "Take a look at the attached file(s)." : "");
    const message = baseText + filesBlock;
    if (!message.trim() || selectedId === null || send.isPending) return;
    setInput("");
    setAttachedImage(null);
    setAttachedFiles([]);
    send.mutate({ message, imageCreationId });
  }

  const selectedTask = tasksList.find((t) => t.id === selectedId);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            placeholder="New task…"
            className="flex-1"
          />
          <Button variant="primary" size="icon" onClick={handleCreate} disabled={!newTitle.trim() || createTask.isPending}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {tasksLoading && (
            <div className="p-3 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          {!tasksLoading && tasksList.length === 0 && (
            <div className="p-6">
              <EmptyState icon={MessagesSquare} title="No tasks yet" description="Start one above to talk to AURORA." />
            </div>
          )}
          {tasksList.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(t.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(t.id); } }}
              className={cn(
                "group flex items-center justify-between gap-2 px-4 py-3 cursor-pointer border-b border-border-subtle text-sm transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                selectedId === t.id ? "bg-primary/10" : "hover:bg-surface",
              )}
            >
              <IdentityAvatar name={t.title} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={t.title}>{t.title}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <StatusBadge status={t.status} />
                  <span className="text-xs text-muted-foreground">{timeAgo(t.updatedAt)}</span>
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deleteTask.mutate(t.id); }}
                title="Delete task"
                aria-label="Delete task"
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-risk-high shrink-0 transition-opacity"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {selectedId === null ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState icon={Sparkles} title="Nothing selected" description="Create a task on the left to start talking to AURORA." />
          </div>
        ) : (
          <>
            <header className="border-b border-border px-6 py-4 flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <h1 className="text-base font-semibold truncate" title={selectedTask?.title}>{selectedTask?.title}</h1>
                {selectedTask && <StatusBadge status={selectedTask.status} />}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <TeamPicker
                  agents={allAgents}
                  assigned={taskAgents}
                  onAssign={(agentId) => assignAgent.mutate(agentId)}
                  onUnassign={(agentId) => unassignAgent.mutate(agentId)}
                  busy={assignAgent.isPending}
                />
                <button
                  onClick={() => {
                    const next = viewMode === "response" ? "thinking" : "response";
                    setViewMode(next);
                    toast({ title: `Switched transcript view to ${next === "thinking" ? "Thinking" : "Response"}`, variant: "default" });
                  }}
                  title={viewMode === "thinking" ? "Show the final responses" : "Show the model's raw reasoning"}
                  className={cn(
                    "flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1.5 transition-colors shrink-0",
                    viewMode === "thinking" ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <BrainCircuit size={13} /> Thinking
                </button>
              {messages.length > 0 && (
                <>
                  <button
                    onClick={() => clearChat.mutate(true)}
                    disabled={clearChat.isPending}
                    title="Save this chat to Memory, then clear it"
                    className="flex items-center gap-1.5 text-xs rounded-full border border-border px-2.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  >
                    <Archive size={13} /> Archive
                  </button>
                  <button
                    onClick={() => { if (confirm("Clear this chat without archiving? This can't be undone.")) clearChat.mutate(false); }}
                    disabled={clearChat.isPending}
                    title="Clear this chat without saving"
                    className="flex items-center gap-1.5 text-xs rounded-full border border-border px-2.5 py-1.5 text-muted-foreground hover:text-risk-high transition-colors shrink-0"
                  >
                    <Trash2 size={13} /> Clear
                  </button>
                </>
              )}
              {voice.supported && (
                <button
                  onClick={() => voice.setEnabled(!voice.enabled)}
                  title={voice.enabled ? "Mute voice replies" : "Enable voice replies"}
                  className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                >
                  {voice.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              )}
              </div>
            </header>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {messagesLoading && <Skeleton className="h-16 w-2/3" />}
              {!messagesLoading && messages.length === 0 && (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">Say hello to get started.</p>
                </div>
              )}
              {messages.map((m) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  agentName={m.agentId != null ? agentNameById.get(m.agentId) : undefined}
                  onSpeak={voice.supported ? () => voice.speak(m.content) : undefined}
                  viewMode={viewMode}
                />
              ))}
              {send.isPending && messages[messages.length - 1]?.role !== "assistant" && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <span className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
                  </span>
                </div>
              )}
            </div>
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
                  onTranscript={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
                  onError={(message) => toast({ title: "Couldn't hear that", description: message, variant: "error" })}
                />
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  onPaste={handlePaste}
                  placeholder="Message AURORA… (paste an image to attach it)"
                  rows={2}
                  className="flex-1"
                />
                {turnActive ? (
                  <Button
                    variant="destructive"
                    size="icon"
                    onClick={() => stop.mutate()}
                    disabled={stop.isPending}
                    className="self-end h-[38px]"
                    title="Stop"
                  >
                    <Square size={14} />
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="icon"
                    onClick={handleSend}
                    disabled={send.isPending || (!input.trim() && !attachedImage && attachedFiles.length === 0)}
                    className="self-end h-[38px]"
                  >
                    <Send size={16} />
                  </Button>
                )}
              </div>
              {send.isError && <div className="mt-2 text-xs text-risk-high">{(send.error as Error).message}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ message, agentName, onSpeak, viewMode = "response" }: {
  message: ChatMessage; agentName?: string; onSpeak?: () => void; viewMode?: "response" | "thinking";
}) {
  const isUser = message.role === "user";
  let toolCalls: ToolCallRecord[] = [];
  if (message.toolCalls) {
    try { toolCalls = JSON.parse(message.toolCalls); } catch { /* malformed, skip */ }
  }

  const imageMatch = message.content.match(ATTACHED_IMAGE_RE);
  const attachedFilename = imageMatch?.[1];
  const displayContent = imageMatch ? message.content.slice(0, imageMatch.index) : message.content;
  const showThinking = viewMode === "thinking" && !isUser;

  return (
    <div className={cn("group flex animate-in items-end gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (agentName ? <IdentityAvatar name={agentName} className="h-7 w-7 mb-1" /> : <AuroraAvatar className="h-7 w-7 mb-1" />)}
      {!isUser && onSpeak && !showThinking && (
        <button
          onClick={onSpeak}
          title="Read aloud"
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0 mb-1"
        >
          <Volume2 size={13} />
        </button>
      )}
      <div className={cn(
        "max-w-2xl rounded-xl px-4 py-2.5 text-sm leading-relaxed",
        isUser ? "bg-primary/15 rounded-tr-sm" : "bg-card border border-border rounded-tl-sm",
        showThinking && "border-dashed",
      )}>
        {!isUser && agentName && (
          <div className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</div>
        )}
        {showThinking ? (
          <div className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {message.thinking || "(no reasoning captured for this message — the model may not support it, or the turn is still running)"}
          </div>
        ) : (
          <>
            {attachedFilename && (
              <AuthedImage
                src={`/creations/${attachedFilename}`}
                alt="Attached"
                className="mb-2 max-h-48 rounded-md border border-border object-contain"
              />
            )}
            {displayContent && <div className="whitespace-pre-wrap">{linkify(displayContent)}</div>}
            {toolCalls.length > 0 && (
              <div className="mt-3 space-y-2 border-t border-border pt-2.5">
                {toolCalls.map((tc, i) => <ToolCallCard key={i} tc={tc} />)}
              </div>
            )}
          </>
        )}
        {!showThinking && !displayContent && toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
            </span>
          </div>
        )}
      </div>
      {isUser && <UserAvatar className="h-7 w-7 mb-1" />}
    </div>
  );
}

/** Assigns/removes persistent agents on the current task — assigning at least one turns the task into a shared thread (see runGroupRound in agent-loop.ts) where every assigned agent responds to each message, instead of the single default assistant. */
function TeamPicker({ agents, assigned, onAssign, onUnassign, busy }: {
  agents: AgentItem[];
  assigned: TaskAgentItem[];
  onAssign: (agentId: number) => void;
  onUnassign: (agentId: number) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const assignedIds = new Set(assigned.map((a) => a.agentId));
  const available = agents.filter((a) => !assignedIds.has(a.id));

  return (
    <div className="relative flex items-center gap-1.5" ref={rootRef}>
      {assigned.map((a) => (
        <div key={a.agentId} className="flex items-center gap-1 rounded-full bg-surface border border-border pl-1 pr-1.5 py-0.5">
          <IdentityAvatar name={a.agentName} className="h-5 w-5 text-[10px]" />
          <span className="text-xs">{a.agentName}</span>
          <button
            onClick={() => onUnassign(a.agentId)}
            title={`Remove ${a.agentName} from this task`}
            aria-label={`Remove ${a.agentName} from this task`}
            className="text-muted-foreground hover:text-risk-high"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Add an agent to this task"
        aria-label="Add an agent to this task"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center justify-center h-6 w-6 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
      >
        <Plus size={12} />
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 mt-2 w-56 rounded-lg border border-border bg-card shadow-panel py-1.5 z-20">
          {available.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {agents.length === 0 ? "No agents yet — create one on the Agents page." : "All agents are already on this task."}
            </div>
          )}
          {available.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              disabled={busy}
              onClick={() => { onAssign(a.id); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface transition-colors disabled:opacity-50"
            >
              <IdentityAvatar name={a.name} className="h-6 w-6 text-[10px]" /> {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
