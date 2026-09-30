// Detects the data drive vanishing out from under a running AURORA.
//
// The data dir lives on an external USB-bridge enclosure that intermittently
// drops off the bus. When it does, nothing announces it — instead every
// subsystem fails in its own confusing dialect at once: chat stops responding
// (the SQLite file is gone), image generation claims no checkpoints are
// installed (its model folder is gone), Ollama calls abort. Hours can go into
// debugging those as separate application bugs. They aren't; there's one
// cause, and it isn't software.
//
// This turns that into a single honest signal the UI can show.
import fs from "node:fs";
import { DATA_DIR } from "./paths";
import { log } from "./app";

export interface DataDriveStatus {
  /** False when the data directory can't be read — almost always the drive detaching, not a permissions change. */
  available: boolean;
  /** When it was last seen healthy, so the UI can say how long ago it dropped. */
  lastSeenAt: number;
  dataDir: string;
}

let lastSeenAt = Date.now();
let available = true;
let timer: NodeJS.Timeout | null = null;

function probe(): boolean {
  try {
    // statSync rather than existsSync: existsSync swallows every error, so a
    // half-detached drive that throws EIO would read as a plain "missing".
    fs.statSync(DATA_DIR);
    return true;
  } catch {
    return false;
  }
}

export function getDataDriveStatus(): DataDriveStatus {
  return { available, lastSeenAt, dataDir: DATA_DIR };
}

/** Polls the data directory so a dropout is noticed and logged near when it happens, rather than inferred later from downstream breakage. */
export function startDataDriveWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    const nowAvailable = probe();
    if (nowAvailable) {
      lastSeenAt = Date.now();
      if (!available) log(`data drive: ${DATA_DIR} is back`);
    } else if (available) {
      // Log only on the transition — a drive that's been gone for an hour
      // shouldn't produce 120 identical lines.
      log(`data drive: ${DATA_DIR} became unreachable — check the enclosure's cable/power. Expect unrelated-looking failures until it returns.`);
    }
    available = nowAvailable;
  }, 30_000);
  timer.unref();
}
