import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { AuroraAvatar, UserAvatar, IdentityAvatar } from "@/components/ui/Avatar";
import { cn, timeAgo } from "@/lib/utils";
import { useVoice } from "@/lib/voice";
import { Plus, Send, Trash2, MessagesSquare, Sparkles, Volume2, VolumeX } from "lucide-react";

interface TaskItem { id: number; title: string; status: string; createdAt: number; updatedAt: number; }
interface ChatMessage { id: number; role: string; content: string; toolCalls: string | null; createdAt: number; }
interface ToolCallRecord { name: string; args: Record<string, unknown>; risk: string; status: string; result: string; }

export default function Tasks() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const voice = useVoice();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const spokenBaseline = useRef<Map<number, number>>(new Map());

  const { data: tasksList = [], isLoading: tasksLoading } = useQuery<TaskItem[]>({ queryKey: ["/api/tasks"], refetchInterval: 4000 });

  useEffect(() => {
    if (selectedId === null && tasksList.length > 0) setSelectedId(tasksList[0].id);
  }, [tasksList.length]);

  const { data: messages = [], isLoading: messagesLoading } = useQuery<ChatMessage[]>({
    queryKey: [`/api/tasks/${selectedId}/messages`],
    enabled: selectedId !== null,
    refetchInterval: 4000,
  });

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
    mutationFn: (message: string) => apiRequest("POST", `/api/tasks/${selectedId}/chat`, { message }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/tasks/${selectedId}/messages`] });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
    },
  });

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
    const message = input.trim();
    if (!message || selectedId === null || send.isPending) return;
    setInput("");
    send.mutate(message);
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
              {voice.supported && (
                <button
                  onClick={() => voice.setEnabled(!voice.enabled)}
                  title={voice.enabled ? "Mute voice replies" : "Enable voice replies"}
                  className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                >
                  {voice.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              )}
            </header>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {messagesLoading && <Skeleton className="h-16 w-2/3" />}
              {!messagesLoading && messages.length === 0 && (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-muted-foreground">Say hello to get started.</p>
                </div>
              )}
              {messages.map((m) => <ChatBubble key={m.id} message={m} onSpeak={voice.supported ? () => voice.speak(m.content) : undefined} />)}
              {send.isPending && (
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
              <div className="flex gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Message AURORA…"
                  rows={2}
                  className="flex-1"
                />
                <Button variant="primary" size="icon" onClick={handleSend} disabled={send.isPending || !input.trim()} className="self-end h-[38px]">
                  <Send size={16} />
                </Button>
              </div>
              {send.isError && <div className="mt-2 text-xs text-risk-high">{(send.error as Error).message}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ message, onSpeak }: { message: ChatMessage; onSpeak?: () => void }) {
  const isUser = message.role === "user";
  let toolCalls: ToolCallRecord[] = [];
  if (message.toolCalls) {
    try { toolCalls = JSON.parse(message.toolCalls); } catch { /* malformed, skip */ }
  }

  return (
    <div className={cn("group flex animate-in items-end gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && <AuroraAvatar className="h-7 w-7 mb-1" />}
      {!isUser && onSpeak && (
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
      )}>
        <div className="whitespace-pre-wrap">{message.content}</div>
        {toolCalls.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-border pt-2.5">
            {toolCalls.map((tc, i) => (
              <div key={i} className="text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-accent font-mono">{tc.name}</code>
                  <RiskBadge risk={tc.risk} />
                  <StatusBadge status={tc.status} />
                </div>
                <div className="mt-1 text-muted-foreground truncate" title={tc.result}>{tc.result}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {isUser && <UserAvatar className="h-7 w-7 mb-1" />}
    </div>
  );
}
