// Desktop notifications for agent activity that happens while you're not
// looking — a new deliverable in the Outbox, or an approval an agent (not
// you) triggered. Uses the standard Web Notification API directly: it works
// unmodified both in a plain browser tab (npm run dev) and inside the
// Electron shell, since Electron's renderer is just Chromium and passes
// Notification calls through to real OS notifications. No IPC/preload
// plumbing needed.
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

const ENABLED_KEY = "aurora-notifications-enabled";
const POLL_MS = 6000;

interface DeliverableRow { id: number; agentId: number; title: string; }
interface ApprovalRow { id: number; action: string; detail: string; status: string; }
interface AgentRow { id: number; name: string; }

interface NotificationsContextValue {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  enabled: boolean;
  setEnabled: (v: boolean) => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}

function fireNotification(title: string, body: string) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body });
  n.onclick = () => { window.focus(); n.close(); };
}

/**
 * Tracks "highest id already accounted for" per source, persisted to
 * localStorage rather than kept only in memory — an in-memory-only cursor
 * resets on every page reload or app restart, which for an app whose whole
 * point is unattended agents working while you're away means it would
 * silently swallow exactly the backlog this feature exists to surface (close
 * the app, agents work overnight, reopen — a memory-only cursor re-seeds to
 * "everything already seen" and nothing fires for what you missed).
 *
 * First-ever run (no persisted cursor yet) seeds silently to the current max
 * id without notifying, so opting in doesn't flood you with a notification
 * for every pre-existing item.
 */
function useNewItemCursor<T>(storageKey: string, items: T[] | undefined, enabled: boolean, getId: (item: T) => number, onNew: (item: T) => void) {
  const cursor = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !items) return;

    if (cursor.current === null) {
      const stored = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
      if (stored === null) {
        const seed = items.reduce((max, item) => Math.max(max, getId(item)), 0);
        cursor.current = seed;
        localStorage.setItem(storageKey, String(seed));
        return;
      }
      cursor.current = Number(stored);
    }

    let maxSeen = cursor.current;
    for (const item of items) {
      const id = getId(item);
      if (id <= cursor.current) continue;
      onNew(item);
      if (id > maxSeen) maxSeen = id;
    }
    if (maxSeen !== cursor.current) {
      cursor.current = maxSeen;
      localStorage.setItem(storageKey, String(maxSeen));
    }
    // onNew/getId are recreated each render but are cheap closures over
    // stable data — including them would re-run this on every render for no
    // reason, so the effect is intentionally keyed on the data + enabled flag only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, enabled, storageKey]);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [enabled, setEnabledState] = useState(() => typeof window !== "undefined" && localStorage.getItem(ENABLED_KEY) === "true");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => (supported ? Notification.permission : "unsupported"));

  // Notification.permission can change at any time behind our back (the user
  // blocks/allows it in OS or browser settings without AURORA reloading) —
  // re-read it periodically so Settings reflects reality instead of the
  // permission state from whenever this component happened to mount.
  useEffect(() => {
    if (!supported) return;
    const id = setInterval(() => setPermission(Notification.permission), POLL_MS);
    return () => clearInterval(id);
  }, [supported]);

  const { data: deliverables } = useQuery<DeliverableRow[]>({ queryKey: ["/api/deliverables"], refetchInterval: POLL_MS, enabled });
  const { data: approvals } = useQuery<ApprovalRow[]>({ queryKey: ["/api/approvals"], refetchInterval: POLL_MS, enabled });
  const { data: agentsList } = useQuery<AgentRow[]>({ queryKey: ["/api/agents"], refetchInterval: 30_000, enabled });

  useNewItemCursor("aurora-notif-cursor-deliverables", deliverables, enabled, (d) => d.id, (d) => {
    const agentName = agentsList?.find((a) => a.id === d.agentId)?.name ?? "An agent";
    fireNotification("New deliverable ready", `${agentName} finished "${d.title}" — check the Outbox.`);
  });

  useNewItemCursor("aurora-notif-cursor-approvals", approvals, enabled, (a) => a.id, (a) => {
    if (a.status !== "pending") return;
    // Only agent-originated approvals — a Terminal command or skill install
    // you composed yourself doesn't need a notification, you were right there.
    let isAgent = false;
    try { isAgent = JSON.parse(a.detail)?.context?.type === "agent"; } catch { /* not a tool_call approval */ }
    if (!isAgent) return;
    fireNotification("An agent needs your approval", `${a.action} is waiting in Approvals.`);
  });

  const setEnabled = useCallback(async (v: boolean) => {
    if (v && supported && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
    }
    setEnabledState(v);
    localStorage.setItem(ENABLED_KEY, String(v));
  }, [supported]);

  return (
    <NotificationsContext.Provider value={{ supported, permission, enabled, setEnabled }}>
      {children}
    </NotificationsContext.Provider>
  );
}
