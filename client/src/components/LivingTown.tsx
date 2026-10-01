import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { getToken } from "@/lib/queryClient";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { X } from "lucide-react";

// A living 2D town: every agent is a little character who commutes, works at
// their company's building, eats at the café, hangs out in the park and goes
// home to sleep — driven by their REAL state (working, waiting on approval,
// chatting, paused) first, and a daily routine otherwise. Their detailed
// portrait floats over their head, so the 2D body and the face go together.
// Simulated residents fill the streets on the same routine. Rendered on a
// canvas at 60fps in a fixed logical space that scales to any width.

// ---------- data shapes (from /api/team and /api/town) ----------
interface TeamMember {
  id: number; name: string; role: string | null; isOverseer: boolean; status: "active" | "paused"; avatarPath: string | null;
  companyId: number | null; working: boolean; waitingApproval: boolean; currentTask: string | null; lastTools: string[];
  mood: string; lastActivity: { text: string; at: number } | null;
}
interface Chatter { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number }
interface TeamData { members: TeamMember[]; chatter: Chatter[] }
interface TownCompany { id: number; name: string; kind: "real" | "simulated"; industry: string; color: number; staff: { id: number; name: string; role: string | null; mood?: string }[] }
interface TownData { simDay: number; companies: TownCompany[]; events: { id: number; text: string; at: number }[] }

// ---------- world layout (logical units) ----------
const W = 1600, H = 1360;
const ROAD = 46;
const ROAD_X = [420, 820, 1220];
const ROAD_Y = [300, 640, 980, 1320];
const COLS = [[30, 397], [443, 797], [843, 1197], [1243, 1570]];
const ROWS = [[30, 277], [323, 617], [663, 957], [1003, 1297]];

interface Lot { x: number; y: number; w: number; h: number; row: number; kind: "hq" | "company" | "park" | "cafe" | "homes"; companyId?: number; label?: string; hue?: number }

/** The road a lot's door opens onto (the one directly below its row). */
function roadBelow(row: number): number { return ROAD_Y[row]; }

function buildLots(companies: TownCompany[]): Lot[] {
  const block = (r: number, c: number) => ({ x: COLS[c][0], y: ROWS[r][0], w: COLS[c][1] - COLS[c][0], h: ROWS[r][1] - ROWS[r][0], row: r });
  const lots: Lot[] = [
    { ...block(0, 1), kind: "hq", label: "AURORA HQ", hue: 265 },
    { ...block(1, 1), kind: "park", label: "Aurora Park" },
    { ...block(1, 2), kind: "cafe", label: "Starlight Café" },
    { ...block(0, 0), kind: "homes", label: "Maple Homes" },
    { ...block(0, 3), kind: "homes", label: "Riverside Homes" },
  ];
  // Half-block lots for companies: real ones fill the inner city first, the
  // simulated businesses downtown (bottom row) and whatever is left.
  const free: Lot[] = [];
  const order: [number, number][] = [[0, 2], [1, 0], [1, 3], [2, 0], [2, 1], [2, 2], [2, 3], [3, 0], [3, 1], [3, 2], [3, 3]];
  for (const [r, c] of order) {
    const b = block(r, c);
    const half = (b.w - 14) / 2;
    free.push({ ...b, w: half, kind: "company" }, { ...b, x: b.x + half + 14, w: half, kind: "company" });
  }
  const real = companies.filter((c) => c.kind === "real");
  const sims = companies.filter((c) => c.kind === "simulated");
  for (const c of [...real, ...sims]) {
    const lot = free.shift();
    if (!lot) break;
    lots.push({ ...lot, companyId: c.id, label: c.name, hue: c.color });
  }
  return lots;
}

// ---------- characters ----------
type Spot = { x: number; y: number; lot: Lot | null };
interface Char {
  key: string; agentId?: number; residentCompany?: number; name: string; role: string; hue: number; skin: string; hair: string;
  x: number; y: number; path: { x: number; y: number }[]; targetKey: string; lot: Lot | null; phase: number; facing: 1 | -1;
  bubble: string | null; asleep: boolean; avatarPath: string | null; tint: number;
}

