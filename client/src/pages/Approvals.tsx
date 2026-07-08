import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn, timeAgo } from "@/lib/utils";
import { ShieldCheck } from "lucide-react";

interface Approval {
  id: number; taskId: number | null; action: string; detail: string; risk: string; status: string;
  targetType: string; targetId: number | null; createdAt: number; decidedAt: number | null;
}

export default function Approvals() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: approvals = [], isLoading } = useQuery<Approval[]>({ queryKey: ["/api/approvals"], refetchInterval: 4000 });

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "approved" | "denied" }) =>
      apiRequest("POST", `/api/approvals/${id}/decide`, { status }).then((r) => r.json()),
    onSuccess: (_data, { status }) => {
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      qc.invalidateQueries({ queryKey: ["/api/agents"] });
      qc.invalidateQueries({ queryKey: ["/api/audit"] });
      toast({ title: status === "approved" ? "Approved" : "Denied", variant: status === "approved" ? "success" : "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't record decision", description: err.message, variant: "error" }),
  });

  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 overflow-y-auto h-screen">
      <PageHeader title="Approvals" description="High-risk tool calls and skill installs wait here until you decide." />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Pending ({pending.length})</h2>
        {!isLoading && pending.length === 0 && <EmptyState icon={ShieldCheck} title="All clear" description="Nothing is waiting on your decision." />}
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecide={(status) => decide.mutate({ id: a.id, status })} pending={decide.isPending} emphasize />
        ))}
      </section>

      {decided.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">History</h2>
          {decided.map((a) => <ApprovalCard key={a.id} approval={a} />)}
        </section>
      )}
    </div>
  );
}

const RISK_BORDER: Record<string, string> = {
  high: "border-l-risk-high",
  medium: "border-l-risk-medium",
  low: "border-l-risk-low",
};

interface ApprovalDetail {
  context?: { type?: string; agentId?: number };
  call?: { args: Record<string, unknown> };
  manifest?: { description?: string; tools?: { name: string }[] };
  files?: unknown[];
  totalSize?: number;
}

function ApprovalCard({ approval, onDecide, pending, emphasize }: { approval: Approval; onDecide?: (status: "approved" | "denied") => void; pending?: boolean; emphasize?: boolean }) {
  let detail: ApprovalDetail = {};
  try { detail = JSON.parse(approval.detail); } catch { /* ignore */ }

  return (
    <Card className={cn("p-4", emphasize ? cn("border-l-4", RISK_BORDER[approval.risk]) : "opacity-80")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm font-mono">{approval.action}</span>
            <RiskBadge risk={approval.risk} />
            <StatusBadge status={approval.status} />
          </div>
          <div className="text-xs text-muted-foreground mt-1.5">
            {approval.targetType.replace("_", " ")}
            {detail.context?.type === "agent" ? ` · agent #${detail.context.agentId}` : approval.taskId ? ` · task #${approval.taskId}` : ""}
            {" · "}{timeAgo(approval.createdAt)}
          </div>

          {approval.targetType === "tool_call" && detail.call && (
            <pre className="mt-2.5 rounded-md bg-surface border border-border p-2.5 text-xs overflow-x-auto max-w-xl font-mono text-muted-foreground">
              {JSON.stringify(detail.call.args, null, 2)}
            </pre>
          )}

          {approval.targetType === "skill_install" && detail.manifest && (
            <div className="mt-2.5 text-xs space-y-1.5">
              <div className="text-muted-foreground">{detail.manifest.description}</div>
              <div className="text-muted-foreground/70">{detail.files?.length ?? 0} files, {Math.ceil((detail.totalSize ?? 0) / 1024)} KB total</div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {detail.manifest.tools?.map((t) => (
                  <span key={t.name} className="rounded-full border border-border px-2.5 py-1 text-muted-foreground font-mono">{t.name}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {onDecide && (
          <div className="flex gap-2 shrink-0">
            <Button variant="destructive" size="sm" disabled={pending} onClick={() => onDecide("denied")}>Deny</Button>
            <Button variant="primary" size="sm" disabled={pending} onClick={() => onDecide("approved")}>Approve</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
