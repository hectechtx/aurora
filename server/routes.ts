import express from "express";
import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { getStorage } from "./storage";
import { runAgentTurn, runAgentTick, resumeAfterApproval } from "./agent-loop";
import { installSkillFromGitHub, InstallError } from "./skills/installer";
import { activateSkill, rejectSkillInstall, disableSkill, enableSkill, deleteSkillCompletely } from "./skills/lifecycle";
import { health, listModels, pullModel, getPullStatus } from "./ollama";
import { health as imageGenHealth } from "./imagegen";
import { executeCommand } from "./shell-exec";
import { hashPin, verifyPin, createSession, destroySession, requireAuth, tokenFromRequest, isValidSession } from "./auth";
import {
  taskCreateSchema, taskUpdateSchema, chatSendSchema, skillInstallSchema, approvalDecisionSchema,
  agentConfigUpdateSchema, ollamaPullSchema, terminalRequestSchema,
  agentCreateSchema, agentUpdateSchema, agentQueueItemCreateSchema, deliverableUpdateSchema,
  authSetupSchema, authLoginSchema, authChangePinSchema,
} from "@shared/schema";
import { CREATIONS_DIR } from "./paths";

/** Parses a route :id param, writing a 400 and returning null if it isn't a real integer — a malformed/non-numeric id would otherwise flow into a Drizzle query as NaN. */
function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: "Invalid id." });
    return null;
  }
  return id;
}

export async function registerRoutes(_httpServer: Server, app: Express): Promise<void> {
  const storage = getStorage;

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
  app.use("/creations", requireAuth, express.static(CREATIONS_DIR));

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
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    await storage().deleteTask(id);
    res.json({ ok: true });
  });

  app.get("/api/tasks/:id/messages", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getChatMessages(id));
  });

  app.post("/api/tasks/:id/chat", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const parsed = chatSendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid message." });
    try {
      const result = await runAgentTurn(id, parsed.data.message);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
    }
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

      const result = await resumeAfterApproval(id, parsed.data.status);
      res.json({ result });
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
    const agent = await storage().createAgent({
      name: parsed.data.name, persona: parsed.data.persona, jobDescription: parsed.data.jobDescription,
      scheduleMinutes: parsed.data.scheduleMinutes ?? null,
    });
    await storage().log(`agent created: ${agent.name}`, agent.jobDescription.slice(0, 200), "ok", "owner");
    res.json(agent);
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

  app.get("/api/agents/:id/log", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    res.json(await storage().getAgentLog(id));
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
    const item = await storage().createQueueItem(id, parsed.data.content);
    res.json(item);
  });

  app.get("/api/agents/:id/memory", async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json(await storage().getNotes(query, 200, id));
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
    res.json(await storage().updateConfig(parsed.data));
  });

  app.get("/api/ollama/status", async (_req, res) => {
    const config = await storage().getConfig();
    const live = await health(config.ollamaHost);
    const models = live ? await listModels(config.ollamaHost).catch(() => []) : [];
    res.json({ live, host: config.ollamaHost, activeModel: config.model, models });
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

  app.get("/api/imagegen/status", async (_req, res) => {
    const config = await storage().getConfig();
    const live = config.imageGenHost ? await imageGenHealth(config.imageGenHost) : false;
    res.json({ live, host: config.imageGenHost });
  });
}
