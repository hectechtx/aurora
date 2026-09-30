import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

// A Task turn or an agent tick now runs server-side in the background — the
// request that kicked it off resolves as soon as it *started*, not once it's
// finished (a call to generate_video can run for the better part of an
// hour). So "is AURORA still working on this" has to be read off the
// message/log entry itself: a fresh placeholder (no content, no tool calls
// yet) or a tool call still marked "pending" both mean it's still going.
export function isEntryInProgress(entry: { role: string; content: string; toolCalls: string | null } | undefined): boolean {
  if (!entry || entry.role !== "assistant") return false;
  if (!entry.content && !entry.toolCalls) return true;
  if (entry.toolCalls) {
    try {
      const calls = JSON.parse(entry.toolCalls) as { status: string }[];
      if (calls.some((t) => t.status === "pending")) return true;
    } catch { /* malformed, treat as not in progress */ }
  }
  return false;
}
