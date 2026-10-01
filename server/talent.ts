// AURORA Talent: the virtual creators (VTubers / virtual influencers). Each
// talent is an original character with a fixed look, voice and niche, a
// character sheet (portrait, full body, expressions) in the house
// semi-realistic 3D style, and an agent who "is" them and writes their
// content. talentVideo() turns a script into a vertical video of the talent
// actually saying it — lip-synced with HuMo when installed, otherwise an
// animated portrait under the voiceover — with burned-in captions.
//
// Characters are always original — never modelled on a real person.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, getCreationsDir } from "./paths";
import { getStorage } from "./storage";
import { generateImage } from "./imagegen";
import { synthesize, KOKORO_VOICES } from "./kokoro";
import { runFfmpeg, wavDurationSeconds, captionsSrt } from "./storyboard";
import { isHumoInstalled, generateHumoClip, HUMO_MAX_SECONDS } from "./humo";
import { isWanInstalled, generateWanVideo } from "./wanvideo";

export interface Talent {
  slug: string;
  name: string;          // on-screen name
  agentName: string;     // the agent who plays them
  niche: string;
  tagline: string;
  look: string;          // appearance for the image model (weighted skin/hair)
  voice: string;         // Kokoro voice id
  setting: string;       // where their videos are filmed
  portrait?: string;     // Library filenames
  fullBody?: string;
  expressions?: string[];
}

const FILE = path.join(DATA_DIR, "talent.json");

/** The founding roster. Looks are original characters in the house 3D style. */
const DEFS: Talent[] = [
  {
    slug: "melly", name: "Melly King", agentName: "Melly King", niche: "Gaming & pop culture VTuber",
    tagline: "Bright, clumsy, unstoppable — gaming news, hot takes and chaotic fun.",
    look: "", voice: "af_sky", setting: "in a cozy gaming streaming room with soft purple and teal LED lights and a microphone",
  },
  {
    slug: "sienna", name: "Sienna Bloom", agentName: "Sienna Bloom", niche: "Lifestyle & wellness",
    tagline: "Cozy routines, real-life tips and small wins, every day.",
    look: "young woman in her mid 20s, (warm medium brown skin:1.4), (long curly auburn hair:1.3), hazel eyes, gold hoop earrings, cream chunky knit sweater",
    voice: "af_bella", setting: "in a bright airy apartment with plants and warm morning sunlight",
  },
  {
    slug: "juno", name: "Juno Wave", agentName: "Juno Wave", niche: "Music & dance",
    tagline: "New sounds, dance challenges and behind-the-beat stories with AURORA Records.",
    look: "young man in his early 20s, (light brown skin:1.4), (short silver-dyed twists:1.3), dark brown eyes, small silver earring, oversized teal bomber jacket over a white tee",
    voice: "am_puck", setting: "in a small music studio with a keyboard, speakers and neon lights",
  },
  {
    slug: "tia", name: "Tia Tea", agentName: "Tia Tea", niche: "Story time: gossip & viral news",
    tagline: "Grab your cup — Tia spills today's viral stories, with receipts.",
    look: "young woman in her mid 20s, (deep brown skin:1.45), (long black box braids with gold cuffs:1.35), bright brown eyes, glossy lips, lilac satin blouse",
    voice: "af_heart", setting: "on a pastel pink couch in a cozy living room, holding a teacup",
  },
];

export const TALENT_STYLE =
  "Stylized realistic 3D character render, solo, one person only, soft even studio lighting, plain neutral gray backdrop, high detail, " +
  "clean modern 3D character art, semi-realistic skin and finely detailed hair";
const NEGATIVE = "anime, cartoon, flat 2d illustration, comic, lowres, blurry, watermark, text, logo, deformed, extra fingers, bad anatomy, two people, multiple faces, nude";

export function getTalents(): Talent[] {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Talent[]; } catch { return []; }
}