const SKINS = ["#f1c7a5", "#e0ac86", "#c68b62", "#a86c48", "#7d4c33", "#5a3825"];
const HAIRS = ["#1d1a1a", "#3b2618", "#6b4423", "#a8742f", "#d9b56b", "#7a1f1f", "#2d2d4a"];
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function rnd(seed: number): number { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

/** Simulated clock: one in-world day every 12 real minutes, so the town always cycles through work, lunch, evening and night. */
const DAY_MS = 12 * 60_000;
function simHour(now = Date.now()): number { return ((now % DAY_MS) / DAY_MS) * 24; }

function spotIn(lot: Lot, seed: number, area: "desk" | "any" = "any"): Spot {
  const pad = 26;
  if (area === "desk" && (lot.kind === "company" || lot.kind === "hq")) {
    const cols = Math.max(2, Math.floor((lot.w - pad * 2) / 54)), rows = Math.max(2, Math.floor((lot.h - 70) / 52));
    const i = seed % (cols * rows);
    return { x: lot.x + pad + 20 + (i % cols) * ((lot.w - pad * 2 - 40) / Math.max(1, cols - 1)), y: lot.y + 58 + Math.floor(i / cols) * ((lot.h - 100) / Math.max(1, rows - 1)), lot };
  }
  return { x: lot.x + pad + rnd(seed) * (lot.w - pad * 2), y: lot.y + 46 + rnd(seed * 7 + 1) * (lot.h - 80), lot };
}

function doorOf(lot: Lot): { x: number; y: number } { return { x: lot.x + lot.w / 2, y: lot.y + lot.h }; }

/** Street route between two spots: out the door, along the roads (L-shaped via the nearest cross street), in the other door. */
function route(from: { x: number; y: number; lot: Lot | null }, to: Spot): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  let curY: number;
  let curX: number;
  if (from.lot) {
    const d = doorOf(from.lot);
    pts.push({ x: d.x, y: d.y - 6 }, { x: d.x, y: roadBelow(from.lot.row) });
    curX = d.x; curY = roadBelow(from.lot.row);
  } else {
    // Already on the street: snap to the nearest road line.
    curY = ROAD_Y.reduce((a, b) => (Math.abs(b - from.y) < Math.abs(a - from.y) ? b : a));
    const nearX = ROAD_X.reduce((a, b) => (Math.abs(b - from.x) < Math.abs(a - from.x) ? b : a));
    if (Math.abs(nearX - from.x) < Math.abs(curY - from.y)) { pts.push({ x: nearX, y: from.y }); curX = nearX; curY = from.y; }
    else { pts.push({ x: from.x, y: curY }); curX = from.x; }
  }
  if (!to.lot) { pts.push({ x: to.x, y: to.y }); return pts; }
  const td = doorOf(to.lot);
  const ty = roadBelow(to.lot.row);
  if (Math.abs(curY - ty) > 1) {
    const cross = ROAD_X.reduce((a, b) => (Math.abs(b - (curX + td.x) / 2) < Math.abs(a - (curX + td.x) / 2) ? b : a));
    pts.push({ x: cross, y: curY }, { x: cross, y: ty });
  }
  pts.push({ x: td.x, y: ty }, { x: td.x, y: td.y - 6 }, { x: to.x, y: to.y });
  return pts;
}

const TOOL_WORDS: Record<string, string> = {
  web_search: "🔎 researching", web_fetch: "📖 reading", browse_page: "🌐 browsing", trending_videos: "📈 checking trends", youtube_search: "▶️ on YouTube",
  video_transcript: "📝 transcripts", produce_video: "🎬 producing a video", make_clip: "✂️ clipping", make_song: "🎵 producing a song", generate_image: "🎨 designing",
  save_document: "✍️ writing", add_store_product: "🛍️ stocking the store", record_transaction: "💰 bookkeeping", treasury_summary: "💰 the books",
  create_pipeline: "🗂️ planning", delegate_to_agent: "📨 delegating", handoff_to_agent: "📨 handing off", check_inbox: "📥 reviewing",
};

