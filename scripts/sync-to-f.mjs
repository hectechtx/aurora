// Mirrors the working copy (wherever this checkout lives — currently
// D:\Claude\AURORA) to a backup location, F:\Claude\AURORA by default
// (override with AURORA_MIRROR_DIR). F: is a flaky external USB drive; this
// keeps a copy current without depending on it being reliable.
//
// Safety: uses robocopy /E (additive — it never deletes), and explicitly
// excludes both sides' `userdata` (100GB+ of models/media — never mirrored,
// and the destination's copy must never be touched) and `node_modules` (large
// and restorable with `npm install`). If the destination drive is unavailable
// it logs and exits 0, so a dropped drive never fails the build.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DST = process.env.AURORA_MIRROR_DIR ?? "F:\\Claude\\AURORA";
const DST_ROOT = path.parse(DST).root;

if (path.resolve(DST) === SRC) {
  console.log("[sync:f] mirror destination is the working copy itself — skipping.");
  process.exit(0);
}
if (!existsSync(DST_ROOT)) {
  console.log(`[sync:f] ${DST_ROOT} unavailable — skipping backup copy. Build is unaffected.`);
  process.exit(0);
}

const args = [
  SRC, DST, "/E",
  "/XD", `${SRC}\\node_modules`, `${SRC}\\userdata`, `${SRC}\\.git`, `${DST}\\userdata`, `${DST}\\node_modules`,
  "/R:1", "/W:1", "/MT:16", "/NFL", "/NDL", "/NP", "/NJH",
];
const r = spawnSync("robocopy", args, { stdio: "inherit" });

// robocopy exit codes 0-7 are success (files copied / nothing to do); >=8 is a
// real failure (usually the drive vanished mid-copy).
if ((r.status ?? 8) >= 8) {
  console.log(`[sync:f] backup copy hit an error (robocopy exit ${r.status}) — ${DST_ROOT} may have dropped. The build itself is fine.`);
} else {
  console.log(`[sync:f] backup copy to ${DST} is current.`);
}
process.exit(0);
