import { Link, useLocation } from "wouter";
import {
  ListTodo, Image, BrainCircuit, SquareTerminal, Puzzle, ShieldCheck, ScrollText,
  Settings as SettingsIcon, Bot, Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

const NAV_GROUPS = [
  {
    label: "Agents",
    items: [
      { href: "/", label: "Agents", icon: Bot },
      { href: "/outbox", label: "Outbox", icon: Inbox },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/library", label: "Library", icon: Image },
      { href: "/memory", label: "Memory", icon: BrainCircuit },
      { href: "/terminal", label: "Terminal", icon: SquareTerminal },
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
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="aurora-mark" x1="0" y1="0" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
      </defs>
      <circle cx="13" cy="13" r="12" stroke="url(#aurora-mark)" strokeWidth="1.5" opacity="0.35" />
      <circle cx="13" cy="13" r="6.5" fill="url(#aurora-mark)" />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
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
      <aside className="w-64 shrink-0 border-r border-border flex flex-col">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <Logo />
          <div>
            <div className="text-[15px] font-semibold tracking-tight leading-none">AURORA</div>
            <div className="text-[11px] text-muted-foreground mt-1">Local vessel</div>
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

        <div className="px-4 py-3.5 border-t border-border">
          <div className="flex items-center gap-2">
            <span className={cn("h-1.5 w-1.5 rounded-full", ollamaStatus?.live ? "bg-risk-low shadow-[0_0_6px] shadow-risk-low" : "bg-risk-high")} />
            <span className="text-xs text-muted-foreground truncate">
              {ollamaStatus?.live ? (ollamaStatus.activeModel || "Ollama connected") : "Ollama offline"}
            </span>
          </div>
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
