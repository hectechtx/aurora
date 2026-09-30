import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useMusic } from "@/lib/music";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { Music, SkipBack, SkipForward, Play, Pause, Shuffle, Search, Loader2, Download } from "lucide-react";

function trackLabel(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** Sidebar trigger + expandable panel — prev/play-pause/next, a shuffle button that reshuffles the whole playlist, a volume slider, and the full track list so you can jump to any song directly. */
export function MusicPlayer() {
  const music = useMusic();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const searchStatus = useQuery<{ installed: boolean }>({ queryKey: ["/api/musicsearch/status"], enabled: open });

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicsearch/install").then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/musicsearch/status"] }),
    onError: (err: Error) => toast({ title: "Couldn't set up song search", description: err.message, variant: "error" }),
  });

  const download = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicsearch/download", { query }).then((r) => r.json()),
    onSuccess: (track: { title: string }) => {
      setQuery("");
      qc.invalidateQueries({ queryKey: ["/api/music/tracks"] });
      toast({ title: `Added "${track.title}"`, variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't find that song", description: err.message, variant: "error" }),
  });

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  if (!music.configured) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Open music player"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 min-w-0 w-full text-left"
      >
        <Music size={12} className={cn("shrink-0", music.enabled ? "text-primary" : "text-muted-foreground")} />
        <span className="text-xs text-muted-foreground truncate flex-1">
          {music.enabled && music.nowPlaying ? trackLabel(music.nowPlaying) : "Music"}
        </span>
      </button>

      {open && (
        <div role="menu" className="absolute bottom-full left-0 mb-2 w-72 rounded-lg border border-border bg-card shadow-panel z-20 overflow-hidden">
          <div className="p-3 border-b border-border">
            <p className="text-xs font-medium truncate" title={music.nowPlaying ?? undefined}>
              {music.nowPlaying ? trackLabel(music.nowPlaying) : "Nothing playing"}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {music.tracks.length} track{music.tracks.length === 1 ? "" : "s"}
            </p>

            <div className="flex items-center justify-center gap-3 mt-3">
              <button onClick={music.previous} title="Previous track" aria-label="Previous track" className="text-muted-foreground hover:text-foreground">
                <SkipBack size={16} />
              </button>
              <button
                onClick={music.togglePlay}
                title={music.enabled ? "Pause" : "Play"}
                aria-label={music.enabled ? "Pause" : "Play"}
                className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:opacity-90"
              >
                {music.enabled ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <button onClick={music.next} title="Next track" aria-label="Next track" className="text-muted-foreground hover:text-foreground">
                <SkipForward size={16} />
              </button>
              <button
                onClick={music.shuffle}
                title="Randomize the playlist"
                aria-label="Randomize the playlist"
                className="text-muted-foreground hover:text-primary"
              >
                <Shuffle size={15} />
              </button>
            </div>

            <div className="flex items-center gap-2 mt-3">
              <input
                type="range"
                min={0}
                max={100}
                value={music.volume}
                onChange={(e) => music.setVolume(Number(e.target.value))}
                className="flex-1 accent-primary h-1"
              />
              <span className="text-[10px] text-muted-foreground w-7 text-right">{music.volume}%</span>
            </div>
          </div>

          {music.order.length > 0 && (
            <div className="max-h-48 overflow-y-auto py-1">
              {music.order.map((track, i) => (
                <button
                  key={track}
                  role="menuitem"
                  onClick={() => music.playTrack(track)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface transition-colors truncate",
                    i === music.currentIndex ? "text-primary font-medium" : "text-muted-foreground",
                  )}
                  title={track}
                >
                  {i === music.currentIndex && music.enabled && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 animate-pulse" />}
                  <span className="truncate">{trackLabel(track)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="p-2.5 border-t border-border">
            {searchStatus.data?.installed ? (
              <form
                onSubmit={(e) => { e.preventDefault(); if (query.trim() && !download.isPending) download.mutate(); }}
                className="flex items-center gap-1.5"
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find & add a song…"
                  disabled={download.isPending}
                  className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={!query.trim() || download.isPending}
                  title="Search and add"
                  aria-label="Search and add"
                  className="h-7 w-7 shrink-0 rounded-md bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-40"
                >
                  {download.isPending ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                </button>
              </form>
            ) : (
              <button
                onClick={() => install.mutate()}
                disabled={install.isPending}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-1"
              >
                {install.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {install.isPending ? "Setting up…" : "Enable song search"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
