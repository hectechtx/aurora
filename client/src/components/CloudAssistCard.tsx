import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Cloud, ExternalLink } from "lucide-react";

interface Provider {
  id: string; name: string; model: string; enabled: boolean; hasKey: boolean; keyless: boolean; rpm: number; rpd: number;
  signupUrl: string; note: string; usedToday: number; lastError: string; coolingDown: boolean;
}
interface CloudData { mode: "off" | "busy"; providers: Provider[]; gpu: { busy: boolean; job: string | null; waiting: number } }

/** Free cloud LLM providers that take agents' background thinking while the GPU renders media. */
export function CloudAssistCard() {
  const qc = useQueryClient();
  const { data } = useQuery<CloudData>({ queryKey: ["/api/cloud"], refetchInterval: 15_000 });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/cloud"] });

  async function save(p: Provider, patch: Record<string, unknown>) {
    await apiRequest("PUT", `/api/cloud/providers/${p.id}`, patch).catch(() => {});
    void refresh();
  }
  async function saveKey(p: Provider) {
    const key = keys[p.id]?.trim();
    if (!key) return;
    await save(p, { apiKey: key });
    setKeys((k) => ({ ...k, [p.id]: "" }));
    const r = await apiRequest("POST", `/api/cloud/providers/${p.id}/test`).then((x) => x.json()).catch(() => ({ result: "test failed" }));
    setResults((x) => ({ ...x, [p.id]: r.result }));
    void refresh();
  }
  async function loadModels(p: Provider) {
    const r = await apiRequest("GET", `/api/cloud/providers/${p.id}/models`).then((x) => x.json()).catch(() => ({ models: [] }));
    setModels((m) => ({ ...m, [p.id]: r.models ?? [] }));
  }

  const ready = (data?.providers ?? []).filter((p) => (p.hasKey || p.keyless) && p.enabled).length;
  return (
    <Card id="cloud" className="p-5 space-y-4 scroll-mt-16">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium"><Cloud size={15} /> Cloud assist (free LLM APIs)</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            While the GPU renders a video, talking clip, image or song, agents' background thinking goes to a free cloud provider instead of fighting
            for the graphics card. Your own chats with AURORA always stay on this PC. Free tiers may log what they receive — only add providers you're OK with.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{data?.mode === "off" ? "Off" : "On when the GPU is busy"}</span>
          <Switch label="Cloud assist" checked={data?.mode !== "off"} onCheckedChange={() => void apiRequest("PUT", "/api/cloud/mode", { mode: data?.mode === "off" ? "busy" : "off" }).then(refresh)} />
        </div>
      </div>
      <div className="rounded-md border border-border bg-surface/40 px-3 py-2 text-xs">
        GPU: {data?.gpu.busy ? <b>busy — {data.gpu.job}{data.gpu.waiting ? ` (+${data.gpu.waiting} queued)` : ""}</b> : "free"} ·
        {" "}{ready ? `${ready} provider${ready === 1 ? "" : "s"} ready` : "no providers set up yet — agents wait for the GPU"}
      </div>
      <div className="space-y-2">
        {(data?.providers ?? []).map((p) => (
          <div key={p.id} className={cn("rounded-lg border p-3", (p.hasKey || p.keyless) && p.enabled ? "border-primary/40" : "border-border")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{p.name} {p.hasKey && <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">key saved</span>}</div>
                <div className="text-[11px] text-muted-foreground">{p.note} Free limit ~{p.rpm}/min, {p.rpd}/day · used today: {p.usedToday}{p.coolingDown ? " · resting after a limit" : ""}</div>
              </div>
              <div className="flex items-center gap-2">
                <a href={p.signupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Get a free key <ExternalLink size={11} /></a>
                {(p.hasKey || p.keyless) && <Switch label={`Use ${p.name}`} checked={p.enabled} onCheckedChange={() => void save(p, { enabled: !p.enabled })} />}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input type="password" placeholder={p.hasKey ? "Replace API key…" : "Paste API key…"} value={keys[p.id] ?? ""} className="h-8 max-w-xs text-xs"
                onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))} />
              <Button size="sm" variant="outline" onClick={() => void saveKey(p)} disabled={!keys[p.id]?.trim()}>Save & test</Button>
              {p.hasKey && (
                <>
                  <span className="text-[11px] text-muted-foreground">Model:</span>
                  {models[p.id]?.length ? (
                    <select className="h-8 max-w-[16rem] rounded-md border border-border bg-transparent px-2 text-xs" value={p.model}
                      onChange={(e) => void save(p, { model: e.target.value })}>
                      {!models[p.id].includes(p.model) && p.model && <option value={p.model}>{p.model}</option>}
                      {models[p.id].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  ) : (
                    <button type="button" className="text-xs underline" onClick={() => void loadModels(p)}>{p.model || "auto"} (change)</button>
                  )}
                  {p.hasKey && <button type="button" className="text-xs text-muted-foreground underline" onClick={() => void save(p, { apiKey: "" })}>remove key</button>}
                </>
              )}
            </div>
            {(results[p.id] || p.lastError) && <div className={cn("mt-1.5 text-[11px]", /works/.test(results[p.id] ?? "") ? "text-risk-low" : "text-risk-high")}>{results[p.id] || `Last error: ${p.lastError}`}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}
