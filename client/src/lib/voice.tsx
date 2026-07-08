// Real spoken replies via the browser's built-in text-to-speech
// (SpeechSynthesis) — free, local, no API keys. Voice quality/selection
// depends entirely on what your OS/browser ships (Windows + Edge tends to
// have good neural voices like "Aria" or "Jenny").
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { ReactNode } from "react";

const ENABLED_KEY = "aurora-voice-enabled";
const VOICE_KEY = "aurora-voice-uri";

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
  voices: SpeechSynthesisVoice[];
  voiceURI: string | null;
  setVoiceURI: (v: string) => void;
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
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURIState] = useState<string | null>(() => (typeof window !== "undefined" ? localStorage.getItem(VOICE_KEY) : null));

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

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    localStorage.setItem(ENABLED_KEY, String(v));
    if (!v && supported) window.speechSynthesis.cancel();
  }, [supported]);

  const setVoiceURI = useCallback((v: string) => {
    setVoiceURIState(v);
    localStorage.setItem(VOICE_KEY, v);
  }, []);

  const speak = useCallback((text: string) => {
    if (!supported) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    const voice = voices.find((v) => v.voiceURI === voiceURI);
    if (voice) utter.voice = voice;
    utter.rate = 1.02;
    utter.pitch = 1.05;
    window.speechSynthesis.speak(utter);
  }, [voices, voiceURI, supported]);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  return (
    <VoiceContext.Provider value={{ supported, enabled, setEnabled, voices, voiceURI, setVoiceURI, speak, stop }}>
      {children}
    </VoiceContext.Provider>
  );
}
