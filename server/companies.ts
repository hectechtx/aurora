// The organization layer: AURORA runs a set of companies. "Real" companies
// are staffed by LLM agents doing actual work (videos, research, code,
// marketing, sales, legal/accounting). "Simulated" companies are virtual
// businesses populated by lightweight residents and driven by the rules-based
// economy in simulation.ts — they make the town feel alive without spending
// GPU time.
//
// Uses the raw SQLite handle (like backup.ts) rather than growing the Storage
// interface for what is mostly simulation bookkeeping.
import { sqlite } from "./storage-sqlite";
import { getStorage } from "./storage";
import { log } from "./app";

sqlite.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'real',
  industry TEXT NOT NULL DEFAULT '', mission TEXT NOT NULL DEFAULT '', lead_agent_id INTEGER,
  color INTEGER NOT NULL DEFAULT 190, cash INTEGER NOT NULL DEFAULT 0, reputation INTEGER NOT NULL DEFAULT 50,
  revenue_last INTEGER NOT NULL DEFAULT 0, product TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_residents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  mood TEXT NOT NULL DEFAULT 'steady', energy INTEGER NOT NULL DEFAULT 80, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, company_id INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL
);
`);

export interface Company {
  id: number; name: string; kind: "real" | "simulated"; industry: string; mission: string; leadAgentId: number | null;
  color: number; cash: number; reputation: number; revenueLast: number; product: string; createdAt: number;
}
export interface Resident { id: number; companyId: number; name: string; role: string; mood: string; energy: number }
export interface WorldEvent { id: number; at: number; companyId: number | null; kind: string; text: string }

function toCompany(r: Record<string, unknown>): Company {
  return {
    id: r.id as number, name: r.name as string, kind: r.kind as Company["kind"], industry: r.industry as string,
    mission: r.mission as string, leadAgentId: (r.lead_agent_id as number | null) ?? null, color: r.color as number,
    cash: r.cash as number, reputation: r.reputation as number, revenueLast: r.revenue_last as number,
    product: r.product as string, createdAt: r.created_at as number,
  };
}

export function getCompanies(): Company[] {
  return (sqlite.prepare("SELECT * FROM companies ORDER BY kind, id").all() as Record<string, unknown>[]).map(toCompany);
}

export function getCompany(id: number): Company | undefined {
  const r = sqlite.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toCompany(r) : undefined;
}

export function createCompany(c: Omit<Company, "id" | "createdAt" | "revenueLast">): Company {
  const info = sqlite.prepare(`INSERT INTO companies (name, kind, industry, mission, lead_agent_id, color, cash, reputation, product, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.kind, c.industry, c.mission, c.leadAgentId, c.color, c.cash, c.reputation, c.product, Date.now());
  return getCompany(Number(info.lastInsertRowid))!;
}

export function updateCompany(id: number, patch: Partial<Pick<Company, "cash" | "reputation" | "revenueLast" | "leadAgentId" | "product" | "mission">>): void {
  const cols: Record<string, string> = { cash: "cash", reputation: "reputation", revenueLast: "revenue_last", leadAgentId: "lead_agent_id", product: "product", mission: "mission" };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !cols[k]) continue;
    sqlite.prepare(`UPDATE companies SET ${cols[k]} = ? WHERE id = ?`).run(v as number | string | null, id);
  }
}

export function setAgentCompany(agentId: number, companyId: number | null): void {
  sqlite.prepare("UPDATE agents SET company_id = ? WHERE id = ?").run(companyId, agentId);
}

export function getResidents(companyId?: number): Resident[] {
  const rows = (companyId == null
    ? sqlite.prepare("SELECT * FROM sim_residents ORDER BY id").all()
    : sqlite.prepare("SELECT * FROM sim_residents WHERE company_id = ? ORDER BY id").all(companyId)) as Record<string, unknown>[];
  return rows.map((r) => ({ id: r.id as number, companyId: r.company_id as number, name: r.name as string, role: r.role as string, mood: r.mood as string, energy: r.energy as number }));
}

export function addResident(companyId: number, name: string, role: string): void {
  sqlite.prepare("INSERT INTO sim_residents (company_id, name, role, created_at) VALUES (?, ?, ?, ?)").run(companyId, name, role, Date.now());
}

