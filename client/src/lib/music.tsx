// Background music: a shuffled, looping playlist pulled from a folder the
// owner points AURORA at in Settings (see /api/music/tracks + the /music
// static mount in routes.ts). Lives above AppShell so it keeps playing
// across page navigation instead of restarting on every route change.
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./queryClient";
import { getToken } from "./queryClient";

interface AgentConfig { musicDir: string; musicEnabled: boolean; musicVolume: number; }

interface MusicContextValue {
  configured: boolean;
  enabled: boolean;
  volume: number;
  setVolume: (v: number) => void;
  tracks: string[];
  order: string[];
  currentIndex: number;
  nowPlaying: string | null;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  shuffle: () => void;
  playTrack: (name: string) => void;
  /** Replace the play order with a specific list (a playlist) and start it. */
  playList: (names: string[]) => void;
}

const MusicContext = createContext<MusicContextValue | null>(null);

export function useMusic(): MusicContextValue {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error("useMusic must be used within MusicProvider");
  return ctx;
}

/** Fisher-Yates — a fresh shuffled order each time the track list changes or the owner hits the shuffle button. */
function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function MusicProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: config } = useQuery<AgentConfig>({ queryKey: ["/api/config"], refetchInterval: 10_000 });
  // Always fetch — downloaded songs live in AURORA's own downloads folder and
  // should be playable even if the owner never set a personal music folder.
  const { data: tracks = [] } = useQuery<string[]>({
    queryKey: ["/api/music/tracks"],
    refetchInterval: 30_000,
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const orderRef = useRef<string[]>([]);
  const posRef = useRef(0);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  // Mirrors orderRef/posRef into render-visible state — refs alone don't
  // trigger a re-render, and the player panel needs to show the live order
  // and highlight the current track.
  const [order, setOrder] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Bumped on every playAt() call; a fetch only applies its result if it's
  // still the most recent request when it resolves. Without this, clicking
  // next/shuffle/a track in quick succession lets a slower-resolving older
  // fetch land after a newer one and clobber it with the wrong track.
  const requestIdRef = useRef(0);

  if (!audioRef.current && typeof window !== "undefined") {
    audioRef.current = new Audio();
  }

  const playAt = useCallback((index: number, order2?: string[]) => {
    const activeOrder = order2 ?? orderRef.current;
    if (activeOrder.length === 0 || !audioRef.current) return;
    const normalized = ((index % activeOrder.length) + activeOrder.length) % activeOrder.length;
    const track = activeOrder[normalized];
    posRef.current = normalized;
    setCurrentIndex(normalized);
    const requestId = ++requestIdRef.current;
    fetch(`/music/${encodeURIComponent(track)}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((blob) => {
        if (requestId !== requestIdRef.current) return; // superseded by a newer request
        const audio = audioRef.current;
        if (!audio) return;
        const prevSrc = audio.src;
        audio.src = URL.createObjectURL(blob);
        if (prevSrc) URL.revokeObjectURL(prevSrc);
        setNowPlaying(track);
        audio.play().catch(() => {});
      })
      .catch(() => {});
  }, []);

  const next = useCallback(() => playAt(posRef.current + 1), [playAt]);
  const previous = useCallback(() => playAt(posRef.current - 1), [playAt]);

  const playTrack = useCallback((name: string) => {
    const idx = orderRef.current.indexOf(name);
    if (idx >= 0) playAt(idx);
    else { orderRef.current = [name]; setOrder([name]); playAt(0, [name]); }
  }, [playAt]);

  const playList = useCallback((names: string[]) => {
    if (names.length === 0) return;
    orderRef.current = names;
    setOrder(names);
    playAt(0, names);
  }, [playAt]);

  const shuffle = useCallback(() => {
    if (tracks.length === 0) return;
    const next2 = shuffled(tracks);
    orderRef.current = next2;
    setOrder(next2);
    playAt(0, next2);
  }, [tracks, playAt]);

  // Reshuffle whenever the track list actually changes (new folder, files added/removed).
  useEffect(() => {
    if (tracks.length === 0) {
      orderRef.current = [];
      setOrder([]);
      return;
    }
    const initial = shuffled(tracks);
    orderRef.current = initial;
    setOrder(initial);
    posRef.current = -1;
    if (config?.musicEnabled) playAt(0, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks.join("|")]);

  // 'ended' listener registered once — next always reads the latest posRef/orderRef via closures over refs, not stale state.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.addEventListener("ended", next);
    return () => audio.removeEventListener("ended", next);
  }, [next]);

  // Play/pause follows the toggle; volume applies continuously.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(100, config?.musicVolume ?? 35)) / 100;
    if (config?.musicEnabled) {
      if (!audio.src && orderRef.current.length > 0) playAt(posRef.current < 0 ? 0 : posRef.current);
      else audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [config?.musicEnabled, config?.musicVolume, playAt]);

  const togglePlay = useCallback(() => {
    apiRequest("PATCH", "/api/config", { musicEnabled: !config?.musicEnabled }).then(() => qc.invalidateQueries({ queryKey: ["/api/config"] }));
  }, [config?.musicEnabled, qc]);

  const setVolume = useCallback((v: number) => {
    apiRequest("PATCH", "/api/config", { musicVolume: Math.max(0, Math.min(100, v)) }).then(() => qc.invalidateQueries({ queryKey: ["/api/config"] }));
  }, [qc]);

  return (
    <MusicContext.Provider value={{
      configured: !!config?.musicDir,
      enabled: !!config?.musicEnabled,
      volume: config?.musicVolume ?? 35,
      setVolume,
      tracks,
      order,
      currentIndex,
      nowPlaying,
      togglePlay,
      next,
      previous,
      shuffle,
      playTrack,
      playList,
    }}>
      {children}
    </MusicContext.Provider>
  );
}
