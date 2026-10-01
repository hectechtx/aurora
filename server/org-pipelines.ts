// Each company's standing workflow — the pipeline that produces its actual
// results on a schedule (studio episodes, clips, store products, campaigns,
// research, money reports). Created only if missing, so the owner's edits and
// deletions on the Pipelines page are never overwritten.
import { getStorage } from "./storage";
import { upsertPipeline } from "./pipelines";
import { log } from "./app";

interface Def { name: string; schedule: "daily" | "weekly"; steps: { agent: string; instruction: string }[] }

const PIPELINES: Def[] = [
  {
    name: "Studio: Daily Episode", schedule: "daily",
    steps: [
      { agent: "riley", instruction: "Find today's best video opportunity for our kid-friendly channel (trending_videos, youtube_search). Pick ONE idea and give the title, hook, angle for ages 4-8, and 5-7 story beats." },
      { agent: "Nat the content creator", instruction: "Write the full narration script for a ~2 minute episode from this idea: a hook in the first line, the beats in order, a friendly sign-off. Spoken words only — no stage directions. Save it with save_document." },
      { agent: "ALI", instruction: "Review this script for hook strength, pacing, clarity and age-appropriateness. Fix what needs fixing yourself and output ONLY the final polished narration script." },
      { agent: "Mandy", instruction: "Produce this script as a finished video with produce_video (landscape, captions on, ~2 minutes, script = the script you received, a catchy title). Then put it in the Outbox with save_deliverable using its mediaId, plus a YouTube title, description and tags." },
    ],
  },
  {
    name: "Studio: Weekly Series Episode", schedule: "weekly",
    steps: [
      { agent: "Leo Vance", instruction: "Plan the next episode of our ongoing kids series (create the series bible with save_document if none exists yet): episode title, what happens, and how it continues from last time." },
      { agent: "Nat the content creator", instruction: "Write the full ~5 minute narration script for this episode. Spoken words only. Save it with save_document." },
      { agent: "ALI", instruction: "Polish this script and output ONLY the final narration script." },
      { agent: "Mandy", instruction: "Produce it with produce_video (landscape, captions on, ~5 minutes) and send it to the Outbox with save_deliverable (mediaId) with title, description and tags." },
    ],
  },
  {
    name: "ClipStorm: Daily Clips", schedule: "daily",
    steps: [
      { agent: "Zane Cooper", instruction: "Find clip sources ONLY from what actually exists: call list_library kind=video and use only videos it lists (the studio's own finished episodes), or a creator URL the owner has explicitly approved for clipping. Never invent a video, title or timestamp. If list_library shows no videos, reply with exactly: NOTHING TO DO — no studio videos to clip yet. Otherwise pick up to 3 of the strongest 15-60 second moments: exact Library filename, start, end, and the hook (use video_transcript timestamps only for real YouTube URLs)." },
      { agent: "Mila Novak", instruction: "Cut each chosen moment with make_clip (vertical, captions on). Report each clip's Library id, length and the hook." },
      { agent: "Ezra Bloom", instruction: "For each clip write the on-screen hook, caption, hashtags and title for YouTube Shorts, TikTok, Instagram Reels, Facebook and X." },
      { agent: "Kira Sol", instruction: "Package each clip for posting: one save_deliverable per clip with mediaId = the clip's Library id, the per-platform captions/hashtags, and a suggested posting time." },
    ],
  },
  {
    name: "Goods: Daily Product Drop", schedule: "daily",
    steps: [
      { agent: "Hana Mori", instruction: "Find 2 product ideas worth adding to the store today (print-on-demand apparel, mugs, posters, stickers or digital downloads that fit our kid-friendly studio brand). Target customer, price point, why now." },
      { agent: "Owen Blake", instruction: "Design each product: the artwork (an illustration with NO text and NO people, e.g. 'a bright cartoon fox astronaut waving') and, if wanted, a short slogan to print under it (exact spelling, max 40 characters)." },
      { agent: "Tyler Grant", instruction: "Write the listing for each: title, description, bullet points, up to 13 tags, and a price." },
      { agent: "Lucia Ramos", instruction: "Add each finished product to the catalog with add_store_product (name, description, price, category, tags, image_prompt = the artwork description, design_text = the slogan if any). Then send the owner a short save_deliverable summary of today's new products." },
    ],
  },
  {
    name: "Pulse: Weekly Campaign", schedule: "weekly",
    steps: [
      { agent: "Priya Shah", instruction: "Analyze this week: what's trending for our audience (trending_videos, youtube_search on similar channels) and what our studio and store are putting out (list_outbox). Give 3 clear opportunities." },
      { agent: "Serena", instruction: "Turn this into a one-week marketing campaign plan for the studio videos and store products: goal, channels, schedule." },
      { agent: "Marco Diaz", instruction: "Write the campaign's promo posts and captions for each channel in the plan." },
      { agent: "Jade Kim", instruction: "Find 3 creators who'd be good collab partners for this campaign (youtube_search) and draft a pitch to each. Send the whole campaign package to the Outbox with save_deliverable." },
    ],
  },
  {
    name: "Forge: Weekly Research Brief", schedule: "weekly",
    steps: [
      { agent: "Theo Park", instruction: "Write this week's research brief for the organization: the most useful developments in kids media, short-form video and print-on-demand (web_search, news_headlines), each with a source and what our companies should do about it. Send it to the Outbox with save_deliverable." },
    ],
  },
  {
    name: "Venture: Weekly Opportunities", schedule: "weekly",
    steps: [
      { agent: "sherrie Knight", instruction: "Find 2 concrete business opportunities for the organization this week (sponsorships, products, services, partnerships) with why they fit and rough upside." },
      { agent: "Dante Brooks", instruction: "Create sales material for each: who to sell to, the pitch, and outreach message drafts (the owner sends them)." },
      { agent: "Grace Liu", instruction: "Turn the best one into a project plan with steps, owners (which company/agent) and timeline, and send the full package to the Outbox with save_deliverable." },
    ],
  },
  {
    name: "Ledger & Law: Weekly Review", schedule: "weekly",
    steps: [
      { agent: "Victor Hale", instruction: "Review this week's Outbox (list_outbox) for legal risk: copyright/music, kids-content rules (COPPA, 'made for kids'), sponsorship disclosure, claims in product listings. List issues with concrete fixes and say when a licensed attorney is needed." },
      { agent: "Nina Ortiz", instruction: "Add this week's finance picture from treasury_summary (real confirmed numbers only) and send the combined legal + finance review to the Outbox with save_deliverable." },
    ],
  },
  {
    name: "Treasury: Daily Books", schedule: "daily",
    steps: [
      { agent: "Graham Wells", instruction: "Check the ledger with treasury_summary. Note confirmed income/expenses by company and anything awaiting confirmation. Never invent numbers." },
      { agent: "Ada Chen", instruction: "Write a short daily money note for the owner: what we actually earned and spent, by company, what's pending, and one practical suggestion. Send it with save_deliverable." },
    ],
  },
];

export async function ensureCompanyPipelines(): Promise<void> {
  const storage = getStorage();
  const existing = new Set((await storage.getPipelines()).map((p) => p.name.toLowerCase()));
  let created = 0, weekly = 0;
  const DAY = 24 * 60 * 60 * 1000;
  for (const def of PIPELINES) {
    if (existing.has(def.name.toLowerCase())) continue;
    const r = await upsertPipeline({ name: def.name, stages: def.steps, schedule: def.schedule, originTaskId: null });
    if (!r.ok) { log(`company pipeline "${def.name}" not created: ${r.message}`); continue; }
    created++;
    // Daily pipelines start on the next tick; weekly ones are staggered one
    // per day over the coming days so the single GPU isn't hit by every
    // company's first run at once.
    if (def.schedule === "weekly") await storage.updatePipeline(r.pipeline.id, { lastRunAt: Date.now() - 7 * DAY + (++weekly) * DAY });
  }
  if (created) log(`company pipelines: created ${created}`);
}