export function removeResident(id: number): void {
  sqlite.prepare("DELETE FROM sim_residents WHERE id = ?").run(id);
}

export function updateResident(id: number, mood: string, energy: number): void {
  sqlite.prepare("UPDATE sim_residents SET mood = ?, energy = ? WHERE id = ?").run(mood, Math.max(0, Math.min(100, Math.round(energy))), id);
}

export function addWorldEvent(kind: string, text: string, companyId: number | null = null): void {
  sqlite.prepare("INSERT INTO world_events (at, company_id, kind, text) VALUES (?, ?, ?, ?)").run(Date.now(), companyId, kind, text.slice(0, 400));
  // Keep the feed bounded — it's a ticker, not an archive.
  sqlite.prepare("DELETE FROM world_events WHERE id <= (SELECT id FROM world_events ORDER BY id DESC LIMIT 1 OFFSET 500)").run();
}

export function getWorldEvents(limit = 40): WorldEvent[] {
  return (sqlite.prepare("SELECT * FROM world_events ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[])
    .map((r) => ({ id: r.id as number, at: r.at as number, companyId: (r.company_id as number | null) ?? null, kind: r.kind as string, text: r.text as string }));
}

// ---- Seeding the organization (runs once, when there are no companies yet) ----

interface Hire { name: string; role: string; persona: string; job: string; schedule?: number | null }

const REAL_COMPANIES: { name: string; industry: string; mission: string; color: number; existing: { match: RegExp; role: string; job?: string; lead?: boolean }[]; hires: (Hire & { lead?: boolean })[] }[] = [
  {
    name: "AURORA Studio", industry: "Video & content", color: 189,
    mission: "Make kid-friendly (ages 4-8) and general-audience YouTube videos: from trend to idea to script to finished production package.",
    existing: [
      { match: /^riley/i, role: "Trend Scout" }, { match: /^nat\b/i, role: "Scriptwriter", lead: true }, { match: /^ali$/i, role: "Editor & QA" },
      { match: /^mandy/i, role: "Video Director" }, { match: /^melly/i, role: "VTuber Host" },
    ],
    hires: [{
      name: "Kai Rivers", role: "Creator & Influencer",
      persona: "Kai is a 23-year-old upbeat creator who lives on short-form video. Fast talker, trend-obsessed, always testing hooks, and honest when an idea is mid.",
      job: "Turn the studio's long-form scripts and ideas into short-form content: Shorts/TikTok/Reels scripts with hooks in the first second, captions, on-screen text and posting notes. Save each package with save_document and send the best to the Outbox with save_deliverable.",
    }],
  },
  {
    name: "Pulse Agency", industry: "Marketing agency", color: 330,
    mission: "Grow the audience for everything AURORA's companies make: market analytics, promotion, influencer partnerships and campaigns.",
    existing: [{ match: /^serena/i, role: "Head of Marketing", lead: true,
      job: "You lead Pulse Agency, AURORA's marketing agency. Set campaign strategy for the studio and other companies, assign work to your analyst, promoter and influencer manager (handoff_to_agent, create_pipeline), and send the owner a weekly marketing plan with save_deliverable." }],
    hires: [
      { name: "Priya Shah", role: "Market Analyst",
        persona: "Priya is a precise, numbers-first analyst. Calm, curious, allergic to vanity metrics, and blunt about what the data does and doesn't show.",
        job: "Analyze markets and audiences: what's trending (trending_videos, youtube_search, news_headlines), competitor channels and their view counts, audience interests and timing. Write short reports with clear recommendations and save them with save_document." },
      { name: "Marco Diaz", role: "Promoter",
        persona: "Marco is a high-energy promoter with a gift for punchy copy. Loves a good hook, hates bland captions, and always asks 'would I stop scrolling for this?'",
        job: "Write promotion for finished work: post copy, captions, titles, hashtags, thumbnail text and a posting schedule per platform. Everything is a draft for the owner to post — save packages with save_document and send them to the Outbox with save_deliverable. Never post anything yourself." },
      { name: "Jade Kim", role: "Influencer Manager",
        persona: "Jade is warm, persuasive and well-connected in creator culture. She reads people fast and knows what makes a collab worth it for both sides.",
        job: "Find collaboration opportunities: creators and channels that fit the studio's audience (youtube_search), why each fits, and a drafted outreach pitch for each. Put them in the Outbox with save_deliverable for the owner to send — never contact anyone yourself." },
    ],
  },
  {
    name: "Forge Labs", industry: "Research & software", color: 145,
    mission: "Research anything the other companies need and build the software and tools that make the organization work.",
    existing: [{ match: /engineer/i, role: "Engineer", lead: true }],
    hires: [
      { name: "Theo Park", role: "Researcher",
        persona: "Theo is a methodical researcher who loves primary sources. Quietly enthusiastic, careful with claims, and always cites where something came from.",
        job: "Do deep research for any company on request: search widely (web_search, web_fetch, news_headlines, video_transcript), cross-check sources, and write clear research briefs with sources. Save briefs with save_document and hand them to whoever asked with handoff_to_agent." },
      { name: "Ravi Mehta", role: "Software Developer",
        persona: "Ravi is a pragmatic developer who ships small, working things. Dry humor, tests before he claims it works, and explains code in plain English.",
        job: "Build small tools, scripts and web pages the other companies need. Work only inside D:\\Library\\projects (one folder per project), test what you build before calling it done, and report what you made and how to use it with save_deliverable." },
    ],
  },
  {
    name: "Venture Works", industry: "Business & sales", color: 38,
    mission: "Find and run business opportunities for the organization: products, offers, sales and the projects that turn ideas into income.",
    existing: [{ match: /^sherrie/i, role: "Entrepreneur", lead: true,
      job: "You lead Venture Works. Spot business opportunities for the organization (products, services, sponsorships, merch), turn the good ones into concrete project plans with your salesman and project manager (create_pipeline, handoff_to_agent), and send proposals to the owner with save_deliverable. You never sign, buy or contact anyone — the owner does." }],
    hires: [
      { name: "Dante Brooks", role: "Salesman",
        persona: "Dante is a smooth, confident closer with a big laugh. He believes every product has a buyer and every buyer has a reason — find the reason.",
        job: "Turn offers into sales material: target customer lists, sales pitches, email and DM drafts, objection handling, and pricing suggestions. All outreach is drafted for the owner to send — save with save_document and send to the Outbox with save_deliverable." },
      { name: "Grace Liu", role: "Project Manager",
        persona: "Grace is organized, unflappable and kind but firm. She turns chaos into checklists and keeps everyone honest about deadlines.",
        job: "Manage cross-company projects: break goals into steps, set up multi-agent workflows with create_pipeline, track progress with list_pipelines, and chase anything stalled with message_agent. Send the owner a short project status with save_deliverable when a milestone lands." },
    ],
  },
  {
    name: "Ledger & Law", industry: "Legal & accounting", color: 262,
    mission: "Keep the organization safe and solvent: content and contract risk review, compliance, budgets and bookkeeping.",
    existing: [],
    hires: [
      { name: "Victor Hale", role: "Legal Counsel", lead: true,
        persona: "Victor is a careful, plain-spoken legal mind. Dry wit, zero patience for vague risk, and always clear about when something needs a real licensed attorney.",
        job: "Review the organization's work for legal risk: copyright and fair use in videos and music, kids-content rules (COPPA / YouTube 'made for kids'), sponsorship disclosure, and contract or terms drafts. Flag issues with concrete fixes, and say plainly when the owner should consult a licensed attorney — you give information, not legal advice. Save reviews with save_document." },
      { name: "Nina Ortiz", role: "Accountant",
        persona: "Nina is meticulous and cheerful about numbers. She likes clean spreadsheets, honest forecasts and catching small leaks before they become big ones.",
        job: "Keep the books for the organization's projects: track costs, revenue ideas and budgets in simple spreadsheets (save_document as csv), price offers, and write short monthly finance summaries for the owner with save_deliverable. You never move money or file anything — you prepare it for the owner." },
    ],
  },
];

const SIM_COMPANIES: { name: string; industry: string; product: string; color: number; size: number }[] = [
  { name: "Byte Bites", industry: "Food delivery", product: "15-minute meal delivery app", color: 20, size: 5 },
  { name: "Nimbus Cloud", industry: "Cloud hosting", product: "Budget GPU servers", color: 205, size: 6 },
  { name: "Glow Cosmetics", industry: "Beauty", product: "Clean skincare line", color: 315, size: 4 },
  { name: "Pixel Forge Games", industry: "Game studio", product: "Indie co-op adventure game", color: 280, size: 6 },
  { name: "Greenline Energy", industry: "Clean energy", product: "Home solar subscriptions", color: 120, size: 5 },
  { name: "Urban Threads", industry: "Fashion", product: "Streetwear drops", color: 0, size: 4 },
  { name: "Quantum Mart", industry: "Retail", product: "Neighborhood smart stores", color: 50, size: 6 },
  { name: "Skyway Travel", industry: "Travel", product: "Weekend getaway packages", color: 180, size: 4 },
];

const FIRST = ["Ava", "Leo", "Mia", "Noah", "Zoe", "Eli", "Lena", "Omar", "Ivy", "Finn", "Sara", "Hugo", "Nora", "Jay", "Rosa", "Ben", "Isla", "Max", "Yuki", "Tariq", "Elena", "Sam", "Amara", "Luca"];
const LAST = ["Stone", "Vega", "Hart", "Cole", "Ng", "Reyes", "Fox", "Bell", "Okafor", "Lind", "Moreau", "Sato", "Price", "Quinn", "Bauer", "Silva"];
const SIM_ROLES = ["Founder", "Engineer", "Designer", "Sales Rep", "Support", "Marketer", "Ops Manager", "Analyst"];

export function randomName(seed: number): string {
  return `${FIRST[seed % FIRST.length]} ${LAST[(seed * 7 + 3) % LAST.length]}`;
}

export function simRole(seed: number): string {
  return SIM_ROLES[1 + (seed % (SIM_ROLES.length - 1))]; // never a second "Founder"
}

/** Builds the organization the first time: assigns existing agents, hires new ones, and founds the simulated companies. Idempotent. */
export async function seedOrganization(): Promise<void> {
  if (getCompanies().length > 0) return;
  const storage = getStorage();
  const agents = await storage.getAgents();
  let hired = 0;

  for (const def of REAL_COMPANIES) {
    const company = createCompany({ name: def.name, kind: "real", industry: def.industry, mission: def.mission, leadAgentId: null, color: def.color, cash: 0, reputation: 60, product: "" });
    for (const e of def.existing) {
      const agent = agents.find((a) => e.match.test(a.name.trim()) || (e.match.source === "engineer" && /engineer/i.test(a.role ?? "")));
      if (!agent) continue;
      setAgentCompany(agent.id, company.id);
      await storage.updateAgent(agent.id, { role: e.role, ...(e.job ? { jobDescription: e.job } : {}) });
      if (e.lead) updateCompany(company.id, { leadAgentId: agent.id });
    }
    for (const h of def.hires) {
      if (agents.some((a) => a.name.trim().toLowerCase() === h.name.toLowerCase())) continue;
      const created = await storage.createAgent({ name: h.name, role: h.role, persona: h.persona, jobDescription: h.job, scheduleMinutes: h.schedule ?? null });
      setAgentCompany(created.id, company.id);
      if (h.lead) updateCompany(company.id, { leadAgentId: created.id });
      hired++;
    }
    addWorldEvent("founded", `${def.name} opened its doors: ${def.mission}`, company.id);
  }

  let seed = 1;
  for (const s of SIM_COMPANIES) {
    const company = createCompany({ name: s.name, kind: "simulated", industry: s.industry, mission: s.product, leadAgentId: null, color: s.color, cash: 50_000 + (seed * 7919) % 60_000, reputation: 40 + (seed * 13) % 30, product: s.product });
    for (let i = 0; i < s.size; i++) addResident(company.id, randomName(seed++), i === 0 ? "Founder" : simRole(seed));
    addWorldEvent("founded", `${s.name} (${s.industry}) set up shop in town, selling ${s.product.toLowerCase()}.`, company.id);
  }
  log(`organization seeded: ${REAL_COMPANIES.length} real companies (${hired} new hires), ${SIM_COMPANIES.length} simulated companies`);
}
