import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { apiRequest } from "@/lib/queryClient";
import { timeAgo, cn } from "@/lib/utils";
import { Brain, X } from "lucide-react";

interface Knowledge { id: number; at: number; kind: "fact" | "lesson" | "team"; text: string; source: string; uses: number }
interface Thought { id: number; agentId: number; at: number; kind: "thought" | "memory" | "gossip"; text: string }
interface MindData { status: { lastAt: number | null; running: boolean; counts: Record<string, number> }; knowledge: Knowledge[]; thoughts: Thought[] }
interface Member { id: number; name: string; avatarPath: string | null }

const KIND: Record<Knowledge["kind"], { icon: string; label: string }> = {
  fact: { icon: "📌", label: "Fact" }, lesson: { icon: "💡", label: "Lesson" }, team: { icon: "👥", label: "Team" },
};

/** What AURORA has learned (and keeps learning), plus the team's latest inner life. */
export function AuroraMind() {
  const qc = useQueryClient();
  const { data } = useQuery<MindData>({ queryKey: ["/api/mind"], refetchInterval: 30_000 });
  const { data: team } = useQuery<{ members: Member[] }>({ queryKey: ["/api/team"], refetchInterval: 10_000 });
  const [filter, setFilter] = useState<"all" | Knowledge["kind"]>("all");
  const [busy, setBusy] = useState(false);
  const byId = new Map((team?.members ?? []).map((m) => [m.id, m] as const));
  const counts = data?.status.counts ?? {};
  const total = (counts.fact ?? 0) + (counts.lesson ?? 0) + (counts.team ?? 0);
  const items = (data?.knowledge ?? []).filter((k) => filter === "all" || k.kind === filter);

  async function reflectNow() {
    setBusy(true);
    try { await apiRequest("POST", "/api/mind/reflect"); } finally { setBusy(false); void qc.invalidateQueries({ queryKey: ["/api/mind"] }); }
  }
  async function forget(id: number) {
    await apiRequest("DELETE", `/api/mind/knowledge/${id}`).catch(() => {});
    void qc.invalidateQueries({ queryKey: ["/api/mind"] });
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold"><Brain size={16} className="text-primary" /> AURORA's mind</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {total} things learned — {counts.fact ?? 0} facts · {counts.lesson ?? 0} lessons · {counts.team ?? 0} team notes.
            {" "}She reflects on everyone's work every few hours{data?.status.lastAt ? ` (last: ${timeAgo(data.status.lastAt)})` : ""}, and every agent can teach her.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void reflectNow()} disabled={busy || data?.status.running}>
          {busy || data?.status.running ? "Reflecting…" : "Reflect now"}
        </Button>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex gap-1 text-[11px]">
            {(["all", "lesson", "fact", "team"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                className={cn("rounded-full border px-2 py-0.5 capitalize", filter === f ? "border-primary/50 bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                {f === "all" ? "All" : `${KIND[f].icon} ${KIND[f].label}s`}
              </button>
            ))}
          </div>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
            {items.length === 0 && <li className="text-xs text-muted-foreground">Nothing yet — she'll start learning at her next reflection.</li>}
            {items.map((k) => (
              <li key={k.id} className="group flex items-start gap-2 rounded-lg border border-border bg-surface/50 px-2.5 py-1.5 text-xs leading-snug">
                <span>{KIND[k.kind].icon}</span>
                <span className="flex-1">{k.text}<span className="ml-1 text-[10px] text-muted-foreground">· {k.source}{k.uses > 1 ? ` · reinforced ×${k.uses}` : ""}</span></span>
                <button type="button" onClick={() => void forget(k.id)} title="Make her forget this" className="opacity-0 transition group-hover:opacity-60 hover:!opacity-100"><X size={12} /></button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">The team's inner life</div>
          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {(data?.thoughts ?? []).length === 0 && <li className="text-xs text-muted-foreground">Quiet so far — thoughts and conversations show up here as they happen.</li>}
            {(data?.thoughts ?? []).slice(0, 25).map((t) => {
              const m = byId.get(t.agentId);
              return (
                <li key={t.id} className="flex items-start gap-2 text-xs leading-snug">
                  <IdentityAvatar name={m?.name ?? "?"} avatarPath={m?.avatarPath} className="h-8 w-8 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{m?.name ?? "Someone"}</span>
                    <span className="ml-1 text-[10px] text-muted-foreground">{t.kind === "thought" ? "💭 thought" : t.kind === "gossip" ? "🗣️ gossip" : "🫶 moment"} · {timeAgo(t.at)}</span>
                    <div className={cn(t.kind === "thought" && "italic")}>{t.text}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Card>
  );
}
