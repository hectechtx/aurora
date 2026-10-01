// The simulated economy behind the town's virtual companies. Pure rules — no
// LLM calls — so dozens of businesses and residents cost no GPU time. Every
// SIM_DAY_MS of real time is one simulated business day: each simulated
// company earns and spends, its industry's market drifts, and events
// (launches, partnerships, scandals, hiring, layoffs) happen with
// probabilities shaped by its situation. Events land in the world news feed.
import {
  getCompanies, updateCompany, getResidents, addResident, removeResident, updateResident, addWorldEvent, randomName, simRole,
  type Company,
} from "./companies";

export const SIM_DAY_MS = 10 * 60_000;
const SALARY = 700;
const OVERHEAD = 500;
const BASE_OUTPUT = 950;

// Industry demand index (1.0 = normal), random-walking day to day so whole
// sectors boom and slump together.
const sectors = new Map<string, number>();
let lastDayAt = 0;
let simDay = 0;

export function currentSimDay(): number {
  return simDay;
}

function chance(p: number): boolean {
  return Math.random() < p;
}

function sectorIndex(industry: string): number {
  const prev = sectors.get(industry) ?? 1;
  const next = Math.max(0.55, Math.min(1.7, prev + (Math.random() - 0.5) * 0.16));
  sectors.set(industry, next);
  return next;
}

function money(n: number): string {
  return `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function simulateCompany(c: Company, others: Company[]): void {
  const staff = getResidents(c.id);
  const demand = sectorIndex(c.industry);
  const revenue = Math.round(staff.length * BASE_OUTPUT * (c.reputation / 50) * demand * (0.75 + Math.random() * 0.5));
  const costs = staff.length * SALARY + OVERHEAD;
  let cash = c.cash + revenue - costs;
  let rep = c.reputation + Math.round((Math.random() - 0.5) * 3);
  const profitable = revenue > costs;

  if (chance(0.1)) {
    rep += 6;
    addWorldEvent("launch", `${c.name} launched a new version of its ${c.product.toLowerCase()} — early buzz is ${demand > 1.1 ? "strong" : "mixed"}.`, c.id);
  }
  if (chance(0.05)) {
    rep -= 8;
    addWorldEvent("scandal", `${c.name} is under fire after customer complaints about its ${c.product.toLowerCase()}.`, c.id);
  }
  if (others.length && chance(0.07)) {
    const partner = others[Math.floor(Math.random() * others.length)];
    rep += 3;
    updateCompany(partner.id, { reputation: Math.min(100, partner.reputation + 3) });
    addWorldEvent("deal", `${c.name} and ${partner.name} announced a partnership.`, c.id);
  }
  if (cash > 140_000 && staff.length < 12 && chance(0.35)) {
    const name = randomName(Date.now() % 997 + c.id * 31);
    addResident(c.id, name, simRole(staff.length + c.id));
    cash -= 5_000;
    addWorldEvent("hire", `${c.name} hired ${name} as business grows (${money(cash)} in the bank).`, c.id);
  }
  if (cash < 0 && staff.length > 2 && chance(0.5)) {
    const leaving = staff[staff.length - 1];
    removeResident(leaving.id);
    addWorldEvent("layoff", `${c.name} let ${leaving.name} go after a rough stretch.`, c.id);
  }
  if (cash < -40_000) {
    cash = 15_000;
    rep -= 10;
    addWorldEvent("restructure", `${c.name} restructured after running out of money — investors put in emergency funding.`, c.id);
  }
  if (demand > 1.5 && chance(0.3)) addWorldEvent("market", `${c.industry} is booming this week — ${c.name} is riding the wave.`, c.id);

  updateCompany(c.id, { cash, revenueLast: revenue, reputation: Math.max(5, Math.min(100, rep)) });

  // Residents' days: energy cycles, mood follows how the company is doing.
  for (const r of getResidents(c.id)) {
    const energy = r.energy + (Math.random() - 0.45) * 20;
    const mood = energy < 25 ? "exhausted" : profitable ? (rep > 65 ? "thriving" : "upbeat") : rep < 35 ? "worried" : "steady";
    updateResident(r.id, mood, energy);
  }
}

/** Called every scheduler tick; runs one simulated business day when SIM_DAY_MS has passed. */
export function simulationTick(now = Date.now()): void {
  if (now - lastDayAt < SIM_DAY_MS) return;
  lastDayAt = now;
  simDay++;
  const sims = getCompanies().filter((c) => c.kind === "simulated");
  for (const c of sims) simulateCompany(c, sims.filter((o) => o.id !== c.id));
}
