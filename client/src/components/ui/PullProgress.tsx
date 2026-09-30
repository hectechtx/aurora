import type { PullStatus } from "@/lib/usePullModel";

export function PullProgress({ status }: { status: PullStatus }) {
  const pct = status.total ? Math.min(100, Math.round(((status.completed ?? 0) / status.total) * 100)) : null;
  return (
    <div className="mt-2.5 space-y-1">
      <div className="text-xs text-muted-foreground">
        {status.status}
        {pct !== null ? ` — ${pct}%` : ""}
      </div>
      {pct !== null && (
        <div className="h-1 w-full rounded-full bg-surface overflow-hidden">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
