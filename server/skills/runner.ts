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
import path from "node:path";
import type { InstalledSkill } from "@shared/schema";

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

export async function runSkillTool(skill: InstalledSkill, toolName: string, args: Record<string, unknown>): Promise<SkillRunResult> {
  const manifest = JSON.parse(skill.manifest) as { entrypoint: string };
  const entrypointPath = path.join(skill.sourcePath, manifest.entrypoint);
  const start = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(process.execPath, [entrypointPath], { cwd: skill.sourcePath });

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
