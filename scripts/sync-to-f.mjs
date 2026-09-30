// Mirrors the working copy (C:\Claude\AURORA) back to F:\Claude\AURORA as a
// backup. The project was moved to the internal C: drive because F: (the
// external USB drive) kept dropping out mid-write; this keeps an F: copy
// current without depending on F: being reliable.
//
// Safety: uses robocopy /E (additive — it never deletes), and explicitly
// excludes the destination's `userdata` (the 100GB+ of models/media that LIVES
// on F: and must never be touched by this sync) and `node_modules` (large and
// restorable with `npm install`). If F: is unavailable it logs and exits 0, so
// a dropped drive never fails the build.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SRC = "C:\\Claude\\AURORA";
const DST = "F:\\Claude\\AURORA";

if (!existsSync("F:\\")) {
  console.log("[sync:f] F: unavailable — skipping backup copy (the flaky external drive). Build is unaffected.");
  process.exit(0);
}

const args = [
  SRC, DST, "/E",
  "/XD", `${SRC}\\node_modules`, `${DST}\\userdata`, `${DST}\\node_modules`, `${SRC}\\.git`,
  "/R:1", "/W:1", "/MT:16", "/NFL", "/NDL", "/NP", "/NJH",
];
const r = spawnSync("robocopy", args, { stdio: "inherit" });

// robocopy exit codes 0-7 are success (files copied / nothing to do); >=8 is a
// real failure (usually F: vanished mid-copy).
if ((r.status ?? 8) >= 8) {
  console.log(`[sync:f] backup copy hit an error (robocopy exit ${r.status}) — F: may have dropped. The C: build itself is fine.`);
} else {
  console.log("[sync:f] backup copy to F:\\Claude\\AURORA is current.");
}
process.exit(0);
