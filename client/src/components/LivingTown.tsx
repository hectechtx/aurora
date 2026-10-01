import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { getToken } from "@/lib/queryClient";
import { IdentityAvatar } from "@/components/ui/Avatar";
import { X } from "lucide-react";
import { AgentProfile } from "@/components/AgentProfile";
import { moodFace } from "@/lib/mood";
import { VENUES, WEEKDAYS, agentSeed, routineAt, townDayNumber, townHour, type VenueId } from "@shared/town";

// A living pixel-art town: every agent is a little character who commutes to
// their company's office, works at a desk, grabs lunch, and spends evenings
// at the theater, park, rec center, arcade, studio or garden — driven by their
// REAL state (working, waiting on approval, chatting, paused) first and the
// shared town routine otherwise (the server uses the same routine, so time
// off in town really lifts their morale). Their detailed portrait floats over
// their head. Tiles: Kenney "Tiny Town" + "RPG Urban" (CC0).

// ---------- data shapes (from /api/team and /api/town) ----------
interface TeamMember {
  id: number; name: string; role: string | null; isOverseer: boolean; status: "active" | "paused"; avatarPath: string | null;
  companyId: number | null; working: boolean; waitingApproval: boolean; currentTask: string | null; lastTools: string[];
  mood: string; lastActivity: { text: string; at: number } | null; morale: number; energy: number;
  relationships?: { otherAgentId: number; sentiment: number; interactions: number }[];
}
interface Chatter { agentIds: [number, number]; lines: { agentId: number; text: string }[]; at: number; venue?: VenueId }
interface TeamData { members: TeamMember[]; chatter: Chatter[] }
interface TownCompany { id: number; name: string; kind: "real" | "simulated"; industry: string; color: number; staff: { id: number; name: string; role: string | null; mood?: string }[] }
interface TownData { simDay: number; companies: TownCompany[]; events: { id: number; text: string; at: number }[] }

// ---------- world layout (tiles of 16px) ----------
const T = 16;
const BCOLS = 5, BW = 17, BH = 14, RD = 2;
const rx = (i: number) => i * (BW + RD);
const ry = (j: number) => j * (BH + RD);
const MW = BCOLS * (BW + RD) + RD;
const ROAD_X = Array.from({ length: BCOLS + 1 }, (_, i) => (rx(i) + 1) * T);
const PIXEL_FONT = `"Pixelify Sans", "VT323", ui-monospace, monospace`;

type Face = "up" | "down" | "left" | "right";
interface Spot { x: number; y: number; face?: Face }
type LotKind = "hq" | "company" | "home" | VenueId;
interface Lot {
  tx: number; ty: number; tw: number; th: number; row: number; kind: LotKind;
  companyId?: number; label: string; hue: number; spots: Spot[]; desks: Spot[]; sign: { x: number; y: number };
}
interface Layout { lots: Lot[]; mh: number; lamps: { x: number; y: number }[]; windows: { x: number; y: number; w: number; h: number }[]; roadY: number[] }

// Offices are scattered between homes and amenities like a real town.
const PLAN: string[][] = [
  ["home", "cafe|restaurant", "hq", "market|store", "home"],
  ["co", "co", "park", "co", "theater|arcade"],
  ["school|library", "co", "plaza", "co", "co"],
  ["home", "co", "rec", "lounge|studio", "co"],
  ["co", "garden|home", "co", "home", "co"],
];
const CO_ORDER: [number, number][] = [[1, 1], [3, 1], [1, 2], [3, 2], [0, 1], [4, 2], [1, 3], [4, 3], [2, 4], [0, 4], [4, 4]];

