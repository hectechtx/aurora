// One 12GB card, two kinds of work: the language model (agents thinking) and
// heavy media jobs (images, Wan video, HuMo talking clips, music). When both
// run at once neither fits in VRAM and everything crawls (a HuMo step went
// from ~10s to ~85s). So heavy jobs take the GPU exclusively, one at a time,
// and while one runs, local LLM calls either go to a free cloud provider
// (cloud-llm.ts) or wait their turn.

let holder: string | null = null;
let since = 0;
const queue: (() => void)[] = [];

export function gpuHeavyBusy(): boolean { return holder !== null; }
export function gpuStatus(): { busy: boolean; job: string | null; since: number | null; waiting: number } {
  return { busy: holder !== null, job: holder, since: holder ? since : null, waiting: queue.length };
}

/** Runs a heavy GPU job with the card to itself (FIFO behind any job already running). */
export async function withHeavyGpu<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (holder !== null) await new Promise<void>((resolve) => queue.push(resolve));
  holder = label;
  since = Date.now();
  try {
    return await fn();
  } finally {
    holder = null;
    const next = queue.shift();
    if (next) next();
  }
}

/** Waits until no heavy job holds the GPU (or the timeout passes — a stuck job must never freeze the agents forever). */
export async function waitForGpu(maxMs = 45 * 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (holder !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
}
