import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { Trash2, Search, BrainCircuit } from "lucide-react";

interface Note { id: number; label: string; value: string; createdAt: number; }

export default function Memory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [query, setQuery] = useState("");

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: [`/api/notes?q=${encodeURIComponent(query)}`],
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/notes/${id}`).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/notes?q=${encodeURIComponent(query)}`] });
      toast({ title: "Note deleted", variant: "default" });
    },
    onError: (err: Error) => toast({ title: "Couldn't delete note", description: err.message, variant: "error" }),
  });

  return (
    <div className="p-8 max-w-3xl mx-auto overflow-y-auto h-screen">
      <PageHeader title="Memory" description="Notes AURORA has saved about you, shared across every task." />

      <div className="relative mb-5">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes…" className="pl-9" />
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && notes.length === 0 && (
        <EmptyState icon={BrainCircuit} title={query ? "No matches" : "No notes yet"} description={query ? "Try a different search term." : "AURORA will save notes here as it learns things about you."} />
      )}

      <div className="space-y-2">
        {notes.map((n) => (
          <Card key={n.id} className="p-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{n.label}</div>
              <div className="text-sm text-muted-foreground mt-1 leading-relaxed">{n.value}</div>
              <div className="text-xs text-muted-foreground/70 mt-2">{timeAgo(n.createdAt)}</div>
            </div>
            <button
              onClick={() => remove.mutate(n.id)}
              title="Delete note"
              aria-label="Delete note"
              className="text-muted-foreground hover:text-risk-high shrink-0 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}
