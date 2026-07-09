import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as tar from "tar";
import { getStorage } from "../storage";
import { loadManifest, listSkillFiles, ManifestError } from "./manifest";
import type { InstalledSkill } from "@shared/schema";
import { STAGING_DIR, SKILLS_DIR } from "../paths";

export { STAGING_DIR, SKILLS_DIR };

fs.mkdirSync(STAGING_DIR, { recursive: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });

export class InstallError extends Error {}

/** Accepts "owner/repo", a bare GitHub URL, or a URL with a /tree/<branch>[/<path>] suffix. */
function parseRepoUrl(input: string): { owner: string; repo: string; refFromUrl?: string; pathFromUrl?: string } {
  const trimmed = input.trim().replace(/\.git$/, "");
  const shortMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

  try {
    const url = new URL(trimmed);
    if (!/(^|\.)github\.com$/.test(url.hostname)) throw new InstallError("Only github.com repo URLs are supported.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new InstallError("Could not find an owner/repo in that URL.");
    const [owner, repo] = parts;
    if (parts[2] === "tree" && parts[3]) {
      return { owner, repo, refFromUrl: parts[3], pathFromUrl: parts.slice(4).join("/") || undefined };
    }
    return { owner, repo };
  } catch (err) {
    if (err instanceof InstallError) throw err;
    throw new InstallError(`Not a valid GitHub repo reference: "${input}".`);
  }
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "aurora-skill-installer" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.default_branch) return json.default_branch;
    }
  } catch { /* fall through to guess */ }
  return "main";
}

const DOWNLOAD_TIMEOUT_MS = 60_000;

async function downloadTarball(owner: string, repo: string, ref: string, destDir: string): Promise<void> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${ref}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new InstallError(`Could not reach GitHub to download ${owner}/${repo}@${ref}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok || !res.body) {
    // ref might be a tag rather than a branch — codeload also accepts that shape directly.
    const tagUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
    let tagRes: Response;
    try {
      tagRes = await fetch(tagUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new InstallError(`Could not reach GitHub to download ${owner}/${repo}@${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!tagRes.ok || !tagRes.body) {
      throw new InstallError(`Could not download ${owner}/${repo}@${ref} from GitHub (repo/branch/tag not found, or it's private).`);
    }
    await pipeline(Readable.fromWeb(tagRes.body as any), tar.x({ cwd: destDir, strip: 1 }));
    return;
  }
  await pipeline(Readable.fromWeb(res.body as any), tar.x({ cwd: destDir, strip: 1 }));
}

export interface InstallResult {
  skill: InstalledSkill;
  approvalId: number;
}

/**
 * Downloads a GitHub repo into a staging directory, validates skill.json,
 * and files a high-risk approval for the owner to review before any of the
 * downloaded code is ever executed. Nothing here is wired into the agent
 * loop's tool registry yet — see skills/lifecycle.ts's approve step for that.
 */
export async function installSkillFromGitHub(repoUrl: string, refInput?: string, subpathInput?: string): Promise<InstallResult> {
  const { owner, repo, refFromUrl, pathFromUrl } = parseRepoUrl(repoUrl);
  const ref = refInput || refFromUrl || (await resolveDefaultBranch(owner, repo));
  const subpath = subpathInput || pathFromUrl;

  const stagingId = randomUUID();
  const stagingRoot = path.join(STAGING_DIR, stagingId);
  fs.mkdirSync(stagingRoot, { recursive: true });

  try {
    await downloadTarball(owner, repo, ref, stagingRoot);
  } catch (err) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw err instanceof InstallError ? err : new InstallError(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const skillRoot = subpath ? path.join(stagingRoot, subpath) : stagingRoot;
  if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory()) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new InstallError(`Subpath "${subpath}" was not found in ${owner}/${repo}@${ref}.`);
  }

  let manifest;
  try {
    manifest = loadManifest(skillRoot);
  } catch (err) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw err instanceof ManifestError ? new InstallError(err.message) : err;
  }

  const { files, totalSize, truncated } = listSkillFiles(skillRoot);

  const storage = getStorage();
  const skill = await storage.createSkill({
    name: manifest.name,
    description: manifest.description,
    sourceRepo: `${owner}/${repo}`,
    sourceRef: ref,
    sourcePath: skillRoot,
    manifest: JSON.stringify(manifest),
    tools: JSON.stringify(manifest.tools),
    status: "pending_review",
    riskDefault: manifest.risk,
    installedAt: Date.now(),
  });

  const approval = await storage.createApproval({
    action: `install skill: ${manifest.name} (from ${owner}/${repo}@${ref})`,
    risk: "high",
    targetType: "skill_install",
    targetId: skill.id,
    detail: JSON.stringify({
      manifest, sourceRepo: `${owner}/${repo}`, sourceRef: ref, subpath: subpath ?? null,
      files, totalSize, filesTruncated: truncated,
    }),
  });

  await storage.log(`requested skill install: ${manifest.name}`, `${owner}/${repo}@${ref}`, "pending", "owner");

  return { skill, approvalId: approval.id };
}
