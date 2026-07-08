import fs from "node:fs";
import path from "node:path";
import { getStorage } from "../storage";
import { SKILLS_DIR } from "./installer";

/** Approving a skill_install: move staging → the real skills dir, enable it. */
export async function activateSkill(skillId: number): Promise<void> {
  const storage = getStorage();
  const skill = await storage.getSkill(skillId);
  if (!skill) throw new Error(`Skill ${skillId} not found`);

  const activeDir = path.join(SKILLS_DIR, String(skillId));
  if (skill.sourcePath !== activeDir) {
    fs.mkdirSync(path.dirname(activeDir), { recursive: true });
    fs.renameSync(skill.sourcePath, activeDir);
    await storage.setSkillSourcePath(skillId, activeDir);
  }
  await storage.setSkillStatus(skillId, "enabled");
  await storage.log(`skill enabled: ${skill.name}`, skill.sourceRepo, "ok", "owner");
}

/** Denying a skill_install: delete the staged files, never enable it. */
export async function rejectSkillInstall(skillId: number): Promise<void> {
  const storage = getStorage();
  const skill = await storage.getSkill(skillId);
  if (!skill) return;
  fs.rmSync(skill.sourcePath, { recursive: true, force: true });
  await storage.deleteSkill(skillId);
  await storage.log(`skill install denied: ${skill.name}`, skill.sourceRepo, "denied", "owner");
}

/** Owner disables an installed skill without deleting its files. */
export async function disableSkill(skillId: number): Promise<void> {
  const storage = getStorage();
  const skill = await storage.getSkill(skillId);
  if (!skill) throw new Error(`Skill ${skillId} not found`);
  await storage.setSkillStatus(skillId, "disabled");
  await storage.log(`skill disabled: ${skill.name}`, skill.sourceRepo, "ok", "owner");
}

export async function enableSkill(skillId: number): Promise<void> {
  const storage = getStorage();
  const skill = await storage.getSkill(skillId);
  if (!skill) throw new Error(`Skill ${skillId} not found`);
  await storage.setSkillStatus(skillId, "enabled");
  await storage.log(`skill re-enabled: ${skill.name}`, skill.sourceRepo, "ok", "owner");
}

/** Fully removes an installed skill: files + row. */
export async function deleteSkillCompletely(skillId: number): Promise<void> {
  const storage = getStorage();
  const skill = await storage.getSkill(skillId);
  if (!skill) return;
  fs.rmSync(skill.sourcePath, { recursive: true, force: true });
  await storage.deleteSkill(skillId);
  await storage.log(`skill deleted: ${skill.name}`, skill.sourceRepo, "ok", "owner");
}
