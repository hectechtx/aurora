import { cn } from "@/lib/utils";

const tone = {
  low: "text-risk-low border-risk-low/30 bg-risk-low/10",
  medium: "text-risk-medium border-risk-medium/30 bg-risk-medium/10",
  high: "text-risk-high border-risk-high/30 bg-risk-high/10",
  neutral: "text-muted-foreground border-border bg-surface",
} as const;

function toneFor(value: string): keyof typeof tone {
  if (value === "high" || value === "denied" || value === "error" || value === "disabled") return "high";
  if (value === "medium" || value === "pending" || value === "pending_review" || value === "awaiting_approval") return "medium";
  if (value === "low" || value === "ok" || value === "enabled" || value === "approved" || value === "active" || value === "done" || value === "success") return "low";
  return "neutral";
}

export function RiskBadge({ risk }: { risk: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", tone[toneFor(risk)])}>
      {risk}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize", tone[toneFor(status)])}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
