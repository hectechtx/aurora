import fs from "node:fs";
import path from "node:path";
import { skillManifestSchema, type SkillManifest } from "@shared/schema";

export class ManifestError extends Error {}

/**
 * Reads and validates skill.json from a downloaded skill's root directory,
 * and guards the declared entrypoint against path traversal (e.g.
 * "../../etc/passwd" or an absolute path) — the entrypoint must resolve to
 * a file inside the skill's own directory.
 */
export function loadManifest(skillRootDir: string): SkillManifest {
  const manifestPath = path.join(skillRootDir, "skill.json");
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestError("No skill.json found at the repo root (or given subpath).");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new ManifestError("skill.json is not valid JSON.");
  }
  const parsed = skillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ManifestError(`skill.json failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const manifest = parsed.data;

  const resolvedRoot = path.resolve(skillRootDir);
  const resolvedEntry = path.resolve(skillRootDir, manifest.entrypoint);
  if (resolvedEntry !== resolvedRoot && !resolvedEntry.startsWith(resolvedRoot + path.sep)) {
    throw new ManifestError(`entrypoint "${manifest.entrypoint}" escapes the skill directory.`);
  }
  if (!fs.existsSync(resolvedEntry)) {
    throw new ManifestError(`entrypoint "${manifest.entrypoint}" does not exist in the downloaded repo.`);
  }

  return manifest;
}

export interface SkillFileEntry {
  path: string;
  size: number;
}

/** Recursively lists files under a skill dir for the approval review UI. Capped so a huge repo doesn't blow up the approval payload. */
export function listSkillFiles(skillRootDir: string, maxFiles = 300): { files: SkillFileEntry[]; totalSize: number; truncated: boolean } {
  const files: SkillFileEntry[] = [];
  let totalSize = 0;
  let truncated = false;

  function walk(dir: string) {
    if (truncated) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const size = fs.statSync(full).size;
        totalSize += size;
        if (files.length < maxFiles) {
          files.push({ path: path.relative(skillRootDir, full), size });
        } else {
          truncated = true;
          return;
        }
      }
    }
  }
  walk(skillRootDir);
  return { files, totalSize, truncated };
}
