import { useEffect, useMemo, useRef, useState } from "react";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { moodFace } from "@/lib/mood";

// A small "AI town" view of the team: an office floor where each agent is a
// character that walks between its desk, teammates' desks, and the lounge as
// its real state changes. Positions live in a fixed 1000x620 logical space
// and are rendered as percentages, so the map scales to any width.

export interface WorldMember {
  id: number; name: string; role: string | null; isOverseer: boolean; status: "active" | "paused";
  avatarPath: string | null; working: boolean; waitingApproval: boolean; currentTask: string | null;
  lastTools: string[]; lastActivity: { text: string; at: number } | null;
  mood?: string; morale?: number; energy?: number;
}
export interface Handoff { fromAgentId: number; toAgentId: number; at: number }
export interface PipelineFlow { pipelineName: string; stage: number; stages: number; agentId: number; prevAgentId: number | null }
export interface Chatter { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number }

const W = 1000;
type Room = { x: number; y: number; w: number; h: number; label: string };
const PER_ROW = 7;
/** Rooms grow with headcount so the big portraits never pile on top of each other. */
function layout(crewCount: number, offDesk: number): { rooms: Record<"lead" | "floor" | "meeting" | "lounge", Room>; H: number } {
  const rows = Math.max(1, Math.ceil(crewCount / PER_ROW));
  const lead = { x: 360, y: 18, w: 280, h: 210, label: "Lead office" };
  const floor = { x: 30, y: lead.y + lead.h + 24, w: 940, h: rows * 175, label: "Workspace" };
  const loungeRows = Math.max(1, Math.ceil(offDesk / 5)); // sleepers also doze in the lounge
  const h = 60 + loungeRows * 130;
  const meeting = { x: 30, y: floor.y + floor.h + 24, w: 455, h, label: "Meeting room" };
  const lounge = { x: 515, y: meeting.y, w: 455, h, label: "Lounge" };
  return { rooms: { lead, floor, meeting, lounge }, H: lounge.y + lounge.h + 18 };
}

const TOOL_WORDS: Record<string, string> = {
  web_search: "searching the web", web_fetch: "reading a page", browse_page: "browsing", browse_interact: "working a site",
  trending_videos: "checking trends", youtube_search: "searching YouTube", video_transcript: "reading a transcript",
  news_headlines: "reading the news", generate_image: "making an image", generate_video: "rendering video",
  save_document: "writing it up", make_voiceover: "recording a voiceover", remember: "taking notes", recall: "thinking back",
  handoff_to_agent: "handing off", delegate_to_agent: "delegating", create_pipeline: "planning a pipeline",
};

/** Deterministic pseudo-random in [0,1) from a seed — so wander spots are stable per agent per "beat". */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function deskSpots(count: number, floor: Room): { x: number; y: number }[] {
  const rows = Math.max(1, Math.ceil(count / PER_ROW));
  const perRow = Math.max(1, Math.ceil(count / rows));
  const { x, y, w, h } = floor;
  return Array.from({ length: count }, (_, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    return { x: x + (w / perRow) * (col + 0.5), y: y + 30 + (h / rows) * row };
  });
}

function pct(v: number, total: number): string {
  return `${(v / total) * 100}%`;
}

