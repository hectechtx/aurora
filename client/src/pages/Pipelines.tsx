import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, Select } from "@/components/ui/Input";
import { StatusBadge } from "@/components/ui/Badge";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { apiRequest } from "@/lib/queryClient";
import { ArrowRight, Play, Pause, Trash2, Plus, X, Workflow } from "lucide-react";

interface StageView { agentId: number; instruction: string; agentName: string; avatarPath: string | null }
interface RunView { id: number; status: string; stageIndex: number; startedAt: number; finishedAt: number | null; output: string | null }
interface PipelineView {
  id: number; name: string; description: string; active: boolean; scheduleMinutes: number | null; scheduleLabel: string;
  lastRunAt: number | null; stages: StageView[]; runs: RunView[];
}
interface AgentLite { id: number; name: string; isOverseer: boolean }

const SCHEDULES = [
  { value: "none", label: "On demand" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

function scheduleValue(minutes: number | null): string {
  return minutes === 60 ? "hourly" : minutes === 1440 ? "daily" : minutes === 10080 ? "weekly" : "none";
}

function when(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : "never";
}

function PipelineCard({ p }: { p: PipelineView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
  const latest = p.runs[0];
  const [showOutput, setShowOutput] = useState(false);

  const run = useMutation({
    mutationFn: () => apiRequest("POST", `/api/pipelines/${p.id}/run`).then((r) => r.json()),
    onSuccess: (r: { message: string }) => { toast({ title: "Started", description: r.message, variant: "success" }); void refresh(); },
    onError: (err: Error) => toast({ title: "Couldn't start", description: err.message, variant: "error" }),
  });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("PATCH", `/api/pipelines/${p.id}`, body).then((r) => r.json()),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/pipelines/${p.id}`).then((r) => r.json()),
    onSuccess: () => void refresh(),
  });

  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-medium">{p.name}</div>
          <div className="text-xs text-muted-foreground">
            {p.active ? p.scheduleLabel : "paused"} · last run {when(p.lastRunAt)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            value={scheduleValue(p.scheduleMinutes)}
            onChange={(e) => patch.mutate({ schedule: e.target.value })}
            className="h-8 w-auto text-xs"
            aria-label="Schedule"
          >
            {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          <Button size="sm" variant="primary" onClick={() => run.mutate()} disabled={run.isPending}><Play size={12} /> Run now</Button>
          <Button size="sm" variant="outline" onClick={() => patch.mutate({ active: !p.active })}>
            {p.active ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete pipeline "${p.name}"?`)) remove.mutate(); }} title="Delete"><Trash2 size={13} /></Button>
        </div>
      </div>

      <ol className="flex flex-wrap items-stretch gap-2">
        {p.stages.map((s, i) => {
          const live = latest?.status === "running" && latest.stageIndex === i;
          return (
            <li key={i} className="flex items-center gap-2">
              <div className={`max-w-[15rem] rounded-lg border px-2.5 py-2 ${live ? "border-primary shadow-glow" : "border-border"}`} title={s.instruction}>
                <div className="flex items-center gap-2">
                  <IdentityAvatar name={s.agentName} avatarPath={s.avatarPath} className="h-6 w-6 text-[10px]" />
                  <span className="text-xs font-medium">{i + 1}. {s.agentName}</span>
                  {live && <span className="text-[10px] text-primary">working…</span>}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-muted-foreground line-clamp-2">{s.instruction}</div>
              </div>
              {i < p.stages.length - 1 && <ArrowRight size={14} className="shrink-0 text-muted-foreground" />}
            </li>
          );
        })}
      </ol>

      {latest && (
        <div className="text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Latest run:</span>
            <StatusBadge status={latest.status} />
            {latest.status === "running" && <span className="text-muted-foreground">step {latest.stageIndex + 1} of {p.stages.length}</span>}
            {latest.output && (
              <button type="button" className="text-primary hover:underline" onClick={() => setShowOutput((v) => !v)}>
                {showOutput ? "hide output" : "show output"}
              </button>
            )}
          </div>
          {showOutput && latest.output && (
            <div className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-surface/50 p-2.5 text-[11px] leading-relaxed">{latest.output}</div>
          )}
        </div>
      )}
    </Card>
  );
}

function Builder({ agents, onDone }: { agents: AgentLite[]; onDone: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const workers = agents.filter((a) => !a.isOverseer);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("daily");
  const [steps, setSteps] = useState<{ agentId: number; instruction: string }[]>([{ agentId: workers[0]?.id ?? 0, instruction: "" }]);

  const save = useMutation({
    mutationFn: () => apiRequest("POST", "/api/pipelines", { name, schedule, stages: steps, runNow: true }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Pipeline saved", description: "First run started.", variant: "success" });
      void qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
      onDone();
    },
    onError: (err: Error) => toast({ title: "Couldn't save", description: err.message, variant: "error" }),
  });

  const valid = name.trim() && steps.length > 0 && steps.every((s) => s.agentId && s.instruction.trim());

  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pipeline name, e.g. Daily trending scripts" className="min-w-[16rem] flex-1" />
        <Select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="w-auto">
          {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex flex-wrap items-start gap-2">
          <span className="mt-2 w-5 text-xs text-muted-foreground">{i + 1}.</span>
          <Select
            value={s.agentId}
            onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, agentId: Number(e.target.value) } : x)))}
            className="w-48"
          >
            {workers.map((a) => <option key={a.id} value={a.id}>{a.name.trim()}</option>)}
          </Select>
          <Textarea
            value={s.instruction}
            onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)))}
            placeholder={i === 0 ? "What this step produces, e.g. Find today's top 10 trending YouTube videos" : "What to do with the previous step's output"}
            rows={2}
            className="min-w-[16rem] flex-1"
          />
          <Button size="icon" variant="ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))} disabled={steps.length === 1} title="Remove step"><X size={14} /></Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setSteps([...steps, { agentId: workers[0]?.id ?? 0, instruction: "" }])} disabled={steps.length >= 8}>
          <Plus size={12} /> Add step
        </Button>
        <Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={!valid || save.isPending}>Save &amp; run</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </Card>
  );
}

export default function Pipelines() {
  const { data: pipelines = [] } = useQuery<PipelineView[]>({ queryKey: ["/api/pipelines"], refetchInterval: 4000 });
  const { data: agents = [] } = useQuery<AgentLite[]>({ queryKey: ["/api/agents"] });
  const [building, setBuilding] = useState(false);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Pipelines"
          description="Multi-agent workflows: each step's output is handed to the next agent, and the final result lands in your Outbox. Ask AURORA to build one in chat, or make one here."
        />
        {!building && <Button variant="primary" onClick={() => setBuilding(true)}><Plus size={14} /> New pipeline</Button>}
      </div>
      {building && <Builder agents={agents} onDone={() => setBuilding(false)} />}
      {pipelines.length === 0 && !building ? (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Workflow size={22} />
          No pipelines yet. Try asking AURORA: "every day have someone find the top 10 trending videos, summarize them, and write full scripts".
        </Card>
      ) : (
        pipelines.map((p) => <PipelineCard key={p.id} p={p} />)
      )}
    </div>
  );
}
