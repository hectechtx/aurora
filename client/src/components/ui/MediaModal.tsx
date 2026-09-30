import { useEffect } from "react";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { AuthedVideo } from "@/components/ui/AuthedVideo";
import { X } from "lucide-react";

/** Full-screen in-app viewer for a creation — a proper video player (seek/volume/fullscreen via native controls) or a lightbox for images, instead of opening a blob URL in a new browser tab. */
export function MediaModal({ kind, src, caption, onClose }: {
  kind: "image" | "video";
  src: string;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm p-6 animate-in"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="absolute top-4 right-4 h-9 w-9 rounded-full bg-card border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <X size={18} />
      </button>
      <div className="max-w-5xl max-h-[85vh] w-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        {kind === "image" && (
          <AuthedImage src={src} alt={caption ?? ""} className="max-h-[75vh] w-auto max-w-full rounded-lg border border-border object-contain" />
        )}
        {kind === "video" && (
          <AuthedVideo src={src} muted={false} loop={false} autoPlay className="max-h-[75vh] w-auto max-w-full rounded-lg border border-border" />
        )}
        {caption && <p className="text-sm text-muted-foreground text-center max-w-2xl">{caption}</p>}
      </div>
    </div>
  );
}
