import { User } from "lucide-react";
import { cn } from "@/lib/utils";

export function AuroraAvatar({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "shrink-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-[0_0_10px_-2px] shadow-primary/50",
        className,
      )}
    />
  );
}

export function UserAvatar({ className }: { className?: string }) {
  return (
    <div className={cn("shrink-0 rounded-full bg-surface border border-border flex items-center justify-center text-muted-foreground", className)}>
      <User size={13} strokeWidth={2} />
    </div>
  );
}

const IDENTITY_HUES = [190, 262, 330, 25, 145, 210, 45, 285];

function hueForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return IDENTITY_HUES[hash % IDENTITY_HUES.length];
}

/** Deterministic colored initial avatar for a task/agent name — same name always gets the same color, so items are easy to tell apart at a glance in a list. */
export function IdentityAvatar({ name, className }: { name: string; className?: string }) {
  const hue = hueForName(name || "?");
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      className={cn("shrink-0 rounded-full flex items-center justify-center text-xs font-semibold", className)}
      style={{ backgroundColor: `hsl(${hue} 65% 20%)`, color: `hsl(${hue} 85% 72%)` }}
    >
      {initial}
    </div>
  );
}
