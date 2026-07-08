// Real code/command execution — the single most powerful (and most
// dangerous) capability the vessel has. Every call is routed through
// agent-loop.ts's risk gating and ALWAYS lands in the approvals queue first
// (see AGENT_TOOLS in agent-loop.ts) — this module itself enforces no
// policy, it just runs what it's told once the owner has approved it.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExecMode = "shell" | "node" | "python";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n… (output truncated)" : s;
}

function runProcess(cmd: string, args: string[], options: { shell?: boolean; cwd?: string } = {}): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(cmd, args, { shell: options.shell ?? false, cwd: options.cwd });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr + `\n${err.message}`), exitCode: null, timedOut, durationMs: Date.now() - start });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code, timedOut, durationMs: Date.now() - start });
    });
  });
}

/**
 * Executes owner-approved code/commands on the machine AURORA is actually
 * running on. "shell" runs the string directly through the system shell.
 * "node"/"python" write the code to a temp file and run it with the
 * matching interpreter, so multi-line scripts with imports work normally.
 */
export async function executeCommand(mode: ExecMode, code: string): Promise<ExecResult> {
  if (mode === "shell") {
    return runProcess(code, [], { shell: true });
  }

  const ext = mode === "node" ? ".js" : ".py";
  const interpreter = mode === "node" ? process.execPath : (process.platform === "win32" ? "python" : "python3");
  const dir = mkdtempSync(path.join(tmpdir(), "aurora-exec-"));
  const file = path.join(dir, `snippet${ext}`);
  try {
    writeFileSync(file, code, "utf-8");
    return await runProcess(interpreter, [file]);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}
