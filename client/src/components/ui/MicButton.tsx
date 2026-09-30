// Push-to-talk dictation. Records from the microphone with MediaRecorder,
// posts the clip to /api/stt, and hands back the transcript for the composer
// to drop into its input.
//
// Note this deliberately does NOT use the browser's SpeechRecognition API,
// which would be far less code — in Chromium that API streams your microphone
// to Google's servers. Recording locally and transcribing with the local
// Whisper model (server/stt.ts) keeps AURORA's promise that nothing said to
// her leaves this machine.
import { useCallback, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getToken } from "@/lib/queryClient";

interface MicButtonProps {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  className?: string;
  disabled?: boolean;
}

type State = "idle" | "recording" | "transcribing";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // result is a data URL; strip the "data:...;base64," prefix.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the recording."));
    reader.readAsDataURL(blob);
  });
}

export function MicButton({ onTranscript, onError, className, disabled }: MicButtonProps) {
  const [state, setState] = useState<State>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const fail = useCallback((message: string) => {
    setState("idle");
    onError?.(message);
  }, [onError]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    // Release the mic so the OS recording indicator goes away immediately
    // rather than lingering for the length of the transcription.
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 1000) return setState("idle"); // barely-there tap, nothing said
        setState("transcribing");
        try {
          const res = await fetch("/api/stt", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken() ?? ""}` },
            body: JSON.stringify({ audio: await blobToBase64(blob), ext: "webm" }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || "Transcription failed.");
          setState("idle");
          if (data.text?.trim()) onTranscript(data.text.trim());
        } catch (err) {
          fail(err instanceof Error ? err.message : "Transcription failed.");
        }
      };

      recorder.start();
      setState("recording");
    } catch {
      fail("Couldn't reach the microphone — check that AURORA is allowed to use it.");
    }
  }, [onTranscript, fail]);

  const busy = state === "transcribing";

  return (
    <button
      type="button"
      onClick={() => (state === "recording" ? stop() : start())}
      disabled={disabled || busy}
      aria-label={state === "recording" ? "Stop recording" : "Dictate a message"}
      title={state === "recording" ? "Stop and transcribe" : "Speak instead of typing"}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors duration-150 shrink-0",
        state === "recording"
          ? "border-destructive bg-destructive/10 text-destructive animate-pulse"
          : "border-border text-muted-foreground hover:bg-surface hover:text-foreground",
        (disabled || busy) && "opacity-60 cursor-not-allowed",
        className,
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : state === "recording" ? <Square size={13} /> : <Mic size={15} />}
    </button>
  );
}
