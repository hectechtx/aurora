import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { LivingTown } from "@/components/LivingTown";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Input";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { IdentityAvatar, AuroraAvatar } from "@/components/ui/Avatar";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { AuthedVideo } from "@/components/ui/AuthedVideo";
import { useToast } from "@/components/ui/Toast";
import { useMusic } from "@/lib/music";
import { timeAgo, cn } from "@/lib/utils";
import { ShieldCheck, Bot, Inbox, Image as ImageIcon, ScrollText, ArrowRight, Sparkles, Music, Send, type LucideIcon } from "lucide-react";

interface Approval { id: number; action: string; risk: string; status: string; targetType: string; createdAt: number; }
interface AgentItem {
  id: number; name: string; status: string; scheduleMinutes: number | null; lastRunAt: number | null;
  isOverseer?: boolean; role?: string | null; morale?: number; energy?: number; mood?: string; avatarPath?: string | null;
}
interface Deliverable { id: number; agentId: number; title: string; status: string; createdAt: number; }
interface Creation { id: number; kind: string; prompt: string; filePath: string; createdAt: number; }
interface AuditEntry { id: number; ts: number; actor: string; action: string; target: string; outcome: string; }
interface OllamaStatus { live: boolean; activeModel: string; }

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Small at-a-glance strip — Ollama connection, how many agents are actually active, and what's playing — so the page reads as "here's your vessel right now" rather than a static report. */
function PulseStrip() {
  const { data: ollama } = useQuery<OllamaStatus>({ queryKey: ["/api/ollama/status"], refetchInterval: 10_000 });
  const { data: agents = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"], refetchInterval: 5000 });
  const music = useMusic();
  const activeCount = agents.filter((a) => a.status === "active").length;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", ollama?.live ? "bg-risk-low shadow-[0_0_6px] shadow-risk-low animate-pulse" : "bg-risk-high")} />
        {ollama?.live ? (ollama.activeModel || "Ollama connected") : "Ollama offline"}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", activeCount > 0 ? "bg-primary shadow-[0_0_6px] shadow-primary animate-pulse" : "bg-border")} />
        {activeCount} agent{activeCount === 1 ? "" : "s"} active
      </span>
      {music.configured && music.enabled && music.nowPlaying && (
        <span className="flex items-center gap-1.5">
          <Music size={12} className="text-primary" />
          <span className="truncate max-w-[180px]">{music.nowPlaying.replace(/\.[^.]+$/, "")}</span>
        </span>
      )}
    </div>
  );
}

function moodEmoji(morale: number): string {
  if (morale >= 85) return "😄";
  if (morale >= 65) return "🙂";
  if (morale >= 45) return "😐";
  if (morale >= 25) return "😕";
  return "😩";
}

/**
 * AURORA's "alive" presence. If she has a generated portrait it breathes
 * inside a halo of pulsing rings; otherwise a living gradient orb stands in.
 * The rings are staggered animate-ping so she reads as present and aware
 * rather than a static icon.
 */
function LiveAuroraPortrait({ avatarPath, active }: { avatarPath?: string | null; active: boolean }) {
  return (
    <div className="relative h-24 w-24 shrink-0 flex items-center justify-center">
      {active && (
        <>
          <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping [animation-duration:3s]" />
          <span className="absolute inset-2 rounded-full bg-accent/20 animate-ping [animation-duration:3s] [animation-delay:0.8s]" />
        </>
      )}
      <span className="absolute inset-1 rounded-full bg-gradient-to-br from-primary/40 to-accent/40 blur-md animate-pulse [animation-duration:4s]" />
      {avatarPath ? (
        <AuthedImage
          src={`/creations/${avatarPath}`}
          alt="AURORA"
          className="relative h-20 w-20 rounded-full object-cover ring-2 ring-primary/50 shadow-[0_0_20px_-2px] shadow-primary/50"
        />
      ) : (
        <span className="relative h-20 w-20 rounded-full bg-gradient-to-br from-primary via-accent to-primary bg-[length:200%_200%] animate-gradient ring-2 ring-primary/50 shadow-[0_0_20px_-2px] shadow-primary/50 flex items-center justify-center">
          <span className="h-6 w-6 rounded-full bg-background/80 shadow-inner animate-pulse [animation-duration:2.5s]" />
        </span>
      )}
    </div>
  );
}

