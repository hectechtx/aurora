import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { AuroraAvatar, UserAvatar, IdentityAvatar } from "@/components/ui/Avatar";
import { cn, timeAgo } from "@/lib/utils";
import { Bot, Plus, Play, Pause, Trash2, Send, CornerDownRight } from "lucide-react";

interface AgentItem {
  id: number; name: string; persona: string; jobDescription: string; status: string;
  scheduleMinutes: number | null; lastRunAt: number | null; createdAt: number; updatedAt: number;
}
interface AgentLogEntry { id: number; role: string; content: string; toolCalls: string | null; createdAt: number; }
interface QueueItem {
  id: number; content: string; status: string; createdAt: number; doneAt: number | null;
  sourceAgentName: string | null;
}
interface ToolCallRecord { name: string; args: Record<string, unknown>; risk: string; status: string; result: string; }

const SCHEDULE_OPTIONS = [
  { label: "Manual only", value: "" },
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
              <IdentityAvatar name={a.name} className="h-8 w-8" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={a.name}>{a.name}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-muted-foreground">
                    {a.scheduleMinutes ? `every ${a.scheduleMinutes}m` : "manual"}
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
        <p className="text-xs text-muted-foreground/70">Manual-only agents run when you hit "Run now" instead of on their own.</p>
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
  const [tab, setTab] = useState<"queue" | "activity" | "memory">("queue");
  const [suggestion, setSuggestion] = useState("");

  const toggleStatus = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/agents/${agent.id}`, { status: agent.status === "active" ? "paused" : "active" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/agents"] }),
    onError: (err: Error) => toast({ title: "Couldn't update agent", description: err.message, variant: "error" }),
  });

  const runNow = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agents/${agent.id}/run`).then((r) => r.json()),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/queue`] });
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/log`] });
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      if (result.skipped) toast({ title: "Nothing to do", description: result.skipped, variant: "default" });
      else toast({ title: "Ran a turn", description: result.status === "awaiting_approval" ? "Waiting on your approval." : "Check Activity for what it did.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Run failed", description: err.message, variant: "error" }),
  });

  const addSuggestion = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agents/${agent.id}/queue`, { content: suggestion }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/agents/${agent.id}/queue`] });
      setSuggestion("");
    },
    onError: (err: Error) => toast({ title: "Couldn't add to queue", description: err.message, variant: "error" }),
  });

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-6 py-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold truncate" title={agent.name}>{agent.name}</h1>
            <StatusBadge status={agent.status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 max-w-xl" title={agent.jobDescription}>{agent.jobDescription}</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {agent.scheduleMinutes ? `Checks its queue every ${agent.scheduleMinutes} min` : "Manual only"}
            {agent.lastRunAt ? ` · last ran ${timeAgo(agent.lastRunAt)}` : " · hasn't run yet"}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Play size={13} /> Run now
          </Button>
          <Button variant="outline" size="sm" onClick={() => toggleStatus.mutate()} disabled={toggleStatus.isPending}>
            {agent.status === "active" ? <><Pause size={13} /> Pause</> : <><Play size={13} /> Resume</>}
          </Button>
        </div>
      </header>

      <div className="border-b border-border px-6">
        <div className="flex gap-1" role="tablist">
          {(["queue", "activity", "memory"] as const).map((t) => (
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

      <div className="flex-1 overflow-y-auto p-6" role="tabpanel">
        {tab === "queue" && (
          <div className="space-y-4 max-w-2xl">
            <div className="flex gap-2">
              <Input
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && suggestion.trim()) addSuggestion.mutate(); }}
                placeholder="Give it something to do…"
                className="flex-1"
              />
              <Button variant="primary" size="icon" onClick={() => addSuggestion.mutate()} disabled={!suggestion.trim() || addSuggestion.isPending}>
                <Send size={15} />
              </Button>
            </div>
            <QueueList agentId={agent.id} />
          </div>
        )}
        {tab === "activity" && <ActivityFeed agentId={agent.id} />}
        {tab === "memory" && <AgentMemory agentId={agent.id} />}
      </div>
    </div>
  );
}

function QueueList({ agentId }: { agentId: number }) {
  const { data: queue = [], isLoading } = useQuery<QueueItem[]>({ queryKey: [`/api/agents/${agentId}/queue`], refetchInterval: 4000 });
  if (isLoading) return <div className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>;
  if (queue.length === 0) return <EmptyState icon={Bot} title="Queue is empty" description="Add something above for it to work on." />;
  return (
    <div className="space-y-2">
      {queue.map((q) => (
        <Card key={q.id} className="p-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {q.sourceAgentName && (
              <div className="flex items-center gap-1 text-xs text-accent mb-1">
                <CornerDownRight size={12} /> handed off from {q.sourceAgentName}
              </div>
            )}
            <p className="text-sm">{q.content}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={q.status} />
            <span className="text-xs text-muted-foreground">{timeAgo(q.createdAt)}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ActivityFeed({ agentId }: { agentId: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: log = [], isLoading } = useQuery<AgentLogEntry[]>({ queryKey: [`/api/agents/${agentId}/log`], refetchInterval: 4000 });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [log.length]);

  if (isLoading) return <Skeleton className="h-16 w-2/3" />;
  if (log.length === 0) return <EmptyState icon={Bot} title="No activity yet" description="Once it works through something in its queue, you'll see it here." />;

  return (
    <div ref={scrollRef} className="space-y-4 max-w-2xl">
      {log.map((entry) => {
        const isUser = entry.role === "user";
        let toolCalls: ToolCallRecord[] = [];
        if (entry.toolCalls) {
          try { toolCalls = JSON.parse(entry.toolCalls); } catch { /* skip malformed */ }
        }
        return (
          <div key={entry.id} className={cn("flex animate-in items-end gap-2", isUser ? "justify-end" : "justify-start")}>
            {!isUser && <AuroraAvatar className="h-7 w-7 mb-1" />}
            <div className={cn(
              "max-w-lg rounded-xl px-4 py-2.5 text-sm leading-relaxed",
              isUser ? "bg-primary/15 rounded-tr-sm" : "bg-card border border-border rounded-tl-sm",
            )}>
              <div className="whitespace-pre-wrap">{entry.content}</div>
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
              <div className="text-[11px] text-muted-foreground/70 mt-1.5">{timeAgo(entry.createdAt)}</div>
            </div>
            {isUser && <UserAvatar className="h-7 w-7 mb-1" />}
          </div>
        );
      })}
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
