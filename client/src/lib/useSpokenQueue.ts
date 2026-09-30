// Plays whatever AURORA decided to say of her own accord.
//
// The speak tool (see server/speech.ts) queues utterances server-side because
// the moments worth speaking — a scheduled agent finishing something, a
// question landing in the Outbox — happen with no open UI turn to return audio
// on. This hook drains that queue and speaks it.
//
// Mounted once at the app shell rather than per-page, so she can talk on any
// tab, and keeps talking while the owner is looking at something else.
import { useEffect, useRef } from "react";
import { useVoice } from "./voice";
import { getToken } from "./queryClient";

interface Utterance { id: number; text: string; speaker: string; createdAt: number }

const POLL_MS = 4000;

export function useSpokenQueue(): void {
  const voice = useVoice();
  // Held in a ref so the polling effect doesn't tear down and restart every
  // time the voice settings change — restarting mid-drain could drop an
  // utterance, and the endpoint is destructive so it would be gone for good.
  const speakRef = useRef(voice.speak);
  speakRef.current = voice.speak;

  const enabledRef = useRef(voice.enabled);
  enabledRef.current = voice.enabled;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        // Don't drain while muted: the queue is destructive, so polling with
        // voice off would silently discard everything she tried to say. Better
        // to leave it queued (it ages out on its own) and just not ask.
        if (enabledRef.current) {
          const res = await fetch("/api/speech/pending", {
            headers: { Authorization: `Bearer ${getToken() ?? ""}` },
          });
          if (res.ok) {
            const data: { utterances?: Utterance[] } = await res.json();
            for (const u of data.utterances ?? []) speakRef.current(u.text);
          }
        }
      } catch {
        // Offline, logged out, or mid drive-dropout — just try again next tick.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    timer = setTimeout(poll, POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
}
