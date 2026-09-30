// Lets AURORA speak of her own accord, not just as narration of a reply.
//
// The browser is the only thing that can actually play audio, but most of the
// moments worth speaking happen server-side with no page interaction to hang
// off: a scheduled agent tick finishing something, an agent posting a question
// to the Outbox, AURORA deciding mid-task that a result is worth saying out
// loud. Those have no open request to return audio on.
//
// So utterances land in a short queue here and the client drains it on a
// timer. Deliberately in-memory and not persisted: speech is a live event, and
// a queue that survived restarts would mean the app suddenly narrating things
// that happened hours ago on next launch.
import { log } from "./app";

export interface Utterance {
  id: number;
  text: string;
  /** Who's speaking — the client shows this and can pick a per-agent voice later. */
  speaker: string;
  createdAt: number;
}

// Small on purpose. If nothing has drained the queue, the owner almost
// certainly isn't listening, and a backlog of stale narration is worse than
// silence.
const MAX_QUEUED = 8;
// Anything older than this is dropped rather than spoken — see above.
const MAX_AGE_MS = 2 * 60 * 1000;

let nextId = 1;
let queue: Utterance[] = [];

/** Queues something for the client to speak. Returns the utterance so callers can log what was said. */
export function say(text: string, speaker = "AURORA"): Utterance | null {
  const clean = text.trim();
  if (!clean) return null;
  // Long monologues are unpleasant to listen to and block the queue; the full
  // text is always in the transcript anyway.
  const capped = clean.length > 600 ? `${clean.slice(0, 600)}…` : clean;

  const utterance: Utterance = { id: nextId++, text: capped, speaker, createdAt: Date.now() };
  queue.push(utterance);
  if (queue.length > MAX_QUEUED) queue = queue.slice(-MAX_QUEUED);
  log(`speech: queued from ${speaker} — "${capped.slice(0, 60)}${capped.length > 60 ? "…" : ""}"`);
  return utterance;
}

/** Returns everything pending and clears the queue — the client is expected to actually play these. Stale entries are discarded rather than handed over. */
export function drain(): Utterance[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh = queue.filter((u) => u.createdAt >= cutoff);
  queue = [];
  return fresh;
}
