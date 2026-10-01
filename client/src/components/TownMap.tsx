import { IdentityAvatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { Building2, Crown, TrendingDown, TrendingUp, Newspaper } from "lucide-react";

// The whole organization at a glance: AURORA HQ on top, the real companies
// (LLM agents doing actual work) as big buildings, and the simulated
// companies (rules-driven virtual businesses) as smaller ones around a
// street, with a live news feed. Click a real company to walk into its office.

export interface StaffMember { id: number; name: string; role: string | null; avatarPath: string | null; status: string; working: boolean; isLead: boolean; mood?: string }
export interface TownCompany {
  id: number; name: string; kind: "real" | "simulated"; industry: string; mission: string; color: number; leadAgentId: number | null;
  cash: number; reputation: number; revenueLast: number; product: string; staff: StaffMember[];
}
export interface TownEvent { id: number; at: number; companyId: number | null; kind: string; text: string }
export interface TownData { simDay: number; companies: TownCompany[]; hq: StaffMember[]; events: TownEvent[] }

const EVENT_ICON: Record<string, string> = {
  founded: "🏢", launch: "🚀", scandal: "⚠️", deal: "🤝", hire: "👋", layoff: "📉", restructure: "🛟", market: "📈", delivered: "✅",
};

function money(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(1)}M` : abs >= 1_000 ? `${Math.round(abs / 1_000)}k` : String(Math.round(abs));
  return `${n < 0 ? "-" : ""}$${s}`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Window grid on a building facade: one lit window per working staff member, the rest dim. */
function Windows({ total, lit, hue }: { total: number; lit: number; hue: number }) {
  const count = Math.max(6, Math.min(18, total * 2));
  return (
    <div className="grid grid-cols-6 gap-1">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="h-2 rounded-[2px]"
          style={{
            background: i < lit * 2 ? `hsl(${hue} 90% 65%)` : "hsl(var(--muted))",
            boxShadow: i < lit * 2 ? `0 0 8px hsl(${hue} 90% 60% / 0.8)` : undefined,
            animation: i < lit * 2 ? "pulse-soft 1.8s ease-in-out infinite" : undefined,
          }}
        />
      ))}
    </div>
  );
}

function RealBuilding({ c, onOpen }: { c: TownCompany; onOpen: () => void }) {
  const working = c.staff.filter((s) => s.working).length;
  const lead = c.staff.find((s) => s.isLead);
  return (
    <button type="button" onClick={onOpen} className="group flex flex-col text-left focus:outline-none" title={c.mission}>
      <div className="h-2 rounded-t-lg" style={{ background: `hsl(${c.color} 75% 55%)` }} />
      <div className="flex flex-1 flex-col gap-2 rounded-b-lg border border-t-0 border-border bg-card/80 p-3 transition-colors group-hover:border-primary/50 group-hover:bg-card">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold leading-tight">{c.name}</div>
            <div className="text-[11px] text-muted-foreground">{c.industry}</div>
          </div>
          {working > 0 && <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{working} working</span>}
        </div>
        <Windows total={c.staff.length} lit={working} hue={c.color} />
        <div className="flex -space-x-2">
          {c.staff.slice(0, 8).map((s) => (
            <div key={s.id} className={cn("rounded-full ring-2 ring-card", s.working && "ring-primary")} title={`${s.name} — ${s.role ?? "agent"}`}>
              <IdentityAvatar name={s.name} avatarPath={s.avatarPath} className={cn("h-7 w-7 text-[10px]", s.status === "paused" && "grayscale opacity-60")} />
            </div>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {c.staff.length} staff{lead ? ` · led by ${lead.name.split(" ")[0]}` : ""}
        </div>
      </div>
    </button>
  );
}

function SimBuilding({ c, selected, onSelect }: { c: TownCompany; selected: boolean; onSelect: () => void }) {
  const up = c.revenueLast >= c.staff.length * 700 + 500;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn("rounded-lg border bg-[hsl(var(--surface)/0.5)] p-2.5 text-left transition-colors focus:outline-none", selected ? "border-primary/60" : "border-border hover:border-muted-foreground/40")}
      title={c.product}
    >
      <div className="mb-1.5 h-1 rounded-full" style={{ background: `hsl(${c.color} 60% 50% / 0.8)` }} />
      <div className="flex items-center justify-between gap-1">
        <div className="truncate text-xs font-medium">{c.name}</div>
        {up ? <TrendingUp size={12} className="shrink-0 text-risk-low" /> : <TrendingDown size={12} className="shrink-0 text-risk-high" />}
      </div>
      <div className="truncate text-[10px] text-muted-foreground">{c.industry}</div>
      <div className="mt-1.5 flex items-center justify-between text-[10px]">
        <span className={c.cash < 0 ? "text-risk-high" : "text-foreground/80"}>{money(c.cash)}</span>
        <span className="text-muted-foreground">rep {c.reputation}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {c.staff.slice(0, 12).map((s) => (
          <span
            key={s.id}
            className="h-2 w-2 rounded-full"
            title={`${s.name} — ${s.role} (${s.mood ?? "steady"})`}
            style={{ background: s.mood === "thriving" ? "hsl(var(--risk-low))" : s.mood === "worried" || s.mood === "exhausted" ? "hsl(var(--risk-high))" : "hsl(var(--muted-foreground))" }}
          />
        ))}
      </div>
    </button>
  );
}

export function TownMap({ data, selectedSimId, onOpenCompany, onSelectSim }: {
  data: TownData; selectedSimId: number | null; onOpenCompany: (id: number | "hq") => void; onSelectSim: (id: number) => void;
}) {
  const real = data.companies.filter((c) => c.kind === "real");
  const sims = data.companies.filter((c) => c.kind === "simulated");
  const nameOf = new Map(data.companies.map((c) => [c.id, c.name] as const));
  const hqWorking = data.hq.filter((s) => s.working).length;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <div className="space-y-4 rounded-2xl border border-border bg-[hsl(var(--card)/0.45)] p-4"
        style={{ backgroundImage: "linear-gradient(hsl(var(--border)/0.35) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/0.35) 1px, transparent 1px)", backgroundSize: "28px 28px" }}>
        {/* HQ */}
        <div className="flex justify-center">
          <button type="button" onClick={() => onOpenCompany("hq")} className="group w-full max-w-md text-left focus:outline-none">
            <div className="h-2.5 rounded-t-xl bg-gradient-to-r from-primary to-accent" />
            <div className="flex items-center gap-3 rounded-b-xl border border-t-0 border-primary/40 bg-card/90 p-3 shadow-glow transition-colors group-hover:bg-card">
              <Crown size={18} className="shrink-0 text-accent" />
              <div className="flex-1">
                <div className="text-sm font-semibold">AURORA HQ</div>
                <div className="text-[11px] text-muted-foreground">Runs every company · sim day {data.simDay}{hqWorking ? ` · ${hqWorking} working` : ""}</div>
              </div>
              <div className="flex -space-x-2">
                {data.hq.map((s) => (
                  <div key={s.id} className={cn("rounded-full ring-2 ring-card", s.working && "ring-primary")} title={`${s.name} — ${s.role ?? ""}`}>
                    <IdentityAvatar name={s.name} avatarPath={s.avatarPath} className={cn(s.isLead ? "h-10 w-10" : "h-8 w-8", "text-[10px]")} />
                  </div>
                ))}
              </div>
            </div>
          </button>
        </div>

        {/* Main street: real companies */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground"><Building2 size={12} /> AURORA companies</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {real.map((c) => <RealBuilding key={c.id} c={c} onOpen={() => onOpenCompany(c.id)} />)}
          </div>
        </div>

        <div className="h-3 rounded-full bg-[hsl(var(--muted)/0.6)]" style={{ backgroundImage: "repeating-linear-gradient(90deg, transparent 0 18px, hsl(var(--muted-foreground)/0.5) 18px 30px)", backgroundSize: "30px 2px", backgroundRepeat: "repeat-x", backgroundPosition: "center" }} />

        {/* The rest of town: simulated companies */}
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">The rest of town (simulated)</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sims.map((c) => <SimBuilding key={c.id} c={c} selected={selectedSimId === c.id} onSelect={() => onSelectSim(c.id)} />)}
          </div>
        </div>
      </div>

      {/* News */}
      <aside className="rounded-2xl border border-border bg-card/60 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium"><Newspaper size={13} /> Town news</div>
        <ol className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
          {data.events.length === 0 && <li className="text-xs text-muted-foreground">Quiet day so far.</li>}
          {data.events.map((e) => (
            <li key={e.id} className="text-xs leading-snug">
              <span className="mr-1">{EVENT_ICON[e.kind] ?? "•"}</span>
              {e.text}
              <div className="text-[10px] text-muted-foreground">{e.companyId ? `${nameOf.get(e.companyId) ?? ""} · ` : ""}{ago(e.at)}</div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
