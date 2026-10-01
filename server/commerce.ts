// Money and merchandise: the Treasury ledger and the store catalog.
//
// Treasury: a ledger of REAL income and expenses per company. Agents can only
// propose entries (status "proposed"); only what the owner enters, imports
// from a platform report, or confirms counts toward "actually earned". That
// keeps the numbers honest — nothing here is simulated money.
//
// Store: the product catalog the store company builds (AI product images,
// copy, prices). It can't open a store or take payments by itself — the
// owner opens the Shopify/Etsy account and payment links; this exports a
// Shopify product CSV and a standalone storefront site to make that one step.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sqlite } from "./storage-sqlite";
import { getCreationsDir } from "./paths";

sqlite.exec(`
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, company_id INTEGER, kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, source TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed', created_by TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS store_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  image_path TEXT, buy_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL
);
`);

// ---- Treasury ----

export interface LedgerEntry {
  id: number; at: number; companyId: number | null; kind: "income" | "expense"; amountCents: number;
  source: string; note: string; status: "proposed" | "confirmed" | "rejected"; createdBy: string; createdAt: number;
}

function toEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    id: r.id as number, at: r.at as number, companyId: (r.company_id as number | null) ?? null, kind: r.kind as LedgerEntry["kind"],
    amountCents: r.amount_cents as number, source: r.source as string, note: r.note as string,
    status: r.status as LedgerEntry["status"], createdBy: r.created_by as string, createdAt: r.created_at as number,
  };
}

