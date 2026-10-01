import { useSpokenQueue } from "@/lib/useSpokenQueue";
import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  ListTodo, Image, BrainCircuit, SquareTerminal, Puzzle, ShieldCheck, ScrollText,
  Settings as SettingsIcon, Bot, Inbox, LayoutDashboard, Globe, Sparkles, FolderKanban,
  Palette, LogOut, ChevronUp, HelpCircle, Music as MusicIcon, Eye, Users, Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { setToken } from "@/lib/queryClient";
import { MusicPlayer } from "@/components/ui/MusicPlayer";
import { LiveBackground } from "@/components/ui/LiveBackground";

const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Home", icon: LayoutDashboard },
    ],
  },
  {
    label: "Agents",
    items: [
      { href: "/team", label: "Team", icon: Users },
      { href: "/pipelines", label: "Pipelines", icon: Workflow },
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/outbox", label: "Outbox", icon: Inbox },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/generate", label: "Generate", icon: Sparkles },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/library", label: "Library", icon: Image },
      { href: "/music", label: "Music", icon: MusicIcon },
      { href: "/memory", label: "Memory", icon: BrainCircuit },
      { href: "/terminal", label: "Terminal", icon: SquareTerminal },
      { href: "/browser", label: "Browser", icon: Globe },
      { href: "/godseye", label: "God's Eye", icon: Eye },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/skills", label: "Skills", icon: Puzzle },
      { href: "/approvals", label: "Approvals", icon: ShieldCheck },
      { href: "/audit", label: "Audit Log", icon: ScrollText },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="aurora-mark" x1="2" y1="24" x2="29" y2="7" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
        <radialGradient id="aurora-spark" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M 3 22 C 10 15, 14 24, 19 18 C 22 14, 25 16, 29 10"
        stroke="url(#aurora-mark)"
        strokeWidth="4.4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="19" cy="18" r="4.5" fill="url(#aurora-spark)" opacity="0.6" />
      <circle cx="19" cy="18" r="1.6" fill="#ffffff" />
    </svg>
  );
}

// Bottom-of-sidebar account menu (the local equivalent of claude.ai's account
// dropdown): jump to Customize/Settings/Help, or Lock the app (clears the auth
// token and returns to the PIN screen).
function AccountMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function lock() {
    setToken(null);
    window.location.reload();
  }

  return (
    <div ref={ref} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-lg border border-border bg-card shadow-panel overflow-hidden py-1 animate-in fade-in slide-in-from-bottom-1 duration-150">
          <Link href="/customize" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground">
            <Palette size={15} /> Customize
          </Link>
          <Link href="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground">
            <SettingsIcon size={15} /> Settings
          </Link>
          <Link href="/audit" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground">
            <HelpCircle size={15} /> Activity &amp; help
          </Link>
          <button onClick={lock} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-risk-high hover:bg-surface border-t border-border-subtle mt-1">
            <LogOut size={15} /> Lock AURORA
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-surface hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-[11px] font-semibold text-background">A</span>
          Account
        </span>
        <ChevronUp size={14} className={cn("transition-transform", open ? "" : "rotate-180")} />
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  // Mounted here rather than on a page so AURORA can speak on any tab, and
  // keeps speaking while the owner is looking at something else entirely.
  useSpokenQueue();
  const { data: ollamaStatus } = useQuery<{ live: boolean; activeModel: string }>({
    queryKey: ["/api/ollama/status"],
    refetchInterval: 10_000,
  });
  const { data: approvals } = useQuery<{ status: string }[]>({ queryKey: ["/api/approvals"], refetchInterval: 5_000 });
  const { data: deliverables } = useQuery<{ status: string }[]>({ queryKey: ["/api/deliverables"], refetchInterval: 5_000 });
  const pendingCount = approvals?.filter((a) => a.status === "pending").length ?? 0;
  const readyCount = deliverables?.filter((d) => d.status === "ready").length ?? 0;
  // A persistent, always-on nav signal for "work is waiting" — independent of
  // desktop notifications, which need an OS permission grant and can be
  // missed or dismissed. This is always visible just by looking at the sidebar.
  const navBadgeCounts: Record<string, number> = { Approvals: pendingCount, Outbox: readyCount };

  return (
    <div className="flex min-h-screen">
      <LiveBackground />
      <aside className="w-64 shrink-0 border-r border-border flex flex-col bg-background/70 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <Logo />
          <div>
            <div className="text-[15px] font-semibold tracking-tight leading-none">AURORA</div>
            <div className="text-[11px] text-muted-foreground mt-1">Local vessel</div>
          </div>
        </div>

        {/* Chat / Code mode toggle (mirrors claude.ai's Home/Code tabs): jump
            to the conversational surface or the developer surface. */}
        <div className="px-3 pb-2">
          <div className="flex rounded-lg border border-border p-0.5 bg-surface/50">
            {[
              { label: "Chat", href: "/tasks", match: ["/", "/tasks", "/agents", "/outbox", "/memory"] },
              { label: "Code", href: "/terminal", match: ["/terminal", "/generate", "/skills", "/browser"] },
            ].map((m) => {
              const active = m.match.includes(location);
              return (
                <Link
                  key={m.label}
                  href={m.href}
                  className={cn(
                    "flex-1 text-center text-xs font-medium rounded-md py-1.5 transition-colors",
                    active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </Link>
              );
            })}
          </div>
        </div>

        <nav className="flex-1 px-3 pb-3 space-y-5 overflow-y-auto">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map(({ href, label, icon: Icon }) => {
                  const active = location === href;
                  const badgeCount = navBadgeCounts[label] ?? 0;
                  return (
                    <Link
                      key={href}
                      href={href}
                      className={cn(
                        "relative flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-surface hover:text-foreground",
                      )}
                    >
                      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
                      <span className="flex items-center gap-2.5">
                        <Icon size={16} strokeWidth={2} />
                        {label}
                      </span>
                      {badgeCount > 0 && (
                        <span className="rounded-full bg-risk-high/15 text-risk-high text-[10px] font-semibold px-1.5 py-0.5 leading-none min-w-[18px] text-center">
                          {badgeCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-4 py-3.5 border-t border-border space-y-2">
          <div className="flex items-center gap-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", ollamaStatus?.live ? "bg-risk-low shadow-[0_0_6px] shadow-risk-low" : "bg-risk-high")} />
            <span className="text-xs text-muted-foreground truncate">
              {ollamaStatus?.live ? (ollamaStatus.activeModel || "Ollama connected") : "Ollama offline"}
            </span>
          </div>
          <MusicPlayer />
          <AccountMenu />
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
