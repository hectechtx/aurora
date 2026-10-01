import { IdentityAvatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { affection, moodFace } from "@/lib/mood";

export interface ProfileMember {
  id: number; name: string; role: string | null; isOverseer: boolean; status: "active" | "paused"; avatarPath: string | null;
  mood: string; energy: number; morale: number; working: boolean; waitingApproval: boolean; currentTask: string | null;
  lastActivity: { text: string; at: number } | null; companyId: number | null;
  relationships?: { otherAgentId: number; sentiment: number; interactions: number }[];
  thoughts?: { kind: "thought" | "memory" | "gossip"; text: string; at: number }[];
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

function Bar({ label, value, color, pixel }: { label: string; value: number; color: string; pixel?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-12 shrink-0 opacity-80">{label}</span>
      <div className={cn("h-2 flex-1 overflow-hidden rounded-full", pixel ? "bg-[#e3c48c]" : "bg-muted")}>
        <div className="h-full rounded-full" style={{ width: `${v}%`, background: color }} />
      </div>
      <span className="w-7 text-right tabular-nums opacity-80">{v}</span>
    </div>
  );
}

/**
 * Everything about one agent at a glance: big detailed portrait, what they're
 * doing, how they feel (mood, morale, energy), and who they get along with.
 */
export function AgentProfile({ m, members, companyName, doing, pixel, onPick }: {
  m: ProfileMember; members: ProfileMember[]; companyName?: string; doing?: string; pixel?: boolean; onPick?: (id: number) => void;
}) {
  const status = m.status === "paused" ? "😴 Off duty" : m.waitingApproval ? "⏳ Waiting on your approval" : m.working ? "💼 Working now" : doing ?? "🙂 Taking it easy";
  const byId = new Map(members.map((x) => [x.id, x] as const));
  const rels = (m.relationships ?? []).filter((r) => byId.has(r.otherAgentId)).sort((a, b) => b.sentiment - a.sentiment);
  const shown = [...rels.slice(0, 5), ...rels.slice(5).filter((r) => r.sentiment < -10).slice(-2)];
  const muted = pixel ? "opacity-75" : "text-muted-foreground";
  return (
    <div className="space-y-3">
      <div className={cn("relative overflow-hidden rounded-xl border-4", m.isOverseer ? "border-[#f2c14e] shadow-[0_0_28px_rgba(242,193,78,0.55)]" : pixel ? "border-[#5a3a22]" : "border-border")}>
        <IdentityAvatar name={m.name} avatarPath={m.avatarPath} className={cn("aspect-square h-auto w-full rounded-none text-4xl", m.status === "paused" && "grayscale")} />
        <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-lg backdrop-blur" title={`Mood: ${m.mood}`}>{moodFace(m.morale, m.energy)}</span>
      </div>
      <div>
        <div className={cn("font-semibold leading-tight", m.isOverseer ? "text-xl" : "text-lg")}>{m.isOverseer ? `✦ ${m.name} ✦` : m.name}</div>
        <div className={cn("text-xs", muted)}>{m.isOverseer ? "Lead of everything" : m.role ?? "Agent"}{companyName ? ` · ${companyName}` : ""}</div>
      </div>
      <div className={cn("rounded-lg px-2.5 py-1.5 text-xs", pixel ? "bg-[#fff1cf]" : "bg-surface border border-border")}>{status}</div>
      {m.working && m.currentTask && <p className={cn("line-clamp-3 text-xs", muted)}>On: {m.currentTask.replace(/^\[[^\]]*\]:?\s*/, "")}</p>}

      <div className="space-y-1.5">
        <div className="text-xs font-semibold">Feelings · {moodFace(m.morale, m.energy)} {m.mood}</div>
        <Bar label="Morale" value={m.morale} color="hsl(330 75% 60%)" pixel={pixel} />
        <Bar label="Energy" value={m.energy} color="hsl(45 90% 55%)" pixel={pixel} />
      </div>

      <div>
        <div className="mb-1.5 text-xs font-semibold">Relationships</div>
        {shown.length === 0 ? (
          <p className={cn("text-xs", muted)}>Hasn't gotten close to anyone yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((r) => {
              const o = byId.get(r.otherAgentId)!;
              const a = affection(r.sentiment);
              return (
                <li key={r.otherAgentId}>
                  <button type="button" onClick={() => onPick?.(o.id)} className="flex w-full items-center gap-2 text-left">
                    <IdentityAvatar name={o.name} avatarPath={o.avatarPath} className="h-9 w-9 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{o.name}</span>
                      <span className={cn("block text-[10px]", muted)}>{a.label} · {r.interactions} together</span>
                    </span>
                    <span className="text-base" title={`Affection ${r.sentiment}`}>{a.emoji}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!!m.thoughts?.length && (
        <div>
          <div className="mb-1.5 text-xs font-semibold">Inner life</div>
          <ul className="space-y-1.5">
            {m.thoughts.map((t, i) => (
              <li key={i} className={cn("rounded-lg px-2.5 py-1.5 text-xs leading-snug", pixel ? "bg-[#fff1cf]" : "bg-surface border border-border")}>
                <span className="mr-1">{t.kind === "thought" ? "💭" : t.kind === "gossip" ? "🗣️" : "🫶"}</span>
                {t.kind === "thought" ? <i>{t.text}</i> : t.text}
                <span className={cn("ml-1 text-[10px]", muted)}>· {ago(t.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {m.lastActivity && (
        <div>
          <div className="mb-1 text-xs font-semibold">Last said</div>
          <p className={cn("line-clamp-4 whitespace-pre-wrap text-xs", muted)}>{m.lastActivity.text}</p>
        </div>
      )}
    </div>
  );
}
