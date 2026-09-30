import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/Toast";

export interface PullStatus { status: string; completed?: number; total?: number; done: boolean; error?: string; }

/** Shared pull-with-progress logic — used by Settings' free-text model pull and the onboarding screen's curated picker, so the polling/toast behavior can't drift between the two. */
export function usePullModel(onPulled?: (model: string) => void) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pulling, setPulling] = useState<string | null>(null);

  const pull = useMutation({
    mutationFn: (model: string) => apiRequest("POST", "/api/ollama/pull", { model }).then((r) => r.json()),
    onSuccess: (_data, model) => setPulling(model),
    onError: (err: Error) => toast({ title: "Couldn't start pull", description: err.message, variant: "error" }),
  });

  const { data: pullStatus } = useQuery<PullStatus>({
    queryKey: [`/api/ollama/pull-status?model=${encodeURIComponent(pulling ?? "")}`],
    enabled: !!pulling,
    refetchInterval: (q) => (q.state.data?.done ? false : 1500),
  });

  useEffect(() => {
    if (pullStatus?.done && pulling) {
      qc.invalidateQueries({ queryKey: ["/api/ollama/status"] });
      if (pullStatus.status === "success") {
        toast({ title: `Pulled "${pulling}"`, variant: "success" });
        onPulled?.(pulling);
      }
      if (pullStatus.status === "error") toast({ title: "Pull failed", description: pullStatus.error, variant: "error" });
    }
    // onPulled is a fresh closure every render; only re-run this when the pull itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pullStatus?.done]);

  return {
    pull: (model: string) => pull.mutate(model),
    pulling,
    pullStatus,
    isBusy: !!pulling && !pullStatus?.done,
  };
}
