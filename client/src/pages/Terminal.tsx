import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea, Select } from "@/components/ui/Input";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { timeAgo } from "@/lib/utils";
import { SquareTerminal, Play } from "lucide-react";

interface Approval {
  id: number; action: string; detail: string; risk: string; status: string;
  targetType: string; createdAt: number; decidedAt: number | null;
}

interface ExecResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number; }

const PRESETS: { label: string; mode: "shell" | "node" | "python"; code: string }[] = [
  { label: "List files", mode: "shell", code: "dir" },
  { label: "Git status", mode: "shell", code: "git status" },
  { label: "npm install", mode: "shell", code: "npm install" },
  { label: "npm run build", mode: "shell", code: "npm run build" },
  { label: "npm test", mode: "shell", code: "npm test" },
  { label: "Node version", mode: "shell", code: "node -v" },
];

export default function Terminal() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<"shell" | "node" | "python">("shell");
  const [code, setCode] = useState("");
  const [results, setResults] = useState<Record<number, ExecResult>>({});

  const { data: approvals = [], isLoading } = useQuery<Approval[]>({ queryKey: ["/api/approvals"], refetchInterval: 3000 });
  const terminalApprovals = approvals.filter((a) => a.targetType === "terminal_request");
  const pending = terminalApprovals.filter((a) => a.status === "pending");
  const history = terminalApprovals.filter((a) => a.status !== "pending");

  const request = useMutation({
    mutationFn: () => apiRequest("POST", "/api/terminal/request", { mode, code }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      setCode("");
      toast({ title: "Waiting for your approval", description: "Review it below before it runs.", variant: "default" });
    },
    onError: (err: Error) => toast({ title: "Request failed", description: err.message, variant: "error" }),
  });

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "approved" | "denied" }) =>
      apiRequest("POST", `/api/approvals/${id}/decide`, { status }).then((r) => r.json()),
    onSuccess: (data, { id, status }) => {
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      qc.invalidateQueries({ queryKey: ["/api/audit"] });
      if (data.result) setResults((prev) => ({ ...prev, [id]: data.result }));
      toast({ title: status === "approved" ? "Executed" : "Denied", variant: status === "approved" ? "success" : "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't record decision", description: err.message, variant: "error" }),
  });

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader
        title="Terminal"
        description="Compose a shell/Node/Python command. It still needs your explicit approval before it runs, same as when the vessel proposes one mid-conversation."
      />

      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="w-32">
            <option value="shell">Shell</option>
            <option value="node">Node.js</option>
            <option value="python">Python</option>
          </Select>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => { setMode(p.mode); setCode(p.code); }}
                className="text-xs rounded-full border border-border px-2.5 py-1 text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <Textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={mode === "shell" ? "dir" : mode === "node" ? "console.log('hello')" : "print('hello')"}
          rows={4}
          className="font-mono"
        />
        <Button variant="primary" onClick={() => request.mutate()} disabled={!code.trim() || request.isPending}>
          <Play size={14} /> Request execution
        </Button>
      </Card>

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">Awaiting your approval</h2>
          {pending.map((a) => (
            <ApprovalRow key={a.id} approval={a} result={results[a.id]} onDecide={(status) => decide.mutate({ id: a.id, status })} pending={decide.isPending} />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">History</h2>
        {isLoading && <Skeleton className="h-16 w-full" />}
        {!isLoading && history.length === 0 && <EmptyState icon={SquareTerminal} title="No commands run yet" description="Compose one above to get started." />}
        {history.map((a) => (
          <ApprovalRow key={a.id} approval={a} result={results[a.id]} />
        ))}
      </section>
    </div>
  );
}

function ApprovalRow({ approval, result, onDecide, pending }: {
  approval: Approval; result?: ExecResult; onDecide?: (status: "approved" | "denied") => void; pending?: boolean;
}) {
  let detail: { mode: string; code: string } = { mode: "shell", code: "" };
  try { detail = JSON.parse(approval.detail); } catch { /* ignore */ }

  return (
    <Card className={approval.status === "pending" ? "p-4 border-l-4 border-l-risk-high" : "p-4 opacity-80"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <RiskBadge risk={approval.risk} />
            <StatusBadge status={approval.status} />
            <span className="text-xs text-muted-foreground uppercase font-mono">{detail.mode}</span>
            <span className="text-xs text-muted-foreground">· {timeAgo(approval.createdAt)}</span>
          </div>
          <pre className="mt-2.5 rounded-md bg-surface border border-border p-2.5 text-xs overflow-x-auto font-mono text-foreground/90">{detail.code}</pre>
          {result && (
            <pre className="mt-2 rounded-md bg-background border border-border p-2.5 text-xs overflow-x-auto font-mono text-muted-foreground whitespace-pre-wrap">
              {`exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`}
              {result.stdout ? `\n${result.stdout}` : ""}
              {result.stderr ? `\nstderr:\n${result.stderr}` : ""}
            </pre>
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
