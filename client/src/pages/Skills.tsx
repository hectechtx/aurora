import { useState } from "react";
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
import { Puzzle, Download } from "lucide-react";

interface SkillTool { name: string; description: string; risk: string; }
interface InstalledSkill {
  id: number; name: string; description: string; sourceRepo: string; sourceRef: string;
  status: string; riskDefault: string; tools: string; installedAt: number;
}

export default function Skills() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");

  const { data: skills = [], isLoading } = useQuery<InstalledSkill[]>({ queryKey: ["/api/skills"], refetchInterval: 5000 });

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
      <PageHeader title="Skills" description="Capabilities downloaded from GitHub. Nothing runs until you approve it." />

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

      <div className="space-y-3">
        {skills.map((s) => {
          let tools: SkillTool[] = [];
          try { tools = JSON.parse(s.tools); } catch { /* ignore */ }
          return (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-sm">{s.name}</h3>
                    <StatusBadge status={s.status} />
                    <RiskBadge risk={s.riskDefault} />
                  </div>
                  <p className="text-sm text-muted-foreground mt-1.5">{s.description}</p>
                  <p className="text-xs text-muted-foreground/70 mt-1.5 font-mono">{s.sourceRepo}@{s.sourceRef}</p>
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
