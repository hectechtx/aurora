// A local single-user PIN gate — not a real multi-user auth system. The
// threat model is "someone else on this machine, or (before the localhost
// binding fix) this network" — not a hostile internet. No usernames, no
// password-reset flow: if you forget your PIN, clear the pinHash/pinSalt
// columns in the DB (or reinstall) and set a new one.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getStorage } from "./storage";

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const candidate = scryptSync(pin, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

// In-memory session store — intentionally not persisted. AURORA is a
// long-running desktop process; if it restarts, re-entering the PIN once is
// a fine tradeoff for not having session tokens sitting in the database.
const sessions = new Map<string, number>(); // token -> createdAt
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, Date.now());
  return token;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const createdAt = sessions.get(token);
  if (createdAt === undefined) return false;
  if (Date.now() - createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function tokenFromRequest(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/** Gates every /api/* route except the auth routes themselves (registered before this middleware). */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const config = await getStorage().getConfig();
  if (!config.pinHash) {
    res.status(428).json({ message: "No PIN set yet — complete first-run setup first.", pinSet: false });
    return;
  }
  if (!isValidSession(tokenFromRequest(req))) {
    res.status(401).json({ message: "Not signed in." });
    return;
  }
  next();
}
