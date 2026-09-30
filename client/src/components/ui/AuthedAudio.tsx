import { useEffect, useState } from "react";
import { getToken } from "@/lib/queryClient";

/** Same reasoning as AuthedVideo/AuthedImage — a bare <audio src="/creations/…"> 401s because /creations needs a Bearer header a plain tag can't send, so fetch it with the token and play the blob. */
export function AuthedAudio({ src, className }: { src: string; className?: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetch(src, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);

  if (!objectUrl) return <div className={className} />;
  return <audio src={objectUrl} className={className} controls />;
}
