import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { timeAgo, cn } from "@/lib/utils";
import { FolderKanban, Plus, Trash2, ListTodo, ArrowRight, X } from "lucide-react";

interface Project { id: number; name: string; description: string; instructions: string; color: string; createdAt: number; updatedAt: number; }
interface Task { id: number; title: string; status: string; projectId: number | null; updatedAt: number; }

export default function Projects() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  const { data: projects = [], isLoading } = useQuery<Project[]>({ queryKey: ["/api/projects"], refetchInterval: 8000 });
  const { data: tasks = [] } = useQuery<Task[]>({ queryKey: ["/api/tasks"], refetchInterval: 8000 });

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/projects", { name, description: description || undefined, instructions: instructions || undefined }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      setCreating(false); setName(""); setDescription(""); setInstructions("");
      toast({ title: "Project created", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Couldn't create project", description: err.message, variant: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/projects/${id}`).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/projects"] });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: "Project deleted", description: "Its tasks were kept and un-grouped.", variant: "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete project", description: err.message, variant: "error" }),
  });

  const countFor = (id: number) => tasks.filter((t) => t.projectId === id).length;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Projects" description="Group related tasks under one roof — a home for a body of work, its context, and everything it produces." />

      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">{projects.length} project{projects.length === 1 ? "" : "s"}</span>
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New Project</>}
        </Button>
      </div>

      {creating && (
        <Card className="p-5 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. YouTube Channel Launch" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description <span className="text-muted-foreground/60">(optional)</span></label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What this project is about." />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Standing instructions <span className="text-muted-foreground/60">(optional)</span></label>
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Context or house rules that apply to every task in this project." />
          </div>
          <Button variant="primary" onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>Create Project</Button>
        </Card>
      )}

      {isLoading && <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>}
      {!isLoading && projects.length === 0 && !creating && (
        <EmptyState icon={FolderKanban} title="No projects yet" description="Create one to group related tasks together." />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {projects.map((p) => (
          <Card key={p.id} className="p-5 group relative overflow-hidden">
            <div className={cn("absolute inset-x-0 top-0 h-1", p.color === "primary" ? "bg-primary" : "bg-accent")} />
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium flex items-center gap-2"><FolderKanban size={15} className="text-primary" /> {p.name}</h3>
              <button
                onClick={() => { if (confirm(`Delete project "${p.name}"? Its tasks are kept (just un-grouped).`)) remove.mutate(p.id); }}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-risk-high transition-opacity"
                title="Delete project"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {p.description && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{p.description}</p>}
            <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><ListTodo size={12} /> {countFor(p.id)} task{countFor(p.id) === 1 ? "" : "s"}</span>
              <span>· updated {timeAgo(p.updatedAt)}</span>
            </div>
            <Link href="/tasks" className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Open in Tasks <ArrowRight size={12} />
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
