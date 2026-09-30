// Curated skills bundled with AURORA itself (see starter-skills/ at the repo
// root) — installed by copying from that read-only bundle into the same
// staging flow installSkillFromGitHub uses, so bundled skills go through the
// exact same manifest-validation + human-approval gate as anything pulled
// from GitHub. No special-cased trust just because it shipped with the app.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStorage } from "../storage";
import { loadManifest, listSkillFiles, ManifestError } from "./manifest";
import { STAGING_DIR } from "../paths";
import { STARTER_SKILLS_DIR } from "../paths";
import type { InstalledSkill } from "@shared/schema";
import type { InstallResult } from "./installer";
import { InstallError } from "./installer";

export interface StarterSkillSummary {
  id: string;
  name: string;
  description: string;
  risk: string;
  toolNames: string[];
  category: string;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Lists what's actually in the bundle right now, reading each skill.json fresh rather than hardcoding a catalog that could drift from the real files. */
export function getStarterCatalog(): StarterSkillSummary[] {
  if (!fs.existsSync(STARTER_SKILLS_DIR)) return [];
  const catalog: StarterSkillSummary[] = [];
  for (const entry of fs.readdirSync(STARTER_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = loadManifest(path.join(STARTER_SKILLS_DIR, entry.name));
      catalog.push({
        id: entry.name,
        name: manifest.name,
        description: manifest.description,
        risk: manifest.risk,
        toolNames: manifest.tools.map((t) => t.name),
        category: manifest.category ?? "Other",
      });
    } catch {
      // A malformed bundled skill shouldn't take the whole catalog down —
      // just leave it out (this would only happen from a packaging mistake).
    }
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installStarterSkill(id: string): Promise<InstallResult> {
  const bundleRoot = path.join(STARTER_SKILLS_DIR, id);
  const resolved = path.resolve(bundleRoot);
  if (!resolved.startsWith(path.resolve(STARTER_SKILLS_DIR) + path.sep) || !fs.existsSync(bundleRoot)) {
    throw new InstallError(`"${id}" isn't one of the bundled starter skills.`);
  }

  const stagingId = randomUUID();
  const stagingRoot = path.join(STAGING_DIR, stagingId);
  copyDir(bundleRoot, stagingRoot);

  let manifest;
  try {
    manifest = loadManifest(stagingRoot);
  } catch (err) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw err instanceof ManifestError ? new InstallError(err.message) : err;
  }

  const { files, totalSize, truncated } = listSkillFiles(stagingRoot);

  const storage = getStorage();
  const skill: InstalledSkill = await storage.createSkill({
    name: manifest.name,
    description: manifest.description,
    sourceRepo: `aurora-starter/${id}`,
    sourceRef: manifest.version,
    sourcePath: stagingRoot,
    manifest: JSON.stringify(manifest),
    tools: JSON.stringify(manifest.tools),
    status: "pending_review",
    riskDefault: manifest.risk,
    installedAt: Date.now(),
  });

  const approval = await storage.createApproval({
    action: `install skill: ${manifest.name} (bundled starter skill)`,
    risk: "high",
    targetType: "skill_install",
    targetId: skill.id,
    detail: JSON.stringify({
      manifest, sourceRepo: `aurora-starter/${id}`, sourceRef: manifest.version, subpath: null,
      files, totalSize, filesTruncated: truncated,
    }),
  });

  await storage.log(`requested skill install: ${manifest.name}`, `bundled starter skill (${id})`, "pending", "owner");

  return { skill, approvalId: approval.id };
}
