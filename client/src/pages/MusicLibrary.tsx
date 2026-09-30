import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useMusic } from "@/lib/music";
import { cn } from "@/lib/utils";
import { Music, Search, Play, Plus, Trash2, ListMusic, Download, HardDrive, X, Check, Loader2, CloudDownload } from "lucide-react";

interface LibTrack { file: string; source: "music" | "downloads"; }
interface ParsedTrack extends LibTrack { title: string; artist: string; }

interface Playlist { id: string; name: string; tracks: string[]; }
const PL_KEY = "aurora-playlists";
function loadPlaylists(): Playlist[] {
  try { return JSON.parse(localStorage.getItem(PL_KEY) || "[]"); } catch { return []; }
}
function savePlaylists(pls: Playlist[]) {
  try { localStorage.setItem(PL_KEY, JSON.stringify(pls)); } catch { /* ignore */ }
}

// "Artist - Title.mp3" → { artist, title }. Falls back to the whole filename
// as the title when there's no " - " separator.
function parse(t: LibTrack): ParsedTrack {
  const base = t.file.replace(/\.[^.]+$/, "");
  const dash = base.indexOf(" - ");
  if (dash > 0) return { ...t, artist: base.slice(0, dash).trim(), title: base.slice(dash + 3).trim() };
  return { ...t, artist: "", title: base.trim() };
}

type Filter = "all" | "music" | "downloads";

interface Candidate { id: string; title: string; uploader: string; duration: number; }

