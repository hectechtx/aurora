import { useEffect, useState } from "react";
import { getToken } from "@/lib/queryClient";

/** Same reasoning as AuthedImage — a plain <video src="/creations/…"> 401s since /creations needs a Bearer header a bare tag can't send. */
export function AuthedVideo({ src, className, muted = true, loop = true, autoPlay }: {
  src: string; className?: string; muted?: boolean; loop?: boolean; autoPlay?: boolean;
}) {
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
  return <video src={objectUrl} className={className} controls muted={muted} loop={loop} autoPlay={autoPlay} />;
}
