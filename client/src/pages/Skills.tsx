import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { RiskBadge, StatusBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { Puzzle, Download, Sparkles, Search } from "lucide-react";

interface SkillTool { name: string; description: string; risk: string; }
interface InstalledSkill {
  id: number; name: string; description: string; sourceRepo: string; sourceRef: string;
  status: string; riskDefault: string; tools: string; manifest: string; installedAt: number;
}
interface StarterSkillSummary {
  id: string; name: string; description: string; risk: string; toolNames: string[]; category: string;
}

/**
 * Installed skills don't have their own category column — the bundled
 * starter ones carry it inside their stored manifest JSON, so pull it from
 * there instead of adding a migration for one derived field. Falls back to
 * looking the id up in the live starter catalog for anything installed
 * before categories existed (its stored manifest snapshot predates the
 * field), so those don't all dump into "Other" just because of when they
 * happened to be installed.
 */
function installedCategory(s: InstalledSkill, starterCatalog: StarterSkillSummary[]): string {
  try {
    const parsed = JSON.parse(s.manifest);
    if (typeof parsed.category === "string" && parsed.category) return parsed.category;
  } catch { /* not bundled, or malformed — falls through */ }
  if (s.sourceRepo.startsWith("aurora-starter/")) {
    const id = s.sourceRepo.slice("aurora-starter/".length);
    const fromCatalog = starterCatalog.find((c) => c.id === id)?.category;
    if (fromCatalog) return fromCatalog;
  }
  return "Other";
}

export default function Skills() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const { data: skills = [], isLoading } = useQuery<InstalledSkill[]>({ queryKey: ["/api/skills"], refetchInterval: 5000 });
  const { data: starterCatalog = [], isLoading: starterLoading } = useQuery<StarterSkillSummary[]>({ queryKey: ["/api/skills/starter-catalog"] });

  const installedStarterIds = new Set(
    skills.filter((s) => s.sourceRepo.startsWith("aurora-starter/")).map((s) => s.sourceRepo.slice("aurora-starter/".length)),
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const s of starterCatalog) set.add(s.category);
    for (const s of skills) set.add(installedCategory(s, starterCatalog));
    return Array.from(set).sort();
  }, [starterCatalog, skills]);

  const q = search.trim().toLowerCase();
  const matches = (name: string, description: string) =>
    !q || name.toLowerCase().includes(q) || description.toLowerCase().includes(q);

  const filteredStarter = starterCatalog.filter(
    (s) => matches(s.name, s.description) && (!category || s.category === category),
  );
  const filteredInstalled = skills.filter(
    (s) => matches(s.name, s.description) && (!category || installedCategory(s, starterCatalog) === category),
  );
  const filtering = q.length > 0 || category !== null;

  const installStarter = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/skills/starter/${id}/install`).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      toast({ title: "Staged for review", description: "Check Approvals to enable it.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Install failed", description: err.message, variant: "error" }),
  });

  const install = useMutation({
    mutationFn: () => apiRequest("POST", "/api/skills/install", {
      repoUrl, ref: ref || undefined, subpath: subpath || undefined,
    }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      setRepoUrl(""); setRef(""); setSubpath("");
      toast({ title: "Staged for review", description: "Check Approvals to enable it.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Install failed", description: err.message, variant: "error" }),
  });

  const disable = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/skills/${id}/disable`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't disable skill", description: err.message, variant: "error" }),
  });
  const enable = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/skills/${id}/enable`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't enable skill", description: err.message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/skills/${id}`).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/skills"] }),
    onError: (err: Error) => toast({ title: "Couldn't delete skill", description: err.message, variant: "error" }),
  });

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Skills" description="Capabilities AURORA can use. Nothing runs until you approve it." />

      <div className="space-y-2.5">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills by name or description…"
            className="pl-9"
          />
        </div>
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setCategory(null)}
              className={cn(
                "text-xs rounded-full border px-2.5 py-1 transition-colors",
                category === null ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c === category ? null : c)}
                className={cn(
                  "text-xs rounded-full border px-2.5 py-1 transition-colors",
                  category === c ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-2"><Sparkles size={14} /> Starter skills</h2>
        <p className="text-xs text-muted-foreground">Bundled with AURORA — no download needed. Same review-and-approve gate as anything from GitHub.</p>
        {starterLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {!starterLoading && starterCatalog.length === 0 && (
          <p className="text-xs text-muted-foreground/70">No starter skills bundled in this build.</p>
        )}
        {!starterLoading && starterCatalog.length > 0 && filteredStarter.length === 0 && (
          <p className="text-xs text-muted-foreground/70">No starter skills match{filtering ? " this search/category" : ""}.</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filteredStarter.map((s) => {
            const installed = installedStarterIds.has(s.id);
            return (
              <div key={s.id} className="rounded-md border border-border p-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{s.name}</span>
                    <RiskBadge risk={s.risk} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">{s.category}</p>
                </div>
                <Button
                  variant={installed ? "outline" : "secondary"}
                  size="sm"
                  disabled={installed || installStarter.isPending}
                  onClick={() => installStarter.mutate(s.id)}
                  className="shrink-0"
                >
                  {installed ? "Installed" : "Install"}
                </Button>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium flex items-center gap-2"><Download size={14} /> Install from GitHub</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="owner/repo or GitHub URL" className="sm:col-span-3" />
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="branch/tag (optional)" />
          <Input value={subpath} onChange={(e) => setSubpath(e.target.value)} placeholder="subpath (optional)" className="sm:col-span-2" />
        </div>
        <Button variant="primary" onClick={() => install.mutate()} disabled={install.isPending || !repoUrl.trim()}>
          {install.isPending ? "Downloading…" : "Download + stage for review"}
        </Button>
      </Card>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!isLoading && skills.length === 0 && (
        <EmptyState icon={Puzzle} title="No skills installed" description="Install one from a GitHub repo above to give AURORA a new capability." />
      )}

      {!isLoading && skills.length > 0 && filteredInstalled.length === 0 && (
        <p className="text-xs text-muted-foreground/70">No installed skills match{filtering ? " this search/category" : ""}.</p>
      )}

      <div className="space-y-3">
        {filteredInstalled.map((s) => {
          let tools: SkillTool[] = [];
          try { tools = JSON.parse(s.tools); } catch { /* ignore */ }
          let hasInstructions = false;
          try { hasInstructions = !!(JSON.parse(s.manifest) as { instructions?: string }).instructions; } catch { /* ignore */ }
          return (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm">{s.name}</h3>
                    <StatusBadge status={s.status} />
                    <RiskBadge risk={s.riskDefault} />
                    {hasInstructions && (
                      <span
                        title="Knowledge skill — its instructions are folded into the model's context while enabled"
                        className="text-[10px] rounded-full border border-accent/40 bg-accent/10 text-accent px-2 py-0.5 font-medium"
                      >
                        knowledge
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1.5">{s.description}</p>
                  <p className="text-xs text-muted-foreground/70 mt-1.5 font-mono">{s.sourceRepo}@{s.sourceRef}</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">{installedCategory(s, starterCatalog)}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {s.status === "enabled" && <Button variant="outline" size="sm" onClick={() => disable.mutate(s.id)}>Disable</Button>}
                  {s.status === "disabled" && <Button variant="outline" size="sm" onClick={() => enable.mutate(s.id)}>Enable</Button>}
                  {s.status !== "pending_review" && <Button variant="destructive" size="sm" onClick={() => remove.mutate(s.id)}>Delete</Button>}
                </div>
              </div>
              {tools.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {tools.map((t) => (
                    <span key={t.name} title={t.description} className="text-xs rounded-full border border-border px-2.5 py-1 text-muted-foreground font-mono">{t.name}</span>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