// ---------- portraits (auth-protected images -> bitmaps) ----------
const portraitCache = new Map<string, ImageBitmap | "loading" | "failed">();
function portrait(path: string | null): ImageBitmap | null {
  if (!path) return null;
  const hit = portraitCache.get(path);
  if (hit && hit !== "loading" && hit !== "failed") return hit;
  if (!hit) {
    portraitCache.set(path, "loading");
    fetch(`/creations/${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => createImageBitmap(b, { resizeWidth: 96, resizeHeight: 96, resizeQuality: "high" }))
      .then((bmp) => portraitCache.set(path, bmp))
      .catch(() => portraitCache.set(path, "failed"));
  }
  return null;
}

// ---------- drawing ----------
function drawWorld(ctx: CanvasRenderingContext2D, lots: Lot[], hour: number, litLots: Set<number>, t: number) {
  // grass
  ctx.fillStyle = "#3f6b3a"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#467541";
  for (let i = 0; i < 260; i++) { const x = rnd(i) * W, y = rnd(i + 999) * H; ctx.fillRect(x, y, 3, 2); }
  // roads + sidewalks
  ctx.fillStyle = "#9a9a8e";
  for (const y of ROAD_Y) ctx.fillRect(0, y - ROAD / 2 - 5, W, ROAD + 10);
  for (const x of ROAD_X) ctx.fillRect(x - ROAD / 2 - 5, 0, ROAD + 10, H);
  ctx.fillStyle = "#3a3d44";
  for (const y of ROAD_Y) ctx.fillRect(0, y - ROAD / 2, W, ROAD);
  for (const x of ROAD_X) ctx.fillRect(x - ROAD / 2, 0, ROAD, H);
  ctx.strokeStyle = "#d9c46a"; ctx.lineWidth = 2; ctx.setLineDash([18, 16]);
  for (const y of ROAD_Y) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  for (const x of ROAD_X) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  ctx.setLineDash([]);
  // crosswalks
  ctx.fillStyle = "rgba(240,240,240,0.55)";
  for (const x of ROAD_X) for (const y of ROAD_Y) for (let k = -2; k <= 2; k++) ctx.fillRect(x - ROAD / 2 - 14, y + k * 8 - 2, 10, 4);

  for (const lot of lots) {
    if (lot.kind === "park") {
      ctx.fillStyle = "#4f8a46"; ctx.fillRect(lot.x, lot.y, lot.w, lot.h);
      ctx.fillStyle = "#c9b98c"; ctx.fillRect(lot.x + lot.w / 2 - 8, lot.y, 16, lot.h); ctx.fillRect(lot.x, lot.y + lot.h / 2 - 8, lot.w, 16);
      ctx.fillStyle = "#3d7bb5"; ctx.beginPath(); ctx.ellipse(lot.x + lot.w * 0.72, lot.y + lot.h * 0.28, 52, 30, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.beginPath(); ctx.ellipse(lot.x + lot.w * 0.72 + Math.sin(t / 900) * 14, lot.y + lot.h * 0.28, 16, 4, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 9; i++) {
        const tx = lot.x + 30 + rnd(i * 3 + 7) * (lot.w - 60), ty = lot.y + 30 + rnd(i * 5 + 3) * (lot.h - 60);
        if (Math.abs(tx - (lot.x + lot.w / 2)) < 26 || Math.abs(ty - (lot.y + lot.h / 2)) < 26) continue;
        ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.beginPath(); ctx.ellipse(tx + 4, ty + 16, 18, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2f6b2f"; ctx.beginPath(); ctx.arc(tx, ty, 20, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#3d8a3a"; ctx.beginPath(); ctx.arc(tx - 5, ty - 5, 12, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#7a5230";
      for (const [bx, by] of [[0.28, 0.68], [0.62, 0.68], [0.28, 0.32]]) ctx.fillRect(lot.x + lot.w * bx - 22, lot.y + lot.h * by, 44, 8);
    } else if (lot.kind === "cafe") {
      ctx.fillStyle = "#d8c3a0"; ctx.fillRect(lot.x, lot.y, lot.w, lot.h);
      ctx.fillStyle = "#8b4a3a"; ctx.fillRect(lot.x + 20, lot.y + 20, lot.w - 40, 70);
      ctx.fillStyle = "#e9d7b5"; for (let i = 0; i < 9; i++) ctx.fillRect(lot.x + 20 + i * ((lot.w - 40) / 9), lot.y + 90, (lot.w - 40) / 18, 12);
      for (let i = 0; i < 6; i++) {
        const tx = lot.x + 60 + (i % 3) * ((lot.w - 120) / 2), ty = lot.y + 150 + Math.floor(i / 3) * 80;
        ctx.fillStyle = "#f4f1ea"; ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#c0392b"; ctx.beginPath(); ctx.arc(tx, ty - 26, 22, Math.PI, 0); ctx.fill();
      }
    } else if (lot.kind === "homes") {
      for (let i = 0; i < 6; i++) {
        const hx = lot.x + 18 + (i % 3) * ((lot.w - 36) / 3), hy = lot.y + 24 + Math.floor(i / 3) * ((lot.h - 30) / 2), hw = (lot.w - 36) / 3 - 14, hh = (lot.h - 30) / 2 - 24;
        ctx.fillStyle = "#4b7f45"; ctx.fillRect(hx - 4, hy - 4, hw + 8, hh + 22);
        ctx.fillStyle = ["#c97b5a", "#7f9ccf", "#d9b45a", "#9c7fcf"][i % 4]; ctx.fillRect(hx, hy + hh * 0.35, hw, hh * 0.65);
        ctx.fillStyle = "#6b3b2f"; ctx.beginPath(); ctx.moveTo(hx - 6, hy + hh * 0.38); ctx.lineTo(hx + hw / 2, hy); ctx.lineTo(hx + hw + 6, hy + hh * 0.38); ctx.fill();
        const night = hour < 6 || hour >= 20;
        ctx.fillStyle = night && (i + Math.floor(hour)) % 3 !== 0 ? "#ffd86b" : "#2c3a4a";
        ctx.fillRect(hx + hw * 0.2, hy + hh * 0.55, hw * 0.22, hh * 0.18); ctx.fillRect(hx + hw * 0.58, hy + hh * 0.55, hw * 0.22, hh * 0.18);
      }
    } else {
      // office building: cutaway top-down view with desks, walls and a sign
      const hue = lot.hue ?? 200;
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(lot.x + 6, lot.y + 8, lot.w, lot.h);
      ctx.fillStyle = lot.kind === "hq" ? `hsl(${hue} 30% 82%)` : `hsl(${hue} 25% 86%)`;
      ctx.fillRect(lot.x, lot.y, lot.w, lot.h);
      ctx.strokeStyle = `hsl(${hue} 15% 92% / 0.5)`; ctx.lineWidth = 1;
      for (let gx = lot.x + 24; gx < lot.x + lot.w; gx += 24) { ctx.beginPath(); ctx.moveTo(gx, lot.y); ctx.lineTo(gx, lot.y + lot.h); ctx.stroke(); }
      const lit = lot.companyId != null ? litLots.has(lot.companyId) : litLots.has(-1);
      // desks
      const cols = Math.max(2, Math.floor((lot.w - 52) / 54)), rows = Math.max(2, Math.floor((lot.h - 70) / 52));
      for (let i = 0; i < cols * rows; i++) {
        const dx = lot.x + 46 + (i % cols) * ((lot.w - 92) / Math.max(1, cols - 1)), dy = lot.y + 44 + Math.floor(i / cols) * ((lot.h - 100) / Math.max(1, rows - 1));
        ctx.fillStyle = "#8a6a4a"; ctx.fillRect(dx - 15, dy - 5, 30, 12);
        ctx.fillStyle = lit && (i + Math.floor(t / 700)) % 4 !== 0 ? `hsl(${hue} 90% 70%)` : "#2b3340"; ctx.fillRect(dx - 7, dy - 9, 14, 7);
      }
      // walls with a door gap at the bottom
      ctx.strokeStyle = lot.kind === "hq" ? `hsl(${hue} 45% 32%)` : `hsl(${hue} 35% 30%)`; ctx.lineWidth = lot.kind === "hq" ? 7 : 5;
      const d = doorOf(lot);
      ctx.beginPath(); ctx.moveTo(d.x - 16, lot.y + lot.h); ctx.lineTo(lot.x, lot.y + lot.h); ctx.lineTo(lot.x, lot.y); ctx.lineTo(lot.x + lot.w, lot.y); ctx.lineTo(lot.x + lot.w, lot.y + lot.h); ctx.lineTo(d.x + 16, lot.y + lot.h); ctx.stroke();
      // sign
      const label = lot.label ?? "";
      ctx.font = `600 ${lot.kind === "hq" ? 18 : 13}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = `hsl(${hue} 55% ${lot.kind === "hq" ? 38 : 32}%)`; ctx.fillRect(lot.x + lot.w / 2 - tw / 2, lot.y - 11, tw, lot.kind === "hq" ? 26 : 20);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, lot.x + lot.w / 2, lot.y + (lot.kind === "hq" ? 2 : -1));
    }
    if (lot.kind === "park" || lot.kind === "cafe" || lot.kind === "homes") {
      ctx.font = "600 13px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(0,0,0,0.45)"; const tw = ctx.measureText(lot.label ?? "").width + 14;
      ctx.fillRect(lot.x + lot.w / 2 - tw / 2, lot.y + 2, tw, 18); ctx.fillStyle = "#fff"; ctx.fillText(lot.label ?? "", lot.x + lot.w / 2, lot.y + 11);
    }
  }
  // street lamps
  for (const x of ROAD_X) for (const y of ROAD_Y) { ctx.fillStyle = "#222"; ctx.fillRect(x + ROAD / 2 + 4, y - ROAD / 2 - 14, 4, 12); }
}