function rnd(seed: number): number { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

function buildLayout(companies: TownCompany[]): Layout {
  const plan = PLAN.map((r) => [...r]);
  const coBlocks = [...CO_ORDER];
  // Growing org: add whole rows of office blocks when the city runs out.
  while (coBlocks.length * 2 < companies.length) {
    const j = plan.length;
    plan.push(Array(BCOLS).fill("co"));
    for (let i = 0; i < BCOLS; i++) coBlocks.push([i, j]);
  }
  const lots: Lot[] = [];
  const real = companies.filter((c) => c.kind === "real");
  const sims = companies.filter((c) => c.kind === "simulated");
  const queue = [...real, ...sims];
  const coSlots = new Map<string, TownCompany[]>();
  for (const [i, j] of coBlocks) coSlots.set(`${i},${j}`, [queue.shift(), queue.shift()].filter(Boolean) as TownCompany[]);
  const mk = (kind: LotKind, i: number, j: number, half: 0 | 1 | null, label: string, hue = 30): Lot => {
    const bx = rx(i) + RD, by = ry(j) + RD;
    const tx = half === null ? bx : bx + half * 9, tw = half === null ? BW : 8;
    return { tx, ty: by, tw, th: BH, row: j, kind, label, hue, spots: [], desks: [], sign: { x: (tx + tw / 2) * T, y: (by + 1) * T } };
  };
  for (let j = 0; j < plan.length; j++) for (let i = 0; i < BCOLS; i++) {
    const cell = plan[j][i];
    if (cell === "co") {
      const cos = coSlots.get(`${i},${j}`) ?? [];
      for (const half of [0, 1] as const) {
        const c = cos[half];
        lots.push(c ? { ...mk("company", i, j, half, c.name, c.color), companyId: c.id } : mk("home", i, j, half, "Cottage"));
      }
    } else if (cell === "hq") lots.push(mk("hq", i, j, null, "AURORA HQ", 265));
    else if (cell === "home") { lots.push(mk("home", i, j, 0, "Maple Cottage")); lots.push(mk("home", i, j, 1, "Willow Cottage")); }
    else if (cell.includes("|")) cell.split("|").forEach((v, h) => lots.push(v === "home" ? mk("home", i, j, h as 0 | 1, "Birch Cottage") : mk(v as VenueId, i, j, h as 0 | 1, VENUES[v as VenueId].name)));
    else lots.push(mk(cell as VenueId, i, j, null, VENUES[cell as VenueId].name));
  }
  const mh = plan.length * (BH + RD) + RD;
  const roadY = Array.from({ length: plan.length + 1 }, (_, j) => (ry(j) + 1) * T);
  const lamps: Layout["lamps"] = [];
  for (let i = 0; i < BCOLS; i++) for (let j = 0; j < plan.length; j++) lamps.push({ x: rx(i) * T + 2 * T + 6, y: ry(j) * T + 2 * T + 2 });
  return { lots, mh, lamps, windows: [], roadY };
}

// ---------- sprite sheets ----------
interface Sheets { tt: HTMLImageElement; ru: HTMLImageElement }
let sheetsPromise: Promise<Sheets> | null = null;
function loadSheets(): Promise<Sheets> {
  if (!sheetsPromise) {
    const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    sheetsPromise = Promise.all([load("/pixel/tiny-town.png"), load("/pixel/rpg-urban.png")]).then(([tt, ru]) => ({ tt, ru }));
  }
  return sheetsPromise;
}

function shade(hex: string, d: number): string {
  const n = parseInt(hex.slice(1), 16), c = (v: number) => Math.max(0, Math.min(255, v + d));
  return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

// ---------- static map painter ----------
function paintMap(L: Layout, S: Sheets): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = MW * T; cv.height = L.mh * T;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  const tt = (c: number, r: number, x: number, y: number) => g.drawImage(S.tt, c * T, r * T, T, T, x * T, y * T, T, T);
  const ru = (c: number, r: number, x: number, y: number) => g.drawImage(S.ru, c * T, r * T, T, T, x * T, y * T, T, T);
  const ttp = (c: number, r: number, px: number, py: number) => g.drawImage(S.tt, c * T, r * T, T, T, Math.round(px), Math.round(py), T, T);
  const rup = (c: number, r: number, px: number, py: number) => g.drawImage(S.ru, c * T, r * T, T, T, Math.round(px), Math.round(py), T, T);
  const rect = (x: number, y: number, w: number, h: number, c: string) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
  L.windows.length = 0;

  // grass everywhere, a few flowers and tufts
  for (let y = 0; y < L.mh; y++) for (let x = 0; x < MW; x++) {
    const r = rnd(x * 131 + y * 7);
    tt(r > 0.93 ? 2 : r > 0.82 ? 1 : 0, 0, x, y);
  }
  // paved streets, 2 tiles wide
  const pave = (x: number, y: number) => ru(1, 4, x, y);
  for (let j = 0; j < L.roadY.length; j++) for (let x = 0; x < MW; x++) { pave(x, ry(j)); pave(x, ry(j) + 1); }
  for (let i = 0; i <= BCOLS; i++) for (let y = 0; y < L.mh; y++) { pave(rx(i), y); pave(rx(i) + 1, y); }

  const tree = (x: number, y: number, kind = 0) => {
    if (kind === 2) { ttp(5, 0, x, y); return; }               // round bush
    const c = kind === 1 ? 3 : 4;                               // orange / green tall tree
    ttp(c, 0, x, y - T); ttp(c, 1, x, y);
  };
  const fenceRow = (x0: number, x1: number, y: number) => { for (let x = x0; x <= x1; x++) tt(x === x0 ? 8 : x === x1 ? 10 : 9, 6, x, y); };
  const dirt = (x0: number, y0: number, w: number, h: number) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = w === 1 ? 1 : x === 0 ? 0 : x === w - 1 ? 2 : 1;
      const r = h === 1 ? 2 : y === 0 ? 1 : y === h - 1 ? 3 : 2;
      tt(c, r, x0 + x, y0 + y);
    }
  };
  const water = (x0: number, y0: number, w: number, h: number) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ru(8 + (x === 0 ? 0 : x === w - 1 ? 2 : 1), 6 + (y === 0 ? 0 : y === h - 1 ? 2 : 1), x0 + x, y0 + y);
  };
  const lamp = (px: number, py: number) => { rup(7, 6, px, py - T); rup(7, 7, px, py); L.lamps.push({ x: px + 8, y: py - 10 }); };
  const bench = (px: number, py: number) => rup(3, 14, px, py);
  /** Tiny Town house: 2 roof rows + 2 wall rows; returns the door's pixel point. */
  const house = (tx: number, ty: number, w: number, roof: "blue" | "red", wall: "wood" | "stone"): { x: number; y: number } => {
    const rb = roof === "blue" ? 0 : 4, wb = wall === "wood" ? 0 : 4;
    const door = tx + Math.floor(w / 2);
    for (let i = 0; i < w; i++) {
      const x = tx + i, edge = i === 0 ? 0 : i === w - 1 ? 2 : 1;
      tt(rb + edge, 4, x, ty); tt(rb + edge, 5, x, ty + 1);
      tt(wb + (i === 0 ? 0 : i === w - 1 ? 3 : 1), 6, x, ty + 2);
      tt(wb + (x === door ? 1 : 0), 7, x, ty + 3);
      if (x !== door) L.windows.push({ x: x * T + 4, y: (ty + 3) * T + 4, w: 8, h: 7 });
    }
    return { x: door * T + T / 2, y: (ty + 4) * T };
  };
  const table = (px: number, py: number, umbrella: string | null) => {
    rect(px - 6, py - 2, 12, 6, "#6b4a2e"); rect(px - 5, py - 3, 10, 5, "#e9dcc0");
    if (umbrella) { rect(px - 1, py - 14, 2, 12, "#5b4636"); rect(px - 9, py - 18, 18, 4, umbrella); rect(px - 7, py - 20, 14, 2, umbrella); rect(px - 9, py - 15, 18, 1, "rgba(0,0,0,0.25)"); }
  };
  const awningStall = (px: number, py: number, c1: string) => {
    for (let i = 0; i < 6; i++) rect(px + i * 6, py, 6, 7, i % 2 ? "#f3ead2" : c1);
    rect(px, py + 7, 36, 2, "rgba(0,0,0,0.25)");
    rect(px + 1, py + 9, 2, 14, "#5b4636"); rect(px + 33, py + 9, 2, 14, "#5b4636");
    rup(6, 10, px + 2, py + 10); rup(7, 10, px + 18, py + 10);
  };
  const desk = (px: number, py: number, carpet: boolean) => {
    rect(px - 11, py - 7, 22, 9, "#5a3a22"); rect(px - 10, py - 8, 20, 8, carpet ? "#8f6aa8" : "#9c6b3f");
    rect(px - 4, py - 15, 9, 7, "#2b3340"); rect(px - 3, py - 14, 7, 5, "#3b4a5c"); rect(px, py - 8, 2, 1, "#2b3340");
    rect(px - 4, py + 5, 8, 5, "#3a3f4a"); // chair
  };
  const officeFloor = (x0: number, y0: number, w: number, h: number, carpet: string | null) => {
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 1) {
      const px = x0 + x, py = y0 + y;
      if (carpet) { g.fillStyle = (Math.floor(px / 4) + Math.floor(py / 4)) % 2 ? carpet : shade(carpet, -8); g.fillRect(px, py, 1, 4); continue; }
      const plank = Math.floor((px + (Math.floor(py / 4) % 3) * 9) / 18) % 4;
      g.fillStyle = ["#b97f4a", "#ad7443", "#c08852", "#a86f3f"][plank]; g.fillRect(px, py, 1, 4);
    }
    g.fillStyle = "rgba(60,35,20,0.35)"; for (let y = 0; y < h; y += 4) g.fillRect(x0, y0 + y, w, 1);
  };

  for (const lot of L.lots) {
    const X = lot.tx * T, Y = lot.ty * T, Wp = lot.tw * T, Hp = lot.th * T;
    const midX = X + Wp / 2;
    // a little path from the lot's door to the street
    const pathTo = (fromTileY: number) => { for (let y = fromTileY; y < lot.ty + lot.th; y++) { ru(1, 4, lot.tx + Math.floor(lot.tw / 2) - 1, y); ru(1, 4, lot.tx + Math.floor(lot.tw / 2), y); } };
    const spot = (x: number, y: number, face?: Face) => lot.spots.push({ x, y, face });

    if (lot.kind === "company" || lot.kind === "hq") {
      const hq = lot.kind === "hq";
      const bx0 = lot.tx, by0 = lot.ty + 1, bw = lot.tw, bh = 10;
      // back wall seen from inside, with windows
      for (let i = 0; i < bw; i++) { tt(4 + (i === 0 ? 0 : i === bw - 1 ? 3 : 1), 6, bx0 + i, by0); tt(4, 7, bx0 + i, by0 + 1); }
      const floors = [null, "#8a96a8", "#a7876a", "#7f9a86", "#9a8aa8"] as const;
      officeFloor(bx0 * T, (by0 + 2) * T, bw * T, (bh - 2) * T, hq ? "#6d5a86" : floors[(lot.companyId ?? 0) % floors.length]);
      // company colour stripe along the top of the wall
      rect(bx0 * T, by0 * T, bw * T, 3, `hsl(${lot.hue} 60% 50%)`);
      // walls (thick outline) with a doorway at the bottom
      const wx = bx0 * T, wy = by0 * T, ww = bw * T, wh = bh * T, gap = 14;
      rect(wx - 3, wy, 3, wh + 3, "#3a2618"); rect(wx + ww, wy, 3, wh + 3, "#3a2618");
      rect(wx - 3, wy + wh, ww / 2 - gap + 3, 3, "#3a2618"); rect(wx + ww / 2 + gap, wy + wh, ww / 2 - gap + 3, 3, "#3a2618");
      // desks
      const cols = hq ? 4 : 2, rows = 3;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const px = Math.round(wx + ((c + 0.5) * ww) / cols), py = Math.round(wy + 3 * T + 10 + r * 2.4 * T);
        if (hq && r === 0 && (c === 1 || c === 2)) continue;
        desk(px, py, hq);
        lot.desks.push({ x: px, y: py + 12, face: "up" });
      }
      if (hq) {
        // AURORA's command desk at the head of the room
        const px = wx + ww / 2, py = wy + 3 * T + 8;
        rect(px - 30, py - 8, 60, 10, "#3b2a4d"); rect(px - 29, py - 9, 58, 9, "#b48ad6");
        for (const dx of [-18, 0, 18]) { rect(px + dx - 6, py - 19, 12, 9, "#1f2633"); rect(px + dx - 5, py - 18, 10, 7, "#4a5b7a"); }
        lot.desks.unshift({ x: px, y: py + 13, face: "up" });
      }
      // a rug and a bookshelf so offices don't all look alike
      if (!hq) {
        rect(wx + ww / 2 - 18, wy + wh - 30, 36, 14, `hsl(${lot.hue} 45% 45%)`); rect(wx + ww / 2 - 16, wy + wh - 28, 32, 10, `hsl(${lot.hue} 50% 58%)`);
        rect(wx + 4, wy + wh - 34, 10, 26, "#5a3a22"); for (let b = 0; b < 4; b++) rect(wx + 5, wy + wh - 32 + b * 6, 8, 4, ["#c0392b", "#3f7fbf", "#e0a63a", "#4f9a4a"][(b + (lot.companyId ?? 0)) % 4]);
      }
      // plants and a water cooler
      ttp(5, 0, wx + 2, wy + 2 * T + 2); ttp(5, 0, wx + ww - T - 2, wy + 2 * T + 2);
      rect(wx + ww - 12, wy + wh - 22, 8, 14, "#d6e4f0"); rect(wx + ww - 11, wy + wh - 28, 6, 7, "#7fb8e0");
      pathTo(lot.ty + 1 + bh);
      tree(X + 2, Y + Hp - 2 * T + 6, hq ? 0 : 2); tree(X + Wp - T - 2, Y + Hp - 2 * T + 6, 2);
      // breakroom spots inside, by the door
      spot(midX - 20, wy + wh - 10, "right"); spot(midX + 20, wy + wh - 10, "left");
      if (hq) { lamp(X + 3 * T, Y + Hp - T); lamp(X + Wp - 4 * T, Y + Hp - T); }
      continue;
    }

    if (lot.kind === "home") {
      const roof = hash(lot.label + lot.tx) % 2 ? "red" : "blue";
      const door = house(lot.tx + 1, lot.ty + 2, 6, roof, hash(lot.label + lot.ty) % 2 ? "wood" : "stone");
      pathTo(lot.ty + 6);
      fenceRow(lot.tx, lot.tx + Math.floor(lot.tw / 2) - 2, lot.ty + 9);
      fenceRow(lot.tx + Math.floor(lot.tw / 2) + 1, lot.tx + lot.tw - 1, lot.ty + 9);
      tree(X + 4, Y + 11 * T + 12, (lot.tx + lot.ty) % 2); tree(X + Wp - T - 4, Y + 11 * T + 10, 2);
      dirt(lot.tx + 5, lot.ty + 7, 2, 2); ttp(5, 1, (lot.tx + 5) * T, (lot.ty + 7) * T); ttp(5, 1, (lot.tx + 6) * T, (lot.ty + 8) * T);
      rup(8, 11, (lot.tx + 1) * T, (lot.ty + 7) * T);
      spot(door.x, door.y + 4, "down");
      continue;
    }

    const v = lot.kind as VenueId;
    switch (v) {
      case "park": {
        // dirt paths in a cross, pond, trees, benches, flowers
        dirt(lot.tx, lot.ty + 6, lot.tw, 2); dirt(lot.tx + 7, lot.ty, 2, lot.th);
        water(lot.tx + 10, lot.ty + 1, 6, 4);
        for (const [x, y, k] of [[1, 2, 0], [3, 1, 1], [5, 3, 0], [1, 11, 1], [4, 13, 0], [11, 11, 0], [14, 13, 1], [15, 10, 2], [2, 4, 2], [12, 13, 2]] as const) tree((lot.tx + x) * T, (lot.ty + y) * T, k);
        for (const [x, y] of [[4, 5], [11, 5], [4, 8], [11, 8]]) bench((lot.tx + x) * T, (lot.ty + y) * T);
        for (let i = 0; i < 14; i++) ttp(2, 0, (lot.tx + 1 + rnd(i * 3) * 15) * T, (lot.ty + 9 + rnd(i * 7) * 4) * T);
        lamp((lot.tx + 6) * T, (lot.ty + 5) * T); lamp((lot.tx + 9) * T, (lot.ty + 9) * T);
        for (const [x, y, f] of [[4.4, 5.6, "down"], [5.2, 5.6, "down"], [11.4, 5.6, "down"], [12.2, 5.6, "down"], [4.4, 8.6, "down"], [11.4, 8.6, "down"], [10.6, 5.6, "up"], [13, 5.6, "up"], [15, 5.6, "up"], [2, 7.2, "right"], [14, 7.4, "left"], [8, 10, "down"]] as const) spot((lot.tx + x) * T, (lot.ty + y) * T, f as Face);
        break;
      }
      case "rec": {
        // sports court on the left, a pool on the right
        const cx = X + T, cy = Y + 2 * T, cw = 8 * T, ch = 10 * T;
        rect(cx, cy, cw, ch, "#4f8a43"); rect(cx + 2, cy + 2, cw - 4, ch - 4, "#6aa95a");
        g.strokeStyle = "#f2f2e6"; g.lineWidth = 1; g.strokeRect(cx + 6.5, cy + 6.5, cw - 13, ch - 13);
        rect(cx + 6, cy + ch / 2, cw - 12, 1, "#f2f2e6"); g.beginPath(); g.arc(cx + cw / 2, cy + ch / 2, 12, 0, Math.PI * 2); g.stroke();
        rect(cx + cw / 2 - 8, cy + 4, 16, 3, "#ddd"); rect(cx + cw / 2 - 8, cy + ch - 7, 16, 3, "#ddd");
        water(lot.tx + 11, lot.ty + 3, 5, 6);
        for (const x of [11, 13, 15]) bench((lot.tx + x) * T, (lot.ty + 10) * T);
        tree(X + 2, Y + Hp - T, 0); tree(X + Wp - T - 2, Y + T + 6, 2);
        for (const [x, y, f] of [[3, 4, "down"], [7, 4, "down"], [5, 6.5, "right"], [3, 9.5, "up"], [7, 9.5, "up"], [5, 10.5, "left"], [11.5, 10.6, "up"], [13.5, 10.6, "up"], [15.5, 10.6, "up"], [10.5, 5, "right"], [10.5, 7, "right"], [13.5, 2.6, "down"]] as const) spot((lot.tx + x) * T, (lot.ty + y) * T, f as Face);
        lamp(X + 10 * T, Y + Hp - T);
        break;
      }
      case "plaza": {
        // town square: paving, a fountain, benches, planters
        for (let y = lot.ty; y < lot.ty + lot.th; y++) for (let x = lot.tx; x < lot.tx + lot.tw; x++) ru(1, 4, x, y);
        water(lot.tx + 6, lot.ty + 4, 5, 5);
        const fx = (lot.tx + 8.5) * T, fy = (lot.ty + 6.5) * T;
        rect(fx - 10, fy - 10, 20, 20, "#c9c2b2"); rect(fx - 8, fy - 8, 16, 16, "#7fc6e8"); rect(fx - 3, fy - 16, 6, 14, "#c9c2b2"); rect(fx - 2, fy - 22, 4, 6, "#bfe8ff");
        for (const [x, y] of [[1, 1], [15, 1], [1, 12], [15, 12]]) { rect((lot.tx + x) * T - 2, (lot.ty + y) * T + 6, 20, 10, "#8a5a3a"); tree((lot.tx + x) * T, (lot.ty + y) * T, x === 1 ? 0 : 1); }
        for (const [x, y] of [[3, 3], [13, 3], [3, 10], [13, 10]]) bench((lot.tx + x) * T, (lot.ty + y) * T);
        lamp((lot.tx + 5) * T, (lot.ty + 3) * T); lamp((lot.tx + 11) * T, (lot.ty + 3) * T); lamp((lot.tx + 5) * T, (lot.ty + 11) * T); lamp((lot.tx + 11) * T, (lot.ty + 11) * T);
        for (const [x, y, f] of [[3.5, 3.7, "down"], [13.5, 3.7, "down"], [3.5, 10.7, "down"], [13.5, 10.7, "down"], [5.3, 6.8, "right"], [11.8, 6.8, "left"], [8.5, 9.8, "up"], [7, 9.8, "up"], [10, 3.6, "down"], [2, 7, "right"], [15, 7, "left"]] as const) spot((lot.tx + x) * T, (lot.ty + y) * T, f as Face);
        break;
      }
      case "garden": {
        for (const [x, y] of [[1, 2], [4, 2], [1, 6], [4, 6]]) {
          dirt(lot.tx + x, lot.ty + y, 3, 3);
          for (let k = 0; k < 4; k++) ttp(5, k % 2 ? 1 : 2, (lot.tx + x + (k % 2) * 1.2 + 0.3) * T, (lot.ty + y + Math.floor(k / 2) * 1.2 + 0.4) * T);
        }
        fenceRow(lot.tx, lot.tx + lot.tw - 1, lot.ty + 1);
        tree(X + Wp - T - 2, Y + 12 * T, 1); ttp(8, 7, (lot.tx + 1) * T, (lot.ty + 10) * T);
        pathTo(lot.ty + 10);
        for (const [x, y, f] of [[2.5, 5.4, "up"], [5.5, 5.4, "up"], [2.5, 9.4, "up"], [5.5, 9.4, "up"], [4, 4.5, "left"], [4, 8.5, "right"], [7.4, 6, "left"]] as const) spot((lot.tx + x) * T, (lot.ty + y) * T, f as Face);
        break;
      }
      default: {
        // building venues: a house-style building + something fun out front
        const style: Record<string, ["blue" | "red", "wood" | "stone", number]> = {
          cafe: ["red", "wood", 6], restaurant: ["blue", "stone", 6], market: ["red", "wood", 4], store: ["red", "stone", 6],
          school: ["red", "stone", 8], library: ["blue", "stone", 7], theater: ["red", "stone", 8], arcade: ["blue", "wood", 6], studio: ["blue", "wood", 6], lounge: ["blue", "stone", 6],
        };
        const [roof, wall, w] = style[v] ?? ["red", "wood", 6];
        const bx = lot.tx + Math.floor((lot.tw - w) / 2);
        const door = house(bx, lot.ty + 1, w, roof, wall);
        pathTo(lot.ty + 5);
        const yard = (lot.ty + 6) * T;
        if (v === "cafe" || v === "restaurant") {
          const umb = v === "cafe" ? "#d95c4a" : "#3f7fbf";
          for (const [dx, dy] of [[1.8, 1.4], [6.2, 1.4], [1.8, 4.6], [6.2, 4.6]]) {
            const px = X + dx * T, py = yard + dy * T;
            table(px, py, umb);
            spot(px - 10, py + 4, "right"); spot(px + 10, py + 4, "left");
          }
          if (v === "restaurant") for (let i = 0; i < 7; i++) rect(X + 8 + i * 16, yard - 4 + (i % 2) * 2, 3, 3, "#ffd36b");
        } else if (v === "market") {
          awningStall(X + 4, yard - T, "#d95c4a"); awningStall(X + Wp - 40, yard - T, "#4f9a4a");
          awningStall(X + 4, yard + 2.5 * T, "#e0a63a"); awningStall(X + Wp - 40, yard + 2.5 * T, "#3f7fbf");
          for (const [x, y] of [[22, 2 * T], [Wp - 22, 2 * T], [22, 5.6 * T], [Wp - 22, 5.6 * T], [Wp / 2, 4 * T]]) spot(X + x, yard + y, "up");
        } else if (v === "theater") {
          // marquee (bulbs animate at runtime) and a little plaza
          rect(door.x - 3 * T, (lot.ty + 4) * T + 2, 6 * T, 10, "#7a1f2a"); rect(door.x - 3 * T + 2, (lot.ty + 4) * T + 4, 6 * T - 4, 6, "#f3d27a");
          for (let y = lot.ty + 6; y < lot.ty + 11; y++) for (let x = lot.tx + 1; x < lot.tx + lot.tw - 1; x++) ru(1, 4, x, y);
          for (let i = 0; i < 8; i++) spot(X + 2 * T + (i % 4) * 1.3 * T, yard + 2 * T + Math.floor(i / 4) * 1.4 * T, "up");
          lamp(X + 4, yard + T); lamp(X + Wp - T - 4, yard + T);
        } else if (v === "arcade") {
          rect(door.x - 2 * T, (lot.ty + 4) * T + 2, 4 * T, 6, "#2a1f4a");
          for (const [x, y] of [[1.4, 1.2], [5.4, 1.2], [1.4, 3.4], [5.4, 3.4]]) { rect(X + x * T, yard + y * T - 12, 12, 16, "#3a2f6a"); rect(X + x * T + 2, yard + y * T - 10, 8, 6, "#5ad1e0"); spot(X + x * T + 6, yard + y * T + 14, "up"); }
          bench(X + 3.4 * T, yard + 5 * T); spot(X + 4 * T, yard + 5.8 * T, "down");
        } else if (v === "lounge") {
          // outdoor stage with string lights
          rect(X + 1.5 * T, yard + 0.5 * T, 5 * T, 2 * T, "#5a3a22"); rect(X + 1.5 * T + 2, yard + 0.5 * T + 2, 5 * T - 4, 2 * T - 6, "#8a5a3a");
          rect(X + 4 * T, yard + 0.5 * T + 4, 1, 12, "#333"); rect(X + 4 * T - 2, yard + 0.5 * T + 2, 5, 3, "#555");
          for (let i = 0; i < 8; i++) rect(X + 8 + i * 14, yard - 6 + (i % 2) * 2, 3, 3, ["#ff8fb1", "#ffd36b", "#8fd3ff"][i % 3]);
          for (const [dx, dy] of [[1.8, 4.2], [6.2, 4.2]]) { table(X + dx * T, yard + dy * T, null); spot(X + dx * T - 10, yard + dy * T + 4, "right"); spot(X + dx * T + 10, yard + dy * T + 4, "left"); }
          for (const x of [2.5, 3.5, 4.5, 5.5]) spot(X + x * T, yard + 3 * T, "up");
        } else if (v === "studio") {
          for (const [x, y] of [[1.2, 1.2], [3.6, 1.2], [6, 1.2], [2.4, 3.8], [4.8, 3.8]]) {
            const px = X + x * T, py = yard + y * T;
            rect(px + 2, py - 6, 1, 16, "#7a5230"); rect(px + 10, py - 6, 1, 16, "#7a5230"); rect(px + 6, py - 8, 1, 18, "#7a5230");
            rect(px + 1, py - 14, 11, 9, "#f6f1e4"); rect(px + 3, py - 12, 4, 3, ["#d95c4a", "#4f9a4a", "#3f7fbf", "#e0a63a"][Math.floor(x) % 4]);
            spot(px + 6, py + 18, "up");
          }
        } else if (v === "school") {
          dirt(lot.tx + 1, lot.ty + 7, 6, 4);
          rect(X + 2 * T, yard + 2 * T, 3, 22, "#7a5230"); rect(X + 4 * T + 6, yard + 2 * T, 3, 22, "#7a5230"); rect(X + 2 * T, yard + 2 * T, 2.5 * T + 9, 3, "#7a5230");
          rect(X + 2.6 * T, yard + 2 * T + 3, 1, 12, "#444"); rect(X + 2.4 * T, yard + 2 * T + 15, 8, 2, "#c0392b");
          for (const [x, y, f] of [[2, 4.5, "down"], [4, 4.6, "down"], [6, 2.5, "left"], [5.5, 4, "up"], [1.5, 2.5, "right"], [3.6, 2, "up"]] as const) spot(X + x * T, yard + y * T, f as Face);
          tree(X + Wp - T - 2, Y + Hp - 2, 0);
        } else {
          // library / store: benches, crates and trees out front
          bench(X + 1.4 * T, yard + 1.5 * T); bench(X + Wp - 2.4 * T, yard + 1.5 * T);
          if (v === "store") { rup(4, 11, X + 1.2 * T, yard + 3.6 * T); rup(5, 11, X + 2.3 * T, yard + 3.6 * T); rup(7, 11, X + Wp - 2 * T, yard + 3.6 * T); }
          else { tree(X + 2, yard + 6 * T, 0); tree(X + Wp - T - 2, yard + 6 * T, 1); }
          for (const [x, y, f] of [[2, 2.3, "down"], [Wp / T - 1.8, 2.3, "down"], [3.4, 3.4, "up"], [Wp / T - 3.4, 3.4, "up"], [Wp / T / 2, 3, "up"]] as const) spot(X + x * T, yard + y * T, f as Face);
        }
        if (v !== "theater" && v !== "studio") lamp(X + 4, Y + Hp - T + 4);
        spot(door.x + 12, door.y + 8, "down");
      }
    }
  }
  return cv;
}

