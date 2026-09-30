// Spoken replies, three engines, in ascending order of how human they sound:
//  - "browser": the OS/browser's built-in SpeechSynthesis — zero setup, but
//    on Windows this is usually the old flat SAPI voices (David/Zira/Mark).
//  - "piper": a local neural TTS engine (github.com/rhasspy/piper) — clearer
//    than SAPI and instant to synthesize, but its prosody is uniform, which
//    is what reads as "robotic" over a long reply.
//  - "kokoro": Kokoro-82M — real phrase stress, question contours and pacing.
//    Runs on CPU in its own Python venv so it never competes with Ollama for
//    VRAM. See server/kokoro.ts.
// All three are fully offline; the latter two download once from Settings.
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { getToken } from "./queryClient";

const ENABLED_KEY = "aurora-voice-enabled";
const VOICE_KEY = "aurora-voice-uri";
const ENGINE_KEY = "aurora-voice-engine";
const PIPER_VOICE_KEY = "aurora-piper-voice";
const KOKORO_VOICE_KEY = "aurora-kokoro-voice";
const KOKORO_SPEED_KEY = "aurora-kokoro-speed";

export type VoiceEngine = "browser" | "piper" | "kokoro";

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "")
    .trim();
}

function pickDefaultVoice(voices: SpeechSynthesisVoice[]): string | null {
  const preferred = ["aria", "jenny", "zira", "samantha", "victoria", "female", "google us english"];
  for (const name of preferred) {
    const match = voices.find((v) => v.lang.startsWith("en") && v.name.toLowerCase().includes(name));
    if (match) return match.voiceURI;
  }
  const english = voices.find((v) => v.lang.startsWith("en"));
  return english?.voiceURI ?? voices[0]?.voiceURI ?? null;
}

interface VoiceContextValue {
  supported: boolean;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  engine: VoiceEngine;
  setEngine: (e: VoiceEngine) => void;
  voices: SpeechSynthesisVoice[];
  voiceURI: string | null;
  setVoiceURI: (v: string) => void;
  piperVoice: string | null;
  setPiperVoice: (v: string) => void;
  kokoroVoice: string | null;
  setKokoroVoice: (v: string) => void;
  kokoroSpeed: number;
  setKokoroSpeed: (v: number) => void;
  speak: (text: string) => void;
  stop: () => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoice must be used within VoiceProvider");
  return ctx;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [enabled, setEnabledState] = useState(() => typeof window !== "undefined" && localStorage.getItem(ENABLED_KEY) === "true");
  const [engine, setEngineState] = useState<VoiceEngine>(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(ENGINE_KEY) : null;
    return stored === "piper" || stored === "kokoro" ? stored : "browser";
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURIState] = useState<string | null>(() => (typeof window !== "undefined" ? localStorage.getItem(VOICE_KEY) : null));
  const [piperVoice, setPiperVoiceState] = useState<string | null>(() => (typeof window !== "undefined" ? localStorage.getItem(PIPER_VOICE_KEY) : null));
  // af_heart is Kokoro's highest-graded voice, so a fresh install speaks well
  // without the owner having to go pick one first.
  const [kokoroVoice, setKokoroVoiceState] = useState<string | null>(() => (typeof window !== "undefined" ? localStorage.getItem(KOKORO_VOICE_KEY) ?? "af_heart" : "af_heart"));
  const [kokoroSpeed, setKokoroSpeedState] = useState<number>(() => {
    const stored = typeof window !== "undefined" ? Number(localStorage.getItem(KOKORO_SPEED_KEY)) : NaN;
    return Number.isFinite(stored) && stored > 0 ? stored : 1;
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!supported) return;
    function loadVoices() {
      const list = window.speechSynthesis.getVoices();
      if (list.length) {
        setVoices(list);
        setVoiceURIState((current) => current ?? pickDefaultVoice(list));
      }
    }
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [supported]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      URL.revokeObjectURL(audioRef.current.src);
      audioRef.current = null;
    }
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    localStorage.setItem(ENABLED_KEY, String(v));
    if (!v) {
      if (supported) window.speechSynthesis.cancel();
      stopAudio();
    }
  }, [supported, stopAudio]);

  const setEngine = useCallback((e: VoiceEngine) => {
    setEngineState(e);
    localStorage.setItem(ENGINE_KEY, e);
    if (supported) window.speechSynthesis.cancel();
    stopAudio();
  }, [supported, stopAudio]);

  const setVoiceURI = useCallback((v: string) => {
    setVoiceURIState(v);
    localStorage.setItem(VOICE_KEY, v);
  }, []);

  const setPiperVoice = useCallback((v: string) => {
    setPiperVoiceState(v);
    localStorage.setItem(PIPER_VOICE_KEY, v);
  }, []);

  const setKokoroVoice = useCallback((v: string) => {
    setKokoroVoiceState(v);
    localStorage.setItem(KOKORO_VOICE_KEY, v);
  }, []);

  const setKokoroSpeed = useCallback((v: number) => {
    setKokoroSpeedState(v);
    localStorage.setItem(KOKORO_SPEED_KEY, String(v));
  }, []);

  const speak = useCallback((text: string) => {
    const clean = cleanForSpeech(text);
    if (!clean) return;

    // Both neural engines share one endpoint and differ only in the body —
    // the server picks the backend from `engine`.
    if (engine === "piper" || engine === "kokoro") {
      const voice = engine === "kokoro" ? kokoroVoice : piperVoice;
      if (!voice) return;
      stopAudio();
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken() ?? ""}` },
        body: JSON.stringify(
          engine === "kokoro"
            ? { text: clean, voice, engine, speed: kokoroSpeed }
            : { text: clean, voice },
        ),
      })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.play().catch(() => {});
        })
        .catch(() => {});
      return;
    }

    if (!supported) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    const voice = voices.find((v) => v.voiceURI === voiceURI);
    if (voice) utter.voice = voice;
    utter.rate = 1.02;
    utter.pitch = 1.05;
    window.speechSynthesis.speak(utter);
  }, [engine, piperVoice, kokoroVoice, kokoroSpeed, voices, voiceURI, supported, stopAudio]);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    stopAudio();
  }, [supported, stopAudio]);

  return (
    <VoiceContext.Provider value={{
      supported, enabled, setEnabled, engine, setEngine, voices, voiceURI, setVoiceURI,
      piperVoice, setPiperVoice, kokoroVoice, setKokoroVoice, kokoroSpeed, setKokoroSpeed, speak, stop,
    }}>
      {children}
    </VoiceContext.Provider>
  );
}
