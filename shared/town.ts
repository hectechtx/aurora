// The town's clock and daily routine, shared by the server (morale from
// leisure, where lounge chats happen) and the client (where everyone walks),
// so the picture on screen and what the agents "remember" always agree.

/** One in-world day every 12 real minutes, so the town cycles through work, lunch, evening and night. */
export const TOWN_DAY_MS = 12 * 60_000;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function townHour(now = Date.now()): number { return ((now % TOWN_DAY_MS) / TOWN_DAY_MS) * 24; }
export function townDayNumber(now = Date.now()): number { return Math.floor(now / TOWN_DAY_MS); }

export type VenueId =
  | "cafe" | "restaurant" | "market" | "store" | "school" | "library" | "park" | "theater" | "arcade"
  | "rec" | "studio" | "garden" | "plaza" | "lounge";

export interface Venue { id: VenueId; name: string; emoji: string; doing: string; morale: number; leisure: boolean }

export const VENUES: Record<VenueId, Venue> = {
  cafe:       { id: "cafe",       name: "Starlight Café",      emoji: "☕", doing: "having coffee",        morale: 1, leisure: true },
  restaurant: { id: "restaurant", name: "Lantern Bistro",      emoji: "🍝", doing: "eating out",           morale: 2, leisure: true },
  market:     { id: "market",     name: "Farmers' Market",     emoji: "🧺", doing: "browsing the market",  morale: 1, leisure: true },
  store:      { id: "store",      name: "General Store",       emoji: "🛒", doing: "shopping",             morale: 1, leisure: true },
  school:     { id: "school",     name: "Aurora Academy",      emoji: "🎓", doing: "taking a class",       morale: 1, leisure: true },
  library:    { id: "library",    name: "Town Library",        emoji: "📚", doing: "reading",              morale: 1, leisure: true },
  park:       { id: "park",       name: "Aurora Park",         emoji: "🌳", doing: "relaxing in the park", morale: 2, leisure: true },
  theater:    { id: "theater",    name: "Grand Theater",       emoji: "🎭", doing: "watching a show",      morale: 2, leisure: true },
  arcade:     { id: "arcade",     name: "Pixel Arcade",        emoji: "🕹️", doing: "playing games",        morale: 2, leisure: true },
  rec:        { id: "rec",        name: "Rec Center",          emoji: "⚽", doing: "playing sports",       morale: 2, leisure: true },
  studio:     { id: "studio",     name: "Art & Music Studio",  emoji: "🎨", doing: "on a hobby",           morale: 2, leisure: true },
  garden:     { id: "garden",     name: "Community Garden",    emoji: "🌻", doing: "gardening",            morale: 2, leisure: true },
  plaza:      { id: "plaza",      name: "Town Square",         emoji: "⛲", doing: "people-watching",      morale: 1, leisure: true },
  lounge:     { id: "lounge",     name: "Moonlight Lounge",    emoji: "🎶", doing: "at live music night",  morale: 2, leisure: true },
};

function rnd(seed: number): number { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }
function pick<T>(list: T[], seed: number): T { return list[Math.floor(rnd(seed) * list.length) % list.length]; }

export type RoutineStop = { kind: "home"; asleep: true } | { kind: "work" } | { kind: "venue"; venue: VenueId };

/**
 * Where someone with this seed is at this hour when nothing real is going on
 * (real work and pauses override it). Staggered by seed so the whole town
 * doesn't move at once; leisure choices change every couple of hours.
 */
export function routineAt(seed: number, hour = townHour(), day = townDayNumber()): RoutineStop {
  const h = (hour + rnd(seed) * 1.5) % 24;
  const weekend = day % 7 >= 5;
  const slot = Math.floor(h / 2) + day * 13;
  if (h < 6.5 || h >= 23) return { kind: "home", asleep: true };
  if (h < 8) return rnd(seed + day) > 0.6 ? { kind: "venue", venue: "cafe" } : { kind: "home", asleep: true };
  if (h >= 12 && h < 13.2) return { kind: "venue", venue: pick<VenueId>(["cafe", "restaurant", "market", "park", "plaza"], seed + day) };
  if (h >= 17.5) return { kind: "venue", venue: pick<VenueId>(["theater", "restaurant", "park", "rec", "arcade", "studio", "garden", "library", "cafe", "market", "school", "store", "plaza", "lounge", "lounge"], seed * 3 + slot) };
  if (weekend) return { kind: "venue", venue: pick<VenueId>(["park", "rec", "garden", "market", "studio", "arcade", "library", "store", "plaza"], seed * 5 + slot) };
  if (h >= 15 && rnd(seed + Math.floor(h)) > 0.82) return { kind: "venue", venue: pick<VenueId>(["park", "cafe", "rec"], seed + Math.floor(h)) };
  return { kind: "work" };
}

/** The seed the client and server both use for a real agent. */
export function agentSeed(agentId: number): number { return agentId * 97 + 13; }