export function TeamWorld({ members, handoffs, flows, chatter = [], leadId = null, selectedId, onSelect }: {
  members: WorldMember[]; handoffs: Handoff[]; flows: PipelineFlow[]; chatter?: Chatter[]; leadId?: number | null; selectedId: number | null; onSelect: (id: number) => void;
}) {
  // A slow "beat" re-rolls idle agents' wander spots so the lounge feels alive.
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), 9000);
    return () => clearInterval(t);
  }, []);

  // The lead office belongs to AURORA, or — inside one company's office — that company's lead.
  const lead = members.find((m) => m.isOverseer) ?? members.find((m) => m.id === leadId) ?? null;
  const crew = members.filter((m) => m !== lead);
  const offDeskCount = members.filter((m) => m.status === "paused" || (!m.working && !m.waitingApproval && m !== lead)).length;
  const { rooms: ROOMS, H } = layout(crew.length, offDeskCount);
  const desks = useMemo(() => deskSpots(crew.length, ROOMS.floor), [crew.length, ROOMS.floor.h]);
  const deskOf = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    crew.forEach((m, i) => map.set(m.id, desks[i]));
    if (lead) map.set(lead.id, { x: ROOMS.lead.x + ROOMS.lead.w / 2, y: ROOMS.lead.y + 40 });
    return map;
  }, [crew, desks, lead]);

  const now = Date.now();
  const visiting = new Map<number, number>(); // agent -> teammate they're walking over to
  for (const h of handoffs) if (now - h.at < 25_000 && deskOf.has(h.toAgentId)) visiting.set(h.fromAgentId, h.toAgentId);

  // A recent lounge chat (server/world.ts): the pair meet in the meeting room
  // and take turns — one line on screen every few seconds.
  const talk = [...chatter].reverse().find((c) => now - c.at < 60_000);
  const talkers = new Map<number, { x: number; y: number }>();
  if (talk) {
    const r = ROOMS.meeting, cx = r.x + r.w / 2, cy = r.y + r.h / 2 + 12;
    talkers.set(talk.agentIds[0], { x: cx - 70, y: cy });
    talkers.set(talk.agentIds[1], { x: cx + 70, y: cy });
  }
  const speaking = talk ? talk.lines[Math.floor((now - talk.at) / 4500) % talk.lines.length] : null;
  const chatting = (m: WorldMember) => talkers.has(m.id) && m.status === "active" && !m.working && !m.waitingApproval && !visiting.has(m.id);

  // Off-desk agents each get their own slot (no pile-ups): paused ones doze in
  // the lounge, idle ones mingle across the meeting room and lounge, drifting
  // a little around their slot on each beat.
  const offDesk = members.filter((m) => m.status === "paused" || (!m.working && !m.waitingApproval && m !== lead && !visiting.has(m.id) && !chatting(m)));
  const sleepers = offDesk.filter((m) => m.status === "paused");
  const idlers = offDesk.filter((m) => m.status !== "paused");
  function slot(room: { x: number; y: number; w: number; h: number }, i: number, n: number): { x: number; y: number } {
    const cols = Math.max(1, Math.min(n, 5)), rows = Math.ceil(n / cols);
    const col = i % cols, row = Math.floor(i / cols);
    return { x: room.x + (room.w / cols) * (col + 0.5), y: room.y + 40 + ((room.h - 50) / rows) * (row + 0.5) };
  }

  function placeOf(m: WorldMember): { x: number; y: number; mode: "desk" | "visit" | "lounge" | "sleep" | "chat" } {
    const desk = deskOf.get(m.id)!;
    if (m.status === "paused") return { ...slot(ROOMS.lounge, sleepers.indexOf(m), sleepers.length), mode: "sleep" };
    if (chatting(m)) return { ...talkers.get(m.id)!, mode: "chat" };
    const target = visiting.get(m.id);
    if (target != null) {
      const d = deskOf.get(target)!;
      return { x: d.x + 60, y: d.y + 70, mode: "visit" };
    }
    if (m.working || m.waitingApproval || m === lead) return { x: desk.x, y: desk.y + (m === lead ? 95 : 70), mode: "desk" };
    const i = idlers.indexOf(m);
    const half = Math.ceil(idlers.length / 2);
    const base = i < half ? slot(ROOMS.meeting, i, half) : slot(ROOMS.lounge, i - half, idlers.length - half);
    return { x: base.x + (rand(m.id * 13 + beat) - 0.5) * 20, y: base.y + (rand(m.id * 5 + beat * 3) - 0.5) * 10, mode: "lounge" };
  }

  // Detect movement so walkers bob while their position transitions.
  const prev = useRef(new Map<number, string>());
  const [walking, setWalking] = useState<Set<number>>(new Set());
  const placed = members.map((m) => ({ m, p: placeOf(m) }));
  useEffect(() => {
    const moved = new Set<number>();
    for (const { m, p } of placed) {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (prev.current.get(m.id) && prev.current.get(m.id) !== key) moved.add(m.id);
      prev.current.set(m.id, key);
    }
    if (moved.size) {
      setWalking(moved);
      const t = setTimeout(() => setWalking(new Set()), 2400);
      return () => clearTimeout(t);
    }
  });

  return (
    <div className="relative mx-auto w-full max-w-[1100px]" style={{ aspectRatio: `${W} / ${H}` }}>
      {/* Floor + rooms */}
      <div className="absolute inset-0 rounded-2xl border border-border bg-[hsl(var(--card)/0.55)] backdrop-blur-sm" />
      {Object.entries(ROOMS).map(([key, r]) => (
        <div
          key={key}
          className={cn("absolute rounded-xl border", key === "lead" ? "border-primary/40 bg-primary/5" : "border-border/70 bg-[hsl(var(--surface)/0.35)]")}
          style={{ left: pct(r.x, W), top: pct(r.y, H), width: pct(r.w, W), height: pct(r.h, H) }}
        >
          <span className="absolute left-2 top-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">{r.label}</span>
        </div>
      ))}

      {/* Desks */}
      {members.map((m) => {
        const d = deskOf.get(m.id);
        if (!d) return null;
        const busy = m.working || m.waitingApproval;
        return (
          <div key={`desk-${m.id}`} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: pct(d.x, W), top: pct(d.y - 8, H), width: pct(m === lead ? 170 : 110, W) }}>
            <div className="mx-auto h-2.5 w-[46%] rounded-t-sm" style={{
              background: busy ? (m.waitingApproval ? "hsl(var(--risk-medium))" : "hsl(var(--primary))") : "hsl(var(--muted))",
              boxShadow: busy ? `0 0 14px ${m.waitingApproval ? "hsl(var(--risk-medium))" : "hsl(var(--primary))"}` : undefined,
            }} />
            <div className="h-3 rounded-sm border border-border bg-[hsl(var(--muted)/0.8)]" />
            <div className="mt-0.5 truncate text-center text-[9px] text-muted-foreground/70">{m.name}'s desk</div>
          </div>
        );
      })}

      {/* Pipeline paths: previous step's desk -> current step's desk */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {flows.map((f, i) => {
          const a = f.prevAgentId != null ? deskOf.get(f.prevAgentId) : (lead ? deskOf.get(lead.id) : undefined);
          const b = deskOf.get(f.agentId);
          if (!a || !b) return null;
          return (
            <g key={i}>
              <path d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 60} ${b.x} ${b.y}`} fill="none"
                stroke="hsl(var(--accent))" strokeWidth={2} strokeDasharray="7 6" style={{ animation: "team-dash 0.8s linear infinite" }} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {flows.map((f, i) => {
        const b = deskOf.get(f.agentId);
        if (!b) return null;
        return (
          <div key={`flow-${i}`} className="pointer-events-none absolute -translate-x-1/2 rounded-full border border-accent/50 bg-card/90 px-2 py-0.5 text-[10px] text-accent"
            style={{ left: pct(b.x, W), top: pct(b.y - 62, H) }}>
            {f.pipelineName} · step {f.stage}/{f.stages}
          </div>
        );
      })}

      {/* Characters */}
      {placed.map(({ m, p }) => {
        const bubble = p.mode === "sleep" ? "zzz"
          : p.mode === "chat" ? (speaking?.agentId === m.id ? speaking.text : null)
          : m.waitingApproval ? "Needs your OK on something"
          : p.mode === "visit" ? "Passing this over to you →"
          : m.working ? (m.lastTools[0] && TOOL_WORDS[m.lastTools[0]] ? `${TOOL_WORDS[m.lastTools[0]]}…` : (m.currentTask ? `On it: ${m.currentTask.replace(/^\[[^\]]*\]\s*/, "").slice(0, 70)}` : "Working…"))
          : null;
        const size = m === lead ? "h-28 w-28" : "h-16 w-16";
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
            className="group absolute z-10 -translate-x-1/2 -translate-y-1/2 focus:outline-none"
            style={{ left: pct(p.x, W), top: pct(p.y, H), transition: "left 2.2s ease-in-out, top 2.2s ease-in-out" }}
            title={`${m.name}${m.role ? ` — ${m.role}` : ""}`}
          >
            {bubble && (
              <div className={cn(
                "pointer-events-none absolute bottom-full left-1/2 mb-1 w-max max-w-[11rem] -translate-x-1/2 rounded-lg border border-border bg-card/95 px-2 py-1 text-[10px] leading-snug shadow-md",
                p.mode === "sleep" && "border-transparent bg-transparent text-muted-foreground shadow-none",
              )}>
                {bubble}
              </div>
            )}
            <div
              className={cn("relative rounded-2xl p-[3px] transition-transform group-hover:scale-110", selectedId === m.id && "scale-110", m.isOverseer && "shadow-[0_0_26px_rgba(242,193,78,0.6)]")}
              style={{
                background: m.isOverseer ? "#f2c14e" : m.waitingApproval ? "hsl(var(--risk-medium))" : m.working ? "hsl(var(--primary))" : m === lead ? "hsl(var(--accent))" : "hsl(var(--border))",
                animation: walking.has(m.id) ? "team-walk 0.36s ease-in-out infinite" : m.working ? "team-ring 1.6s ease-in-out infinite" : undefined,
              }}
            >
              <IdentityAvatar name={m.name} avatarPath={m.avatarPath} className={cn(size, "rounded-xl", p.mode === "sleep" && "grayscale opacity-60")} />
              {m.morale != null && <span className="absolute -bottom-1.5 -right-1.5 rounded-full bg-card px-1 text-sm leading-tight shadow" title={`${m.mood ?? ""} · morale ${m.morale} · energy ${m.energy}`}>{moodFace(m.morale, m.energy ?? 100)}</span>}
            </div>
            <div className={cn("mt-1 whitespace-nowrap text-center font-medium text-foreground/90 drop-shadow", m.isOverseer ? "text-sm" : "text-[11px]")}>{m.isOverseer ? `✦ ${m.name} ✦` : m.name.split(/\s+/)[0]}</div>
            {m.morale != null && (
              <div className="mx-auto mt-0.5 w-14 space-y-[2px]" title={`Morale ${m.morale} · Energy ${m.energy}`}>
                <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-[hsl(330_75%_60%)]" style={{ width: `${m.morale}%` }} /></div>
                <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-[hsl(45_90%_55%)]" style={{ width: `${m.energy ?? 0}%` }} /></div>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
