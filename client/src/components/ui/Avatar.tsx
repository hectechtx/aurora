import { User } from "lucide-react";
import { cn } from "@/lib/utils";
import { AuthedImage } from "./AuthedImage";

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

/** Deterministic colored initial avatar for a task/agent name — same name always gets the same color, so items are easy to tell apart at a glance in a list. When `avatarPath` is set (a generated character portrait, see Agents.tsx), renders that image instead. */
export function IdentityAvatar({ name, avatarPath, className }: { name: string; avatarPath?: string | null; className?: string }) {
  if (avatarPath) {
    return (
      <AuthedImage
        src={`/creations/${avatarPath}`}
        alt={name}
        className={cn("shrink-0 rounded-full object-cover bg-surface", className)}
      />
    );
  }
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