function saveTalents(list: Talent[]): void {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function updateTalent(slug: string, patch: Partial<Talent>): Talent | undefined {
  const list = getTalents();
  const t = list.find((x) => x.slug === slug);
  if (!t) return undefined;
  Object.assign(t, patch);
  saveTalents(list);
  return t;
}

/** Adds any founding talent that's missing (safe to run on every start). */
export function ensureTalents(): void {
  const list = getTalents();
  let changed = false;
  for (const d of DEFS) if (!list.some((t) => t.slug === d.slug)) { list.push({ ...d }); changed = true; }
  if (changed) saveTalents(list);
}

export function findTalent(q: string): Talent | undefined {
  const s = q.trim().toLowerCase();
  return getTalents().find((t) => t.slug === s || t.name.toLowerCase() === s || t.agentName.toLowerCase() === s || t.name.toLowerCase().split(" ")[0] === s);
}

export function describeTalents(): string {
  return getTalents().map((t) =>
    `- ${t.name} (${t.niche}) — "${t.tagline}" Voice ${t.voice}. Character sheet: ${t.portrait ? `portrait ${t.portrait}${t.fullBody ? `, full body ${t.fullBody}` : ""}${t.expressions?.length ? `, ${t.expressions.length} expressions` : ""}` : "NOT made yet (use create_talent_sheet)"}.`,
  ).join("\n");
}

/** Reads a look off an existing portrait with the vision model (for talents who are existing agents). */
async function lookFromPortrait(ollamaHost: string, model: string, png: Buffer): Promise<string> {
  const res = await fetch(`${ollamaHost}/api/chat`, {
    method: "POST", signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model, stream: false, think: false,
      messages: [{ role: "user", images: [png.toString("base64")], content:
        "Describe this character's appearance for a 3D artist in ONE sentence of comma-separated traits: gender presentation, apparent age, hair color and hairstyle, skin tone, eye color, clothing and its colors, accessories. No names, no art style words, no background." }],
    }),
  });
  const j = (await res.json()) as any;
  const desc = String(j.message?.content ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const skin = desc.match(/[A-Za-z -]*skin(?: tone)?/i)?.[0].trim();
  const hair = desc.match(/[A-Za-z -]*hair/i)?.[0].trim();
  return [skin && `(${skin}:1.4)`, hair && `(${hair}:1.3)`, desc].filter(Boolean).join(", ");
}

async function saveImageCreation(buf: Buffer, prompt: string, title: string, agentId?: number): Promise<{ filename: string; id: number }> {
  const filename = `talent-${randomUUID()}.png`;
  fs.writeFileSync(path.join(getCreationsDir(), filename), buf);
  const c = await getStorage().createCreation({ kind: "image", prompt: prompt.slice(0, 1000), filePath: filename, title, agentId });
  return { filename, id: c.id };
}

/**
 * Builds (or completes) a talent's character sheet: portrait, full body and
 * four expressions, all saved to the Library. The talent's agent gets the
 * portrait as their avatar so they look the same everywhere.
 */
export async function createTalentSheet(t: Talent, opts: { imageHost: string; ollamaHost: string; visionModel: string }): Promise<string> {
  const storage = getStorage();
  const agent = (await storage.getAgents()).find((a) => a.name.trim().toLowerCase() === t.agentName.toLowerCase());
  const made: string[] = [];
  let look = t.look;
  let portrait: Buffer | null = t.portrait ? fs.readFileSync(path.join(getCreationsDir(), t.portrait)) : null;

  if (!portrait && agent?.avatarPath && !look) {
    // An existing agent becoming a talent keeps the face everyone knows.
    portrait = fs.readFileSync(path.join(getCreationsDir(), agent.avatarPath));
    const saved = await saveImageCreation(portrait, `${t.name} portrait`, `${t.name} — portrait`, agent.id);
    t.portrait = saved.filename;
    made.push(`portrait (from their current look) #${saved.id}`);
  }
  if (!look) {
    if (!portrait) throw new Error(`${t.name} has no look or portrait to start from.`);
    look = await lookFromPortrait(opts.ollamaHost, opts.visionModel, portrait);
    t.look = look;
  }
  if (!portrait) {
    const prompt = `${look}, ${TALENT_STYLE}, head and shoulders portrait, looking at the camera, friendly confident expression`;
    portrait = (await generateImage(opts.imageHost, prompt, opts.ollamaHost, { negative: NEGATIVE })).pngBuffer;
    const saved = await saveImageCreation(portrait, prompt, `${t.name} — portrait`, agent?.id);
    t.portrait = saved.filename;
    made.push(`portrait #${saved.id}`);
    if (agent) await storage.updateAgent(agent.id, { avatarPath: saved.filename });
  }
  if (!t.fullBody) {
    const prompt = `${look}, ${TALENT_STYLE}, full body shot standing, whole outfit and shoes visible, relaxed confident pose`;
    const buf = (await generateImage(opts.imageHost, prompt, opts.ollamaHost, { negative: NEGATIVE })).pngBuffer;
    const saved = await saveImageCreation(buf, prompt, `${t.name} — full body`, agent?.id);
    t.fullBody = saved.filename;
    made.push(`full body #${saved.id}`);
  }
  if (!t.expressions?.length) {
    t.expressions = [];
    for (const mood of ["big happy smile", "surprised, mouth open in shock", "laughing", "skeptical raised eyebrow"]) {
      const prompt = `${look}, ${TALENT_STYLE}, head and shoulders portrait, ${mood}`;
      const buf = (await generateImage(opts.imageHost, prompt, opts.ollamaHost, { negative: NEGATIVE, initImage: portrait!, denoise: 0.45 })).pngBuffer;
      const saved = await saveImageCreation(buf, prompt, `${t.name} — ${mood.split(",")[0]}`, agent?.id);
      t.expressions.push(saved.filename);
    }
    made.push(`${t.expressions.length} expressions`);
  }
  updateTalent(t.slug, { look: t.look, portrait: t.portrait, fullBody: t.fullBody, expressions: t.expressions });
  return made.length ? `${t.name}'s character sheet: ${made.join(", ")} — all in the Library.` : `${t.name}'s character sheet was already complete.`;
}

