// Executes an enabled skill's declared tool. Contract: the entrypoint is run
// with `node <entrypoint>`, receives a single JSON line on stdin —
// {"tool": "<name>", "args": {...}} — and must print a single JSON value to
// stdout as the result.
//
// Honest caveat (same trust model as shell-exec.ts): this spawns with the
// owner's OS privileges in the skill's own directory. Node's process-level
// sandboxing does not restrict network access, so an approved skill can
// still make outbound calls — the real safety boundary is the human review
// of the manifest and file listing at install time (see skills/installer.ts
// and the approvals UI), not this runtime.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../paths";
import type { InstalledSkill } from "@shared/schema";
import type { Storage } from "../storage-types";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n… (output truncated)" : s;
}

export interface SkillRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * The skill's folder on disk. sourcePath is stored as an absolute path at
 * install time, so it goes stale when the data dir moves (it pointed into a
 * %APPDATA% that a Windows reset wiped, while the files themselves survived
 * under AURORA_HOME). A missing cwd makes spawn fail with a bare ENOENT, so
 * fall back to SKILLS_DIR/<folder name> when the stored path is gone.
 */
export function resolveSkillDir(skill: InstalledSkill): string {
  if (fs.existsSync(skill.sourcePath)) return skill.sourcePath;
  const moved = path.join(SKILLS_DIR, path.basename(skill.sourcePath));
  return fs.existsSync(moved) ? moved : skill.sourcePath;
}

/** One-shot startup fix: rewrites stale stored skill paths to where the files actually are now, so delete/disable (lifecycle.ts) act on the real folder too. Returns how many were repaired. */
export async function repairSkillPaths(storage: Storage): Promise<number> {
  let fixed = 0;
  for (const skill of await storage.getSkills()) {
    const actual = resolveSkillDir(skill);
    if (actual !== skill.sourcePath) {
      await storage.setSkillSourcePath(skill.id, actual);
      fixed++;
    }
  }
  return fixed;
}

export async function runSkillTool(skill: InstalledSkill, toolName: string, args: Record<string, unknown>): Promise<SkillRunResult> {
  const manifest = JSON.parse(skill.manifest) as { entrypoint?: string };
  // Knowledge-only skills have no entrypoint and expose no tools, so this
  // should be unreachable for them — but a malformed manifest shouldn't
  // crash the loop with a path.join(undefined) either.
  if (!manifest.entrypoint) {
    return { ok: false, error: `skill "${skill.name}" has no entrypoint (knowledge-only skill?)`, stderr: "", timedOut: false, durationMs: 0 };
  }
  const skillDir = resolveSkillDir(skill);
  const entrypointPath = path.join(skillDir, manifest.entrypoint);
  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // process.execPath is a real node binary in dev, but is AURORA.exe
    // itself in the packaged Electron app — spawning that directly on a .js
    // file launches a second Electron GUI instance instead of running the
    // skill, which is why every skill silently produced no stdout there.
    // ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node when
    // spawned as a child process; harmless no-op for a real node.exe.
    const child = spawn(process.execPath, [entrypointPath], {
      cwd: skillDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // Without this, a write to a stdin pipe whose process already died/never
    // started (e.g. spawn failed) emits an unhandled 'error' on the stream,
    // which crashes the whole process — not just this one skill call.
    child.stdin.on("error", () => { /* surfaced via the child 'error'/'close' handlers instead */ });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, stderr: truncate(stderr), timedOut, durationMs: Date.now() - start });
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: "skill timed out after 30s", stderr: truncate(stderr), timedOut, durationMs: Date.now() - start });
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve({ ok: true, result, stderr: truncate(stderr), timedOut, durationMs: Date.now() - start });
      } catch {
        resolve({
          ok: false,
          error: "skill did not print a valid JSON result to stdout",
          stderr: truncate(stderr + "\n--- stdout ---\n" + truncate(stdout)),
          timedOut,
          durationMs: Date.now() - start,
        });
      }
    });

    child.stdin.write(JSON.stringify({ tool: toolName, args }) + "\n");
    child.stdin.end();
  });
}
