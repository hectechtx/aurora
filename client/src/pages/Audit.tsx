import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Card } from "@/components/ui/Card";
import { timeAgo } from "@/lib/utils";
import { ScrollText } from "lucide-react";

interface AuditEntry { id: number; ts: number; actor: string; action: string; target: string; outcome: string; }

export default function Audit() {
  const { data: entries = [], isLoading } = useQuery<AuditEntry[]>({ queryKey: ["/api/audit"], refetchInterval: 5000 });

  return (
    <div className="p-8 max-w-4xl mx-auto overflow-y-auto h-screen">
      <PageHeader title="Audit Log" description="Every meaningful thing the vessel did or was asked to do." />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <EmptyState icon={ScrollText} title="No activity yet" description="Actions the vessel takes will show up here." />
      )}

      {!isLoading && entries.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-40" />
              <col />
              <col className="w-24" />
            </colgroup>
            <thead className="bg-surface text-[11px] uppercase tracking-wider text-muted-foreground/70">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">When</th>
                <th className="text-left px-4 py-2.5 font-medium">Actor</th>
                <th className="text-left px-4 py-2.5 font-medium">Action</th>
                <th className="text-left px-4 py-2.5 font-medium">Target</th>
                <th className="text-left px-4 py-2.5 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-border-subtle hover:bg-surface/60 transition-colors">
                  <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{timeAgo(e.ts)}</td>
                  <td className="px-4 py-2.5 font-medium truncate" title={e.actor}>{e.actor}</td>
                  <td className="px-4 py-2.5 truncate" title={e.action}>{e.action}</td>
                  <td className="px-4 py-2.5 text-muted-foreground truncate font-mono text-xs" title={e.target}>{e.target}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={e.outcome} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
