import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { timeAgo } from "@/lib/utils";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { Inbox, Copy, Check, Archive, HelpCircle, Send } from "lucide-react";

// Keep in sync with OWNER_QUESTION_TAG in server/agent-loop.ts.
const OWNER_QUESTION_TAG = "owner-question";
function hasTag(d: { tags: string }, tag: string): boolean {
  try { return (JSON.parse(d.tags) as string[]).includes(tag); } catch { return false; }
}

interface Deliverable {
  id: number; agentId: number; title: string; description: string; tags: string; body: string;
  creationId: number | null; status: string; createdAt: number;
}
interface AgentItem { id: number; name: string; }
interface Creation { id: number; filePath: string; }

export default function Outbox() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: deliverables = [], isLoading } = useQuery<Deliverable[]>({ queryKey: ["/api/deliverables"], refetchInterval: 5000 });
  const { data: agentsList = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"] });
  const { data: creationsList = [] } = useQuery<Creation[]>({ queryKey: ["/api/creations"] });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "posted" | "archived" }) =>
      apiRequest("PATCH", `/api/deliverables/${id}`, { status }).then((r) => r.json()),
    onSuccess: (_data, { status }) => {
      qc.invalidateQueries({ queryKey: ["/api/deliverables"] });
      toast({ title: status === "posted" ? "Marked as posted" : "Archived", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't update deliverable", description: err.message, variant: "error" }),
  });

  function agentName(agentId: number): string {
    return agentsList.find((a) => a.id === agentId)?.name ?? `agent #${agentId}`;
  }

  function copyAll(d: Deliverable) {
    let tags: string[] = [];
    try { tags = JSON.parse(d.tags); } catch { /* ignore */ }
    const text = `${d.title}\n\n${d.description}\n\n${d.body}\n\n${tags.map((t) => `#${t}`).join(" ")}`;
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard", variant: "success" });
  }

  const answer = useMutation({
    mutationFn: ({ id, answer }: { id: number; answer: string }) =>
      apiRequest("POST", `/api/deliverables/${id}/answer`, { answer }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deliverables"] });
      toast({ title: "Answer sent to the agent", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't send answer", description: err.message, variant: "error" }),
  });

  const questions = deliverables.filter((d) => d.status === "ready" && hasTag(d, OWNER_QUESTION_TAG));
  const ready = deliverables.filter((d) => d.status === "ready" && !hasTag(d, OWNER_QUESTION_TAG));
  const other = deliverables.filter((d) => d.status !== "ready");

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 overflow-y-auto h-screen">
      <PageHeader title="Outbox" description="Finished content your agents have produced, plus any questions they have for you. Nothing here ever gets posted automatically." />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {questions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <HelpCircle size={13} /> Questions for you ({questions.length})
          </h2>
          {questions.map((d) => (
            <QuestionCard
              key={d.id}
              deliverable={d}
              agentName={agentName(d.agentId)}
              onAnswer={(text) => answer.mutate({ id: d.id, answer: text })}
              pending={answer.isPending}
            />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Ready ({ready.length})</h2>
        {!isLoading && ready.length === 0 && (
          <EmptyState icon={Inbox} title="Nothing ready yet" description="Ask an agent to save a deliverable and it'll show up here for review." />
        )}
        {ready.map((d) => (
          <DeliverableCard
            key={d.id}
            deliverable={d}
            agentName={agentName(d.agentId)}
            creation={creationsList.find((c) => c.id === d.creationId)}
            onCopy={() => copyAll(d)}
            onPosted={() => updateStatus.mutate({ id: d.id, status: "posted" })}
            onArchive={() => updateStatus.mutate({ id: d.id, status: "archived" })}
          />
        ))}
      </section>

      {other.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">History</h2>
          {other.map((d) => (
            <DeliverableCard
              key={d.id}
              deliverable={d}
              agentName={agentName(d.agentId)}
              creation={creationsList.find((c) => c.id === d.creationId)}
              onCopy={() => copyAll(d)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function QuestionCard({ deliverable, agentName, onAnswer, pending }: {
  deliverable: Deliverable; agentName: string; onAnswer: (text: string) => void; pending: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <Card className="p-4 border-primary/30 bg-primary/5">
      <div className="flex gap-3">
        <IdentityAvatar name={agentName} className="h-8 w-8 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{agentName} asks · {timeAgo(deliverable.createdAt)}</p>
          <p className="text-sm mt-1.5 whitespace-pre-wrap">{deliverable.body}</p>
          <div className="mt-3 flex gap-2 items-end">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) onAnswer(text.trim()); } }}
              placeholder="Type your answer… (it goes straight to the agent)"
              rows={2}
              className="flex-1"
            />
            <Button
              variant="primary"
              size="icon"
              className="self-end h-[38px]"
              disabled={pending || !text.trim()}
              onClick={() => { if (text.trim()) onAnswer(text.trim()); }}
            >
              <Send size={15} />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DeliverableCard({ deliverable, agentName, creation, onCopy, onPosted, onArchive }: {
  deliverable: Deliverable; agentName: string; creation?: Creation;
  onCopy: () => void; onPosted?: () => void; onArchive?: () => void;
}) {
  let tags: string[] = [];
  try { tags = JSON.parse(deliverable.tags); } catch { /* ignore */ }

  return (
    <Card className="p-4">
      <div className="flex gap-4">
        {creation && (
          <AuthedImage src={`/creations/${creation.filePath}`} alt="" className="w-24 h-24 rounded-md object-cover border border-border shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-sm">{deliverable.title}</h3>
            <StatusBadge status={deliverable.status} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{agentName} · {timeAgo(deliverable.createdAt)}</p>
          {deliverable.description && <p className="text-sm text-muted-foreground mt-2">{deliverable.description}</p>}
          {deliverable.body && <p className="text-sm mt-2 whitespace-pre-wrap line-clamp-4">{deliverable.body}</p>}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {tags.map((t) => <span key={t} className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground">#{t}</span>)}
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <Button variant="outline" size="sm" onClick={onCopy}><Copy size={12} /> Copy</Button>
            {onPosted && <Button variant="outline" size="sm" onClick={onPosted}><Check size={12} /> Mark posted</Button>}
            {onArchive && <Button variant="ghost" size="sm" onClick={onArchive}><Archive size={12} /> Archive</Button>}
          </div>
        </div>
      </div>
    </Card>
  );
}
