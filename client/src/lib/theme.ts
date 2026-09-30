// Client-side theme customization (the "Customize" panel). Each theme just
// overrides the brand CSS variables (--primary / --accent / --ring) live on
// :root — background/foreground stay dark for consistency. The choice is
// persisted in localStorage and re-applied on load (see applyStoredTheme,
// called from main.tsx before React renders so there's no flash).

export interface Theme {
  id: string;
  name: string;
  primary: string;        // HSL triple, e.g. "189 85% 56%"
  primaryHover: string;
  accent: string;
  swatch: string;         // css gradient for the picker chip
}

export const THEMES: Theme[] = [
  { id: "aurora", name: "Aurora", primary: "189 85% 56%", primaryHover: "189 85% 62%", accent: "262 65% 68%", swatch: "linear-gradient(135deg, hsl(189 85% 56%), hsl(262 65% 68%))" },
  { id: "violet", name: "Violet", primary: "262 80% 66%", primaryHover: "262 80% 72%", accent: "320 75% 65%", swatch: "linear-gradient(135deg, hsl(262 80% 66%), hsl(320 75% 65%))" },
  { id: "ocean", name: "Ocean", primary: "205 90% 58%", primaryHover: "205 90% 64%", accent: "190 85% 55%", swatch: "linear-gradient(135deg, hsl(205 90% 58%), hsl(190 85% 55%))" },
  { id: "ember", name: "Ember", primary: "22 90% 58%", primaryHover: "22 90% 64%", accent: "38 92% 56%", swatch: "linear-gradient(135deg, hsl(22 90% 58%), hsl(38 92% 56%))" },
  { id: "forest", name: "Forest", primary: "152 60% 48%", primaryHover: "152 60% 54%", accent: "168 70% 50%", swatch: "linear-gradient(135deg, hsl(152 60% 48%), hsl(168 70% 50%))" },
  { id: "rose", name: "Rose", primary: "335 80% 62%", primaryHover: "335 80% 68%", accent: "280 70% 66%", swatch: "linear-gradient(135deg, hsl(335 80% 62%), hsl(280 70% 66%))" },
];

const STORAGE_KEY = "aurora-theme";

export function getStoredThemeId(): string {
  try { return localStorage.getItem(STORAGE_KEY) || "aurora"; } catch { return "aurora"; }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.style.setProperty("--primary", theme.primary);
  root.style.setProperty("--primary-hover", theme.primaryHover);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--ring", theme.primary);
}

export function setTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  applyTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, theme.id); } catch { /* ignore */ }
}

// ---- High-contrast (near-black background) ----
const CONTRAST_KEY = "aurora-contrast";
const NORMAL_BG = "224 28% 7%";
const CONTRAST_BG = "224 40% 3%";

export function getContrast(): boolean {
  try { return localStorage.getItem(CONTRAST_KEY) === "1"; } catch { return false; }
}
export function setContrast(on: boolean): void {
  document.documentElement.style.setProperty("--background", on ? CONTRAST_BG : NORMAL_BG);
  try { localStorage.setItem(CONTRAST_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

// ---- Custom monospace font for code/terminal ----
const FONT_KEY = "aurora-code-font";
const DEFAULT_MONO = '"JetBrains Mono", ui-monospace, monospace';

export function getCodeFont(): string {
  try { return localStorage.getItem(FONT_KEY) || ""; } catch { return ""; }
}
export function setCodeFont(font: string): void {
  const value = font.trim() ? `"${font.trim()}", ${DEFAULT_MONO}` : DEFAULT_MONO;
  document.documentElement.style.setProperty("--font-mono", value);
  try { if (font.trim()) localStorage.setItem(FONT_KEY, font.trim()); else localStorage.removeItem(FONT_KEY); } catch { /* ignore */ }
}

/** Applied once at startup (main.tsx) so saved appearance shows with no flash. */
export function applyStoredTheme(): void {
  const theme = THEMES.find((t) => t.id === getStoredThemeId()) ?? THEMES[0];
  applyTheme(theme);
  if (getContrast()) setContrast(true);
  const font = getCodeFont();
  if (font) setCodeFont(font);
}
