import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { TeamWorld, type Handoff, type PipelineFlow } from "@/components/TeamWorld";
import { Play, Pause, X, ShieldAlert, Wrench } from "lucide-react";

interface Member {
  id: number;
  name: string;
  role: string | null;
  isOverseer: boolean;
  status: "active" | "paused";
  avatarPath: string | null;
  mood: string;
  energy: number;
  morale: number;
  lastRunAt: number | null;
  scheduleMinutes: number | null;
  spawnedByAgentId: number | null;
  working: boolean;
  waitingApproval: boolean;
  currentTask: string | null;
  pendingCount: number;
  lastActivity: { text: string; at: number } | null;
  lastTools: string[];
  relationships: { otherAgentId: number; sentiment: number; interactions: number }[];
}

interface TeamData { members: Member[]; pendingApprovals: number; recentHandoffs: Handoff[]; pipelineFlows: PipelineFlow[] }

type State = "working" | "approval" | "idle" | "paused";

function stateOf(m: Member): State {
  if (m.status === "paused") return "paused";
  if (m.waitingApproval) return "approval";
  if (m.working) return "working";
  return "idle";
}

const STATE_LABEL: Record<State, string> = { working: "Working", approval: "Needs approval", idle: "Idle", paused: "Paused" };
const STATE_COLOR: Record<State, string> = {
  working: "hsl(var(--primary))",
  approval: "hsl(var(--risk-medium))",
  idle: "hsl(var(--muted-foreground))",
  paused: "hsl(var(--border))",
};