function OverseerCard({ overseer, activeCount, pending, ready }: { overseer: AgentItem; activeCount: number; pending: number; ready: number }) {
  const morale = overseer.morale ?? 70;
  return (
    <Card className="p-5 animate-in fade-in slide-in-from-bottom-1 duration-300 relative overflow-hidden">
      <div className="absolute -top-16 -right-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
      <div className="flex items-center gap-5 relative">
        <LiveAuroraPortrait avatarPath={overseer.avatarPath} active={overseer.status === "active"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold">AURORA</h2>
            <span className="text-[11px] rounded-full bg-primary/15 text-primary border border-primary/30 px-2 py-0.5 font-medium">Overseer</span>
            <span className="text-[11px] rounded-full bg-surface border border-border px-2 py-0.5 text-muted-foreground">
              {moodEmoji(morale)} {overseer.mood ?? "steady"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Leading your team and coordinating every agent — she answers only to you.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", activeCount > 0 ? "bg-primary shadow-[0_0_6px] shadow-primary animate-pulse" : "bg-border")} />
              overseeing {activeCount} active agent{activeCount === 1 ? "" : "s"}
            </span>
            <span>{pending} awaiting your approval</span>
            <span>{ready} ready to post</span>
          </div>
        </div>
        <Link href="/agents" className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0 self-start">
          Manage <ArrowRight size={12} />
        </Link>
      </div>
    </Card>
  );
}

// Talk to AURORA straight from Home: a message here spins up a new task
// (conversation) and drops you into it — the "New session" composer.
function HomeComposer() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [text, setText] = useState("");

  const start = useMutation({
    mutationFn: async (message: string) => {
      const task = await apiRequest("POST", "/api/tasks", { title: message.slice(0, 60) }).then((r) => r.json());
      await apiRequest("POST", `/api/tasks/${task.id}/chat`, { message });
      return task;
    },
    onSuccess: () => { setText(""); navigate("/tasks"); },
    onError: (err: Error) => toast({ title: "Couldn't start", description: err.message, variant: "error" }),
  });

  function send() {
    const m = text.trim();
    if (!m || start.isPending) return;
    start.mutate(m);
  }

  return (
    <Card className="p-3 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="flex items-end gap-2">
        <AuroraAvatar className="h-8 w-8 mb-1 shrink-0" />
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask AURORA anything, or describe a task…"
          rows={1}
          className="flex-1 resize-none min-h-[40px]"
        />
        <button
          onClick={send}
          disabled={!text.trim() || start.isPending}
          className="mb-0.5 h-[38px] w-[38px] shrink-0 rounded-md bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40 hover:bg-primary-hover transition-colors"
          aria-label="Send"
        >
          <Send size={15} />
        </button>
      </div>
    </Card>
  );
}

interface Stats {
  sessions: number; messages: number; tokensEstimate: number; activeDays: number;
  currentStreak: number; longestStreak: number; peakHour: number | null; favoriteModel: string;
  perDay: { date: string; count: number }[];
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function hourLabel(h: number | null): string {
  if (h === null) return "—";
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const REFERENCE_BOOK_TOKENS = 270_000; // ~Moby-Dick

// The Claude-Code-style usage dashboard, merged into AURORA's home: real
// stats computed from the local DB (sessions, messages, token estimate,
// streaks, peak hour) plus a contribution-graph activity heatmap.
function StatsDashboard() {
  const { data } = useQuery<Stats>({ queryKey: ["/api/stats"], refetchInterval: 30_000 });
  if (!data) return null;
  const cells: [string, string][] = [
    ["Sessions", fmtNum(data.sessions)],
    ["Messages", fmtNum(data.messages)],
    ["Total tokens", fmtNum(data.tokensEstimate)],
    ["Active days", String(data.activeDays)],
    ["Current streak", `${data.currentStreak}d`],
    ["Longest streak", `${data.longestStreak}d`],
    ["Peak hour", hourLabel(data.peakHour)],
    ["Favorite model", data.favoriteModel],
  ];
  const max = Math.max(1, ...data.perDay.map((d) => d.count));
  const moby = data.tokensEstimate / REFERENCE_BOOK_TOKENS;

  return (
    <Card className="p-5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4">
        {cells.map(([label, value]) => (
          <div key={label}>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
            <div className="text-xl font-semibold mt-0.5 tabular-nums truncate" title={value}>{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-[3px] overflow-x-auto pb-1">
        {chunk(data.perDay, 7).map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.count} event${d.count === 1 ? "" : "s"}`}
                className="h-3 w-3 rounded-sm shrink-0"
                style={{ backgroundColor: d.count === 0 ? "hsl(var(--surface))" : `hsl(var(--primary) / ${(0.22 + (d.count / max) * 0.78).toFixed(2)})` }}
              />
            ))}
          </div>
        ))}
      </div>
      {moby >= 1 && (
        <p className="text-xs text-muted-foreground/70 mt-3">You've used ~{Math.round(moby)}× more tokens than Moby-Dick.</p>
      )}
    </Card>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: "default" | "warn" }) {
  return (
    <Card className="p-4">
      <div className={cn("text-2xl font-semibold tabular-nums", tone === "warn" && value > 0 ? "text-risk-high" : "text-foreground")}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </Card>
  );
}

function SectionCard({ title, icon: Icon, href, children }: { title: string; icon: LucideIcon; href: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="flex items-center justify-between mb-3.5">
        <h2 className="text-sm font-medium flex items-center gap-1.5"><Icon size={14} /> {title}</h2>
        <Link href={href} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          View all <ArrowRight size={12} />
        </Link>
      </div>
      {children}
    </Card>
  );
}

export default function Home() {
  const { data: approvals = [], isLoading: approvalsLoading } = useQuery<Approval[]>({ queryKey: ["/api/approvals"], refetchInterval: 5000 });
  const { data: agents = [], isLoading: agentsLoading } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"], refetchInterval: 5000 });
  const { data: deliverables = [], isLoading: deliverablesLoading } = useQuery<Deliverable[]>({ queryKey: ["/api/deliverables"], refetchInterval: 5000 });
  const { data: creations = [], isLoading: creationsLoading } = useQuery<Creation[]>({ queryKey: ["/api/creations"], refetchInterval: 5000 });
  const { data: audit = [], isLoading: auditLoading } = useQuery<AuditEntry[]>({ queryKey: ["/api/audit"], refetchInterval: 5000 });

  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const overseer = agents.find((a) => a.isOverseer);
  const teamAgents = agents.filter((a) => !a.isOverseer);
  const activeAgents = agents.filter((a) => a.status === "active");
  const readyDeliverables = deliverables.filter((d) => d.status === "ready");
  const recentCreations = creations.slice(0, 8);
  const recentAudit = audit.slice(0, 8);
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <div className="p-8 max-w-6xl mx-auto overflow-y-auto h-screen space-y-6">
      <PageHeader title={`${greeting()}.`} description="What's happening across your vessel right now." />
      <PulseStrip />
      <LivingTown />
      <HomeComposer />

      {overseer && (
        <OverseerCard
          overseer={overseer}
          activeCount={activeAgents.length}
          pending={pendingApprovals.length}
          ready={readyDeliverables.length}
        />
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-1 duration-300">
        <StatTile label="Pending approvals" value={pendingApprovals.length} tone="warn" />
        <StatTile label="Active agents" value={activeAgents.length} />
        <StatTile label="Ready to post" value={readyDeliverables.length} />
        <StatTile label="Creations" value={creations.length} />
      </div>

      <StatsDashboard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Needs your attention" icon={ShieldCheck} href="/approvals">
          {approvalsLoading && <Skeleton className="h-16 w-full" />}
          {!approvalsLoading && pendingApprovals.length === 0 && (
            <EmptyState icon={ShieldCheck} title="All clear" description="Nothing is waiting on you." />
          )}
          {!approvalsLoading && pendingApprovals.length > 0 && (
            <div className="space-y-2">
              {pendingApprovals.slice(0, 5).map((a) => (
                <Link key={a.id} href="/approvals" className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface transition-colors">
                  <span className="truncate font-mono text-xs" title={a.action}>{a.action}</span>
                  <RiskBadge risk={a.risk} />
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Agents" icon={Bot} href="/agents">
          {agentsLoading && <Skeleton className="h-16 w-full" />}
          {!agentsLoading && teamAgents.length === 0 && (
            <EmptyState icon={Bot} title="No agents yet" description="Create one from the Agents page." />
          )}
          {!agentsLoading && teamAgents.length > 0 && (
            <div className="space-y-2">
              {teamAgents.slice(0, 5).map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2 text-sm">
                  <div className="relative shrink-0">
                    <IdentityAvatar name={a.name} className="h-6 w-6" />
                    {a.status === "active" && (
                      <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-risk-low shadow-[0_0_4px] shadow-risk-low animate-pulse ring-2 ring-card" />
                    )}
                  </div>
                  <span className="truncate flex-1" title={a.name}>{a.name}</span>
                  <StatusBadge status={a.status} />
                  <span className="text-xs text-muted-foreground/70 shrink-0">
                    {a.lastRunAt ? timeAgo(a.lastRunAt) : "hasn't run"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Outbox" icon={Inbox} href="/outbox">
          {deliverablesLoading && <Skeleton className="h-16 w-full" />}
          {!deliverablesLoading && readyDeliverables.length === 0 && (
            <EmptyState icon={Inbox} title="Nothing ready" description="Finished work from your agents shows up here." />
          )}
          {!deliverablesLoading && readyDeliverables.length > 0 && (
            <div className="space-y-2">
              {readyDeliverables.slice(0, 5).map((d) => (
                <Link key={d.id} href="/outbox" className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface transition-colors">
                  <span className="truncate" title={d.title}>{d.title}</span>
                  <span className="text-xs text-muted-foreground/70 shrink-0">{agentNameById.get(d.agentId) ?? "—"}</span>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent activity" icon={ScrollText} href="/audit">
          {auditLoading && <Skeleton className="h-16 w-full" />}
          {!auditLoading && recentAudit.length === 0 && (
            <EmptyState icon={ScrollText} title="No activity yet" description="Actions the vessel takes will show up here." />
          )}
          {!auditLoading && recentAudit.length > 0 && (
            <div className="space-y-2">
              {recentAudit.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="truncate" title={e.action}>{e.action}</span>
                  <span className="text-xs text-muted-foreground/70 shrink-0">{timeAgo(e.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <Card className="p-5 animate-in fade-in slide-in-from-bottom-1 duration-300">
        <div className="flex items-center justify-between mb-3.5">
          <h2 className="text-sm font-medium flex items-center gap-1.5"><ImageIcon size={14} /> Recent creations</h2>
          <Link href="/library" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            View all <ArrowRight size={12} />
          </Link>
        </div>
        {creationsLoading && (
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}
          </div>
        )}
        {!creationsLoading && recentCreations.length === 0 && (
          <EmptyState icon={Sparkles} title="Nothing generated yet" description="Ask AURORA to make you an image or video from any task." />
        )}
        {!creationsLoading && recentCreations.length > 0 && (
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {recentCreations.map((c) => (
              <Link key={c.id} href="/library" className="aspect-square rounded-md border border-border bg-surface overflow-hidden hover:border-primary/50 transition-colors">
                {c.kind === "image" ? (
                  <AuthedImage src={`/creations/${c.filePath}`} alt={c.prompt} className="w-full h-full object-cover" />
                ) : (
                  <AuthedVideo src={`/creations/${c.filePath}`} className="w-full h-full object-cover" />
                )}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