export function addLedgerEntry(e: { at?: number; companyId: number | null; kind: "income" | "expense"; amountCents: number; source: string; note: string; status: "proposed" | "confirmed"; createdBy: string }): LedgerEntry {
  const info = sqlite.prepare(`INSERT INTO ledger_entries (at, company_id, kind, amount_cents, source, note, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.at ?? Date.now(), e.companyId, e.kind, Math.abs(Math.round(e.amountCents)), e.source.slice(0, 100), e.note.slice(0, 500), e.status, e.createdBy.slice(0, 80), Date.now());
  return toEntry(sqlite.prepare("SELECT * FROM ledger_entries WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>);
}

export function listLedger(limit = 200): LedgerEntry[] {
  return (sqlite.prepare("SELECT * FROM ledger_entries ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(toEntry);
}

export function setLedgerStatus(id: number, status: "confirmed" | "rejected"): void {
  sqlite.prepare("UPDATE ledger_entries SET status = ? WHERE id = ?").run(status, id);
}

export function deleteLedgerEntry(id: number): void {
  sqlite.prepare("DELETE FROM ledger_entries WHERE id = ?").run(id);
}

export interface TreasurySummary {
  incomeCents: number; expenseCents: number; netCents: number; proposedCount: number;
  byCompany: { companyId: number | null; incomeCents: number; expenseCents: number }[];
  byMonth: { month: string; incomeCents: number; expenseCents: number }[];
}

/** Totals over CONFIRMED entries only — the honest "what's actually been earned". */
export function treasurySummary(): TreasurySummary {
  const confirmed = (sqlite.prepare("SELECT * FROM ledger_entries WHERE status = 'confirmed'").all() as Record<string, unknown>[]).map(toEntry);
  const sum = (k: "income" | "expense", xs: LedgerEntry[]) => xs.filter((e) => e.kind === k).reduce((a, e) => a + e.amountCents, 0);
  const byCompany = new Map<number | null, LedgerEntry[]>();
  const byMonth = new Map<string, LedgerEntry[]>();
  for (const e of confirmed) {
    byCompany.set(e.companyId, [...(byCompany.get(e.companyId) ?? []), e]);
    const month = new Date(e.at).toISOString().slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
  }
  const income = sum("income", confirmed), expense = sum("expense", confirmed);
  return {
    incomeCents: income, expenseCents: expense, netCents: income - expense,
    proposedCount: (sqlite.prepare("SELECT count(*) n FROM ledger_entries WHERE status = 'proposed'").get() as { n: number }).n,
    byCompany: [...byCompany.entries()].map(([companyId, xs]) => ({ companyId, incomeCents: sum("income", xs), expenseCents: sum("expense", xs) })),
    byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, xs]) => ({ month, incomeCents: sum("income", xs), expenseCents: sum("expense", xs) })),
  };
}

/**
 * Imports a platform report the owner exported (Stripe, Shopify, YouTube, a
 * bank CSV…). Flexible about headers: needs a date column and an amount
 * column; negative amounts become expenses. Imported rows count as confirmed —
 * they come from the owner's own records.
 */
export function importLedgerCsv(csv: string, companyId: number | null, source: string): { imported: number; skipped: number } {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const split = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()) ?? [];
  const head = split(rows[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col("date", "created", "time"), iAmount = col("amount", "net", "total", "earnings", "revenue"), iDesc = col("description", "note", "memo", "title", "name");
  if (iDate < 0 || iAmount < 0) throw new Error("the CSV needs a date column and an amount column");
  let imported = 0, skipped = 0;
  for (const line of rows.slice(1)) {
    const cells = split(line);
    const amount = Number(String(cells[iAmount] ?? "").replace(/[^0-9.\-]/g, ""));
    const at = Date.parse(cells[iDate] ?? "");
    if (!Number.isFinite(amount) || amount === 0 || Number.isNaN(at)) { skipped++; continue; }
    addLedgerEntry({ at, companyId, kind: amount < 0 ? "expense" : "income", amountCents: Math.round(Math.abs(amount) * 100), source, note: iDesc >= 0 ? cells[iDesc] ?? "" : "", status: "confirmed", createdBy: "owner (import)" });
    imported++;
  }
  return { imported, skipped };
}

// ---- Store ----

export interface StoreProduct {
  id: number; name: string; description: string; priceCents: number; category: string; tags: string[];
  imagePath: string | null; buyUrl: string; status: "draft" | "ready" | "listed"; createdBy: string; createdAt: number;
}

function toProduct(r: Record<string, unknown>): StoreProduct {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags as string); } catch { /* malformed */ }
  return {
    id: r.id as number, name: r.name as string, description: r.description as string, priceCents: r.price_cents as number,
    category: r.category as string, tags, imagePath: (r.image_path as string | null) ?? null, buyUrl: r.buy_url as string,
    status: r.status as StoreProduct["status"], createdBy: r.created_by as string, createdAt: r.created_at as number,
  };
}

export function addProduct(p: { name: string; description: string; priceCents: number; category: string; tags: string[]; imagePath: string | null; createdBy: string }): StoreProduct {
  const info = sqlite.prepare(`INSERT INTO store_products (name, description, price_cents, category, tags, image_path, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`).run(p.name.slice(0, 120), p.description.slice(0, 4000), Math.max(0, Math.round(p.priceCents)), p.category.slice(0, 60), JSON.stringify(p.tags.slice(0, 13)), p.imagePath, p.createdBy, Date.now());
  return toProduct(sqlite.prepare("SELECT * FROM store_products WHERE id = ?").get(Number(info.lastInsertRowid)) as Record<string, unknown>);
}

export function listProducts(): StoreProduct[] {
  return (sqlite.prepare("SELECT * FROM store_products ORDER BY id DESC").all() as Record<string, unknown>[]).map(toProduct);
}

export function updateProduct(id: number, patch: { buyUrl?: string; status?: StoreProduct["status"]; priceCents?: number; name?: string; description?: string }): void {
  if (patch.buyUrl !== undefined) sqlite.prepare("UPDATE store_products SET buy_url = ? WHERE id = ?").run(patch.buyUrl.slice(0, 500), id);
  if (patch.status) sqlite.prepare("UPDATE store_products SET status = ? WHERE id = ?").run(patch.status, id);
  if (patch.priceCents !== undefined) sqlite.prepare("UPDATE store_products SET price_cents = ? WHERE id = ?").run(Math.max(0, Math.round(patch.priceCents)), id);
  if (patch.name) sqlite.prepare("UPDATE store_products SET name = ? WHERE id = ?").run(patch.name.slice(0, 120), id);
  if (patch.description !== undefined) sqlite.prepare("UPDATE store_products SET description = ? WHERE id = ?").run(patch.description.slice(0, 4000), id);
}

export function deleteProduct(id: number): void {
  sqlite.prepare("DELETE FROM store_products WHERE id = ?").run(id);
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Shopify's product-import CSV (Admin → Products → Import). Images are uploaded separately in Shopify since they're local files here. */
export function shopifyCsv(): string {
  const head = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published", "Variant Price", "Variant Requires Shipping", "Status"];
  const lines = listProducts().map((p) => [
    p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), p.name, `<p>${p.description.replace(/\n/g, "<br>")}</p>`,
    "AURORA Goods", "", p.category, p.tags.join(", "), "TRUE", (p.priceCents / 100).toFixed(2), "TRUE", "draft",
  ].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n");
}

/** A standalone storefront (one HTML page + product images) the owner can host anywhere — buy buttons use each product's payment link. */
export function exportStoreSite(): string {
  const dir = path.join(getCreationsDir(), "store-site");
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const cards = listProducts().filter((p) => p.status !== "draft").map((p) => {
    let img = "";
    if (p.imagePath && fs.existsSync(path.join(getCreationsDir(), p.imagePath))) {
      const name = `${p.id}${path.extname(p.imagePath)}`;
      fs.copyFileSync(path.join(getCreationsDir(), p.imagePath), path.join(dir, "images", name));
      img = `<img src="images/${name}" alt="${esc(p.name)}">`;
    }
    const buy = p.buyUrl ? `<a class="buy" href="${esc(p.buyUrl)}">Buy — $${(p.priceCents / 100).toFixed(2)}</a>` : `<span class="soon">$${(p.priceCents / 100).toFixed(2)} · coming soon</span>`;
    return `<article>${img}<h2>${esc(p.name)}</h2><p>${esc(p.description)}</p>${buy}</article>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AURORA Goods</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1117;color:#eef}header{padding:32px 16px;text-align:center}
main{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));max-width:1100px;margin:0 auto;padding:0 16px 48px}
article{background:#181b24;border:1px solid #2a2f3d;border-radius:14px;padding:14px}img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px}
h2{font-size:1.05rem;margin:10px 0 6px}p{color:#aab;font-size:.9rem;line-height:1.4}.buy{display:inline-block;margin-top:8px;padding:8px 14px;border-radius:999px;background:#38c6e0;color:#071016;font-weight:600;text-decoration:none}.soon{color:#889}
</style></head><body><header><h1>AURORA Goods</h1><p>Made by the AURORA studio.</p></header><main>${cards}</main></body></html>`;
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");
  return dir;
}

export function newImageName(ext = "png"): string {
  return `product-${randomUUID()}.${ext}`;
}
