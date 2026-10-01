import { useState } from "react";
import { Loader2, CheckCircle2, Circle, XCircle, ShieldAlert, ChevronDown, ChevronRight } from "lucide-react";
import { linkify } from "@/lib/linkify";
import { cn } from "@/lib/utils";

export interface ToolCallRecord { name: string; args: Record<string, unknown>; risk: string; status: string; result: string; }

/** set_plan calls render as a live checklist instead of a raw tool card — the whole point of the tool is an at-a-glance "where is it and what's left", which a JSON blob doesn't give. */
function PlanChecklist({ tc }: { tc: ToolCallRecord }) {
  const steps = Array.isArray(tc.args.steps) ? tc.args.steps.map(String) : [];
  const done = new Set(Array.isArray(tc.args.done) ? tc.args.done.map(Number) : []);
  if (steps.length === 0) return null;
  return (
    <div className="rounded-md border border-border-subtle bg-surface/50 px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 mb-1.5">Plan</div>
      <ul className="space-y-1">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            {done.has(i)
              ? <CheckCircle2 size={13} className="text-risk-low shrink-0 mt-0.5" />
              : <Circle size={13} className="text-muted-foreground/50 shrink-0 mt-0.5" />}
            <span className={done.has(i) ? "text-muted-foreground line-through" : "text-foreground/90"}>{step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function host(url: unknown): string {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return String(url ?? "a page"); }
}

function q(v: unknown, max = 60): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * One plain-English line per tool call — what the owner sees instead of raw
 * tool names and JSON (which read as "traces of code" mixed into replies).
 * The exact arguments/result are still one click away under "details".
 */
function describe(tc: ToolCallRecord): string {
  const a = tc.args;
  switch (tc.name) {
    case "web_search": return `Searched the web for "${q(a.query)}"`;
    case "web_fetch": return `Read ${host(a.url)}`;
    case "browse_page": return a.url ? `Opened ${host(a.url)}` : "Looked through the page";
    case "browse_interact": return a.url ? `Worked on ${host(a.url)}` : "Clicked through the page";
    case "remember": return `Saved to memory: ${q(a.label, 40)}`;
    case "recall": return a.query ? `Checked memory for "${q(a.query, 40)}"` : "Checked memory";
    case "speak": return `Said out loud: "${q(a.text, 50)}"`;
    case "generate_image": return `Made an image: ${q(a.prompt, 50)}`;
    case "generate_video": return `Made a video: ${q(a.prompt, 50)}`;
    case "see_image": return "Looked at an image";
    case "search_music": return `Found music: ${q(a.query, 40)}`;
    case "trending_videos": return `Checked what's trending on YouTube${a.period ? ` (${a.period})` : ""}`;
    case "youtube_search": return `Searched YouTube for "${q(a.query, 40)}"`;
    case "video_transcript": return "Read a video's transcript";
    case "news_headlines": return a.topic ? `Checked the news on "${q(a.topic, 40)}"` : "Checked the top news";
    case "save_document": return `Saved a document: ${q(a.title, 50)}`;
    case "make_voiceover": return "Recorded a voiceover";
    case "save_deliverable": return `Sent to your Outbox: ${q(a.title, 50)}`;
    case "ask_owner": return "Asked you a question (in the Outbox)";
    case "delegate_to_agent": return `Handed the job to ${q(a.agent, 30)}`;
    case "handoff_to_agent": return `Handed off to ${q(a.target, 30)}`;
    case "message_agent": return `Messaged ${q(a.target, 30)}`;
    case "spawn_agent": return `Brought a new agent onto the team: ${q(a.name, 30)}`;
    case "create_pipeline": return `Built the "${q(a.name, 40)}" pipeline`;
    case "run_pipeline": return `Started the "${q(a.name, 40)}" pipeline`;
    case "list_pipelines": return "Checked the team's pipelines";
    case "check_audit_log": return "Checked the activity log";
    case "list_skills": return "Checked her skills";
    case "switch_model": return `Switched to the ${q(a.model, 30)} model`;
    case "run_shell": return `Ran a command: ${q(a.command, 50)}`;
    case "run_node": case "run_python": return "Ran some code";
    case "read_file": return `Read a file: ${q(a.path, 50)}`;
    case "write_file": return `Wrote a file: ${q(a.path, 50)}`;
    case "edit_file": return `Edited a file: ${q(a.path, 50)}`;
    default: {
      const pretty = tc.name.replace(/_/g, " ");
      return `Used ${pretty}`;
    }
  }
}

/** Compact, readable view of one tool call. Collapsed to a single line; "details" reveals the exact arguments and full result. Shared by Tasks' chat and Agents' activity feed. */
export function ToolCallCard({ tc }: { tc: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  if (tc.name === "set_plan") return <PlanChecklist tc={tc} />;
  const waiting = tc.status === "pending" && /approval/i.test(tc.result);
  const running = tc.status === "pending" && !waiting;
  const failed = tc.status === "error" || tc.status === "denied";
  return (
    <div className={cn("rounded-md border px-2.5 py-1.5", waiting ? "border-risk-medium/40 bg-risk-medium/5" : "border-border-subtle bg-surface/40")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left text-xs">
        {running && <Loader2 size={12} className="animate-spin text-muted-foreground shrink-0" />}
        {waiting && <ShieldAlert size={12} className="text-risk-medium shrink-0" />}
        {failed && <XCircle size={12} className="text-risk-high shrink-0" />}
        {!running && !waiting && !failed && <CheckCircle2 size={12} className="text-risk-low shrink-0" />}
        <span className={cn("flex-1", failed ? "text-risk-high/90" : "text-foreground/85")}>
          {describe(tc)}
          {waiting && <span className="text-risk-medium"> — waiting for your approval</span>}
          {failed && <span> — didn't work</span>}
        </span>
        {open ? <ChevronDown size={12} className="text-muted-foreground" /> : <ChevronRight size={12} className="text-muted-foreground" />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 border-t border-border-subtle pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <div className="font-mono break-words"><span className="text-accent">{tc.name}</span> {JSON.stringify(tc.args)}</div>
          <div className="whitespace-pre-wrap break-words">{linkify(tc.result)}</div>
        </div>
      )}
    </div>
  );
}