function fmtDur(s: number): string {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Find a song online and add it to the library — search shows candidates so
// you pick the right one, instead of blind-grabbing the first hit.
function FindAndAddSong({ onAdded }: { onAdded: () => void }) {
  const { toast } = useToast();
  const [song, setSong] = useState("");
  const [artist, setArtist] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [addedIds, setAddedIds] = useState<string[]>([]);

  const status = useQuery<{ installed: boolean }>({ queryKey: ["/api/musicsearch/status"] });

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicsearch/install").then((r) => r.json()),
    onSuccess: () => { status.refetch(); toast({ title: "Music search ready", variant: "success" }); },
    onError: (e: Error) => toast({ title: "Couldn't install", description: e.message, variant: "error" }),
  });

  const search = useMutation({
    mutationFn: () => apiRequest("POST", "/api/musicsearch/search", { query: [artist, song].filter(Boolean).join(" - ") }).then((r) => r.json()),
    onSuccess: (r: Candidate[]) => { setResults(r); if (r.length === 0) toast({ title: "No results", variant: "default" }); },
    onError: (e: Error) => toast({ title: "Search failed", description: e.message, variant: "error" }),
  });

  const add = useMutation({
    mutationFn: (id: string) => apiRequest("POST", "/api/musicsearch/add", { id }).then((r) => r.json()),
    onSuccess: (t: { title: string }, id) => {
      setAddedIds((p) => [...p, id]);
      toast({ title: `Added "${t.title}"`, description: "It's in your library now.", variant: "success" });
      onAdded();
    },
    onError: (e: Error) => toast({ title: "Couldn't add song", description: e.message, variant: "error" }),
  });

  const canSearch = !!(song.trim() || artist.trim());

  if (status.data && !status.data.installed) {
    return (
      <Card className="p-4 space-y-2">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><CloudDownload size={15} /> Find &amp; add songs</h3>
        <p className="text-xs text-muted-foreground">A one-time ~15MB download sets this up.</p>
        <Button variant="primary" size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
          {install.isPending && <Loader2 size={13} className="animate-spin" />} Set up music search
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium flex items-center gap-1.5"><CloudDownload size={15} /> Find &amp; add a song</h3>
      <div className="flex flex-wrap gap-2">
        <Input value={song} onChange={(e) => setSong(e.target.value)} placeholder="Song title…" className="flex-1 min-w-[160px]"
          onKeyDown={(e) => { if (e.key === "Enter" && canSearch) search.mutate(); }} />
        <Input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist (optional)…" className="flex-1 min-w-[140px]"
          onKeyDown={(e) => { if (e.key === "Enter" && canSearch) search.mutate(); }} />
        <Button variant="primary" onClick={() => search.mutate()} disabled={!canSearch || search.isPending}>
          {search.isPending ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Find
        </Button>
      </div>

      {results.length > 0 && (
        <div className="divide-y divide-border-subtle border border-border rounded-md">
          {results.map((r) => {
            const added = addedIds.includes(r.id);
            const busy = add.isPending && add.variables === r.id;
            return (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{r.title}</div>
                  <div className="text-xs text-muted-foreground truncate">{r.uploader}{r.duration ? ` · ${fmtDur(r.duration)}` : ""}</div>
                </div>
                <Button variant={added ? "ghost" : "outline"} size="sm" disabled={added || busy} onClick={() => add.mutate(r.id)}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : added ? <Check size={13} className="text-primary" /> : <Plus size={13} />}
                  {added ? "Added" : busy ? "Adding…" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function MusicLibrary() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const music = useMusic();
  const { data: lib = [] } = useQuery<LibTrack[]>({ queryKey: ["/api/music/library"], refetchInterval: 15_000 });

  const [q, setQ] = useState("");
  const [artistQ, setArtistQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [playlists, setPlaylists] = useState<Playlist[]>(loadPlaylists);
  const [selectedPl, setSelectedPl] = useState<string | null>(null);

  useEffect(() => savePlaylists(playlists), [playlists]);

  const parsed = lib.map(parse);
  const filtered = parsed.filter((t) => {
    if (filter !== "all" && t.source !== filter) return false;
    if (q && !(`${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase()))) return false;
    if (artistQ && !t.artist.toLowerCase().includes(artistQ.toLowerCase())) return false;
    return true;
  });

  function newPlaylist() {
    const name = prompt("Playlist name?")?.trim();
    if (!name) return;
    const pl: Playlist = { id: `${Date.now()}`, name, tracks: [] };
    setPlaylists((p) => [...p, pl]);
    setSelectedPl(pl.id);
  }
  function addToPlaylist(file: string) {
    if (!selectedPl) { toast({ title: "Pick a playlist first", description: "Select one above (or create one) to add songs to.", variant: "default" }); return; }
    setPlaylists((p) => p.map((pl) => pl.id === selectedPl ? { ...pl, tracks: pl.tracks.includes(file) ? pl.tracks : [...pl.tracks, file] } : pl));
    toast({ title: "Added to playlist", variant: "success" });
  }
  function removeFromPlaylist(plId: string, file: string) {
    setPlaylists((p) => p.map((pl) => pl.id === plId ? { ...pl, tracks: pl.tracks.filter((t) => t !== file) } : pl));
  }
  function deletePlaylist(plId: string) {
    setPlaylists((p) => p.filter((pl) => pl.id !== plId));
    if (selectedPl === plId) setSelectedPl(null);
  }

  const active = playlists.find((p) => p.id === selectedPl);
  const titleOf = (file: string) => parse({ file, source: "music" }).title;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Music" description="Everything AURORA has — your own tracks and downloaded songs, searchable, with playlists you build." />

      <FindAndAddSong onAdded={() => {
        qc.invalidateQueries({ queryKey: ["/api/music/library"] });
        qc.invalidateQueries({ queryKey: ["/api/music/tracks"] });
      }} />

      {/* Playlists */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium flex items-center gap-1.5"><ListMusic size={15} /> Playlists</h3>
          <Button variant="outline" size="sm" onClick={newPlaylist}><Plus size={13} /> New</Button>
        </div>
        {playlists.length === 0 && <p className="text-xs text-muted-foreground/70">No playlists yet — make one, then add songs from the list below.</p>}
        <div className="flex flex-wrap gap-2">
          {playlists.map((pl) => (
            <div key={pl.id} className={cn("flex items-center gap-1.5 rounded-full border pl-1 pr-2 py-1 text-xs", selectedPl === pl.id ? "border-primary bg-primary/10" : "border-border")}>
              <button onClick={() => music.playList(pl.tracks)} disabled={pl.tracks.length === 0} title="Play playlist" className="h-6 w-6 rounded-full bg-primary/15 text-primary flex items-center justify-center disabled:opacity-40">
                <Play size={12} />
              </button>
              <button onClick={() => setSelectedPl(selectedPl === pl.id ? null : pl.id)} className="font-medium">
                {pl.name} <span className="text-muted-foreground">({pl.tracks.length})</span>
              </button>
              <button onClick={() => deletePlaylist(pl.id)} className="text-muted-foreground hover:text-risk-high" title="Delete playlist"><X size={12} /></button>
            </div>
          ))}
        </div>
        {active && (
          <div className="border-t border-border-subtle pt-2 space-y-1">
            <div className="text-xs text-muted-foreground">Editing <span className="text-foreground font-medium">{active.name}</span> — click <Plus size={11} className="inline" /> on any song below to add it.</div>
            {active.tracks.map((f) => (
              <div key={f} className="flex items-center justify-between gap-2 text-sm py-0.5">
                <span className="truncate">{titleOf(f)}</span>
                <button onClick={() => removeFromPlaylist(active.id, f)} className="text-muted-foreground hover:text-risk-high shrink-0"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Search + filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or artist…" className="pl-9" />
        </div>
        <Input value={artistQ} onChange={(e) => setArtistQ(e.target.value)} placeholder="Artist…" className="max-w-[160px]" />
        <div className="flex rounded-lg border border-border p-0.5">
          {([["all", "All", Music], ["music", "My music", HardDrive], ["downloads", "Downloads", Download]] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setFilter(id)} className={cn("flex items-center gap-1 text-xs rounded-md px-2.5 py-1.5 transition-colors", filter === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Track list */}
      <Card className="p-2">
        {filtered.length === 0 && <div className="p-6"><EmptyState icon={Music} title="No songs" description={lib.length === 0 ? "Download songs from Settings → Music search, or set a music folder." : "Nothing matches your search."} /></div>}
        <div className="divide-y divide-border-subtle">
          {filtered.map((t) => {
            const playing = music.nowPlaying === t.file;
            return (
              <div key={t.file} className={cn("flex items-center gap-3 px-2 py-2 rounded-md", playing && "bg-primary/5")}>
                <button onClick={() => music.playTrack(t.file)} className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0", playing ? "bg-primary text-primary-foreground" : "bg-surface text-muted-foreground hover:text-foreground")} title="Play">
                  <Play size={14} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-sm truncate", playing && "text-primary font-medium")}>{t.title}</div>
                  <div className="text-xs text-muted-foreground truncate">{t.artist || "Unknown artist"}</div>
                </div>
                <span className={cn("text-[10px] rounded-full px-2 py-0.5 border shrink-0", t.source === "downloads" ? "border-accent/40 text-accent" : "border-border text-muted-foreground")}>
                  {t.source === "downloads" ? "downloaded" : "my music"}
                </span>
                <button onClick={() => addToPlaylist(t.file)} className="text-muted-foreground hover:text-primary shrink-0" title={active ? `Add to ${active.name}` : "Select a playlist first"}>
                  {active?.tracks.includes(t.file) ? <Check size={15} className="text-primary" /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