/** Drops stage directions, speaker labels and markdown so only spoken words reach the voice. */
export function spokenText(script: string): string {
  return script
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/^\s*[A-Z][\w .'-]{0,30}:\s*/gm, "")
    .replace(/[*_#>`~]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TalentVideoResult { buffer: Buffer; seconds: number; lipSynced: boolean }

/** Script -> the talent saying it, vertical 9:16 with captions. Long scripts are capped at ~75s. */
export async function talentVideo(
  t: Talent, script: string,
  opts: { imageHost: string; ollamaHost: string; onProgress?: (m: string) => void },
): Promise<TalentVideoResult> {
  if (!t.portrait) throw new Error(`${t.name} needs a character sheet first (create_talent_sheet).`);
  const text = spokenText(script).slice(0, 1100);
  if (text.length < 10) throw new Error("The script has no spoken words in it.");
  const voice = KOKORO_VOICES.some((v) => v.id === t.voice) ? t.voice : "af_heart";
  const portrait = fs.readFileSync(path.join(getCreationsDir(), t.portrait));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-talent-"));
  try {
    opts.onProgress?.("recording the voice");
    const wav = await synthesize(text, voice);
    fs.writeFileSync(path.join(work, "voice.wav"), wav);
    const seconds = Math.min(75, wavDurationSeconds(wav));
    const prompt = `${t.look.replace(/[()]|:\d(\.\d+)?/g, "")}, talking to the camera ${t.setting}, expressive face, natural head movement and hand gestures, vertical video`;
    let lipSynced = false;

    if (isHumoInstalled()) {
      // Up to ~4s per HuMo run: slice the voice and render each slice.
      const parts: string[] = [];
      const n = Math.ceil(seconds / HUMO_MAX_SECONDS);
      for (let i = 0; i < n; i++) {
        opts.onProgress?.(`filming part ${i + 1} of ${n}`);
        const start = i * HUMO_MAX_SECONDS, len = Math.min(HUMO_MAX_SECONDS, seconds - start);
        if (len < 0.3) break;
        await runFfmpeg(["-y", "-ss", start.toFixed(3), "-t", len.toFixed(3), "-i", "voice.wav", "-ar", "16000", "-ac", "1", `part${i}.wav`], 60_000, work);
        const clip = await generateHumoClip(opts.imageHost, { prompt, image: portrait, audio: fs.readFileSync(path.join(work, `part${i}.wav`)), seconds: len, ollamaHost: opts.ollamaHost });
        fs.writeFileSync(path.join(work, `part${i}.mp4`), clip);
        parts.push(`part${i}.mp4`);
      }
      fs.writeFileSync(path.join(work, "parts.txt"), parts.map((p) => `file '${p}'`).join("\n"));
      // Re-encode the joined video, and lay the original full-quality voice back over it.
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", "parts.txt", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25", "joined.mp4"], 600_000, work);
      lipSynced = true;
    } else if (isWanInstalled()) {
      opts.onProgress?.("animating the portrait");
      const clip = await generateWanVideo(opts.imageHost, { prompt, image: portrait, width: 480, height: 832, seconds: 4, ollamaHost: opts.ollamaHost });
      fs.writeFileSync(path.join(work, "clip.mp4"), clip);
      // Forward-then-reverse loop so the motion never jumps.
      await runFfmpeg(["-y", "-i", "clip.mp4", "-filter_complex", "[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]", "-map", "[v]", "-an", "pingpong.mp4"], 300_000, work);
      await runFfmpeg(["-y", "-stream_loop", "-1", "-i", "pingpong.mp4", "-t", seconds.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "25", "joined.mp4"], 300_000, work);
    } else {
      // Still portrait with a slow push-in.
      fs.writeFileSync(path.join(work, "portrait.png"), portrait);
      await runFfmpeg(["-y", "-loop", "1", "-i", "portrait.png", "-vf", `scale=960:-2,zoompan=z='min(zoom+0.0007,1.15)':d=${Math.ceil(seconds * 25)}:s=480x832:fps=25`, "-t", seconds.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "joined.mp4"], 300_000, work);
    }

    opts.onProgress?.("adding captions");
    fs.writeFileSync(path.join(work, "captions.srt"), captionsSrt([{ start: 0, duration: seconds + 0.6, narration: text }]));
    await runFfmpeg([
      "-y", "-i", "joined.mp4", "-i", "voice.wav",
      "-vf", "scale=720:1248:flags=lanczos,subtitles=captions.srt:force_style='FontName=Arial,FontSize=13,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=0,Alignment=2,MarginV=70'",
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "final.mp4",
    ], 600_000, work);
    return { buffer: fs.readFileSync(path.join(work, "final.mp4")), seconds, lipSynced };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