// ---------- characters ----------
interface Char {
  key: string; agentId?: number; name: string; role: string; hue: number; person: number;
  x: number; y: number; path: Spot[]; targetKey: string; lot: Lot | null; phase: number; face: Face;
  bubble: string | null; emote: string | null; asleep: boolean; avatarPath: string | null; working: boolean; lead: boolean;
}

function doorOf(lot: Lot): { x: number; y: number } { return { x: (lot.tx + lot.tw / 2) * T, y: (lot.ty + lot.th) * T }; }

/** Street route: out the door, along the streets (via the nearest cross street), in the other door, to the spot. */
function route(L: Layout, from: { x: number; y: number; lot: Lot | null }, to: Spot & { lot: Lot }): Spot[] {
  const pts: Spot[] = [];
  const roadBelow = (lot: Lot) => L.roadY[lot.row + 1];
  let curX: number, curY: number;
  if (from.lot === to.lot && from.lot) {
    // same lot: just stroll over
    pts.push({ x: to.x, y: from.y }, { x: to.x, y: to.y, face: to.face });
    return pts;
  }
  if (from.lot) {
    const d = doorOf(from.lot);
    pts.push({ x: d.x, y: from.y }, { x: d.x, y: roadBelow(from.lot) });
    curX = d.x; curY = roadBelow(from.lot);
  } else {
    curY = L.roadY.reduce((a, b) => (Math.abs(b - from.y) < Math.abs(a - from.y) ? b : a));
    const nearX = ROAD_X.reduce((a, b) => (Math.abs(b - from.x) < Math.abs(a - from.x) ? b : a));
    if (Math.abs(nearX - from.x) < Math.abs(curY - from.y)) { pts.push({ x: nearX, y: from.y }); curX = nearX; curY = from.y; }
    else { pts.push({ x: from.x, y: curY }); curX = from.x; }
  }
  const td = doorOf(to.lot);
  const ty = roadBelow(to.lot);
  if (Math.abs(curY - ty) > 1) {
    const cross = ROAD_X.reduce((a, b) => (Math.abs(b - (curX + td.x) / 2) < Math.abs(a - (curX + td.x) / 2) ? b : a));
    pts.push({ x: cross, y: curY }, { x: cross, y: ty });
  }
  pts.push({ x: td.x, y: ty }, { x: td.x, y: to.y }, { x: to.x, y: to.y, face: to.face });
  return pts;
}

