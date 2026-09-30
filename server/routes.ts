import express from "express";
import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getStorage } from "./storage";
import { runAgentTurn, runAgentTick, beginResumeAfterApproval, finishResumeAfterApproval, requestStop, OWNER_QUESTION_TAG } from "./agent-loop";
import { installSkillFromGitHub, InstallError } from "./skills/installer";
import { getStarterCatalog, installStarterSkill } from "./skills/starter";
import { activateSkill, rejectSkillInstall, disableSkill, enableSkill, deleteSkillCompletely } from "./skills/lifecycle";
import { health, listModels, pullModel, getPullStatus, listModelsWithVisionFlag, unloadAllModels } from "./ollama";
import { downloadAndLaunchOllamaInstaller, OllamaInstallError } from "./ollama-installer";
import { health as imageGenHealth, generateImage } from "./imagegen";
import { generateProject, ProjectGenError } from "./projectgen";
import { executeCommand } from "./shell-exec";
import {
  isPiperEngineInstalled, installedVoices, downloadAndInstallPiperEngine, downloadVoice, synthesize,
  CURATED_VOICES, PiperError,
} from "./piper";
import {
  isKokoroInstalled, startKokoroSetup, getKokoroSetupStatus, synthesize as kokoroSynthesize,
  KOKORO_VOICES, KokoroError,
} from "./kokoro";
import { isSttInstalled, startSttSetup, getSttSetupStatus, transcribe, SttError } from "./stt";
import { getDataDriveStatus } from "./datadrive";
import { drain as drainSpeech } from "./speech";
import { health as wangpHealth, DEFAULT_WANGP_HOST as WANGP_HOST, DEFAULT_MODEL as WANGP_MODEL } from "./wangp";
import { listBackups, BACKUP_DIR } from "./backup";
import { isVideoGenInstalled, startVideoGenSetup, getSetupStatus as getVideoGenSetupStatus, detectGpu, generateVideo } from "./videogen";
import { isMusicGenInstalled, startMusicGenSetup, getSetupStatus as getMusicGenSetupStatus, generateMusic } from "./musicgen";
import { generateStoryboard, StoryboardError } from "./storyboard";
import { isYtDlpInstalled, installYtDlp, searchAndDownloadTrack, searchTracks, downloadTrackById, MusicSearchError } from "./musicsearch";
import {
  isImageGenInstalled, startImageGenSetup, getSetupStatus as getImageGenSetupStatus,
  isServerRunning as isImageGenServerRunning, startServer as startImageGenServer,
  stopServer as stopImageGenServer, defaultHost as imageGenDefaultHost,
} from "./imagegen-installer";
import { hashPin, verifyPin, createSession, destroySession, requireAuth, tokenFromRequest, isValidSession } from "./auth";
import {
  taskCreateSchema, taskUpdateSchema, taskAgentAssignSchema, chatSendSchema, skillInstallSchema, approvalDecisionSchema,
  projectCreateSchema, projectUpdateSchema, taskProjectAssignSchema,
  agentConfigUpdateSchema, ollamaPullSchema, terminalRequestSchema, imageUploadSchema,
  agentCreateSchema, agentUpdateSchema, agentQueueItemCreateSchema, deliverableUpdateSchema,
  agentRecurringTaskCreateSchema, agentRecurringTaskUpdateSchema,
  authSetupSchema, authLoginSchema, authChangePinSchema, ttsSpeakSchema, sttTranscribeSchema,
  generateImageSchema, generateVideoSchema, generateProjectSchema, generateStoryboardSchema, musicSearchSchema,
} from "@shared/schema";
import { getCreationsDir, setCreationsDir, getMusicDir, setMusicDir, getDownloadsDir, UPDATE_SOURCE_DIR } from "./paths";
import { getElectronApis } from "./electron-bridge";
import { listBrowserSessions, showBrowserSession, closeBrowserSession } from "./browser-tool";
import { log } from "./app";

/** Parses a route :id param, writing a 400 and returning null if it isn't a real integer — a malformed/non-numeric id would otherwise flow into a Drizzle query as NaN. */
function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "Invalid id." });
    return null;
  }
  return id;
}

// One in-flight video-gen job started from the Generate tab, keyed by a
// random id the client polls. In-memory only (same reasoning as ollama.ts's
// pullState) — a job is meaningless after a restart, and this is a
// single-user local app with no need to persist progress across process
// lifetimes.
interface VideoGenJob {
  status: "running" | "done" | "error";
  lines: string[];
  creationId?: number;
  error?: string;
  kill?: () => void;
}

interface StoryboardJob {
  status: "running" | "done" | "error";
  message: string;
  creationId?: number;
  error?: string;
  stopped: boolean;
}

