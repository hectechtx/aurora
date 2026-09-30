import { Loader2, CheckCircle2, Circle } from "lucide-react";
import { RiskBadge, StatusBadge } from "./Badge";
import { linkify } from "@/lib/linkify";

export interface ToolCallRecord { name: string; args: Record<string, unknown>; risk: string; status: string; result: string; }

/** set_plan calls render as a live checklist instead of a raw tool card — the whole point of the tool is an at-a-glance "where is it and what's left", which a JSON blob doesn't give. */
function PlanChecklist({ tc }: { tc: ToolCallRecord }) {
  const steps = Array.isArray(tc.args.steps) ? tc.args.steps.map(String) : [];
  const done = new Set(Array.isArray(tc.args.done) ? tc.args.done.map(Number) : []);
  if (steps.length === 0) return null;
  return (
    <div className="rounded-md border border-border-subtle bg-surface/50 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 mb-1.5">Plan</div>
      <ul className="space-y-1">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {done.has(i)
              ? <CheckCircle2 size={13} className="text-risk-low shrink-0 mt-0.5" />
              : <Circle size={13} className="text-muted-foreground/50 shrink-0 mt-0.5" />}
            <span className={done.has(i) ? "text-muted-foreground line-through" : "text-foreground/90"}>{step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Full (never truncated) view of one tool call — name, risk/status, and the complete result with links live, so "what did it actually do" is never hidden behind a hover tooltip. Shared by Tasks' chat and Agents' activity feed since both render the same transcript shape. */
export function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
  if (tc.name === "set_plan") return <PlanChecklist tc={tc} />;
  const running = tc.status === "pending";
  return (
    <div className="rounded-md border border-border-subtle bg-surface/50 px-2.5 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        {running && <Loader2 size={11} className="animate-spin text-muted-foreground shrink-0" />}
        <code className="text-accent font-mono text-xs">{tc.name}</code>
        <RiskBadge risk={tc.risk} />
        <StatusBadge status={tc.status} />
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed">
        {linkify(tc.result)}
      </div>
    </div>
  );
}
