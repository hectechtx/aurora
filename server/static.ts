import express from "express";
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { STATIC_DIR } from "./paths";

export function serveStatic(app: Express) {
  const distPath = STATIC_DIR;
  if (!fs.existsSync(distPath)) {
    throw new Error(`Could not find the build directory: ${distPath} — run "npm run build" first.`);
  }

  app.use(express.static(distPath));
  app.use(/.*/, (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
