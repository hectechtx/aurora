import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { timeAgo, cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/Badge";
import { IdentityAvatar, AuroraAvatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { Trash2, Search, BrainCircuit, MessagesSquare } from "lucide-react";

interface Note { id: number; label: string; value: string; createdAt: number; }
interface AgentItem { id: number; name: string; }
interface AgentConversationItem {
  id: number; agentId: number; sourceAgentId: number | null; content: string; status: string;
  createdAt: number; sourceAgentName: string; targetAgentName: string;
}

// "aurora" = the shared/global notes (agentId null); a positive number = that agent's own notes; "conversations" = agent-to-agent archive.
type Scope = "aurora" | number | "conversations";

export default function Memory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("aurora");

  const { data: agentsList = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"] });

  const notesUrl = scope === "conversations"
    ? null
    : scope === "aurora"
      ? `/api/notes?q=${encodeURIComponent(query)}`
      : `/api/agents/${scope}/memory?q=${encodeURIComponent(query)}`;

  const { data: notes = [], isLoading: notesLoading } = useQuery<Note[]>({
    queryKey: [notesUrl ?? "__none__"],
    enabled: notesUrl !== null,
  });

  const { data: conversations = [], isLoading: conversationsLoading } = useQuery<AgentConversationItem[]>({
    queryKey: ["/api/agents/conversations"],
    enabled: scope === "conversations",
    refetchInterval: 15_000,
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/notes/${id}`).then((r) => r.json()),
    onSuccess: () => {
      if (notesUrl) qc.invalidateQueries({ queryKey: [notesUrl] });
      toast({ title: "Note deleted", variant: "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete note", description: err.message, variant: "error" }),
  });

  const filteredConversations = query.trim()
    ? conversations.filter((c) => c.content.toLowerCase().includes(query.trim().toLowerCase()))
    : conversations;

  return (
    <div className="p-8 max-w-3xl mx-auto overflow-y-auto h-screen">
      <PageHeader
        title="Memory"
        description="What AURORA and each agent remember, plus every conversation your agents have had with each other."
      />

      <div className="flex flex-wrap gap-1.5 mb-4">
        <button
          onClick={() => setScope("aurora")}
          className={cn(
            "flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1.5 transition-colors",
            scope === "aurora" ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <AuroraAvatar className="h-3.5 w-3.5" /> AURORA
        </button>
        {agentsList.map((a) => (
          <button
            key={a.id}
            onClick={() => setScope(a.id)}
            className={cn(
              "flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1.5 transition-colors",
              scope === a.id ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <IdentityAvatar name={a.name} className="h-3.5 w-3.5 text-[9px]" /> {a.name}
          </button>
        ))}
        <button
          onClick={() => setScope("conversations")}
          className={cn(
            "flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1.5 transition-colors",
            scope === "conversations" ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <MessagesSquare size={13} /> Agent conversations
        </button>
      </div>

      <div className="relative mb-5">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={scope === "conversations" ? "Search conversations…" : "Search notes…"}
          className="pl-9"
        />
      </div>

      {scope !== "conversations" && (
        <>
          {notesLoading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {!notesLoading && notes.length === 0 && (
            <EmptyState
              icon={BrainCircuit}
              title={query ? "No matches" : "No notes yet"}
              description={
                query
                  ? "Try a different search term."
                  : scope === "aurora"
                    ? "AURORA will save notes here as it learns things about you, shared across every task."
                    : "This agent's own private notes will show up here as it learns things."
              }
            />
          )}

          <div className="space-y-2">
            {notes.map((n) => (
              <Card key={n.id} className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{n.label}</div>
                  <div className="text-sm text-muted-foreground mt-1 leading-relaxed">{n.value}</div>
                  <div className="text-xs text-muted-foreground/70 mt-2">{timeAgo(n.createdAt)}</div>
                </div>
                <button
                  onClick={() => remove.mutate(n.id)}
                  title="Delete note"
                  aria-label="Delete note"
                  className="text-muted-foreground hover:text-risk-high shrink-0 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </Card>
            ))}
          </div>
        </>
      )}

      {scope === "conversations" && (
        <>
          {conversationsLoading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {!conversationsLoading && filteredConversations.length === 0 && (
            <EmptyState
              icon={MessagesSquare}
              title={query ? "No matches" : "No agent-to-agent messages yet"}
              description={query ? "Try a different search term." : "Handoffs and messages your agents send each other will show up here."}
            />
          )}

          <div className="space-y-2">
            {filteredConversations.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{c.sourceAgentName} → {c.targetAgentName}</span>
                  <StatusBadge status={c.status} />
                </div>
                <p className="text-sm text-muted-foreground mt-1.5 whitespace-pre-wrap leading-relaxed">{c.content}</p>
                <p className="text-xs text-muted-foreground/70 mt-2">{timeAgo(c.createdAt)}</p>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
