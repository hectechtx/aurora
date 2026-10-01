// AURORA's authority as the organization's lead (the owner's right hand):
// her inbox of things awaiting a decision, marking reviewed work, and
// founding new companies from market research — with guardrails so the
// organization can't balloon out of control or past one GPU's capacity.
import { getStorage } from "./storage";
import { sqlite } from "./storage-sqlite";
import { getCompanies, createCompany, setAgentCompany, addWorldEvent } from "./companies";
import { upsertPipeline } from "./pipelines";
import { log } from "./app";

export const LEAD_REVIEWED_TAG = "reviewed-by-aurora";
const QUESTION_TAG = "owner-question";
const MAX_REAL_COMPANIES = 16;
const MAX_AGENTS = 100;
const FOUNDING_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function tagsOf(raw: string): string[] {
  try { const t = JSON.parse(raw); return Array.isArray(t) ? t.map(String) : []; } catch { return []; }
}

export function addDeliverableTag(id: number, tag: string): void {
  const row = sqlite.prepare("SELECT tags FROM deliverables WHERE id = ?").get(id) as { tags: string } | undefined;
  if (!row) return;
  const tags = tagsOf(row.tags);
  if (!tags.includes(tag)) tags.push(tag);
  sqlite.prepare("UPDATE deliverables SET tags = ? WHERE id = ?").run(JSON.stringify(tags), id);
}

/** Everything waiting on a lead decision: tool approvals, agents' questions, and finished work nobody has reviewed yet. */
export async function leadInbox(): Promise<string> {
  const storage = getStorage();
  const [approvals, deliverables, agents] = await Promise.all([storage.getApprovals(), storage.getDeliverables(), storage.getAgents()]);
  const names = new Map(agents.map((a) => [a.id, a.name.trim()] as const));
  const pending = approvals.filter((a) => a.status === "pending").slice(0, 15);
  const open = deliverables.filter((d) => d.status === "ready");
  const questions = open.filter((d) => tagsOf(d.tags).includes(QUESTION_TAG)).slice(0, 10);
  const unreviewed = open.filter((d) => !tagsOf(d.tags).includes(QUESTION_TAG) && !tagsOf(d.tags).includes(LEAD_REVIEWED_TAG)).slice(0, 12);
  const parts: string[] = [];
  parts.push(pending.length
    ? `Requests awaiting approval:\n${pending.map((a) => `- approval #${a.id} [${a.risk}] ${a.action.slice(0, 160)}`).join("\n")}`
    : "No requests awaiting approval.");
  if (questions.length) parts.push(`Agents' questions:\n${questions.map((d) => `- question #${d.id} from ${names.get(d.agentId) ?? "?"}: ${d.body.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`);
  parts.push(unreviewed.length
    ? `Finished work to review:\n${unreviewed.map((d) => `- deliverable #${d.id} "${d.title}" by ${names.get(d.agentId) ?? "?"}: ${d.body.replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}`
    : "No unreviewed work.");
  return parts.join("\n\n");
}

export interface FoundingInput {
  name: string; industry: string; mission: string; reason: string;
  team: { name: string; role: string; persona: string; job: string; lead?: boolean }[];
  pipeline: { name: string; schedule: string; steps: { agent: string; instruction: string }[] };
}

/** AURORA founds a new real company: hires its team, gives it a standing pipeline, announces it in town, and tells the owner. */
export async function foundCompany(input: FoundingInput): Promise<{ ok: boolean; message: string }> {
  const storage = getStorage();
  const name = input.name.trim().slice(0, 60);
  const companies = getCompanies();
  const real = companies.filter((c) => c.kind === "real");
  if (!name || !input.mission.trim()) return { ok: false, message: "a company needs a name and a mission" };
  if (companies.some((c) => c.name.toLowerCase() === name.toLowerCase())) return { ok: false, message: `${name} already exists` };
  if (real.length >= MAX_REAL_COMPANIES) return { ok: false, message: `the organization is at its limit of ${MAX_REAL_COMPANIES} real companies — pitch it to the owner instead` };
  const lastFounded = (sqlite.prepare("SELECT max(at) t FROM world_events WHERE kind = 'founded-by-aurora'").get() as { t: number | null }).t;
  if (lastFounded && Date.now() - lastFounded < FOUNDING_COOLDOWN_MS) {
    return { ok: false, message: "AURORA already founded a company this week (limit: one per week, so the GPU and the owner can keep up) — save this plan for next week or send it to the owner" };
  }
  const team = input.team.filter((t) => t.name?.trim() && t.role?.trim() && t.job?.trim()).slice(0, 5);
  if (team.length < 2) return { ok: false, message: "a new company needs at least 2 team members (name, role, persona, job)" };
  const agents = await storage.getAgents();
  if (agents.length + team.length > MAX_AGENTS) return { ok: false, message: `that would exceed the ${MAX_AGENTS}-agent limit` };
  const clash = team.find((t) => agents.some((a) => a.name.trim().toLowerCase() === t.name.trim().toLowerCase()));
  if (clash) return { ok: false, message: `an agent named ${clash.name} already exists — pick another name` };

  const company = createCompany({ name, kind: "real", industry: input.industry.slice(0, 60), mission: input.mission.slice(0, 400), leadAgentId: null, color: Math.floor(Math.random() * 360), cash: 0, reputation: 55, product: "" });
  let leadId: number | null = null;
  for (const [i, t] of team.entries()) {
    const created = await storage.createAgent({
      name: t.name.trim().slice(0, 60), role: t.role.trim().slice(0, 60),
      persona: (t.persona || `${t.name} is a capable, friendly ${t.role}.`).slice(0, 600), jobDescription: t.job.slice(0, 1200), scheduleMinutes: null,
    });
    setAgentCompany(created.id, company.id);
    if (t.lead || (i === 0 && !team.some((x) => x.lead))) leadId = created.id;
  }
  if (leadId) sqlite.prepare("UPDATE companies SET lead_agent_id = ? WHERE id = ?").run(leadId, company.id);

  const pipe = await upsertPipeline({ name: input.pipeline.name || `${name}: Weekly Work`, stages: input.pipeline.steps, schedule: input.pipeline.schedule || "weekly", originTaskId: null });
  addWorldEvent("founded-by-aurora", `AURORA founded ${name} (${input.industry}): ${input.mission}`, company.id);
  const overseer = agents.find((a) => a.isOverseer);
  if (overseer) {
    await storage.createDeliverable({
      agentId: overseer.id, title: `New company founded: ${name}`,
      description: `AURORA founded a new company from market research.`, tags: JSON.stringify(["founding"]),
      body: `**${name}** — ${input.industry}\n\n**Mission:** ${input.mission}\n\n**Why it's a no-brainer:** ${input.reason}\n\n**Team:** ${team.map((t) => `${t.name} (${t.role})`).join(", ")}\n\n` +
        (pipe.ok ? `**Pipeline:** ${input.pipeline.name} (${input.pipeline.schedule})` : `Pipeline not created: ${pipe.message}`) +
        `\n\nAnything involving real money, accounts or contracts still comes to you. Pause or delete the company's agents on the Team page if you disagree.`,
    });
  }
  await log(`AURORA founded company: ${name}`, `${team.length} agents${pipe.ok ? "" : `; pipeline failed: ${pipe.message}`}`);
  return { ok: true, message: `Founded ${name} with ${team.length} agents${pipe.ok ? ` and the "${input.pipeline.name}" pipeline (${input.pipeline.schedule})` : `, but the pipeline failed: ${pipe.message}`}. The owner has been notified in the Outbox.` };
}