const TOOL_WORDS: Record<string, string> = {
  web_search: "🔎 researching", web_fetch: "📖 reading", browse_page: "🌐 browsing", trending_videos: "📈 trends", youtube_search: "▶️ YouTube",
  video_transcript: "📝 transcripts", produce_video: "🎬 producing", make_clip: "✂️ clipping", make_song: "🎵 making music", generate_image: "🎨 designing",
  generate_video: "🎬 animating", save_document: "✍️ writing", add_store_product: "🛍️ stocking", record_transaction: "💰 bookkeeping", treasury_summary: "💰 the books",
  create_pipeline: "🗂️ planning", delegate_to_agent: "📨 delegating", handoff_to_agent: "📨 handing off", check_inbox: "📥 reviewing", hire_specialist: "🤝 hiring",
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
      .then((b) => createImageBitmap(b, { resizeWidth: 256, resizeHeight: 256, resizeQuality: "high" }))
      .then((bmp) => portraitCache.set(path, bmp))
      .catch(() => portraitCache.set(path, "failed"));
  }
  return null;
}

/** Portrait card size in device px: grows with zoom; AURORA's is half again bigger. */
function cardSize(k: number, ui: number, lead: boolean): number {
  const base = Math.max(22 * ui, Math.min(56 * ui, k * 9));
  return Math.round(lead ? base * 1.6 : base);
}