export async function registerRoutes(_httpServer: Server, app: Express): Promise<void> {
  const storage = getStorage;
  const videoGenJobs = new Map<string, VideoGenJob>();
  const storyboardJobs = new Map<string, StoryboardJob>();

  // Applies a previously-saved custom content storage location, if any —
  // setStorage()'s seedIfEmpty() has already guaranteed the config row
  // exists by the time we get here.
  try {
    setCreationsDir((await storage().getConfig()).contentDir);
  } catch (err) {
    log(`couldn't apply saved content storage location, falling back to the default: ${err instanceof Error ? err.message : String(err)}`);
  }
  setMusicDir((await storage().getConfig()).musicDir);

  // ---- Auth — must be registered before the requireAuth gate below, since
  // these are the only routes reachable without a session. ----
  app.get("/api/auth/status", async (req, res) => {
    const config = await storage().getConfig();
    res.json({ pinSet: !!config.pinHash, authenticated: config.pinHash ? isValidSession(tokenFromRequest(req)) : false });
  });

  app.post("/api/auth/setup", async (req, res) => {
    const config = await storage().getConfig();
    if (config.pinHash) return res.status(400).json({ message: "A PIN is already set." });
    const parsed = authSetupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "PIN must be 4-12 digits." });
    const { hash, salt } = hashPin(parsed.data.pin);
    await storage().setPin(hash, salt);
    await storage().log("PIN set (first-run setup)", "", "ok", "owner");
    res.json({ token: createSession() });
  });

  app.post("/api/auth/login", async (req, res) => {
    const config = await storage().getConfig();
    if (!config.pinHash) return res.status(428).json({ message: "No PIN set yet — complete first-run setup first.", pinSet: false });
    const parsed = authLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid PIN." });
    if (!verifyPin(parsed.data.pin, config.pinHash, config.pinSalt)) {
      return res.status(401).json({ message: "Incorrect PIN." });
    }
    res.json({ token: createSession() });
  });

  app.post("/api/auth/logout", async (req, res) => {
    destroySession(tokenFromRequest(req));
    res.json({ ok: true });
  });

  // Everything below this line requires a valid session.
  app.use("/api", requireAuth);
  // Re-resolves the static root on every request (instead of once at
  // registration) so changing the content storage location in Settings
  // takes effect immediately, with no server restart.
  app.use("/creations", requireAuth, (req, res, next) => express.static(getCreationsDir())(req, res, next));
  // Same re-resolve-per-request pattern as /creations, but the folder is
  // optional (no music configured = 404 instead of serving nothing/erroring).
  // Serve the owner's music folder AND the dedicated downloads folder under the
  // same /music path, so downloaded songs play as part of one merged library.
  // Tries the music folder first, then falls through to downloads.
  app.use("/music", requireAuth, (req, res, next) => {
    const dir = getMusicDir();
    if (!dir) return express.static(getDownloadsDir())(req, res, next);
    express.static(dir)(req, res, (err?: unknown) => {
      if (err) return next(err);
      express.static(getDownloadsDir())(req, res, next);
    });
  });

  app.post("/api/auth/change-pin", async (req, res) => {
    const parsed = authChangePinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid PIN." });
    const config = await storage().getConfig();
    if (!verifyPin(parsed.data.currentPin, config.pinHash, config.pinSalt)) {
      return res.status(401).json({ message: "Current PIN is incorrect." });
    }
    const { hash, salt } = hashPin(parsed.data.newPin);
    await storage().setPin(hash, salt);
    await storage().log("PIN changed", "", "ok", "owner");
    res.json({ ok: true });
  });

  // ---- Tasks (each is its own conversation thread) ----
  app.get("/api/tasks", async (_req, res) => {
    res.json(await storage().getTasks());
  });

  app.post("/api/tasks", async (req, res) => {
    const parsed = taskCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid title." });
    res.json(await storage().createTask(parsed.data.title));
  });

  app.patch("/api/tasks/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = taskUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid update." });
    const task = await storage().updateTask(id, parsed.data);
    if (!task) return res.status(404).json({ message: "Task not found." });
    res.json(task);
    // Auto work log on completion — mirror of the agent queue-item note in
    // agent-loop.ts's runAgentTick: closing a task leaves a recallable trail
    // of what it was and how it ended (its last assistant reply), so Memory
    // becomes a history of everything AURORA has done. Best-effort, after
    // the response — never worth failing or delaying the PATCH over.
    if (parsed.data.status === "done") {
      (async () => {
        const messages = await storage().getChatMessages(id, 10);
        const lastReply = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
        await storage().createNote(`task done: ${task.title.slice(0, 120)}`, (lastReply?.content ?? "(no summary available)").slice(0, 800), null);
      })().catch(() => {});
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteTask(id);
    res.json({ ok: true });
  });

  // ---- Projects (grouping of tasks) ----
  app.get("/api/projects", async (_req, res) => {
    res.json(await storage().getProjects());
  });

  app.post("/api/projects", async (req, res) => {
    const parsed = projectCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid project." });
    const project = await storage().createProject(parsed.data);
    await storage().log(`project created: ${project.name}`, "", "ok", "owner");
    res.json(project);
  });

  app.patch("/api/projects/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = projectUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid update." });
    const project = await storage().updateProject(id, parsed.data);
    if (!project) return res.status(404).json({ message: "Project not found." });
    res.json(project);
  });

  app.delete("/api/projects/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteProject(id);
    res.json({ ok: true });
  });

  // Usage/activity stats for the Home dashboard.
  app.get("/api/stats", async (_req, res) => {
    res.json(await storage().getStats());
  });

  // Assign a task to a project (or clear it with projectId: null).
  app.patch("/api/tasks/:id/project", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = taskProjectAssignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const task = await storage().setTaskProject(id, parsed.data.projectId);
    if (!task) return res.status(404).json({ message: "Task not found." });
    res.json(task);
  });

  app.get("/api/tasks/:id/messages", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getChatMessages(id));
  });

  // Clear a task's chat, optionally archiving it into the Memory bank first.
  // archive=true saves a transcript note (recallable later) before wiping.
  app.post("/api/tasks/:id/chat/clear", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const archive = req.body?.archive === true;
    if (archive) {
      const task = await storage().getTask(id);
      const messages = await storage().getChatMessages(id, 1000);
      if (messages.length > 0) {
        const transcript = [...messages].reverse()
          .map((m) => `${m.role}: ${(m.content || "").slice(0, 2000)}`).join("\n\n").slice(0, 18000);
        await storage().createNote(`Archived chat: ${task?.title ?? `task #${id}`}`, transcript);
      }
    }
    await storage().clearChatMessages(id);
    await storage().log(archive ? "archived + cleared task chat" : "cleared task chat", `task #${id}`, "ok", "owner");
    res.json({ ok: true });
  });

  app.post("/api/tasks/:id/chat", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = chatSendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid message." });
    try {
      const result = await runAgentTurn(id, parsed.data.message, parsed.data.imageCreationId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/tasks/:id/stop", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const stopped = requestStop({ type: "task", taskId: id });
    res.json({ stopped });
  });

  // Assigning agents to a Task turns its chat into a shared thread they all
  // read and respond in (see runGroupRound in agent-loop.ts) — an ordinary
  // task with no agents assigned keeps the single-assistant behavior.
  app.get("/api/tasks/:id/agents", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getTaskAgents(id));
  });

  app.post("/api/tasks/:id/agents", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = taskAgentAssignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid agent." });
    const agent = await storage().getAgent(parsed.data.agentId);
    if (!agent) return res.status(404).json({ message: "Agent not found." });
    const task = await storage().getTask(id);
    if (!task) return res.status(404).json({ message: "Task not found." });
    res.json(await storage().assignAgentToTask(id, parsed.data.agentId));
  });

  app.delete("/api/tasks/:id/agents/:agentId", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const agentId = Number(req.params.agentId);
    if (!Number.isInteger(agentId)) return res.status(400).json({ message: "Invalid agent id." });
    await storage().unassignAgentFromTask(id, agentId);
    res.json({ ok: true });
  });

  // ---- Skills ----
  app.get("/api/skills", async (_req, res) => {
    res.json(await storage().getSkills());
  });

  app.post("/api/skills/install", async (req, res) => {
    const config = await storage().getConfig();
    if (!config.advancedToolsEnabled) return res.status(403).json({ message: "Advanced tools are off — enable them in Settings before installing skills from GitHub." });
    const parsed = skillInstallSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input." });
    try {
      const result = await installSkillFromGitHub(parsed.data.repoUrl, parsed.data.ref, parsed.data.subpath);
      res.json(result);
    } catch (err) {
      const message = err instanceof InstallError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof InstallError ? 400 : 500).json({ message });
    }
  });

  app.get("/api/skills/starter-catalog", async (_req, res) => {
    res.json(getStarterCatalog());
  });

  app.post("/api/skills/starter/:id/install", async (req, res) => {
    const config = await storage().getConfig();
    if (!config.advancedToolsEnabled) return res.status(403).json({ message: "Advanced tools are off — enable them in Settings before installing skills." });
    const id = String(req.params.id ?? "").trim();
    try {
      const result = await installStarterSkill(id);
      res.json(result);
    } catch (err) {
      const message = err instanceof InstallError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof InstallError ? 400 : 500).json({ message });
    }
  });

  app.post("/api/skills/:id/disable", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
      await disableSkill(id);
      res.json(await storage().getSkill(id));
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/skills/:id/enable", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const config = await storage().getConfig();
    if (!config.advancedToolsEnabled) return res.status(403).json({ message: "Advanced tools are off — enable them in Settings before enabling skills." });
    try {
      await enableSkill(id);
      res.json(await storage().getSkill(id));
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/skills/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await deleteSkillCompletely(id);
    res.json({ ok: true });
  });

  // ---- Approvals ----
  app.get("/api/approvals", async (_req, res) => {
    res.json(await storage().getApprovals());
  });

  app.post("/api/approvals/:id/decide", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = approvalDecisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid decision." });
    const approval = await storage().getApproval(id);
    if (!approval) return res.status(404).json({ message: "Approval not found." });
    if (approval.status !== "pending") return res.status(400).json({ message: "This approval was already decided." });

    try {
      if (approval.targetType === "skill_install") {
        if (approval.targetId == null) return res.status(500).json({ message: "This approval is missing its target skill." });
        // Flip status first (atomically — see decideApproval) so a concurrent
        // duplicate decide can't also pass this check and double-run activate/reject.
        const decided = await storage().decideApproval(id, parsed.data.status);
        if (!decided) return res.status(400).json({ message: "This approval was already decided." });
        if (parsed.data.status === "approved") await activateSkill(approval.targetId);
        else await rejectSkillInstall(approval.targetId);
        return res.json({ approval: await storage().getApproval(id) });
      }

      if (approval.targetType === "terminal_request") {
        const decided = await storage().decideApproval(id, parsed.data.status);
        if (!decided) return res.status(400).json({ message: "This approval was already decided." });
        if (parsed.data.status === "denied") {
          await storage().log("terminal request denied", approval.action, "denied", "owner");
          return res.json({ approval: await storage().getApproval(id) });
        }
        // Advanced tools may have been switched off after this was
        // requested but before it was approved — re-check at execution time.
        const config = await storage().getConfig();
        if (!config.advancedToolsEnabled) {
          await storage().log("terminal request blocked (advanced tools off)", approval.action, "error", "owner");
          return res.status(403).json({ message: "Advanced tools were turned off after this was requested — enable them in Settings to run it." });
        }
        const { mode, code } = JSON.parse(approval.detail) as { mode: "shell" | "node" | "python"; code: string };
        const result = await executeCommand(mode, code);
        await storage().log(`ran terminal command (${mode})`, code.slice(0, 200), result.exitCode === 0 ? "ok" : "error", "owner");
        return res.json({ approval: await storage().getApproval(id), result });
      }

      // Only the fast "flip the approval" half is awaited here — the actual
      // tool call (which for something like generate_video can take up to
      // ~20 minutes) runs in the background so the Approve button responds
      // immediately instead of leaving the request hanging. Progress shows
      // up in the task/agent's own message feed, which already polls.
      const prepared = await beginResumeAfterApproval(id, parsed.data.status);
      finishResumeAfterApproval(prepared, parsed.data.status).catch((err) => {
        storage().log(`resume after approval failed: ${id}`, err instanceof Error ? err.message : String(err), "error").catch(() => {});
      });
      res.json({ approval: prepared.approval });
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Terminal (manually composed, still approval-gated) ----
  app.post("/api/terminal/request", async (req, res) => {
    const config = await storage().getConfig();
    if (!config.advancedToolsEnabled) return res.status(403).json({ message: "Advanced tools are off — enable them in Settings to use the Terminal." });
    const parsed = terminalRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const { mode, code } = parsed.data;
    const approval = await storage().createApproval({
      action: `run_${mode}(${code.length > 60 ? code.slice(0, 60) + "…" : code})`,
      risk: "high",
      targetType: "terminal_request",
      detail: JSON.stringify({ mode, code }),
    });
    await storage().log(`requested terminal command (${mode})`, code.slice(0, 200), "pending", "owner");
    res.json({ approvalId: approval.id });
  });

  // ---- Agents (persistent named workers) ----
  app.get("/api/agents", async (_req, res) => {
    res.json(await storage().getAgents());
  });

  app.post("/api/agents", async (req, res) => {
    const parsed = agentCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid agent." });
    // Names are the only handle handoff_to_agent has to pick a target by —
    // two agents sharing a name would make that resolution ambiguous (and,
    // since getAgents() is ordered by updatedAt, unstable over time).
    const nameTaken = (await storage().getAgents()).some((a) => a.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (nameTaken) return res.status(400).json({ message: `An agent named "${parsed.data.name}" already exists — names need to be unique.` });
    const agent = await storage().createAgent({
      name: parsed.data.name, persona: parsed.data.persona, jobDescription: parsed.data.jobDescription,
      scheduleMinutes: parsed.data.scheduleMinutes ?? null,
    });
    await storage().log(`agent created: ${agent.name}`, agent.jobDescription.slice(0, 200), "ok", "owner");
    res.json(agent);
  });

  // Registered before "/api/agents/:id" so "conversations" isn't swallowed
  // as an :id — Express matches routes in registration order.
  app.get("/api/agents/conversations", async (_req, res) => {
    res.json(await storage().getAgentConversations());
  });

  app.get("/api/agents/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const agent = await storage().getAgent(id);
    if (!agent) return res.status(404).json({ message: "Agent not found." });
    res.json(agent);
  });

  app.patch("/api/agents/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = agentUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid update." });
    if (parsed.data.name) {
      const nameTaken = (await storage().getAgents()).some((a) => a.id !== id && a.name.toLowerCase() === parsed.data.name!.toLowerCase());
      if (nameTaken) return res.status(400).json({ message: `An agent named "${parsed.data.name}" already exists — names need to be unique.` });
    }
    const agent = await storage().updateAgent(id, parsed.data);
    if (!agent) return res.status(404).json({ message: "Agent not found." });
    res.json(agent);
  });

  app.delete("/api/agents/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteAgent(id);
    res.json({ ok: true });
  });

  // A Sims-style character portrait built from the agent's own name/persona/
  // job description, through the same local image-gen pipeline as any other
  // creation. Not tracked as a Library creation (it's an agent property, not
  // generated content to browse) — just a filename on the agent row.
  app.post("/api/agents/:id/avatar/generate", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const agent = await storage().getAgent(id);
    if (!agent) return res.status(404).json({ message: "Agent not found." });
    const config = await storage().getConfig();
    if (!config.imageGenHost) return res.status(400).json({ message: "Set up local image generation in Settings first." });
    // AURORA the overseer gets a photorealistic human portrait — the owner
    // wants her to feel alive and present, not a game-art avatar like the
    // worker agents. Everyone else keeps the character-select style.
    const prompt = agent.isOverseer
      ? "Photorealistic portrait headshot of a calm, intelligent woman with dark hair, warm and attentive expression, " +
        "soft studio lighting, subtle teal and violet rim light, looking directly at the camera, shallow depth of field, " +
        "cinematic, ultra detailed, natural skin texture, 85mm lens, high quality. She is AURORA, a personal AI overseer."
      : `Stylized character portrait avatar of "${agent.name}", a personal AI assistant character. ` +
        `Role: ${agent.jobDescription.slice(0, 300)}. Personality: ${agent.persona.slice(0, 300)}. ` +
        "Simple clean background, friendly expression, headshot framing, video game character select screen art, vibrant colors, high quality.";
    try {
      const { pngBuffer } = await generateImage(config.imageGenHost, prompt, config.ollamaHost);
      const filename = `avatar-${id}-${randomUUID()}.png`;
      fs.writeFileSync(path.join(getCreationsDir(), filename), pngBuffer);
      if (agent.avatarPath) {
        try { fs.unlinkSync(path.join(getCreationsDir(), agent.avatarPath)); } catch { /* already gone */ }
      }
      const updated = await storage().updateAgent(id, { avatarPath: filename });
      await storage().log(`generated avatar for agent: ${agent.name}`, "", "ok", "owner");
      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/agents/:id/log", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getAgentLog(id));
  });

  // Clear an agent's activity log, optionally archiving it to that agent's own
  // Memory bank first (archive=true).
  app.post("/api/agents/:id/log/clear", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const archive = req.body?.archive === true;
    if (archive) {
      const agent = await storage().getAgent(id);
      const log = await storage().getAgentLog(id, 1000);
      if (log.length > 0) {
        const transcript = [...log].reverse()
          .map((m) => `${m.role}: ${(m.content || "").slice(0, 2000)}`).join("\n\n").slice(0, 18000);
        await storage().createNote(`Archived chat: ${agent?.name ?? `agent #${id}`}`, transcript, id);
      }
    }
    await storage().clearAgentLog(id);
    await storage().log(archive ? "archived + cleared agent log" : "cleared agent log", `agent #${id}`, "ok", "owner");
    res.json({ ok: true });
  });

  app.get("/api/agents/:id/queue", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getAgentQueue(id));
  });

  app.post("/api/agents/:id/queue", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = agentQueueItemCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid suggestion." });
    // Same plain-text hint runAgentTurn folds into a Task message — lets the
    // agent's see_image tool find an image attached via the composer above.
    let content = parsed.data.content;
    if (parsed.data.imageCreationId) {
      const creation = await storage().getCreation(parsed.data.imageCreationId);
      if (creation) content += `\n\n[Attached image: "${creation.filePath}" — use your see_image tool with this exact filename if you want to look at it.]`;
    }
    const item = await storage().createQueueItem(id, content);
    // Nudge the agent to work its queue right now instead of waiting for the
    // next scheduler pass (up to ~60s) — fire-and-forget, same pattern as
    // handoff_to_agent's own nudge. runAgentTick's in-flight guard makes
    // this safe even if the agent is already ticking for another reason.
    runAgentTick(id).catch((err) => {
      storage().log(`queue nudge failed: agent ${id}`, err instanceof Error ? err.message : String(err), "error").catch(() => {});
    });
    res.json(item);
  });

  // ---- Recurring task templates — a standing instruction that re-adds
  // itself to the agent's queue on its own schedule (see server/scheduler.ts). ----
  app.get("/api/agents/:id/recurring", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getRecurringTasks(id));
  });

  app.post("/api/agents/:id/recurring", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = agentRecurringTaskCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid recurring task." });
    const task = await storage().createRecurringTask(id, parsed.data.content, parsed.data.scheduleMinutes);
    res.json(task);
  });

  app.patch("/api/agents/:id/recurring/:recurringId", async (req, res) => {
    const recurringId = Number(req.params.recurringId);
    if (!Number.isInteger(recurringId)) return res.status(400).json({ message: "Invalid id." });
    const parsed = agentRecurringTaskUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid update." });
    const task = await storage().updateRecurringTask(recurringId, parsed.data);
    if (!task) return res.status(404).json({ message: "Recurring task not found." });
    res.json(task);
  });

  app.delete("/api/agents/:id/recurring/:recurringId", async (req, res) => {
    const recurringId = Number(req.params.recurringId);
    if (!Number.isInteger(recurringId)) return res.status(400).json({ message: "Invalid id." });
    await storage().deleteRecurringTask(recurringId);
    res.json({ ok: true });
  });

  app.get("/api/agents/:id/memory", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await storage().getNotes(query, 200, id));
  });

  // Social standings for one agent, with the other agent's name resolved
  // server-side so the Agents UI can render "close with Riley" without a
  // second round trip per relationship.
  app.get("/api/agents/:id/relationships", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const [rels, all] = await Promise.all([storage().getRelationships(id), storage().getAgents()]);
    const nameById = new Map(all.map((a) => [a.id, a.name] as const));
    res.json(rels.map((r) => ({ ...r, otherAgentName: nameById.get(r.otherAgentId) ?? "unknown" })));
  });

  app.post("/api/agents/:id/run", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    try {
      const result = await runAgentTick(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/agents/:id/stop", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    // queueItemId/handoffDepth aren't needed to look up or kill the running
    // turn — requestStop only keys off agentId — so zero placeholders here are fine.
    const stopped = requestStop({ type: "agent", agentId: id, queueItemId: 0, handoffDepth: 0 });
    res.json({ stopped });
  });

  // ---- Outbox (deliverables agents have produced, for you to post yourself) ----
  app.get("/api/deliverables", async (req, res) => {
    if (req.query.agentId !== undefined) {
      const agentId = Number(req.query.agentId);
      if (!Number.isInteger(agentId)) return res.status(400).json({ message: "Invalid agentId." });
      return res.json(await storage().getDeliverables(agentId));
    }
    res.json(await storage().getDeliverables());
  });

  app.patch("/api/deliverables/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = deliverableUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid update." });
    const deliverable = await storage().updateDeliverable(id, parsed.data.status);
    if (!deliverable) return res.status(404).json({ message: "Deliverable not found." });
    res.json(deliverable);
  });

  app.delete("/api/deliverables/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteDeliverable(id);
    res.json({ ok: true });
  });

  // Answer an agent's ask_owner question (an Outbox deliverable tagged
  // OWNER_QUESTION_TAG). The reply is dropped onto the asking agent's queue so
  // it acts on it next tick, and the question is marked posted (answered).
  app.post("/api/deliverables/:id/answer", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!answer) return res.status(400).json({ message: "An answer is required." });
    const deliverable = await storage().getDeliverable(id);
    if (!deliverable) return res.status(404).json({ message: "Question not found." });
    let tags: string[] = [];
    try { tags = JSON.parse(deliverable.tags); } catch { /* not a JSON tag list */ }
    if (!tags.includes(OWNER_QUESTION_TAG)) return res.status(400).json({ message: "That deliverable isn't an agent question." });
    await storage().createQueueItem(
      deliverable.agentId,
      `The owner answered your earlier question:\n\nQ: ${deliverable.body}\n\nA: ${answer}\n\nAct on this answer.`,
    );
    const updated = await storage().updateDeliverable(id, "posted");
    await storage().log("answered agent question", deliverable.title, "ok", "owner");
    res.json(updated);
  });

  // ---- Memory (persistent notes; global scope — agents have their own, see /api/agents/:id/memory) ----
  app.get("/api/notes", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await storage().getNotes(query, 200));
  });

  app.delete("/api/notes/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteNote(id);
    res.json({ ok: true });
  });

  // ---- Library (generated media) ----
  app.get("/api/creations", async (_req, res) => {
    res.json(await storage().getCreations());
  });

  // Recycle Bin — soft-deleted Library items, recoverable until purged.
  app.get("/api/creations/trash", async (_req, res) => {
    res.json(await storage().getTrashedCreations());
  });

  // Soft delete (into the Recycle Bin) — keeps the file.
  app.delete("/api/creations/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteCreation(id);
    res.json({ ok: true });
  });

  app.post("/api/creations/:id/restore", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().restoreCreation(id);
    res.json({ ok: true });
  });

  // Permanent delete — removes the row and its file from disk.
  app.delete("/api/creations/:id/forever", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteCreationForever(id);
    res.json({ ok: true });
  });

  // A pasted/attached image from a Task's composer. Saved into the same
  // Library the rest of the app already uses, so see_image (Library-only
  // path lookups) and the Outbox/Library UI all just work on it unchanged.
  app.post("/api/creations/upload", async (req, res) => {
    const parsed = imageUploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid image." });
    const match = parsed.data.dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
    if (!match) return res.status(400).json({ message: "Invalid image data URL." });
    const ext = match[1] === "jpg" ? "jpeg" : match[1];
    const buffer = Buffer.from(match[2], "base64");
    const filename = `${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(getCreationsDir(), filename), buffer);
    const creation = await storage().createCreation({ kind: "image", prompt: "(uploaded by you)", filePath: filename });
    res.json(creation);
  });

  // ---- Generate (direct, form-driven media/project generation — the
  // Generate tab. Same underlying generators as the agent tool-calling path,
  // just invoked straight from a prompt form instead of an LLM deciding to
  // call a tool.) ----
  app.post("/api/generate/image", async (req, res) => {
    const parsed = generateImageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const config = await storage().getConfig();
    if (!config.imageGenHost) return res.status(400).json({ message: "Set up local image generation in Settings first." });
    try {
      const { pngBuffer } = await generateImage(config.imageGenHost, parsed.data.prompt, config.ollamaHost);
      const filename = `${randomUUID()}.png`;
      fs.writeFileSync(path.join(getCreationsDir(), filename), pngBuffer);
      const creation = await storage().createCreation({ kind: "image", prompt: parsed.data.prompt, filePath: filename, title: parsed.data.title });
      await storage().log("generated image (Generate tab)", parsed.data.prompt.slice(0, 200), "ok", "owner");
      res.json(creation);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // Pre-vetted width/height/frame-count combinations rather than letting the
  // Generate tab collect raw pixel dimensions — this GPU has 8GB of VRAM and
  // freeform values are an easy way to silently exceed it, or exceed
  // available system RAM while the checkpoint memory-maps, which crashes the
  // subprocess outright instead of failing cleanly. Landscape/portrait carry
  // the same total pixel count, so both carry roughly the same cost.
  const VIDEO_ORIENTATION_PRESETS: Record<string, { width: number; height: number }> = {
    landscape: { width: 512, height: 320 },
    portrait: { width: 320, height: 512 },
  };
  const VIDEO_LENGTH_PRESETS: Record<string, number> = { short: 25, medium: 49, long: 97 };
  const VIDEO_STYLE_DESCRIPTORS: Record<string, string> = {
    cinematic: "cinematic lighting, shallow depth of field, film grain, dramatic composition",
    realistic: "photorealistic, natural lighting, lifelike detail",
    animated: "animated, cartoon style, bold outlines, vibrant flat colors",
    anime: "anime style, cel-shaded, expressive",
    "3d": "3D render, smooth shading, studio lighting",
    dreamlike: "dreamlike, soft focus, surreal, ethereal atmosphere",
  };

  // Video gen can run for minutes, so this kicks off a background job and
  // hands back an id to poll — the client can't hold an HTTP request open
  // that long. Mirrors the progress/kill hooks the agent tool-calling path
  // already wires generateVideo() up to (see agent-loop.ts's generate_video).
  app.post("/api/generate/video", async (req, res) => {
    const parsed = generateVideoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    if (!isVideoGenInstalled()) return res.status(400).json({ message: "Set up local video generation in Settings first." });

    let conditioningImagePath: string | undefined;
    if (parsed.data.sourceImage) {
      const safeName = path.basename(parsed.data.sourceImage);
      const full = path.join(getCreationsDir(), safeName);
      if (fs.existsSync(full)) conditioningImagePath = full;
    }

    // Free the GPU before LTX-Video tries to load its own checkpoint — on an
    // 8GB card, whatever Ollama still has loaded can leave too little VRAM
    // free, which crashes the video-gen subprocess outright instead of
    // failing cleanly.
    const config = await storage().getConfig();
    await unloadAllModels(config.ollamaHost);

    const { width, height } = VIDEO_ORIENTATION_PRESETS[parsed.data.orientation];
    const numFrames = VIDEO_LENGTH_PRESETS[parsed.data.length];
    const styleDescriptor = parsed.data.style ? VIDEO_STYLE_DESCRIPTORS[parsed.data.style] : undefined;
    const fullPrompt = styleDescriptor ? `${parsed.data.prompt}, ${styleDescriptor}` : parsed.data.prompt;

    const jobId = randomUUID();
    const job: VideoGenJob = { status: "running", lines: [] };
    videoGenJobs.set(jobId, job);

    generateVideo(
      { prompt: fullPrompt, width, height, numFrames, conditioningImagePath, ollamaHost: config.ollamaHost },
      {
        onProgress: (line) => {
          job.lines.push(line);
          if (job.lines.length > 200) job.lines.shift();
        },
        onStart: (kill) => { job.kill = kill; },
      },
    )
      .then(async (buffer) => {
        const filename = `${randomUUID()}.mp4`;
        fs.writeFileSync(path.join(getCreationsDir(), filename), buffer);
        const creation = await storage().createCreation({ kind: "video", prompt: parsed.data.prompt, filePath: filename, title: parsed.data.title });
        job.status = "done";
        job.creationId = creation.id;
        await storage().log("generated video (Generate tab)", parsed.data.prompt.slice(0, 200), "ok", "owner");
      })
      .catch((err) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      });

    res.json({ jobId });
  });

  app.get("/api/generate/video/:jobId", async (req, res) => {
    const job = videoGenJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found." });
    const creation = job.creationId ? await storage().getCreation(job.creationId) : null;
    res.json({ status: job.status, lines: job.lines.slice(-50), creation, error: job.error ?? null });
  });

  app.post("/api/generate/video/:jobId/stop", async (req, res) => {
    const job = videoGenJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found." });
    job.kill?.();
    res.json({ ok: true });
  });

  // Code projects are generated by asking the main chat model for a JSON
  // manifest of files (see projectgen.ts), written under a "_projects"
  // subfolder of the creations dir and tracked as a Library creation of
  // kind "project" whose filePath is the project's own folder name.
  app.post("/api/generate/project", async (req, res) => {
    const parsed = generateProjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const config = await storage().getConfig();
    if (!config.model) return res.status(400).json({ message: "Pick a model in Settings first." });
    try {
      const { files } = await generateProject(config.ollamaHost, config.model, parsed.data.description);
      const projectId = randomUUID();
      const relDir = path.join("_projects", projectId);
      const dir = path.join(getCreationsDir(), relDir);
      for (const f of files) {
        const full = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
      }
      const creation = await storage().createCreation({ kind: "project", prompt: parsed.data.description, filePath: relDir, title: parsed.data.title });
      await storage().log("generated code project (Generate tab)", parsed.data.description.slice(0, 200), "ok", "owner");
      res.json({ ...creation, fileCount: files.length });
    } catch (err) {
      const message = err instanceof ProjectGenError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof ProjectGenError ? 400 : 500).json({ message });
    }
  });

  app.get("/api/creations/:id/project-files", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const creation = await storage().getCreation(id);
    if (!creation || creation.kind !== "project") return res.status(404).json({ message: "Project not found." });
    const dir = path.join(getCreationsDir(), creation.filePath);
    function walk(rel: string): string[] {
      let out: string[] = [];
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out = out.concat(walk(relPath));
        else out.push(relPath);
      }
      return out;
    }
    try {
      res.json({ files: walk("") });
    } catch {
      res.json({ files: [] });
    }
  });

  // Long-form narrated video (script + per-scene image/video + TTS,
  // stitched with ffmpeg — see server/storyboard.ts). Can genuinely run for
  // tens of minutes on a full-length request, so this is a background job
  // like /api/generate/video, just with coarser (message-level, not
  // line-level) progress since each "step" here is itself a whole scene.
  app.post("/api/generate/storyboard", async (req, res) => {
    const parsed = generateStoryboardSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const config = await storage().getConfig();
    if (!config.model) return res.status(400).json({ message: "Pick a model in Settings first." });
    if (parsed.data.mode !== "images" && !isVideoGenInstalled()) {
      return res.status(400).json({ message: "Video/Hybrid mode needs local video generation set up in Settings — or pick Slideshow instead." });
    }
    if (!config.imageGenHost && parsed.data.mode !== "video") {
      return res.status(400).json({ message: "Set up local image generation in Settings first." });
    }

    // Same VRAM-contention reasoning as /api/generate/video — every scene
    // may call generateVideo(), which needs the GPU headroom Ollama's own
    // loaded model would otherwise be sitting on.
    if (parsed.data.mode !== "images") await unloadAllModels(config.ollamaHost);

    const jobId = randomUUID();
    const job: StoryboardJob = { status: "running", message: "Starting…", stopped: false };
    storyboardJobs.set(jobId, job);

    generateStoryboard(
      {
        topic: parsed.data.topic, targetMinutes: parsed.data.targetMinutes, mode: parsed.data.mode,
        orientation: parsed.data.orientation, voiceId: parsed.data.voiceId,
        ollamaHost: config.ollamaHost, ollamaModel: config.model, imageGenHost: config.imageGenHost,
      },
      {
        onProgress: (message) => { job.message = message; },
        shouldStop: () => job.stopped,
      },
    )
      .then(async (result) => {
        const filename = `${randomUUID()}.mp4`;
        fs.writeFileSync(path.join(getCreationsDir(), filename), result.buffer);
        const creation = await storage().createCreation({
          kind: "video", prompt: parsed.data.topic, filePath: filename, title: parsed.data.title,
        });
        job.status = "done";
        job.creationId = creation.id;
        await storage().log("generated long-form video (Generate tab)", `${result.sceneCount} scenes, ~${Math.round(result.actualSeconds)}s`, "ok", "owner");
      })
      .catch((err) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      });

    res.json({ jobId });
  });

  app.get("/api/generate/storyboard/:jobId", async (req, res) => {
    const job = storyboardJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found." });
    const creation = job.creationId ? await storage().getCreation(job.creationId) : null;
    res.json({ status: job.status, message: job.message, creation, error: job.error ?? null });
  });

  app.post("/api/generate/storyboard/:jobId/stop", async (req, res) => {
    const job = storyboardJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found." });
    job.stopped = true;
    res.json({ ok: true });
  });

  // Opens a generated project's folder in the OS file explorer — desktop-app
  // only, same as the folder-picker dialog.
  app.post("/api/creations/:id/reveal", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const creation = await storage().getCreation(id);
    if (!creation) return res.status(404).json({ message: "Not found." });
    const electron = await getElectronApis();
    if (!electron) return res.status(501).json({ message: "Only available in the installed desktop app." });
    const full = path.join(getCreationsDir(), creation.filePath);
    const err = await electron.shell.openPath(full);
    if (err) return res.status(500).json({ message: err });
    res.json({ ok: true });
  });

  // ---- Audit ----
  app.get("/api/audit", async (_req, res) => {
    res.json(await storage().getAudit());
  });

  // ---- Config / Ollama / Image gen ----
  app.get("/api/config", async (_req, res) => {
    res.json(await storage().getConfig());
  });

  app.patch("/api/config", async (req, res) => {
    const parsed = agentConfigUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid config." });
    if (parsed.data.contentDir !== undefined) {
      try {
        setCreationsDir(parsed.data.contentDir);
      } catch (err) {
        return res.status(400).json({ message: `Couldn't use that folder: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (parsed.data.musicDir !== undefined) {
      const dir = parsed.data.musicDir.trim();
      if (dir && !fs.existsSync(dir)) {
        return res.status(400).json({ message: "That folder doesn't exist." });
      }
      setMusicDir(parsed.data.musicDir);
    }
    res.json(await storage().updateConfig(parsed.data));
  });

  const MUSIC_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
  app.get("/api/music/tracks", async (_req, res) => {
    // Merge the owner's music folder with the downloads folder into one list,
    // deduped by filename (a song present in both is served once). Both are
    // reachable under /music/<name> via the chained static handler above.
    const seen = new Set<string>();
    const collect = (dir: string | null) => {
      if (!dir) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase())) seen.add(f);
        }
      } catch { /* folder missing/unreadable — skip */ }
    };
    collect(getMusicDir());
    collect(getDownloadsDir());
    res.json([...seen]);
  });

  // Richer library listing for the Music page: each track tagged with its
  // source (the owner's own music folder vs AURORA's downloads). Deduped so a
  // file present in both shows once (as "music").
  app.get("/api/music/library", async (_req, res) => {
    const bySource: { file: string; source: "music" | "downloads" }[] = [];
    const seen = new Set<string>();
    const collect = (dir: string | null, source: "music" | "downloads") => {
      if (!dir) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase())) continue;
          if (seen.has(f)) continue;
          seen.add(f);
          bySource.push({ file: f, source });
        }
      } catch { /* folder missing/unreadable — skip */ }
    };
    collect(getMusicDir(), "music");
    collect(getDownloadsDir(), "downloads");
    res.json(bySource);
  });

  // ---- Music search — find and download a single track straight into the
  // background-music folder above. Same install-once-run-forever shape as
  // Piper (a standalone binary, no Python env to manage). ----
  app.get("/api/musicsearch/status", async (_req, res) => {
    res.json({ installed: isYtDlpInstalled() });
  });

  app.post("/api/musicsearch/install", async (_req, res) => {
    try {
      await installYtDlp();
      res.json({ installed: true });
    } catch (err) {
      const message = err instanceof MusicSearchError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof MusicSearchError ? 400 : 500).json({ message });
    }
  });

  app.post("/api/musicsearch/download", async (req, res) => {
    const parsed = musicSearchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    try {
      const track = await searchAndDownloadTrack(parsed.data.query);
      await storage().log("downloaded track (music search)", track.title, "ok", "owner");
      res.json(track);
    } catch (err) {
      const message = err instanceof MusicSearchError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof MusicSearchError ? 400 : 500).json({ message });
    }
  });

  // Find candidates without downloading, so the owner picks the right track
  // (the Music tab's "find & add a song" flow).
  app.post("/api/musicsearch/search", async (req, res) => {
    const parsed = musicSearchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    try {
      res.json(await searchTracks(parsed.data.query, 8));
    } catch (err) {
      const message = err instanceof MusicSearchError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof MusicSearchError ? 400 : 500).json({ message });
    }
  });

  // Add (download) one specific candidate the owner chose from search results.
  app.post("/api/musicsearch/add", async (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id) return res.status(400).json({ message: "A track id is required." });
    try {
      const track = await downloadTrackById(id);
      await storage().log("added track (music search)", track.title, "ok", "owner");
      res.json(track);
    } catch (err) {
      const message = err instanceof MusicSearchError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof MusicSearchError ? 400 : 500).json({ message });
    }
  });

  // ---- System (Electron-only capabilities: native dialogs, self-update) ----
  // Health of the external drive the data dir lives on, plus the off-drive
  // backups that exist precisely because it keeps detaching. See datadrive.ts.
  // Anything AURORA (or an agent) decided to say out loud via the speak tool.
  // Draining endpoint: the client is expected to actually play what it gets,
  // so a second reader would swallow the audio. See speech.ts.
  app.get("/api/speech/pending", async (_req, res) => {
    res.json({ utterances: drainSpeech() });
  });

  // WanGP is the working video backend (see wangp.ts for why LTX isn't).
  // It lives outside AURORA in Pinokio, so this only reports reachability —
  // AURORA doesn't own its lifecycle and shouldn't pretend to.
  app.get("/api/videogen/wangp/status", async (_req, res) => {
    res.json({ live: await wangpHealth(), host: WANGP_HOST, model: WANGP_MODEL });
  });

  // God's Eye View — a separate local app (its own server on 4173), embedded
  // as a door in AURORA. Not auto-started, so this just reports reachability.
  // ---- Agent browser tabs (Polar-style watch / take over) ----
  app.get("/api/browser/sessions", (_req, res) => {
    res.json(listBrowserSessions());
  });

  app.post("/api/browser/sessions/:key/show", (req, res) => {
    if (!showBrowserSession(req.params.key)) return res.status(404).json({ message: "That agent tab isn't open anymore." });
    res.json({ ok: true });
  });

  app.delete("/api/browser/sessions/:key", (req, res) => {
    closeBrowserSession(req.params.key);
    res.json({ ok: true });
  });

  app.get("/api/godseye/status", async (_req, res) => {
    const url = "http://localhost:4173";
    let live = false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      live = r.ok;
    } catch { /* not running — expected */ }
    res.json({ live, url });
  });

  app.get("/api/system/storage", async (_req, res) => {
    res.json({ drive: getDataDriveStatus(), backups: listBackups().slice(0, 10), backupDir: BACKUP_DIR });
  });

  app.get("/api/system/info", async (_req, res) => {
    const electron = await getElectronApis();
    res.json({
      version: electron?.app.getVersion() ?? "dev",
      // Native folder/file dialogs and the update flow only exist in the
      // installed desktop app — `npm run dev` runs outside Electron entirely.
      electronAvailable: electron !== null,
    });
  });

  app.post("/api/system/pick-folder", async (_req, res) => {
    const electron = await getElectronApis();
    if (!electron) return res.status(501).json({ message: "Folder browsing is only available in the installed desktop app." });
    const result = await electron.dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    res.json({ path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] });
  });

  // Newest "AURORA Setup *.exe" in UPDATE_SOURCE_DIR, or null if there isn't
  // one — shared by the status check and the apply step so both agree on
  // exactly which file "the latest build" means at that moment.
  function findLatestInstaller(): { path: string; mtimeMs: number } | null {
    let entries: string[];
    try { entries = fs.readdirSync(UPDATE_SOURCE_DIR); } catch { return null; }
    const candidates = entries
      .filter((f) => /^AURORA Setup .*\.exe$/i.test(f))
      .map((f) => {
        const full = path.join(UPDATE_SOURCE_DIR, f);
        return { path: full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0] ?? null;
  }

  app.get("/api/system/update-check", async (_req, res) => {
    const electron = await getElectronApis();
    if (!electron) return res.json({ available: false });
    const latest = findLatestInstaller();
    if (!latest) return res.json({ available: false });
    // "Newer than what's running" = newer than the currently-loaded
    // app.asar's own mtime, which gets rewritten by every fresh build+ship.
    let runningMtimeMs = 0;
    try { runningMtimeMs = fs.statSync(electron.app.getAppPath()).mtimeMs; } catch { /* dev/unpacked run, no asar */ }
    const available = latest.mtimeMs > runningMtimeMs + 2000;
    res.json({ available, builtAt: latest.mtimeMs });
  });

  app.post("/api/system/apply-update", async (_req, res) => {
    const electron = await getElectronApis();
    if (!electron) return res.status(501).json({ message: "Updating is only available in the installed desktop app." });
    const latest = findLatestInstaller();
    if (!latest) return res.status(404).json({ message: "No installer found to update from." });
    await storage().log("applying update", latest.path, "ok", "owner");
    // /S = silent NSIS install, no wizard to click through.
    const child = spawn(latest.path, ["/S"], { detached: true, stdio: "ignore" });
    child.unref();
    res.json({ ok: true });
    // Give the response time to actually reach the browser before this
    // process (and every file it has locked) disappears.
    setTimeout(() => electron.app.quit(), 500);
  });

  app.get("/api/ollama/status", async (_req, res) => {
    const config = await storage().getConfig();
    const live = await health(config.ollamaHost);
    const models = live ? await listModels(config.ollamaHost).catch(() => []) : [];
    res.json({ live, host: config.ollamaHost, activeModel: config.model, models });
  });

  // Separate from /status (which is polled every few seconds) since checking
  // vision support means one /api/show call per pulled model — fine
  // occasionally, not fine on a tight poll loop.
  app.get("/api/ollama/vision-models", async (_req, res) => {
    const config = await storage().getConfig();
    const live = await health(config.ollamaHost);
    const models = live ? await listModelsWithVisionFlag(config.ollamaHost).catch(() => []) : [];
    res.json({ models });
  });

  app.post("/api/ollama/pull", async (req, res) => {
    const parsed = ollamaPullSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid model name." });
    const config = await storage().getConfig();
    pullModel(config.ollamaHost, parsed.data.model); // fire and forget — client polls pull-status
    res.json({ started: true });
  });

  app.get("/api/ollama/pull-status", async (req, res) => {
    const model = String(req.query.model ?? "");
    res.json(getPullStatus(model) ?? { status: "idle", done: true });
  });

  // Human-triggered only (the onboarding screen's "Download & Install Ollama"
  // button) — deliberately not an agent tool. Downloads the real installer
  // from ollama.com and opens its own (non-silent) installer window.
  app.post("/api/ollama/install", async (_req, res) => {
    try {
      await downloadAndLaunchOllamaInstaller();
      res.json({ launched: true });
    } catch (err) {
      const message = err instanceof OllamaInstallError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof OllamaInstallError ? 400 : 500).json({ message });
    }
  });

  app.get("/api/imagegen/status", async (_req, res) => {
    const config = await storage().getConfig();
    const live = config.imageGenHost ? await imageGenHealth(config.imageGenHost) : false;
    res.json({ live, host: config.imageGenHost });
  });

  // ---- Local neural voice (Piper) — a nicer-sounding alternative to the
  // browser's built-in SpeechSynthesis, fully offline once downloaded. ----
  app.get("/api/tts/status", async (_req, res) => {
    // Kokoro voices are merged into the same list so every voice picker (not
    // just Settings) can offer them — the long-form video narrator was still
    // handing out flat Piper voices otherwise, which is the exact thing Kokoro
    // was installed to replace. Kokoro needs no per-voice download, so all of
    // them count as installed once the engine is.
    const kokoroInstalled = isKokoroInstalled();
    const kokoroVoices = kokoroInstalled ? KOKORO_VOICES.map((v) => v.id) : [];
    const kokoroCatalog = KOKORO_VOICES.map((v) => ({
      id: v.id, label: `${v.label} (${v.accent}, natural)`, blurb: v.blurb, sizeMb: 0,
    }));
    res.json({
      installed: isPiperEngineInstalled() || kokoroInstalled,
      // Kokoro first — it's the better default, and pickers select index 0.
      voices: [...kokoroVoices, ...installedVoices()],
      catalog: [...kokoroCatalog, ...CURATED_VOICES],
    });
  });

  // Human-triggered only (a Settings button), same reasoning as the Ollama
  // installer — never exposed as an agent tool.
  app.post("/api/tts/install", async (_req, res) => {
    try {
      await downloadAndInstallPiperEngine();
      res.json({ installed: true });
    } catch (err) {
      const message = err instanceof PiperError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof PiperError ? 400 : 500).json({ message });
    }
  });

  app.post("/api/tts/voices/:id/install", async (req, res) => {
    try {
      await downloadVoice(req.params.id);
      res.json({ installed: true });
    } catch (err) {
      const message = err instanceof PiperError ? err.message : (err instanceof Error ? err.message : String(err));
      res.status(err instanceof PiperError ? 400 : 500).json({ message });
    }
  });

  app.post("/api/tts", async (req, res) => {
    const parsed = ttsSpeakSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    const { text, voice, engine, speed } = parsed.data;
    try {
      const wav = engine === "kokoro"
        ? await kokoroSynthesize(text, voice, speed)
        : await synthesize(text, voice);
      res.set("Content-Type", "audio/wav");
      res.send(wav);
    } catch (err) {
      const expected = err instanceof PiperError || err instanceof KokoroError;
      const message = err instanceof Error ? err.message : String(err);
      res.status(expected ? 400 : 500).json({ message });
    }
  });

  // ---- Kokoro-82M — the natural-prosody voice engine. Separate install from
  // Piper (its own Python venv) so having one never implies the other. ----
  app.get("/api/tts/kokoro/status", async (_req, res) => {
    res.json({ installed: isKokoroInstalled(), voices: KOKORO_VOICES, setup: getKokoroSetupStatus() });
  });

  // Human-triggered only (a Settings button), same reasoning as the Piper and
  // Ollama installers — never exposed as an agent tool. Returns immediately;
  // the install runs for several minutes and Settings polls the status route.
  app.post("/api/tts/kokoro/install", async (_req, res) => {
    startKokoroSetup();
    res.json({ started: true });
  });

  // ---- Hearing: local speech-to-text. Deliberately not the browser's
  // SpeechRecognition API, which uploads microphone audio to Google. ----
  app.get("/api/stt/status", async (_req, res) => {
    res.json({ installed: isSttInstalled(), setup: getSttSetupStatus() });
  });

  app.post("/api/stt/install", async (_req, res) => {
    startSttSetup();
    res.json({ started: true });
  });

  app.post("/api/stt", async (req, res) => {
    const parsed = sttTranscribeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request." });
    try {
      const text = await transcribe(Buffer.from(parsed.data.audio, "base64"), parsed.data.ext ?? "webm");
      res.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof SttError ? 400 : 500).json({ message });
    }
  });

  // ---- Local video generation (LTX-Video) — no host to configure like
  // image gen; it's a local Python subprocess whose install state IS its
  // availability, same as Piper. ----
  app.get("/api/videogen/status", async (_req, res) => {
    const gpu = await detectGpu();
    res.json({ installed: isVideoGenInstalled(), gpu, setup: getVideoGenSetupStatus() });
  });

  // Human-triggered only (a Settings button) — never an agent tool. Setup
  // takes several minutes to tens of minutes (PyTorch + repo + deps), so
  // this just kicks it off; the client polls setup-status for progress.
  app.post("/api/videogen/setup", async (_req, res) => {
    startVideoGenSetup();
    res.json({ started: true });
  });

  app.get("/api/videogen/setup-status", async (_req, res) => {
    res.json(getVideoGenSetupStatus());
  });

  // ---- Local AI music generation (ACE-Step) — same install-once-then-spawn
  // shape as video gen. ----
  app.get("/api/musicgen/status", async (_req, res) => {
    res.json({ installed: isMusicGenInstalled(), setup: getMusicGenSetupStatus() });
  });

  app.post("/api/musicgen/setup", async (_req, res) => {
    startMusicGenSetup();
    res.json({ started: true });
  });

  app.get("/api/musicgen/setup-status", async (_req, res) => {
    res.json(getMusicGenSetupStatus());
  });

  // Generate a song and save it as a creation (shows in the Library, plays in
  // the media player). Human-triggered from the Generate tab. Long-running.
  app.post("/api/musicgen/generate", async (req, res) => {
    if (!isMusicGenInstalled()) return res.status(400).json({ message: "Set up local music generation in Settings first." });
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ message: "A style/description prompt is required." });
    const lyrics = typeof req.body?.lyrics === "string" ? req.body.lyrics : "";
    const durationSeconds = Number(req.body?.durationSeconds) || 60;
    const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim() : prompt.slice(0, 80);
    const config = await storage().getConfig();
    try {
      const buf = await generateMusic({ prompt, lyrics, durationSeconds, ollamaHost: config.ollamaHost });
      const filename = `${randomUUID()}.wav`;
      fs.writeFileSync(path.join(getCreationsDir(), filename), buf);
      const creation = await storage().createCreation({ kind: "audio", prompt: `${title} — ${prompt}`, filePath: filename, title });
      await storage().log("generated music (ACE-Step)", title, "ok", "owner");
      res.json(creation);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Local image generation (AUTOMATIC1111 stable-diffusion-webui) — a
  // standing local server (like Ollama), not a per-call subprocess like
  // video gen. imagegen.ts already talks to it over HTTP once it's running;
  // these routes just cover installing it and starting/stopping the server. ----
  app.get("/api/imagegen/setup-status", async (_req, res) => {
    res.json({ installed: isImageGenInstalled(), serverRunning: isImageGenServerRunning(), setup: getImageGenSetupStatus(), defaultHost: imageGenDefaultHost() });
  });

  app.post("/api/imagegen/setup", async (_req, res) => {
    startImageGenSetup();
    res.json({ started: true });
  });

  app.post("/api/imagegen/server/start", async (_req, res) => {
    try {
      const result = startImageGenServer();
      res.json(result);
    } catch (err) {
      res.status(400).json({ message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/imagegen/server/stop", async (_req, res) => {
    res.json(stopImageGenServer());
  });
}
