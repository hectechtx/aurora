// Thin client for a local Automatic1111/ComfyUI-style Stable Diffusion
// server. Same spirit as ollama.ts: no API keys, nothing hosted — if you
// don't have one of these running, image generation just reports
// unavailable rather than falling back to a paid API.

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Image gen server ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function health(host: string): Promise<boolean> {
  if (!host) return false;
  try {
    await fetchJson(`${host}/sdapi/v1/sd-models`, undefined, 3_000);
    return true;
  } catch {
    return false;
  }
}

export interface GeneratedImage {
  pngBuffer: Buffer;
}

/** Automatic1111's txt2img endpoint. Returns the first generated image as a PNG buffer. */
export async function generateImage(host: string, prompt: string): Promise<GeneratedImage> {
  const data = await fetchJson(`${host}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, steps: 20, width: 512, height: 512, sampler_name: "Euler a" }),
  }, 180_000);

  const images: string[] = data.images ?? [];
  if (!images.length) throw new Error("Image gen server returned no images.");
  return { pngBuffer: Buffer.from(images[0], "base64") };
}