function ago(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="w-9">{label}</span>
      <div className="h-1 flex-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

// Literal class strings so Tailwind's scanner picks them up.
const AVATAR_SIZE = { 64: "h-16 w-16", 88: "h-[88px] w-[88px]", 112: "h-28 w-28" } as const;

/** One agent on the floor: avatar with a state ring, name, and a speech bubble of what they last said/did. */
function Node({ m, size, selected, onSelect }: { m: Member; size: keyof typeof AVATAR_SIZE; selected: boolean; onSelect: () => void }) {
  const st = stateOf(m);
  const bubble = st === "working"
    ? (m.currentTask ? `On it: ${m.currentTask}` : "Working…")
    : m.lastActivity?.text;
  return (
    <button type="button" onClick={onSelect} className="group relative flex flex-col items-center gap-1.5 focus:outline-none" style={{ width: size + 80 }}>
      {/* Floats above the avatar (absolute, so it never shifts the layout). Always
          shown while working; otherwise only on hover/selection, so a floor of
          idle agents isn't a wall of overlapping text. */}
      {bubble && (
        <div className={cn(
          "pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-52 -translate-x-1/2 rounded-xl border border-border bg-card/95",
          "px-2.5 py-1.5 text-[11px] leading-snug text-left shadow-md backdrop-blur line-clamp-3 transition-opacity",
          st === "working" || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}>
          {bubble}
        </div>
      )}
      <div
        className={cn("relative rounded-full p-[3px] transition-transform group-hover:scale-105", selected && "scale-105")}
        style={{
          background: STATE_COLOR[st],
          boxShadow: st === "working" ? `0 0 24px -2px ${STATE_COLOR[st]}` : undefined,
          animation: st === "working" ? "team-ring 1.6s ease-in-out infinite" : undefined,
        }}
      >
        <IdentityAvatar name={m.name} avatarPath={m.avatarPath} className={cn(AVATAR_SIZE[size], "text-lg", st === "paused" && "grayscale opacity-60")} />
        {st === "approval" && (
          <span className="absolute -right-1 -top-1 rounded-full bg-[hsl(var(--risk-medium))] p-1 text-black"><ShieldAlert size={11} /></span>
        )}
      </div>
      <div className="text-center">
        <div className={cn("font-semibold leading-tight", m.isOverseer ? "text-base" : "text-sm")}>{m.name}</div>
        <div className="text-[11px] text-muted-foreground">{m.isOverseer ? "Lead · Overseer" : m.role ?? "Agent"} · {STATE_LABEL[st]}</div>
      </div>
    </button>
  );
}

export default function Team() {
  const qc = useQueryClient();
  const { data } = useQuery<TeamData>({ queryKey: ["/api/team"], refetchInterval: 2500 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<"world" | "ring">("world");
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 900, h: 640 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const members = data?.members ?? [];
  const lead = members.find((m) => m.isOverseer) ?? null;
  const crew = members.filter((m) => m !== lead);
  const selected = members.find((m) => m.id === selectedId) ?? null;
  const counts = useMemo(() => {
    const c = { working: 0, approval: 0, idle: 0, paused: 0 } as Record<State, number>;
    for (const m of members) c[stateOf(m)]++;
    return c;
  }, [members]);

  // Crew sit on an ellipse around the lead. Below ~760px wide the ring gets
  // too cramped, so the floor falls back to a simple grid.
  const ring = stage.w >= 760;
  const cx = stage.w / 2, cy = stage.h / 2;
  const rx = stage.w / 2 - 110, ry = stage.h / 2 - 95;
  const positions = crew.map((_, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, crew.length)) * Math.PI * 2;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });

  async function setStatus(m: Member, status: "active" | "paused") {
    await apiRequest("PATCH", `/api/agents/${m.id}`, { status }).catch(() => {});
    void qc.invalidateQueries({ queryKey: ["/api/team"] });
  }

  async function runNow(m: Member) {
    void apiRequest("POST", `/api/agents/${m.id}/run`).catch(() => {});
    setTimeout(() => void qc.invalidateQueries({ queryKey: ["/api/team"] }), 800);
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader title="Team" description="Watch AURORA and her agents work, live." />
          <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
            {(["world", "ring"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn("rounded px-2.5 py-1 capitalize", view === v ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {v === "world" ? "Office" : "Ring"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {(Object.keys(counts) as State[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: STATE_COLOR[s] }} />
              {counts[s]} {STATE_LABEL[s].toLowerCase()}
            </span>
          ))}
          {!!data?.pendingApprovals && (
            <Link href="/approvals" className="text-[hsl(var(--risk-medium))] hover:underline">
              {data.pendingApprovals} waiting in Approvals →
            </Link>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto">
          {members.length > 0 && view === "world" ? (
            <div className="p-4 sm:p-6">
              <TeamWorld members={members} handoffs={data?.recentHandoffs ?? []} flows={data?.pipelineFlows ?? []} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          ) : members.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No agents yet — create one on the Agents page.</div>
          ) : ring ? (
            <>
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                {lead && crew.map((m, i) => {
                  const st = stateOf(m);
                  const active = st === "working" || (lead.working && st !== "paused");
                  return (
                    <line
                      key={m.id}
                      x1={cx} y1={cy} x2={positions[i].x} y2={positions[i].y}
                      stroke={active ? "hsl(var(--primary))" : "hsl(var(--border))"}
                      strokeOpacity={active ? 0.8 : 0.6}
                      strokeWidth={active ? 2 : 1}
                      strokeDasharray={active ? "6 6" : undefined}
                      style={active ? { animation: "team-dash 0.8s linear infinite" } : undefined}
                    />
                  );
                })}
              </svg>
              {lead && (
                <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: cx, top: cy }}>
                  <Node m={lead} size={112} selected={selectedId === lead.id} onSelect={() => setSelectedId(lead.id)} />
                </div>
              )}
              {crew.map((m, i) => (
                <div key={m.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: positions[i].x, top: positions[i].y }}>
                  <Node m={m} size={64} selected={selectedId === m.id} onSelect={() => setSelectedId(m.id)} />
                </div>
              ))}
            </>
          ) : (
            <div className="grid grid-cols-2 gap-6 p-6 sm:grid-cols-3">
              {[...(lead ? [lead] : []), ...crew].map((m) => (
                <div key={m.id} className="flex justify-center">
                  <Node m={m} size={m.isOverseer ? 88 : 64} selected={selectedId === m.id} onSelect={() => setSelectedId(m.id)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-card/60 p-4 backdrop-blur animate-in">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div>
                  <IdentityAvatar name={selected.name} avatarPath={selected.avatarPath} className="h-12 w-12" />
                </div>
                <div>
                  <div className="font-semibold">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.isOverseer ? "Lead · Overseer" : selected.role ?? "Agent"} · {STATE_LABEL[stateOf(selected)]}</div>
                </div>
              </div>
              <button type="button" className="opacity-60 hover:opacity-100" onClick={() => setSelectedId(null)} title="Close"><X size={16} /></button>
            </div>

            <div className="mt-4 space-y-1.5">
              <Meter label="Energy" value={selected.energy} />
              <Meter label="Morale" value={selected.morale} />
              <div className="text-[11px] text-muted-foreground">Mood: {selected.mood}</div>
            </div>

            <dl className="mt-4 space-y-2 text-xs">
              <div><dt className="text-muted-foreground">Last active</dt><dd>{ago(selected.lastRunAt)}</dd></div>
              <div><dt className="text-muted-foreground">Schedule</dt><dd>{selected.scheduleMinutes ? `every ${selected.scheduleMinutes} min` : "whenever there's work"}</dd></div>
              <div><dt className="text-muted-foreground">Queue</dt><dd>{selected.pendingCount} pending</dd></div>
              {selected.currentTask && <div><dt className="text-muted-foreground">Working on</dt><dd>{selected.currentTask}</dd></div>}
              {selected.lastTools.length > 0 && (
                <div>
                  <dt className="text-muted-foreground">Recent tools</dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {selected.lastTools.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px]"><Wrench size={9} />{t}</span>
                    ))}
                  </dd>
                </div>
              )}
              {selected.lastActivity && (
                <div><dt className="text-muted-foreground">Latest ({ago(selected.lastActivity.at)})</dt><dd className="whitespace-pre-wrap">{selected.lastActivity.text}</dd></div>
              )}
            </dl>

            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void runNow(selected)} disabled={selected.working || selected.status === "paused"}>
                <Play size={12} /> Run now
              </Button>
              {selected.status === "active" ? (
                <Button size="sm" variant="outline" onClick={() => void setStatus(selected, "paused")}><Pause size={12} /> Pause</Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => void setStatus(selected, "active")}><Play size={12} /> Resume</Button>
              )}
              <Link href="/agents"><Button size="sm" variant="ghost">Open in Agents</Button></Link>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
