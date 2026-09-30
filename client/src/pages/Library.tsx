import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { timeAgo, cn } from "@/lib/utils";
import { getToken } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Input } from "@/components/ui/Input";
import { StatusBadge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { AuthedVideo } from "@/components/ui/AuthedVideo";
import { MediaModal } from "@/components/ui/MediaModal";
import { Image as ImageIcon, Download, Trash2, Search, FileText, ArrowUpRight, FolderCode, FolderOpen, RotateCcw, Trash } from "lucide-react";

interface Creation { id: number; taskId: number | null; agentId: number | null; kind: string; prompt: string; title: string | null; filePath: string; createdAt: number; deletedAt: number | null; }
interface Deliverable { id: number; agentId: number; title: string; description: string; body: string; creationId: number | null; status: string; createdAt: number; }
interface AgentItem { id: number; name: string; }

type Tab = "all" | "image" | "video" | "project" | "deliverable" | "trash";

/**
 * /creations is bearer-token-only (no cookie fallback — see AuthedImage), so
 * a plain <a href> or window.open(url) can't carry the Authorization header.
 * Fetching the bytes ourselves and handing the browser a blob URL is what
 * actually works for both "view full size" and "save this file".
 */
async function fetchCreationBlob(filePath: string): Promise<Blob> {
  const res = await fetch(`/creations/${filePath}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) throw new Error(`Couldn't load file (${res.status})`);
  return res.blob();
}

export default function Library() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [viewing, setViewing] = useState<Creation | null>(null);

  const { data: creations = [], isLoading } = useQuery<Creation[]>({ queryKey: ["/api/creations"], refetchInterval: 5000 });
  const { data: deliverables = [], isLoading: deliverablesLoading } = useQuery<Deliverable[]>({ queryKey: ["/api/deliverables"], refetchInterval: 5000 });
  const { data: agentsList = [] } = useQuery<AgentItem[]>({ queryKey: ["/api/agents"] });

  const { data: trashed = [] } = useQuery<Creation[]>({ queryKey: ["/api/creations/trash"], refetchInterval: 8000 });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["/api/creations"] });
    qc.invalidateQueries({ queryKey: ["/api/creations/trash"] });
  }

  const deleteCreation = useMutation({
    mutationFn: (id: number) => fetch(`/api/creations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken() ?? ""}` } }),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Moved to Recycle Bin", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete", description: err.message, variant: "error" }),
  });

  const restoreCreation = useMutation({
    mutationFn: (id: number) => fetch(`/api/creations/${id}/restore`, { method: "POST", headers: { Authorization: `Bearer ${getToken() ?? ""}` } }),
    onSuccess: () => { invalidateAll(); toast({ title: "Restored", variant: "success" }); },
    onError: (err: Error) => toast({ title: "Couldn't restore", description: err.message, variant: "error" }),
  });

  const purgeCreation = useMutation({
    mutationFn: (id: number) => fetch(`/api/creations/${id}/forever`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken() ?? ""}` } }),
    onSuccess: () => { invalidateAll(); toast({ title: "Deleted permanently", variant: "success" }); },
    onError: (err: Error) => toast({ title: "Couldn't delete", description: err.message, variant: "error" }),
  });

  const revealProject = useMutation({
    mutationFn: (id: number) => fetch(`/api/creations/${id}/reveal`, { method: "POST", headers: { Authorization: `Bearer ${getToken() ?? ""}` } }).then((r) => r.json()),
    onError: (err: Error) => toast({ title: "Couldn't open folder", description: err.message, variant: "error" }),
  });

  async function handleDownload(c: Creation) {
    try {
      const blob = await fetchCreationBlob(c.filePath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = c.filePath;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: "Couldn't download", description: err instanceof Error ? err.message : String(err), variant: "error" });
    }
  }

  function handleDelete(c: Creation) {
    deleteCreation.mutate(c.id);
  }

  function handlePurge(c: Creation) {
    if (!window.confirm(`Permanently delete this ${c.kind}? This can't be undone.`)) return;
    purgeCreation.mutate(c.id);
  }

  function agentName(agentId: number | null): string | null {
    if (agentId === null) return null;
    return agentsList.find((a) => a.id === agentId)?.name ?? null;
  }

  const q = search.trim().toLowerCase();
  const filteredCreations = useMemo(
    () => creations.filter((c) => (tab === "all" || tab === c.kind) && (!q || c.prompt.toLowerCase().includes(q) || c.title?.toLowerCase().includes(q))),
    [creations, tab, q],
  );
  const filteredDeliverables = useMemo(
    () =>
      (tab === "all" || tab === "deliverable"
        ? deliverables.filter((d) => !q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q))
        : []),
    [deliverables, tab, q],
  );

  const imageCount = creations.filter((c) => c.kind === "image").length;
  const videoCount = creations.filter((c) => c.kind === "video").length;
  const projectCount = creations.filter((c) => c.kind === "project").length;
  const totalLoading = isLoading || deliverablesLoading;
  const nothingAtAll = !totalLoading && tab !== "trash" && creations.length === 0 && deliverables.length === 0;
  const nothingMatches = !totalLoading && tab !== "trash" && !nothingAtAll && filteredCreations.length === 0 && filteredDeliverables.length === 0;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "all", label: "All", count: creations.length + deliverables.length },
    { key: "image", label: "Images", count: imageCount },
    { key: "video", label: "Videos", count: videoCount },
    { key: "project", label: "Projects", count: projectCount },
    { key: "deliverable", label: "Deliverables", count: deliverables.length },
    { key: "trash", label: "Recycle Bin", count: trashed.length },
  ];

  return (
    <div className="p-8 max-w-6xl mx-auto overflow-y-auto h-screen">
      <PageHeader
        title="Library"
        description="Everything AURORA has made — images, videos, and finished deliverables from any task or agent, all in one place."
      />

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by prompt or title…" className="pl-9" />
        </div>
        <div className="flex gap-1.5 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "text-xs rounded-full border px-3 py-1.5 transition-colors whitespace-nowrap",
                tab === t.key ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label} <span className="opacity-60">{t.count}</span>
            </button>
          ))}
        </div>
      </div>

      {totalLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}
        </div>
      )}

      {nothingAtAll && (
        <EmptyState
          icon={ImageIcon}
          title="Nothing generated yet"
          description="Set up image or video generation in Settings, then ask AURORA to make you something from any task — or have an agent save a deliverable."
        />
      )}

      {nothingMatches && (
        <EmptyState icon={Search} title="No matches" description="Try a different search term or tab." />
      )}

      {!totalLoading && (filteredCreations.length > 0 || filteredDeliverables.length > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {filteredCreations.map((c) => (
            <div
              key={`c${c.id}`}
              className="group relative rounded-lg border border-border bg-card overflow-hidden hover:border-primary/50 hover:shadow-panel transition-all duration-200"
            >
              <button
                onClick={() => (c.kind === "project" ? revealProject.mutate(c.id) : setViewing(c))}
                className="block w-full text-left"
                title={c.kind === "project" ? "Open folder" : "Open"}
              >
                {c.kind === "image" && (
                  <div className="aspect-square bg-surface overflow-hidden">
                    <AuthedImage src={`/creations/${c.filePath}`} alt={c.prompt} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                  </div>
                )}
                {c.kind === "video" && (
                  <div className="aspect-square bg-surface overflow-hidden">
                    <AuthedVideo src={`/creations/${c.filePath}`} className="w-full h-full object-cover" />
                  </div>
                )}
                {c.kind === "project" && (
                  <div className="aspect-square bg-surface flex items-center justify-center">
                    <FolderCode size={28} className="text-muted-foreground/50" />
                  </div>
                )}
                <div className="p-2.5">
                  <p className="text-xs line-clamp-2 text-foreground/90" title={c.title ?? c.prompt}>{c.title ?? c.prompt}</p>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <p className="text-[11px] text-muted-foreground">{timeAgo(c.createdAt)}</p>
                    {agentName(c.agentId) && <p className="text-[11px] text-muted-foreground/70">· {agentName(c.agentId)}</p>}
                  </div>
                </div>
              </button>

              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {c.kind === "project" ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); revealProject.mutate(c.id); }}
                    title="Open folder"
                    aria-label="Open folder"
                    className="h-7 w-7 rounded-md bg-background/90 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <FolderOpen size={13} />
                  </button>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDownload(c); }}
                    title="Save to your computer"
                    aria-label="Save to your computer"
                    className="h-7 w-7 rounded-md bg-background/90 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    <Download size={13} />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(c); }}
                  title="Delete"
                  aria-label="Delete"
                  disabled={deleteCreation.isPending}
                  className="h-7 w-7 rounded-md bg-background/90 border border-border flex items-center justify-center text-muted-foreground hover:text-risk-high"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}

          {filteredDeliverables.map((d) => (
            <Link
              key={`d${d.id}`}
              href="/outbox"
              className="group relative rounded-lg border border-border bg-card overflow-hidden hover:border-primary/50 hover:shadow-panel transition-all duration-200 flex flex-col"
            >
              <div className="aspect-square bg-surface flex items-center justify-center">
                <FileText size={28} className="text-muted-foreground/50" />
              </div>
              <div className="p-2.5 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs line-clamp-2 text-foreground/90 flex-1" title={d.title}>{d.title}</p>
                  <ArrowUpRight size={12} className="text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <StatusBadge status={d.status} />
                  <p className="text-[11px] text-muted-foreground">{timeAgo(d.createdAt)}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {tab === "trash" && (
        trashed.length === 0 ? (
          <EmptyState icon={Trash} title="Recycle Bin is empty" description="Items you delete from the Library land here first — you can restore them or delete them permanently." />
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">Deleted items are kept here until you remove them permanently. Restore anything you didn't mean to delete.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {trashed.map((c) => (
                <div key={`t${c.id}`} className="group relative rounded-lg border border-border bg-card overflow-hidden opacity-80 hover:opacity-100 transition-opacity">
                  <div className="aspect-square bg-surface overflow-hidden flex items-center justify-center">
                    {c.kind === "image" && <AuthedImage src={`/creations/${c.filePath}`} alt={c.prompt} className="w-full h-full object-cover" />}
                    {c.kind === "video" && <AuthedVideo src={`/creations/${c.filePath}`} className="w-full h-full object-cover" />}
                    {c.kind === "project" && <FolderCode size={28} className="text-muted-foreground/50" />}
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs line-clamp-2 text-foreground/90" title={c.title ?? c.prompt}>{c.title ?? c.prompt}</p>
                    <p className="text-[11px] text-muted-foreground mt-1.5">deleted {timeAgo(c.deletedAt ?? c.createdAt)}</p>
                  </div>
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => restoreCreation.mutate(c.id)}
                      title="Restore"
                      aria-label="Restore"
                      disabled={restoreCreation.isPending}
                      className="h-7 w-7 rounded-md bg-background/90 border border-border flex items-center justify-center text-muted-foreground hover:text-risk-low"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      onClick={() => handlePurge(c)}
                      title="Delete permanently"
                      aria-label="Delete permanently"
                      disabled={purgeCreation.isPending}
                      className="h-7 w-7 rounded-md bg-background/90 border border-border flex items-center justify-center text-muted-foreground hover:text-risk-high"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )
      )}

      {viewing && (viewing.kind === "image" || viewing.kind === "video") && (
        <MediaModal
          kind={viewing.kind}
          src={`/creations/${viewing.filePath}`}
          caption={viewing.title ?? viewing.prompt}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