function darkness(hour: number): number {
  return hour >= 20.5 || hour < 5 ? 0.58 : hour >= 18 ? ((hour - 18) / 2.5) * 0.58 : hour < 7 ? ((7 - hour) / 2) * 0.58 : 0;
}

function clockText(hour: number) {
  const hh = Math.floor(hour), mm = Math.floor(((hour % 1) * 60) / 10) * 10;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "am" : "pm"}`;
}

const PANEL = "rounded-lg border-4 border-[#5a3a22] bg-[#f6d9a0] text-[#3a2212] shadow-[inset_0_0_0_3px_#e8b86a,0_4px_0_#3a2212]";

// ---------- component ----------
export function LivingTown({ className, height, preview = false }: { className?: string; height?: string; preview?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { data: team } = useQuery<TeamData>({ queryKey: ["/api/team"], refetchInterval: 3000 });
  const { data: town } = useQuery<TownData>({ queryKey: ["/api/town"], refetchInterval: 5000 });
  const companyKey = town?.companies.map((c) => `${c.id}:${c.name}:${c.color}`).join(",") ?? "";
  const layout = useMemo(() => buildLayout(town?.companies ?? []), [companyKey]);
  const [sheets, setSheets] = useState<Sheets | null>(null);
  const mapCanvas = useMemo(() => (sheets ? paintMap(layout, sheets) : null), [layout, sheets]);
  const chars = useRef(new Map<string, Char>());
  const [hover, setHover] = useState<Char | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hud, setHud] = useState({ day: townDayNumber(), hour: townHour() });
  const teamRef = useRef(team); teamRef.current = team;
  const townRef = useRef(town); townRef.current = town;
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const mapRef = useRef(mapCanvas); mapRef.current = mapCanvas;
  const sheetsRef = useRef(sheets); sheetsRef.current = sheets;
  // Camera: zoom 1 = the whole town fits; scroll to zoom, drag to pan, click an agent to follow them.
  const WW = MW * T;
  const cam = useRef({ zoom: preview ? 1.7 : 2.2, cx: (rx(2) + RD + BW / 2) * T, cy: (RD + 8) * T });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const selectedRef = useRef<number | null>(null); selectedRef.current = selected;

  useEffect(() => { loadSheets().then(setSheets).catch(() => {}); }, []);

  // Decide where everyone should be, every couple of seconds.
  useEffect(() => {
    const plan = () => {
      const tm = teamRef.current, tw = townRef.current, L = layoutRef.current;
      const hour = townHour(), day = townDayNumber();
      setHud({ day, hour });
      if (!tm || !tw || L.lots.length === 0 || !mapRef.current) return;
      const hq = L.lots.find((l) => l.kind === "hq")!;
      const homes = L.lots.filter((l) => l.kind === "home");
      const venueLot = (v: VenueId) => L.lots.find((l) => l.kind === v) ?? hq;
      const lotFor = (companyId: number | null) => (companyId == null ? hq : L.lots.find((l) => l.companyId === companyId) ?? hq);
      const talk = [...(tm.chatter ?? [])].reverse().find((c) => Date.now() - c.at < 60_000);
      const speaking = talk ? talk.lines[Math.floor((Date.now() - talk.at) / 4500) % talk.lines.length] : null;
      const seen = new Set<string>();
      const slot = Math.floor(hour * 2);

      const pickSpot = (lot: Lot, seed: number, desk = false): Spot & { lot: Lot } => {
        const list = desk && lot.desks.length ? lot.desks : lot.spots.length ? lot.spots : [{ x: doorOf(lot).x, y: doorOf(lot).y - 8 }];
        const s = list[(desk ? seed : seed + slot) % list.length];
        // a little jitter so people sharing a spot don't stack perfectly
        const j = desk ? 0 : Math.round((rnd(seed) - 0.5) * 8);
        return { ...s, x: s.x + j, lot };
      };

      const place = (key: string, wanted: { spot: Spot & { lot: Lot }; key: string }, init: Omit<Char, "x" | "y" | "path" | "targetKey" | "lot" | "phase" | "face">) => {
        seen.add(key);
        let c = chars.current.get(key);
        if (!c) {
          c = { ...init, x: wanted.spot.x, y: wanted.spot.y, path: [], targetKey: wanted.key, lot: wanted.spot.lot, phase: 0, face: wanted.spot.face ?? "down" };
          chars.current.set(key, c);
          return;
        }
        Object.assign(c, { name: init.name, role: init.role, hue: init.hue, bubble: init.bubble, emote: init.emote, asleep: init.asleep, avatarPath: init.avatarPath, working: init.working });
        if (c.targetKey !== wanted.key) {
          c.path = route(L, { x: c.x, y: c.y, lot: c.path.length ? null : c.lot }, wanted.spot);
          c.targetKey = wanted.key;
          c.lot = wanted.spot.lot;
        }
      };

      const routine = (seed: number, home: Lot, work: Lot) => {
        const stop = routineAt(seed, hour, day);
        if (stop.kind === "home") return { spot: pickSpot(home, seed), key: "home", asleep: true, emote: null as string | null };
        if (stop.kind === "work") return { spot: pickSpot(work, seed, true), key: "work", asleep: false, emote: null };
        return { spot: pickSpot(venueLot(stop.venue), seed), key: `v-${stop.venue}`, asleep: false, emote: VENUES[stop.venue].emoji };
      };

      const companyHue = new Map(tw.companies.map((c) => [c.id, c.color] as const));
      for (const m of tm.members) {
        const seed = agentSeed(m.id);
        const home = homes[m.id % homes.length];
        const work = lotFor(m.companyId);
        const hue = m.isOverseer ? 265 : (m.companyId != null ? companyHue.get(m.companyId) ?? 200 : 265);
        let wanted: { spot: Spot & { lot: Lot }; key: string }, bubble: string | null = null, asleep = false, emote: string | null = null;
        const chatting = talk && talk.agentIds.includes(m.id) && m.status === "active" && !m.working;
        if (m.status === "paused") { wanted = { spot: pickSpot(home, seed), key: "home" }; asleep = true; }
        else if (m.working || m.waitingApproval) {
          wanted = { spot: m.isOverseer ? { ...hq.desks[0], lot: hq } : pickSpot(work, seed, true), key: "work" };
          bubble = m.waitingApproval ? "⏳ needs your OK" : TOOL_WORDS[m.lastTools[0] ?? ""] ?? "💼 working";
        } else if (chatting) {
          const lot = venueLot(talk!.venue ?? "park");
          const base = lot.spots[0] ?? { x: doorOf(lot).x, y: doorOf(lot).y - 10 };
          const first = talk!.agentIds[0] === m.id;
          wanted = { spot: { x: base.x + (first ? -9 : 9), y: base.y, face: first ? "right" : "left", lot }, key: `chat-${talk!.at}` };
          if (speaking?.agentId === m.id) bubble = "💬";
        } else {
          const r = routine(seed, home, work);
          wanted = r; asleep = r.asleep; emote = r.emote;
        }
        place(`a${m.id}`, wanted, {
          key: `a${m.id}`, agentId: m.id, name: m.name, role: m.role ?? "", hue, person: hash(m.name) % 6, bubble, emote, asleep, avatarPath: m.avatarPath, working: m.working, lead: m.isOverseer,
        });
      }
      for (const c of tw.companies.filter((x) => x.kind === "simulated")) {
        const work = lotFor(c.id);
        for (const r of c.staff) {
          const seed = r.id * 131 + 7;
          const rt = routine(seed, homes[(r.id + 1) % homes.length], work);
          place(`r${r.id}`, rt, {
            key: `r${r.id}`, name: r.name, role: `${r.role ?? "Resident"} · ${c.name}`, hue: c.color, person: hash(r.name) % 6,
            bubble: null, emote: null, asleep: rt.asleep, avatarPath: null, working: rt.key === "work", lead: false,
          });
        }
      }
      for (const k of [...chars.current.keys()]) if (!seen.has(k)) chars.current.delete(k);
    };
    plan();
    const id = setInterval(plan, 2000);
    return () => clearInterval(id);
  }, []);

  const fitScale = (canvas: HTMLCanvasElement) => Math.min(canvas.width / WW, canvas.height / (layoutRef.current.mh * T));

  // Animation loop.
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0, last = performance.now();
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = height ? wrap.clientHeight : w * (layoutRef.current.mh / MW);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(wrap);
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const L = layoutRef.current, S = sheetsRef.current, map = mapRef.current;
      const WH = L.mh * T;
      const dpr = window.devicePixelRatio || 1;
      const v = cam.current;
      const followed = selectedRef.current != null ? chars.current.get(`a${selectedRef.current}`) : undefined;
      if (followed && !drag.current) { v.cx += (followed.x - v.cx) * Math.min(1, dt * 3); v.cy += (followed.y - v.cy) * Math.min(1, dt * 3); }
      clampCam(v);
      const k = fitScale(canvas) * v.zoom;
      const ox = Math.round(canvas.width / 2 - v.cx * k), oy = Math.round(canvas.height / 2 - v.cy * k);
      const toScreen = (x: number, y: number) => ({ x: x * k + ox, y: y * k + oy });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#3b6b35"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, ox, oy);
      ctx.imageSmoothingEnabled = false;
      if (map) ctx.drawImage(map, 0, 0);
      const hour = townHour();
      const working = new Set<number>();
      for (const m of teamRef.current?.members ?? []) if (m.working) working.add(m.companyId ?? -1);
      const simIds = new Set((townRef.current?.companies ?? []).filter((c) => c.kind === "simulated").map((c) => c.id));

      // live screens on busy offices; theater marquee bulbs; arcade neon
      for (const lot of L.lots) {
        if (lot.kind === "company" || lot.kind === "hq") {
          const busy = working.has(lot.companyId ?? -1) || (lot.companyId != null && simIds.has(lot.companyId) && hour > 8 && hour < 18);
          if (!busy) continue;
          ctx.fillStyle = `hsla(${lot.hue}, 85%, 70%, ${0.65 + 0.25 * Math.sin(now / 300 + lot.tx)})`;
          for (const d of lot.desks) ctx.fillRect(d.x - 3, d.y - 26, 7, 5);
        } else if (lot.kind === "theater") {
          const d = doorOf(lot), bx = d.x - 3 * T, by = (lot.ty + 4) * T + 3;
          for (let i = 0; i < 12; i++) { ctx.fillStyle = (i + Math.floor(now / 250)) % 3 ? "#ffe9a8" : "#c0392b"; ctx.fillRect(bx + 2 + i * 8, by - 2, 2, 2); }
        } else if (lot.kind === "arcade") {
          const d = doorOf(lot);
          ctx.fillStyle = `hsl(${(now / 20) % 360} 90% 65%)`; ctx.fillRect(d.x - 2 * T + 3, (lot.ty + 4) * T + 4, 4 * T - 6, 2);
        }
      }

      // move characters
      const list = [...chars.current.values()];
      for (const c of list) {
        if (!c.path.length) continue;
        const p = c.path[0];
        const dx = p.x - c.x, dy = p.y - c.y, dist = Math.hypot(dx, dy);
        const speed = (c.agentId != null ? 58 : 48) * dt;
        if (Math.abs(dx) > Math.abs(dy)) c.face = dx > 0 ? "right" : "left"; else if (Math.abs(dy) > 0.5) c.face = dy > 0 ? "down" : "up";
        if (dist <= speed) { c.x = p.x; c.y = p.y; c.path.shift(); if (!c.path.length && p.face) c.face = p.face; }
        else { c.x += (dx / dist) * speed; c.y += (dy / dist) * speed; }
        c.phase += dt * 7;
      }
      // sleepers are indoors; everyone else drawn back to front
      const visible = list.filter((c) => !(c.asleep && !c.path.length)).sort((a, b) => a.y - b.y);
      if (S) {
        for (const c of visible) {
          const moving = c.path.length > 0;
          const frameRow = c.person * 3 + (moving ? 1 + (Math.floor(c.phase) % 2) : 0);
          const col = 23 + ({ left: 0, down: 1, up: 2, right: 3 } as const)[c.face];
          const x = Math.round(c.x), y = Math.round(c.y);
          ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x - 5, y - 1, 10, 2);
          ctx.drawImage(S.ru, col * T, frameRow * T, T, T, x - 8, y - 15, T, T);
        }
      }

      // night tint + warm lights
      const dark = darkness(hour);
      if (dark > 0.01) {
        ctx.fillStyle = `rgba(14, 18, 52, ${dark})`; ctx.fillRect(0, 0, WW, WH);
        ctx.globalCompositeOperation = "lighter";
        const glow = (x: number, y: number, r: number, c: string) => { const gr = ctx.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, c); gr.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, r * 2, r * 2); };
        for (const l of L.lamps) glow(l.x, l.y, 46, `rgba(255, 196, 110, ${dark * 0.6})`);
        for (const lot of L.lots) {
          if (lot.kind === "company" || lot.kind === "hq") { if (working.has(lot.companyId ?? -1)) glow((lot.tx + lot.tw / 2) * T, (lot.ty + 6) * T, lot.tw * T * 0.6, `hsla(${lot.hue}, 90%, 60%, ${dark * 0.3})`); }
          else if (lot.kind !== "home" && lot.kind !== "park" && lot.kind !== "garden" && lot.kind !== "plaza") glow(doorOf(lot).x, (lot.ty + 5) * T, 70, `rgba(255, 170, 90, ${dark * 0.45})`);
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = `rgba(255, 214, 120, ${Math.min(0.9, dark * 1.6)})`;
        for (const w of L.windows) if (hash(`${w.x},${w.y}`) % 3 !== 0) ctx.fillRect(w.x, w.y, w.w, w.h);
      }
      // selection marker
      const sel = selectedRef.current != null ? chars.current.get(`a${selectedRef.current}`) : undefined;
      if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(Math.round(sel.x) - 9.5, Math.round(sel.y) - 16.5, 19, 19); }

      // ---- screen-space overlays: signs, portraits, names, bubbles ----
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const ui = dpr;
      if (k >= 1.1 * ui) {
        const fs = Math.round(Math.max(9, Math.min(15, (k * 3.4) / ui)) * ui);
        ctx.font = `600 ${fs}px ${PIXEL_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const lot of L.lots) {
          if (lot.kind === "home") continue;
          const p = toScreen(lot.sign.x, lot.kind === "company" || lot.kind === "hq" ? lot.sign.y - 4 : lot.sign.y - 8);
          if (p.x < -200 || p.y < -50 || p.x > canvas.width + 200 || p.y > canvas.height + 50) continue;
          const label = lot.kind === "hq" ? "✦ AURORA HQ" : lot.kind === "company" ? lot.label : `${VENUES[lot.kind as VenueId].emoji} ${lot.label}`;
          const tw = ctx.measureText(label).width + fs;
          ctx.fillStyle = "#3a2212"; ctx.fillRect(Math.round(p.x - tw / 2 - ui), Math.round(p.y - fs * 0.7 - ui), Math.round(tw + 2 * ui), Math.round(fs * 1.4 + 2 * ui));
          ctx.fillStyle = lot.kind === "company" || lot.kind === "hq" ? `hsl(${lot.hue} 45% 34%)` : "#8a5a2c";
          ctx.fillRect(Math.round(p.x - tw / 2), Math.round(p.y - fs * 0.7), Math.round(tw), Math.round(fs * 1.4));
          ctx.fillStyle = "#fbecc8"; ctx.fillText(label, p.x, p.y + ui);
        }
      }
      const showNames = k >= 2.6 * ui;
      // Detailed portrait cards ride above each agent; AURORA's is the biggest,
      // gold-framed, and always named. Drawn last so she's never covered.
      const sleepers = list.filter((c) => c.agentId != null && c.asleep && !c.path.length);
      const order = [...visible.filter((c) => c.agentId != null), ...sleepers].sort((a, b) => Number(a.lead) - Number(b.lead) || a.y - b.y);
      for (const c of order) {
        const s = cardSize(k, ui, c.lead);
        const head = toScreen(c.x, c.y - 16);
        const bx = head.x, top = head.y - s - 6 * ui;
        if (bx < -s || top < -s * 2 || bx > canvas.width + s || top > canvas.height + s) continue;
        ctx.globalAlpha = c.asleep ? 0.55 : 1;
        const pad = (c.lead ? 4 : 3) * ui;
        if (c.lead) { ctx.shadowColor = "rgba(255, 210, 120, 0.9)"; ctx.shadowBlur = 18 * ui; }
        ctx.fillStyle = "#3a2212"; ctx.fillRect(bx - s / 2 - pad - ui, top - pad - ui, s + 2 * pad + 2 * ui, s + 2 * pad + 2 * ui);
        ctx.shadowBlur = 0;
        ctx.fillStyle = c.lead ? "#f2c14e" : `hsl(${c.hue} 60% 52%)`; ctx.fillRect(bx - s / 2 - pad, top - pad, s + 2 * pad, s + 2 * pad);
        // little pointer down to the character
        ctx.beginPath(); ctx.moveTo(bx - 4 * ui, top + s + pad); ctx.lineTo(bx, top + s + pad + 5 * ui); ctx.lineTo(bx + 4 * ui, top + s + pad); ctx.fill();
        const bmp = portrait(c.avatarPath);
        if (bmp) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(bmp, bx - s / 2, top, s, s); ctx.imageSmoothingEnabled = false; }
        else { ctx.fillStyle = "#222"; ctx.fillRect(bx - s / 2, top, s, s); ctx.fillStyle = "#fff"; ctx.font = `700 ${Math.round(s / 2)}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(c.name[0] ?? "?", bx, top + s / 2); }
        ctx.globalAlpha = 1;
        if (c.lead) {
          const fs = Math.round(Math.max(11, Math.min(15, s / ui / 5)) * ui);
          ctx.font = `700 ${fs}px ${PIXEL_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          const t = "✦ AURORA ✦", tw = ctx.measureText(t).width + 12 * ui;
          ctx.fillStyle = "#3a2212"; ctx.fillRect(bx - tw / 2 - ui, top - pad - fs - 8 * ui, tw + 2 * ui, fs + 6 * ui);
          ctx.fillStyle = "#f2c14e"; ctx.fillRect(bx - tw / 2, top - pad - fs - 7 * ui, tw, fs + 4 * ui);
          ctx.fillStyle = "#3a2212"; ctx.fillText(t, bx, top - pad - fs / 2 - 5 * ui);
        }
        if (c.asleep) { ctx.fillStyle = "#dfe6ff"; ctx.font = `700 ${Math.round(s / 3)}px ${PIXEL_FONT}`; ctx.textAlign = "center"; ctx.fillText("z", bx + s / 2 + 6 * ui, top + s * 0.3 - ((now / 120) % 6)); continue; }
        if (showNames && !c.lead) {
          const fs = Math.round(Math.max(10, Math.min(13, (k * 2.6) / ui)) * ui);
          ctx.font = `600 ${fs}px ${PIXEL_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
          const nm = c.name.split(" ")[0]; const nw = ctx.measureText(nm).width + 8 * ui;
          const ny = toScreen(c.x, c.y).y + 2 * ui;
          ctx.fillStyle = "rgba(30,18,10,0.7)"; ctx.fillRect(bx - nw / 2, ny, nw, fs + 4 * ui);
          ctx.fillStyle = "#fbecc8"; ctx.fillText(nm, bx, ny + 2 * ui);
        }
        const tag = c.bubble ?? (k >= 2 * ui ? c.emote : null);
        if (tag) {
          const fs = Math.round(Math.max(10, Math.min(13, (k * 2.5) / ui)) * ui);
          ctx.font = `500 ${fs}px ${PIXEL_FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          const text = tag.length > 30 ? tag.slice(0, 29) + "…" : tag;
          // bubble sits to the right of the portrait so the face stays visible
          const bw = ctx.measureText(text).width + 12 * ui, bh = fs + 8 * ui, bxx = bx + s / 2 + pad + 6 * ui, byy = top + 2 * ui;
          ctx.fillStyle = "#3a2212"; ctx.fillRect(bxx - ui, byy - ui, bw + 2 * ui, bh + 2 * ui);
          ctx.fillStyle = "#fff4dc"; ctx.fillRect(bxx, byy, bw, bh);
          ctx.fillStyle = "#3a2212"; ctx.fillRect(bxx - 4 * ui, byy + bh / 2 - 2 * ui, 4 * ui, 4 * ui);
          ctx.fillText(text, bxx + 6 * ui, byy + bh / 2 + ui);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [height]);

  function clampCam(v: { zoom: number; cx: number; cy: number }) {
    const canvas = canvasRef.current; if (!canvas) return;
    const WH = layoutRef.current.mh * T;
    v.zoom = Math.max(1, Math.min(8, v.zoom));
    const k = fitScale(canvas) * v.zoom;
    const hw = canvas.width / (2 * k), hh = canvas.height / (2 * k);
    v.cx = hw * 2 >= WW ? WW / 2 : Math.max(hw, Math.min(WW - hw, v.cx));
    v.cy = hh * 2 >= WH ? WH / 2 : Math.max(hh, Math.min(WH - hh, v.cy));
  }

  /** CSS pixels per world pixel. */
  function cssScale(): number {
    const canvas = canvasRef.current!;
    return fitScale(canvas) * cam.current.zoom * (canvas.getBoundingClientRect().width / canvas.width);
  }

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvasRef.current!.getBoundingClientRect();
    const k = cssScale();
    return { x: (clientX - rect.left - rect.width / 2) / k + cam.current.cx, y: (clientY - rect.top - rect.height / 2) / k + cam.current.cy };
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
    const k = cssScale();
    const { x, y } = toWorld(e.clientX, e.clientY);
    // Hit radius ~20 screen px at any zoom; real agents (incl. their portrait
    // badge above the head) win over background residents.
    const radius = Math.max(8, 20 / k);
    const dpr = window.devicePixelRatio || 1;
    let best: Char | null = null, bd = radius;
    for (const c of chars.current.values()) {
      if (c.asleep && !c.path.length && c.agentId == null) continue;
      const body = Math.hypot(c.x - x, c.y - 8 - y);
      // the portrait card: a box above the head
      const sz = cardSize(k * dpr, dpr, c.lead) / (k * dpr);
      const cardTop = c.y - 16 - sz - 6 / k;
      const onCard = c.agentId != null && Math.abs(c.x - x) <= sz / 2 + 3 / k && y >= cardTop - 3 / k && y <= c.y - 16;
      const badge = onCard ? 0 : Infinity;
      const d = Math.min(body, badge) - (c.agentId != null ? radius * 0.4 : 0) - (onCard && c.lead ? 1 : 0);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  const selMember = team?.members.find((m) => m.id === selected) ?? null;
  const selCompany = selMember?.companyId != null ? town?.companies.find((c) => c.id === selMember.companyId) : null;
  const latest = town?.events?.[0];
  const talk = [...(team?.chatter ?? [])].reverse().find((c) => Date.now() - c.at < 60_000);
  const line = talk ? talk.lines[Math.floor((Date.now() - talk.at) / 4500) % talk.lines.length] : null;
  const speaker = line ? team?.members.find((m) => m.id === line.agentId) : null;
  const night = hud.hour < 6 || hud.hour >= 19;
  const selDoing = (() => {
    if (!selMember) return "";
    if (selMember.status === "paused") return "😴 Off duty";
    if (selMember.waitingApproval) return "⏳ Waiting on an approval";
    if (selMember.working) return "💼 Working now";
    const s = routineAt(agentSeed(selMember.id));
    return s.kind === "venue" ? `${VENUES[s.venue].emoji} ${VENUES[s.venue].doing} at the ${VENUES[s.venue].name}` : s.kind === "home" ? "😴 Home, asleep" : `🙂 ${selMember.mood}`;
  })();

  return (
    <div className={className}>
     <div className={preview ? "" : "flex gap-3"}>
      <div ref={wrapRef} className="relative w-full min-w-0 flex-1 overflow-hidden rounded-xl border-4 border-[#5a3a22] shadow-panel" style={height ? { height } : undefined}>
        <canvas
          ref={canvasRef}
          className="block cursor-pointer"
          style={{ imageRendering: "pixelated" }}
          onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy, moved: false }; }}
          onMouseMove={(e) => {
            const d = drag.current;
            if (d) {
              if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
              if (d.moved) {
                const k = cssScale();
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
            if (c?.agentId != null && cam.current.zoom < 3) cam.current.zoom = 3;
          }}
          onMouseLeave={() => { setHover(null); drag.current = null; }}
        />

        {/* Stardew-style clock panel */}
        <div className={`pointer-events-none absolute right-3 top-3 select-none px-3 py-1.5 ${PANEL}`} style={{ fontFamily: PIXEL_FONT }}>
          <div className="flex items-center gap-2 text-sm font-semibold leading-tight">
            <span>{night ? "🌙" : hud.hour < 8 ? "🌅" : hud.hour >= 17 ? "🌇" : "☀️"}</span>
            <span>{WEEKDAYS[hud.day % 7]}. {(hud.day % 28) + 1}</span>
          </div>
          <div className="mt-0.5 rounded bg-[#fff1cf] px-2 text-center text-base font-semibold leading-tight">{clockText(hud.hour)}</div>
        </div>

        <div className="absolute bottom-3 right-3 flex overflow-hidden rounded-md border-2 border-[#5a3a22] bg-[#f6d9a0] text-sm text-[#4a2c14]" style={{ fontFamily: PIXEL_FONT }}>
          <button type="button" className="px-3 py-1 hover:bg-[#ffe9bd]" onClick={() => zoomAt(1.3)} title="Zoom in">+</button>
          <button type="button" className="px-3 py-1 hover:bg-[#ffe9bd]" onClick={() => zoomAt(1 / 1.3)} title="Zoom out">−</button>
          <button type="button" className="px-3 py-1 text-xs hover:bg-[#ffe9bd]" onClick={() => { cam.current.zoom = 1; setSelected(null); }} title="Show the whole town">Whole town</button>
          {preview && <Link href="/town" className="border-l-2 border-[#5a3a22] px-3 py-1 text-xs hover:bg-[#ffe9bd]">Open Town →</Link>}
        </div>

        {latest && !line && (
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[55%] truncate rounded-md border-2 border-[#5a3a22] bg-[#f6d9a0]/95 px-3 py-1 text-xs text-[#4a2c14]" style={{ fontFamily: PIXEL_FONT }}>📰 {latest.text}</div>
        )}

        {/* dialogue box with the speaker's portrait */}
        {line && speaker && (
          <div className={`pointer-events-none absolute bottom-3 left-3 flex w-[min(460px,calc(100%-190px))] gap-2.5 p-2 ${PANEL}`} style={{ fontFamily: PIXEL_FONT }}>
            <div className="flex-1">
              <p className="line-clamp-3 text-sm leading-snug">{line.text}</p>
              {talk?.venue && <p className="mt-1 text-xs opacity-70">at the {VENUES[talk.venue].name}</p>}
            </div>
            <div className="flex w-16 shrink-0 flex-col items-center">
              <div className="rounded border-[3px] border-[#5a3a22] bg-[#c9e3f0]">
                <IdentityAvatar name={speaker.name} avatarPath={speaker.avatarPath} className="h-14 w-14 rounded-none" />
              </div>
              <div className="mt-1 w-full truncate rounded bg-[#fff1cf] px-1 text-center text-xs font-semibold">{speaker.name.split(" ")[0]}</div>
            </div>
          </div>
        )}

        {hover && !selMember && (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border-2 border-[#5a3a22] bg-[#f6d9a0] p-2 pr-3 text-[#3a2212]" style={{ fontFamily: PIXEL_FONT }}>
            {hover.agentId != null
              ? <IdentityAvatar name={hover.name} avatarPath={hover.avatarPath} className="h-10 w-10" />
              : <span className="h-3 w-3 rounded-full" style={{ background: `hsl(${hover.hue} 50% 50%)` }} />}
            <div>
              <div className="text-sm font-semibold">{hover.name}</div>
              <div className="text-xs opacity-75">{hover.role}{hover.agentId == null ? " · resident" : ""}{hover.asleep ? " · asleep" : hover.emote && !hover.bubble ? ` · ${hover.emote}` : ""}</div>
            </div>
          </div>
        )}
        {selMember && (
          <div className={`absolute left-3 top-3 max-h-[calc(100%-24px)] w-80 overflow-y-auto p-3 ${PANEL}`} style={{ fontFamily: PIXEL_FONT }}>
            <div className="mb-1 flex justify-end"><button type="button" onClick={() => setSelected(null)} className="opacity-60 hover:opacity-100" title="Close"><X size={15} /></button></div>
            <AgentProfile pixel m={selMember} members={team?.members ?? []} companyName={selCompany?.name ?? "AURORA HQ"} doing={selDoing}
              onPick={(id) => { setSelected(id); if (cam.current.zoom < 3) cam.current.zoom = 3; }} />
            <Link href="/team" className="mt-3 inline-block text-xs font-semibold underline">Open in Team →</Link>
          </div>
        )}
      </div>
      {!preview && team && <CastPanel members={team.members} companies={town?.companies ?? []} selected={selected} height={height} onPick={(id) => { setSelected(id); if (cam.current.zoom < 3) cam.current.zoom = 3; }} />}
     </div>
    </div>
  );
}

function statusOf(m: TeamMember): string {
  if (m.status === "paused") return "😴 Off duty";
  if (m.waitingApproval) return "⏳ Needs your OK";
  if (m.working) return TOOL_WORDS[m.lastTools[0] ?? ""] ?? "💼 Working";
  const s = routineAt(agentSeed(m.id));
  return s.kind === "venue" ? `${VENUES[s.venue].emoji} ${VENUES[s.venue].doing}` : s.kind === "home" ? "😴 Asleep at home" : "💼 At the office";
}

/** Everyone's detailed portrait, AURORA featured at the top. Click to follow them in town. */
function CastPanel({ members, companies, selected, height, onPick }: { members: TeamMember[]; companies: TownCompany[]; selected: number | null; height?: string; onPick: (id: number) => void }) {
  const lead = members.find((m) => m.isOverseer);
  const rest = members.filter((m) => !m.isOverseer).sort((a, b) => Number(b.working) - Number(a.working) || a.name.localeCompare(b.name));
  const companyName = (id: number | null) => (id == null ? "AURORA HQ" : companies.find((c) => c.id === id)?.name ?? "");
  return (
    <aside className={`hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto p-3 lg:flex ${PANEL}`} style={{ fontFamily: PIXEL_FONT, height }}>
      {lead && (
        <button type="button" onClick={() => onPick(lead.id)} className="text-left">
          <div className="rounded-lg border-4 border-[#3a2212] bg-[#f2c14e] p-1.5 shadow-[0_0_24px_rgba(242,193,78,0.6)]">
            <IdentityAvatar name={lead.name} avatarPath={lead.avatarPath} className="aspect-square h-auto w-full rounded-md" />
          </div>
          <div className="mt-2 text-center text-lg font-semibold leading-tight">✦ {lead.name} ✦</div>
          <div className="text-center text-xs opacity-80">Lead of everything · AURORA HQ</div>
          <div className="mt-1 rounded bg-[#fff1cf] px-2 py-1 text-center text-xs">{statusOf(lead)} · {moodFace(lead.morale, lead.energy)} {lead.mood}</div>
          {lead.working && lead.currentTask && <p className="mt-1 line-clamp-2 text-center text-[11px] opacity-75">{lead.currentTask.replace(/^[[^]]*]:?s*/, "")}</p>}
        </button>
      )}
      <div className="border-t-2 border-[#c99a5a] pt-2 text-xs font-semibold opacity-80">The team · {rest.length}</div>
      <div className="grid grid-cols-3 gap-2">
        {rest.map((m) => (
          <button key={m.id} type="button" onClick={() => onPick(m.id)} title={`${m.name} — ${m.role ?? ""} · ${companyName(m.companyId)}
${statusOf(m)}`}
            className={`rounded-md border-[3px] p-0.5 text-center transition ${selected === m.id ? "border-[#3a2212] bg-[#fff1cf]" : "border-[#c99a5a] hover:border-[#3a2212]"}`}>
            <div className="relative">
              <IdentityAvatar name={m.name} avatarPath={m.avatarPath} className={`aspect-square h-auto w-full rounded ${m.status === "paused" ? "opacity-60 grayscale" : ""}`} />
              <span className="absolute -bottom-1 -left-1 rounded-full bg-[#fff1cf] px-0.5 text-xs leading-tight shadow" title={`${m.mood} · morale ${m.morale} · energy ${m.energy}`}>{moodFace(m.morale, m.energy)}</span>
              {(m.working || m.waitingApproval) && <span className={`absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border border-white ${m.waitingApproval ? "bg-amber-400" : "bg-emerald-400"}`} />}
            </div>
            <div className="mt-0.5 truncate text-[11px] font-semibold leading-tight">{m.name.split(" ")[0]}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
