// A Telegram remote for music search: text the bot a song from your phone,
// pick from the results, and the mp3 lands in the same downloads folder the
// music player already reads.
//
// Two deliberate departures from the n8n bot this idea came from
// (github.com/BitOpenCode/Pocket-Sound-V2-n8n-Telegram):
//
//   1. LONG POLLING, NOT WEBHOOKS. Webhooks need a public HTTPS URL pointing
//      at your machine — port forwarding, a domain, a certificate. AURORA runs
//      on a home PC behind NAT (often double-NAT), where that's painful and
//      fragile. getUpdates makes only OUTBOUND requests, so it works from any
//      network with zero inbound connectivity and nothing exposed.
//
//   2. SINGLE OWNER, NO TIERS. The upstream is a multi-user service with
//      referrals, paid tiers and an admin panel. This is a remote control for
//      one person's own app: every update is checked against one numeric
//      Telegram user id and silently dropped otherwise. Anyone can find a bot
//      by username and message it — without that check this would be an open
//      downloader for the whole internet.
import { searchTracks, downloadTrackById, isYtDlpInstalled, MusicSearchError, type TrackCandidate } from "./musicsearch";
import type { Storage } from "./storage-types";

const API = "https://api.telegram.org";

/** Telegram long-poll holds the connection this long before returning empty. */
const POLL_TIMEOUT_S = 50;
/** Backoff after a network error, so a dropped link doesn't spin the CPU. */
const ERROR_BACKOFF_MS = 5_000;

let running = false;
let stopRequested = false;

/** Search results per chat, so a button press knows what "#2" meant. */
const lastResults = new Map<number, TrackCandidate[]>();

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

async function tg(token: string, method: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.result;
}

function send(token: string, chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

function fmtDuration(seconds: number): string {
  if (!seconds) return "?:??";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/**
 * Results as a numbered list plus one button per track. Buttons carry the
 * LIST INDEX, not the video id: Telegram caps callback_data at 64 bytes and
 * ids can be long, so the id is looked up from `lastResults` on press.
 */
function resultsKeyboard(tracks: TrackCandidate[]) {
  return {
    inline_keyboard: tracks.map((t, i) => [{
      text: `${i + 1}. ${t.title.slice(0, 40)}${t.title.length > 40 ? "…" : ""}`,
      callback_data: `dl:${i}`,
    }]),
  };
}

async function handleSearch(token: string, chatId: number, query: string) {
  if (!isYtDlpInstalled()) {
    return send(token, chatId, "Music search isn't set up yet — install it in AURORA's Settings first.");
  }
  await send(token, chatId, `🔎 Searching for <b>${escapeHtml(query)}</b>…`);
  try {
    const tracks = await searchTracks(query, 8);
    if (!tracks.length) return send(token, chatId, "Nothing found. Try a different wording.");
    lastResults.set(chatId, tracks);
    const list = tracks
      .map((t, i) => `${i + 1}. <b>${escapeHtml(t.title)}</b>\n    ${escapeHtml(t.uploader || "unknown")} · ${fmtDuration(t.duration)}`)
      .join("\n");
    await send(token, chatId, `Pick one:\n\n${list}`, { reply_markup: resultsKeyboard(tracks) });
  } catch (err) {
    const msg = err instanceof MusicSearchError ? err.message : String(err);
    await send(token, chatId, `❌ ${escapeHtml(msg)}`);
  }
}

async function handleDownload(token: string, chatId: number, index: number) {
  const tracks = lastResults.get(chatId);
  const track = tracks?.[index];
  if (!track) {
    return send(token, chatId, "That result list has expired — search again.");
  }
  await send(token, chatId, `⬇️ Downloading <b>${escapeHtml(track.title)}</b>…`);
  try {
    const done = await downloadTrackById(track.id);
    await send(token, chatId, `✅ Saved <b>${escapeHtml(done.title)}</b>\nIt's in your music folder now.`);
  } catch (err) {
    const msg = err instanceof MusicSearchError ? err.message : String(err);
    await send(token, chatId, `❌ Download failed: ${escapeHtml(msg)}`);
  }
}

async function handleUpdate(token: string, ownerId: string, update: TgUpdate) {
  // Every path is gated on the owner id. A bot responds to anyone who finds
  // its username, so unknown senders are dropped without a reply — answering
  // "access denied" would confirm the bot exists and invite probing.
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (!fromId || String(fromId) !== ownerId) return;

  if (update.callback_query) {
    const cq = update.callback_query;
    // Always answer, or the client shows a spinner until it times out.
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    const chatId = cq.message?.chat.id;
    const m = /^dl:(\d+)$/.exec(cq.data ?? "");
    if (chatId && m) await handleDownload(token, chatId, Number(m[1]));
    return;
  }

  const text = update.message?.text?.trim();
  const chatId = update.message?.chat.id;
  if (!text || !chatId) return;

  if (text === "/start" || text === "/help") {
    return send(token, chatId,
      "🎵 <b>AURORA music remote</b>\n\n" +
      "Send me a song name or artist and I'll search, then tap a result to download it " +
      "straight into your music folder.\n\n" +
      "Commands:\n/start — this message\n/status — check the downloader");
  }
  if (text === "/status") {
    return send(token, chatId, isYtDlpInstalled()
      ? "✅ Downloader is installed and ready."
      : "⚠️ yt-dlp isn't installed — set up music search in AURORA's Settings.");
  }
  if (text.startsWith("/")) {
    return send(token, chatId, "Unknown command. Just send a song name to search.");
  }
  await handleSearch(token, chatId, text);
}

/**
 * Boots the poller if a token AND an owner id are configured. Safe to call on
 * every startup — it no-ops when unconfigured or already running.
 */
export function startTelegramBot(storage: Storage): void {
  if (running) return;
  running = true;
  stopRequested = false;
  void pollLoop(storage).finally(() => { running = false; });
}

export function stopTelegramBot(): void {
  stopRequested = true;
}

async function pollLoop(storage: Storage): Promise<void> {
  let offset = 0;
  let announced = false;

  while (!stopRequested) {
    let token = "";
    let ownerId = "";
    try {
      const cfg = await storage.getConfig();
      token = (cfg.telegramBotToken ?? "").trim();
      ownerId = (cfg.telegramOwnerId ?? "").trim();
    } catch {
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    // Re-read config each pass so connecting the bot in Settings takes effect
    // without restarting AURORA — and disconnecting it stops the loop cold.
    if (!token || !ownerId) {
      announced = false;
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (!announced) {
      console.log("[aurora] telegram music remote is listening");
      announced = true;
    }

    try {
      const updates: TgUpdate[] = await tg(token, "getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        // One bad update must not kill the loop.
        await handleUpdate(token, ownerId, u).catch((err) => {
          console.error(`[aurora] telegram update failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      console.error(`[aurora] telegram poll failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