function drawLights(ctx: CanvasRenderingContext2D, lots: Lot[], hour: number, litLots: Set<number>) {
  // Night: darken everything, then add warm light pools for lamps and lit offices.
  const dark = hour >= 20 || hour < 5 ? 0.55 : hour >= 18 ? (hour - 18) / 2 * 0.55 : hour < 7 ? (7 - hour) / 2 * 0.55 : 0;
  if (dark <= 0.01) return;
  ctx.fillStyle = `rgba(10, 14, 40, ${dark})`; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "lighter";
  const glow = (x: number, y: number, r: number, c: string) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
  for (const x of ROAD_X) for (const y of ROAD_Y) glow(x + ROAD / 2 + 6, y - ROAD / 2 - 12, 70, `rgba(255, 200, 110, ${dark * 0.55})`);
  for (const lot of lots) {
    if ((lot.kind === "company" || lot.kind === "hq") && (lot.companyId != null ? litLots.has(lot.companyId) : litLots.has(-1))) glow(lot.x + lot.w / 2, lot.y + lot.h / 2, Math.max(lot.w, lot.h) * 0.6, `hsla(${lot.hue ?? 200}, 90%, 60%, ${dark * 0.35})`);
    if (lot.kind === "cafe") glow(lot.x + lot.w / 2, lot.y + 60, 140, `rgba(255, 170, 90, ${dark * 0.4})`);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawChar(ctx: CanvasRenderingContext2D, c: Char, t: number, highlight: boolean) {
  const moving = c.path.length > 0;
  const step = moving ? Math.sin(c.phase) : 0;
  const bob = moving ? Math.abs(Math.sin(c.phase)) * 1.5 : 0;
  const s = c.agentId != null ? 1 : 0.8;
  const x = c.x, y = c.y - bob;
  ctx.save(); ctx.translate(x, y); ctx.scale(s * c.facing, s);
  ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.beginPath(); ctx.ellipse(0, 16, 9, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  if (c.asleep) ctx.globalAlpha = 0.55;
  // legs
  ctx.fillStyle = "#2b2f3a"; ctx.fillRect(-5, 6 + step * 1.5, 4, 9 - step * 1.5); ctx.fillRect(1, 6 - step * 1.5, 4, 9 + step * 1.5);
  // body (company colour)
  ctx.fillStyle = `hsl(${c.hue} ${c.agentId != null ? 65 : 40}% ${c.agentId != null ? 52 : 46}%)`;
  ctx.beginPath(); ctx.roundRect(-7, -6, 14, 14, 4); ctx.fill();
  // arms swing
  ctx.fillStyle = c.skin; ctx.fillRect(-9, -3 - step * 2, 3, 8); ctx.fillRect(6, -3 + step * 2, 3, 8);
  // head + hair
  ctx.fillStyle = c.skin; ctx.beginPath(); ctx.arc(0, -12, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = c.hair; ctx.beginPath(); ctx.arc(0, -14, 6.8, Math.PI, 0); ctx.fill();
  ctx.fillStyle = "#1b1b1b"; ctx.fillRect(1.5, -12.5, 1.6, 1.6);
  ctx.restore();
  if (highlight) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, c.y + 16, 14, 5, 0, 0, Math.PI * 2); ctx.stroke(); }
  if (c.agentId == null) return;
  // portrait badge over the head — the detailed avatar riding along with the 2D body
  const bmp = portrait(c.avatarPath);
  const by = y - 40;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, by, 12, 0, Math.PI * 2); ctx.fillStyle = `hsl(${c.hue} 70% 55%)`; ctx.fill();
  ctx.beginPath(); ctx.arc(x, by, 10, 0, Math.PI * 2); ctx.clip();
  if (bmp) ctx.drawImage(bmp, x - 10, by - 10, 20, 20);
  else { ctx.fillStyle = "#222"; ctx.fillRect(x - 10, by - 10, 20, 20); ctx.fillStyle = "#fff"; ctx.font = "700 10px Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(c.name[0] ?? "?", x, by + 1); }
  ctx.restore();
  ctx.font = "600 10px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  const nm = c.name.split(" ")[0];
  ctx.fillStyle = "rgba(0,0,0,0.55)"; const nw = ctx.measureText(nm).width + 8; ctx.fillRect(x - nw / 2, c.y + 19, nw, 13);
  ctx.fillStyle = "#fff"; ctx.fillText(nm, x, c.y + 20);
  if (c.bubble) {
    ctx.font = "500 11px Inter, system-ui, sans-serif";
    const text = c.bubble.length > 54 ? c.bubble.slice(0, 52) + "…" : c.bubble;
    const bw = ctx.measureText(text).width + 14, bx = x - bw / 2, byy = by - 34;
    ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.beginPath(); ctx.roundRect(bx, byy, bw, 20, 8); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 5, byy + 20); ctx.lineTo(x, byy + 26); ctx.lineTo(x + 5, byy + 20); ctx.fill();
    ctx.fillStyle = "#1a1a1a"; ctx.textBaseline = "middle"; ctx.fillText(text, x, byy + 10);
  }
  if (c.asleep) { ctx.fillStyle = "#cfd8ff"; ctx.font = "700 12px Inter, sans-serif"; ctx.fillText("z", x + 12, by - 6 - (t / 400) % 8); ctx.fillText("z", x + 18, by - 14 - (t / 500) % 8); }
}

// ---------- component ----------
export function LivingTown({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data: team } = useQuery<TeamData>({ queryKey: ["/api/team"], refetchInterval: 3000 });
  const { data: town } = useQuery<TownData>({ queryKey: ["/api/town"], refetchInterval: 5000 });
  const lots = useMemo(() => buildLots(town?.companies ?? []), [town?.companies.map((c) => c.id).join(",")]);
  const chars = useRef(new Map<string, Char>());
  const [hover, setHover] = useState<Char | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [clock, setClock] = useState("");
  const teamRef = useRef(team); teamRef.current = team;
  const townRef = useRef(town); townRef.current = town;
  const lotsRef = useRef(lots); lotsRef.current = lots;
  // Camera: zoom 1 = whole town; scroll to zoom, drag to pan, click an agent to follow them.
  const cam = useRef({ zoom: 1, cx: W / 2, cy: H / 2 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const selectedRef = useRef<number | null>(null); selectedRef.current = selected;

  // Decide where everyone should be, every couple of seconds.
  useEffect(() => {
    const plan = () => {
      const tm = teamRef.current, tw = townRef.current, L = lotsRef.current;
      if (!tm || !tw || L.length === 0) return;
      const hour = simHour();
      const hq = L.find((l) => l.kind === "hq")!;
      const park = L.find((l) => l.kind === "park")!;
      const cafe = L.find((l) => l.kind === "cafe")!;
      const homes = L.filter((l) => l.kind === "homes");
      const lotFor = (companyId: number | null) => (companyId == null ? hq : L.find((l) => l.companyId === companyId) ?? hq);
      const talk = [...(tm.chatter ?? [])].reverse().find((c) => Date.now() - c.at < 60_000);
      const speaking = talk ? talk.lines[Math.floor((Date.now() - talk.at) / 4500) % talk.lines.length] : null;
      const seen = new Set<string>();

      const place = (key: string, seed: number, wanted: { spot: Spot; key: string }, init: Omit<Char, "x" | "y" | "path" | "targetKey" | "lot" | "phase" | "facing">) => {
        seen.add(key);
        let c = chars.current.get(key);
        if (!c) {
          c = { ...init, x: wanted.spot.x, y: wanted.spot.y, path: [], targetKey: wanted.key, lot: wanted.spot.lot, phase: 0, facing: 1 };
          chars.current.set(key, c);
          return;
        }
        Object.assign(c, { name: init.name, role: init.role, hue: init.hue, bubble: init.bubble, asleep: init.asleep, avatarPath: init.avatarPath });
        if (c.targetKey !== wanted.key) {
          c.path = route({ x: c.x, y: c.y, lot: c.path.length ? null : c.lot }, wanted.spot);
          c.targetKey = wanted.key;
          c.lot = wanted.spot.lot;
        }
      };

      const routine = (seed: number, home: Lot, work: Lot): { spot: Spot; key: string; asleep: boolean } => {
        const h = (hour + rnd(seed) * 1.5) % 24; // staggered so not everyone moves at once
        if (h < 6.5 || h >= 22.5) return { spot: spotIn(home, seed), key: `home`, asleep: true };
        if (h >= 12 && h < 13.2) return { spot: spotIn(cafe, seed + Math.floor(hour)), key: `cafe`, asleep: false };
        if (h >= 17.5) {
          const social = rnd(seed + 3) > 0.45 ? park : cafe;
          return { spot: spotIn(social, seed + Math.floor(hour / 2)), key: `social-${social.kind}-${Math.floor(hour / 2)}`, asleep: false };
        }
        if (h >= 15 && rnd(seed + Math.floor(hour)) > 0.82) return { spot: spotIn(park, seed + 9), key: `break-${Math.floor(hour)}`, asleep: false };
        return { spot: spotIn(work, seed, "desk"), key: `work`, asleep: false };
      };

      const companyHue = new Map(tw.companies.map((c) => [c.id, c.color] as const));
      for (const m of tm.members) {
        const seed = m.id * 97 + 13;
        const home = homes[m.id % homes.length];
        const work = lotFor(m.companyId);
        const hue = m.isOverseer ? 265 : (m.companyId != null ? companyHue.get(m.companyId) ?? 200 : 265);
        const look = { skin: SKINS[hash(m.name) % SKINS.length], hair: HAIRS[hash(m.name + "h") % HAIRS.length] };
        let wanted: { spot: Spot; key: string }, bubble: string | null = null, asleep = false;
        const chatting = talk && talk.agentIds.includes(m.id) && m.status === "active" && !m.working;
        if (m.status === "paused") { wanted = { spot: spotIn(home, seed), key: "home" }; asleep = true; }
        else if (m.working || m.waitingApproval) {
          wanted = { spot: spotIn(work, seed, "desk"), key: "work" };
          bubble = m.waitingApproval ? "⏳ needs your OK" : TOOL_WORDS[m.lastTools[0] ?? ""] ?? "💼 working";
        } else if (chatting) {
          const bench = { x: park.x + park.w * (talk!.agentIds[0] === m.id ? 0.26 : 0.36), y: park.y + park.h * 0.66, lot: park };
          wanted = { spot: bench, key: `chat-${talk!.at}` };
          if (speaking?.agentId === m.id) bubble = speaking.text;
        } else {
          const r = routine(seed, home, work);
          wanted = r; asleep = r.asleep;
        }
        place(`a${m.id}`, seed, wanted, {
          key: `a${m.id}`, agentId: m.id, name: m.name, role: m.role ?? "", hue, ...look, bubble, asleep, avatarPath: m.avatarPath, tint: 0,
        });
      }
      for (const c of tw.companies.filter((x) => x.kind === "simulated")) {
        const work = lotFor(c.id);
        for (const r of c.staff) {
          const seed = r.id * 131 + 7;
          const rt = routine(seed, homes[(r.id + 1) % homes.length], work);
          place(`r${r.id}`, seed, rt, {
            key: `r${r.id}`, residentCompany: c.id, name: r.name, role: r.role ?? "", hue: c.color,
            skin: SKINS[hash(r.name) % SKINS.length], hair: HAIRS[hash(r.name + "h") % HAIRS.length], bubble: null, asleep: rt.asleep, avatarPath: null, tint: 0,
          });
        }
      }
      for (const k of [...chars.current.keys()]) if (!seen.has(k)) chars.current.delete(k);
      const hh = Math.floor(hour), mm = Math.floor((hour % 1) * 60);
      setClock(`Day ${tw.simDay || 1} · ${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`);
    };
    plan();
    const id = setInterval(plan, 2000);
    return () => clearInterval(id);
  }, []);

  // Animation loop.
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0, last = performance.now();
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(w * (H / W) * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${w * (H / W)}px`;
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const scale = canvas.width / W;
      const v = cam.current;
      // follow the selected agent
      const followed = selectedRef.current != null ? chars.current.get(`a${selectedRef.current}`) : undefined;
      if (followed && !drag.current) { v.cx += (followed.x - v.cx) * Math.min(1, dt * 3); v.cy += (followed.y - v.cy) * Math.min(1, dt * 3); }
      clampCam(v);
      const k = scale * v.zoom;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#2f5229"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, canvas.width / 2 - v.cx * k, canvas.height / 2 - v.cy * k);
      const hour = simHour();
      const litLots = new Set<number>();
      for (const m of teamRef.current?.members ?? []) if (m.working) litLots.add(m.companyId ?? -1);
      drawWorld(ctx, lotsRef.current, hour, litLots, now);
      // move + draw characters, back to front
      const list = [...chars.current.values()];
      for (const c of list) {
        if (c.path.length) {
          const p = c.path[0];
          const dx = p.x - c.x, dy = p.y - c.y, dist = Math.hypot(dx, dy);
          const speed = (c.agentId != null ? 70 : 55) * dt;
          if (dist <= speed) { c.x = p.x; c.y = p.y; c.path.shift(); }
          else { c.x += (dx / dist) * speed; c.y += (dy / dist) * speed; if (Math.abs(dx) > 0.5) c.facing = dx > 0 ? 1 : -1; }
          c.phase += dt * 11;
        }
      }
      list.sort((a, b) => a.y - b.y);
      for (const c of list) drawChar(ctx, c, now, selected != null && c.agentId === selected);
      drawLights(ctx, lotsRef.current, hour, litLots);
      // keep bubbles/portraits readable on top of the night tint
      if (hour >= 18 || hour < 7) for (const c of list) if (c.agentId != null && (c.bubble || selected === c.agentId)) drawChar(ctx, c, now, selected === c.agentId);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [selected]);

  function clampCam(v: { zoom: number; cx: number; cy: number }) {
    v.zoom = Math.max(1, Math.min(4, v.zoom));
    const hw = W / (2 * v.zoom), hh = H / (2 * v.zoom);
    v.cx = Math.max(hw, Math.min(W - hw, v.cx));
    v.cy = Math.max(hh, Math.min(H - hh, v.cy));
  }

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = cam.current, k = (rect.width / W) * v.zoom;
    return { x: (clientX - rect.left - rect.width / 2) / k + v.cx, y: (clientY - rect.top - rect.height / 2) / k + v.cy };
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cxp = clientX ?? rect.left + rect.width / 2, cyp = clientY ?? rect.top + rect.height / 2;
    const before = toWorld(cxp, cyp);
    cam.current.zoom *= factor; clampCam(cam.current);
    const after = toWorld(cxp, cyp);
    cam.current.cx += before.x - after.x; cam.current.cy += before.y - after.y; clampCam(cam.current);
  }

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  function pick(e: React.MouseEvent<HTMLCanvasElement>): Char | null {
    const canvas = canvasRef.current!;
    const { x, y } = toWorld(e.clientX, e.clientY);
    let best: Char | null = null, bd = 26;
    for (const c of chars.current.values()) {
      const d = Math.hypot(c.x - x, c.y - 6 - y) - (c.agentId != null ? 6 : 0);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  const selMember = team?.members.find((m) => m.id === selected) ?? null;
  const selCompany = selMember?.companyId != null ? town?.companies.find((c) => c.id === selMember.companyId) : null;
  const latest = town?.events?.[0];

  return (
    <div className={className}>
      <div ref={wrapRef} className="relative w-full overflow-hidden rounded-2xl border border-border shadow-panel">
        <canvas
          ref={canvasRef}
          className="block cursor-pointer"
          onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy, moved: false }; }}
          onMouseMove={(e) => {
            const d = drag.current;
            if (d) {
              if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
              if (d.moved) {
                const rect = canvasRef.current!.getBoundingClientRect(), k = (rect.width / W) * cam.current.zoom;
                cam.current.cx = d.cx - (e.clientX - d.x) / k; cam.current.cy = d.cy - (e.clientY - d.y) / k; clampCam(cam.current);
                return;
              }
            }
            setHover(pick(e));
          }}
          onMouseUp={(e) => {
            const d = drag.current; drag.current = null;
            if (d?.moved) return;
            const c = pick(e);
            setSelected(c?.agentId ?? null);
            if (c?.agentId != null && cam.current.zoom < 2.2) cam.current.zoom = 2.2;
          }}
          onMouseLeave={() => { setHover(null); drag.current = null; }}
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white backdrop-blur">{clock}</div>
        <div className="absolute bottom-3 right-3 flex overflow-hidden rounded-full bg-black/55 text-sm text-white backdrop-blur">
          <button type="button" className="px-3 py-1 hover:bg-white/15" onClick={() => zoomAt(1.3)} title="Zoom in">+</button>
          <button type="button" className="px-3 py-1 hover:bg-white/15" onClick={() => zoomAt(1 / 1.3)} title="Zoom out">−</button>
          <button type="button" className="px-3 py-1 text-xs hover:bg-white/15" onClick={() => { cam.current = { zoom: 1, cx: W / 2, cy: H / 2 }; setSelected(null); }} title="Show the whole town">Reset</button>
        </div>
        {latest && <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] truncate rounded-full bg-black/55 px-3 py-1 text-xs text-white backdrop-blur">📰 {latest.text}</div>}
        {hover && !selMember && (
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-xl bg-black/65 p-2 pr-3 text-white backdrop-blur">
            {hover.agentId != null
              ? <IdentityAvatar name={hover.name} avatarPath={hover.avatarPath} className="h-10 w-10" />
              : <span className="h-3 w-3 rounded-full" style={{ background: `hsl(${hover.hue} 50% 50%)` }} />}
            <div>
              <div className="text-xs font-semibold">{hover.name}</div>
              <div className="text-[10px] opacity-75">{hover.role}{hover.agentId == null ? " · resident" : ""}{hover.asleep ? " · asleep" : ""}</div>
            </div>
          </div>
        )}
        {selMember && (
          <div className="absolute right-3 top-3 w-72 rounded-2xl border border-border bg-card/95 p-3 shadow-xl backdrop-blur animate-in">
            <div className="flex items-start gap-3">
              <IdentityAvatar name={selMember.name} avatarPath={selMember.avatarPath} className="h-20 w-20 rounded-xl" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold leading-tight">{selMember.name}</div>
                <div className="text-xs text-muted-foreground">{selMember.isOverseer ? "Lead of everything" : selMember.role}</div>
                <div className="text-xs text-muted-foreground">{selCompany?.name ?? "AURORA HQ"}</div>
                <div className="mt-1 text-[11px]">{selMember.status === "paused" ? "😴 Off duty" : selMember.waitingApproval ? "⏳ Waiting on an approval" : selMember.working ? "💼 Working now" : `🙂 ${selMember.mood}`}</div>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="opacity-60 hover:opacity-100" title="Close"><X size={15} /></button>
            </div>
            {selMember.working && selMember.currentTask && <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">On: {selMember.currentTask.replace(/^\[[^\]]*\]:?\s*/, "")}</p>}
            {!selMember.working && selMember.lastActivity && <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">Last: {selMember.lastActivity.text}</p>}
            <Link href="/team" className="mt-2 inline-block text-xs text-primary hover:underline">Open in Team →</Link>
          </div>
        )}
      </div>
    </div>
  );
}
