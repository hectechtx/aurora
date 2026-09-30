// Rolling backups of the AURORA database onto a *different* physical drive.
//
// Why this exists: AURORA's data dir lives on F:, which is an external
// USB-bridge enclosure (NORELSYS 1081CS) that intermittently drops off the
// bus — mid-session, with the app running and SQLite holding an open WAL.
// When it detaches, the database doesn't just become slow, it ceases to
// exist, and every symptom looks like an unrelated application bug (chat
// stops responding, image checkpoints "vanish", Ollama calls abort).
//
// The drive can't be replaced right now, so the design assumption is simply
// that it WILL disappear again, possibly permanently. Backups therefore go to
// the internal C: drive — putting them anywhere on F: would make them worthless
// for the exact failure they exist to survive.
//
// Uses better-sqlite3's online backup API rather than copying the file:
// copying a live WAL-mode database can capture a torn state, whereas .backup()
// produces a consistent snapshot even while the app keeps writing.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type DatabaseType from "better-sqlite3";
import { log } from "./app";

// Deliberately NOT derived from DATA_DIR — the whole point is to land on a
// different drive than the database. With AURORA_HOME on D:, the DB lives on
// D: and these land on C:, so either drive can be lost (or wiped by a Windows
// reset, as happened 2026-09-30) without losing both.
export const BACKUP_DIR = process.env.AURORA_BACKUP_DIR
  ?? path.join(os.homedir(), "AppData", "Roaming", "AURORA", "backups");

// Keep a window of history rather than one snapshot: if the drive vanishes
// mid-write and the newest backup caught a bad moment, there are older good
// ones behind it.
const KEEP = 10;
const INTERVAL_MS = 30 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

function pruneOldBackups(): void {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("aurora-") && f.endsWith(".db"))
    .sort()               // ISO-ish timestamps sort chronologically
    .reverse();
  for (const stale of files.slice(KEEP)) {
    fs.promises.unlink(path.join(BACKUP_DIR, stale)).catch(() => { /* best-effort */ });
  }
}

/**
 * Takes one consistent snapshot. Resolves to the written path, or null if the
 * backup couldn't be taken — which is an expected, non-fatal outcome here,
 * since the source drive may be mid-dropout. Never throws: a failed backup
 * must never take down the app it's meant to protect.
 */
export async function backupNow(sqlite: DatabaseType.Database): Promise<string | null> {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // Colons aren't legal in Windows filenames, hence the dashes.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = path.join(BACKUP_DIR, `aurora-${stamp}.db`);
    await sqlite.backup(dest);
    pruneOldBackups();
    return dest;
  } catch (err) {
    log(`backup: failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Starts the periodic backup loop, taking one immediately so a session always has at least one fresh snapshot behind it. */
export function startBackups(sqlite: DatabaseType.Database): void {
  if (timer) return;
  void backupNow(sqlite).then((p) => {
    if (p) log(`backup: wrote ${path.basename(p)} to ${BACKUP_DIR}`);
  });
  timer = setInterval(() => { void backupNow(sqlite); }, INTERVAL_MS);
  // Don't hold the process open just for backups at shutdown.
  timer.unref();
}

export interface BackupInfo { file: string; sizeBytes: number; takenAt: number }

/** Newest first — surfaced in Settings so the owner can see the safety net is real. */
export function listBackups(): BackupInfo[] {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("aurora-") && f.endsWith(".db"))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, sizeBytes: stat.size, takenAt: stat.mtimeMs };
      })
      .sort((a, b) => b.takenAt - a.takenAt);
  } catch {
    return [];
  }
}
