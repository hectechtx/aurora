import path from "node:path";

// In dev/CLI use, everything lives under ./data relative to the process cwd
// (the project root). When running packaged inside Electron, main.ts sets
// AURORA_DATA_DIR to the app's per-user userData folder before the server
// boots, since a packaged app's cwd isn't a reliable — or writable — place.
export const DATA_DIR = process.env.AURORA_DATA_DIR ?? path.resolve(process.cwd(), "data");

export const DB_PATH = process.env.AURORA_DB_PATH ?? path.join(DATA_DIR, "aurora.db");
export const CREATIONS_DIR = path.join(DATA_DIR, "creations");
export const SKILLS_DIR = path.join(DATA_DIR, "skills");
export const STAGING_DIR = path.join(DATA_DIR, "skills-staging");

// The built frontend (vite build output). In dev this is unused (Vite's own
// middleware serves it); in a packaged Electron app main.ts points this at
// the bundled resources dir since it sits alongside the app code, not cwd.
export const STATIC_DIR = process.env.AURORA_STATIC_DIR ?? path.resolve(process.cwd(), "dist/public");
