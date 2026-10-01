// "The Agency" (github.com/msitarzewski/agency-agents, MIT) — 200+ specialist
// agent profiles (marketing, sales, finance, engineering, design, product,
// strategy…). AURORA uses it as a hiring library: search it, and hire a
// specialist as a real agent whose personality and job come from the profile.
//
// Profiles are long (~15KB) — far more than a 9B local model's context can
// carry per turn — so a hire gets a condensed version: identity + vibe as the
// persona; core mission, critical rules and workflow as the job.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";

export const AGENCY_DIR = path.join(DATA_DIR, "agency");

export interface Specialist { id: string; name: string; description: string; division: string; vibe: string }

let index: Specialist[] | null = null;

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

export function isAgencyInstalled(): boolean {
  return fs.existsSync(AGENCY_DIR);
}

/** All specialist profiles (cached after the first scan). */
export function agencyIndex(): Specialist[] {
  if (index) return index;
  const out: Specialist[] = [];
  if (!isAgencyInstalled()) return out;
  for (const division of fs.readdirSync(AGENCY_DIR)) {
    const dir = path.join(AGENCY_DIR, division);
    if (division.startsWith(".") || !fs.statSync(dir).isDirectory() || ["scripts", "examples", "integrations"].includes(division)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const fm = frontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
        if (fm.name && fm.description) out.push({ id: `${division}/${f.replace(/\.md$/, "")}`, name: fm.name, description: fm.description, division, vibe: fm.vibe ?? "" });
      } catch { /* unreadable profile — skip */ }
    }
  }
  index = out;
  return out;
}

/** Keyword search over names, descriptions and divisions. */
export function searchAgency(query: string, limit = 12): Specialist[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const all = agencyIndex();
  if (!words.length) return all.slice(0, limit);
  return all
    .map((s) => {
      const hay = `${s.name} ${s.description} ${s.division} ${s.id}`.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += s.name.toLowerCase().includes(w) ? 3 : 1;
      return { s, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.s);
}

function section(md: string, heading: RegExp, max: number): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start < 0) return "";
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    body.push(l);
  }
  const text = body.join("\n").replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, "") + " …" : text;
}

/** Condensed persona + job for hiring a specialist as an AURORA agent. */
export function specialistProfile(id: string): { name: string; description: string; persona: string; job: string } | null {
  const spec = agencyIndex().find((s) => s.id === id || s.id.endsWith(`/${id}`) || s.name.toLowerCase() === id.toLowerCase());
  if (!spec) return null;
  const md = fs.readFileSync(path.join(AGENCY_DIR, `${spec.id}.md`), "utf8");
  const identity = section(md, /identity/i, 420);
  const persona = [spec.vibe, identity].filter(Boolean).join(" ").slice(0, 600);
  const job = [
    spec.description,
    section(md, /core mission|core capabilities|executive summary|domain expertise/i, 700) && `Mission:\n${section(md, /core mission|core capabilities|executive summary|domain expertise/i, 700)}`,
    section(md, /critical rules|decision framework/i, 550) && `Rules:\n${section(md, /critical rules|decision framework/i, 550)}`,
    section(md, /workflow|your process|specialized skills/i, 500) && `How you work:\n${section(md, /workflow|your process|specialized skills/i, 500)}`,
  ].filter(Boolean).join("\n\n");
  return { name: spec.name, description: spec.description, persona, job: job.slice(0, 2200) };
}

/** A short "playbook" excerpt to append to an existing agent's job. */
export function specialistPlaybook(id: string, max = 1100): string | null {
  const p = specialistProfile(id);
  if (!p) return null;
  const md = fs.readFileSync(path.join(AGENCY_DIR, `${agencyIndex().find((s) => s.name === p.name)!.id}.md`), "utf8");
  const text = [section(md, /core mission|core capabilities|executive summary|domain expertise/i, 600), section(md, /workflow|your process|specialized skills/i, 500)].filter(Boolean).join("\n\n");
  return text ? `Playbook (from The Agency's ${p.name}):\n${text}`.slice(0, max) : null;
}
