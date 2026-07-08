import { useQuery } from "@tanstack/react-query";
import { timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ImageIcon } from "lucide-react";

interface Creation { id: number; taskId: number | null; kind: string; prompt: string; filePath: string; createdAt: number; }

export default function Library() {
  const { data: creations = [], isLoading } = useQuery<Creation[]>({ queryKey: ["/api/creations"], refetchInterval: 5000 });

  return (
    <div className="p-8 max-w-6xl mx-auto overflow-y-auto h-screen">
      <PageHeader
        title="Library"
        description="Everything AURORA has generated. Ask it to make you an image from any task to add to this."
      />

      {isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-square" />)}
        </div>
      )}

      {!isLoading && creations.length === 0 && (
        <EmptyState
          icon={ImageIcon}
          title="Nothing generated yet"
          description="Set up an Image Gen host in Settings, then ask AURORA to generate an image from any task."
        />
      )}

      {!isLoading && creations.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {creations.map((c) => (
            <a
              key={c.id}
              href={`/creations/${c.filePath}`}
              target="_blank"
              rel="noreferrer"
              className="group rounded-lg border border-border bg-card overflow-hidden hover:border-primary/50 hover:shadow-panel transition-all duration-200"
            >
              {c.kind === "image" && (
                <div className="aspect-square bg-surface overflow-hidden">
                  <img src={`/creations/${c.filePath}`} alt={c.prompt} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                </div>
              )}
              <div className="p-2.5">
                <p className="text-xs line-clamp-2 text-foreground/90" title={c.prompt}>{c.prompt}</p>
                <p className="text-[11px] text-muted-foreground mt-1.5">{timeAgo(c.createdAt)}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
