import { useEffect, useState } from "react";
import { getToken } from "@/lib/queryClient";

/**
 * <img src="/creations/…"> alone 401s — /creations is behind requireAuth
 * (bearer token only, no cookie fallback) and a plain <img> tag can't send
 * an Authorization header. This fetches the bytes with the token and hands
 * the browser an object URL instead.
 */
export function AuthedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
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

  if (!objectUrl) return <div className={className} aria-label={alt} />;
  return <img src={objectUrl} alt={alt} className={className} />;
}
