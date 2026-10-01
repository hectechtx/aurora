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
    name: "Talent: Spill the Tea with Tia (daily story time)", schedule: "daily",
    steps: [
      { agent: "Rhea Quill", instruction: "Find today's 3 biggest viral / entertainment stories that are REAL and reported by credible outlets (news_headlines, web_search, trending_videos, web_fetch to confirm). For each: what happened, who reported it (outlet + link), what's confirmed vs 'reportedly'. Skip private people, minors, and anything about health, sexuality or crimes beyond official reports. If nothing qualifies, reply exactly: NOTHING TO DO — no solid stories today." },
      { agent: "Tia Tea", instruction: "Write today's 'Spill the Tea with Tia' story-time script (about 45-60 seconds spoken, ~130 words): a hooky opener, the stories in your dramatic funny voice using ONLY the researched facts, naming the outlet for each ('according to…'), 'reportedly' for anything unconfirmed, and a cozy sign-off. Spoken words only. Save it with save_document and output the script." },
      { agent: "Victor Hale", instruction: "Fact and risk check this gossip script against the research above: anything not supported by a cited source, possibly defamatory, about private people or minors, or mocking someone's looks must be cut or softened. Output ONLY the final approved spoken script (or exactly NOTHING TO DO — too risky to publish if it can't be fixed)." },
      { agent: "Tia Tea", instruction: "Make the approved script into your video with talent_video (talent = Tia, title = a catchy story-time title). Then send it to the Outbox with save_deliverable (mediaId = the video) with captions for TikTok / Shorts / Reels, hashtags, the source links, and the label 'AI-generated virtual creator'." },
    ],
  },
  {
    name: "Talent: Melly's Weekly Gaming Video", schedule: "weekly",
    steps: [
      { agent: "Melly King", instruction: "Pick this week's best gaming / pop-culture topic from real news and trends (news_headlines, trending_videos, web_search). Write a ~45 second script in your bright, chaotic voice (spoken words only, real facts only), make it with talent_video (talent = Melly), and send it to the Outbox with save_deliverable (mediaId) with title, caption, hashtags and the 'AI-generated virtual creator' label." },
    ],
  },
  {
    name: "Talent: Sienna's Weekly Lifestyle Video", schedule: "weekly",
    steps: [
      { agent: "Sienna Bloom", instruction: "Pick one trending lifestyle / wellness topic (trending_videos, web_search). Write a cozy ~45 second script in your voice (spoken words only, no medical claims), make it with talent_video (talent = Sienna), and send it to the Outbox with save_deliverable (mediaId) with title, caption, hashtags and the 'AI-generated virtual creator' label." },
    ],
  },
  {
    name: "Talent: Juno's Weekly Music Video", schedule: "weekly",
    steps: [
      { agent: "Juno Wave", instruction: "Make this week's music video: hype AURORA Records' newest release (list_library kind=audio) or break down a trending dance challenge — describe songs, never use copyrighted audio. Write ~45 seconds in your voice (spoken words only), make it with talent_video (talent = Juno), and send it to the Outbox with save_deliverable (mediaId) with title, caption, hashtags and the 'AI-generated virtual creator' label." },
    ],
  },
  {
    name: "Talent: Weekly Social Plan", schedule: "weekly",
    steps: [
      { agent: "Vivian Cross", instruction: "Review the agency (list_talents, list_outbox): what each talent posted this week, what to double down on, and next week's theme for each talent. Keep every brand consistent." },
      { agent: "Bea Holloway", instruction: "Turn the plan into next week's social kit for every talent: profile bio and handle suggestions (if not set up yet), a day-by-day posting calendar with times, and per-platform captions and hashtags, each post labelled 'AI-generated virtual creator'. Send it to the Outbox with save_deliverable." },
    ],
  },
  {
    name: "Studio: Daily Episode", schedule: "daily",
    steps: [
      { agent: "riley", instruction: "Find today's best video opportunity for our kid-friendly channel (trending_videos, youtube_search). Pick ONE idea and give the title, hook, angle for ages 4-8, and 5-7 story beats." },
      { agent: "Nat the content creator", instruction: "Write the full narration script for a ~2 minute episode from this idea: a hook in the first line, the beats in order, a friendly sign-off. Spoken words only — no stage directions. Save it with save_document." },
      { agent: "ALI", instruction: "Review this script for hook strength, pacing, clarity and age-appropriateness. Fix what needs fixing yourself and output ONLY the final polished narration script." },
      { agent: "Mandy", instruction: "Produce this script as a finished video with produce_video (landscape, captions on, visual_style = 'bright colorful 3D cartoon, kid-friendly, no realistic people', ~2 minutes, script = the script you received, a catchy title). Then put it in the Outbox with save_deliverable using its mediaId, plus a YouTube title, description and tags." },
    ],
  },
  {
    name: "Studio: Weekly Series Episode", schedule: "weekly",
    steps: [
      { agent: "Leo Vance", instruction: "Plan the next episode of our ongoing kids series (create the series bible with save_document if none exists yet): episode title, what happens, and how it continues from last time." },
      { agent: "Nat the content creator", instruction: "Write the full ~5 minute narration script for this episode. Spoken words only. Save it with save_document." },
      { agent: "ALI", instruction: "Polish this script and output ONLY the final narration script." },
      { agent: "Mandy", instruction: "Produce it with produce_video (landscape, captions on, visual_style = 'bright colorful 3D cartoon, kid-friendly, no realistic people', ~5 minutes) and send it to the Outbox with save_deliverable (mediaId) with title, description and tags." },
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
    name: "Records: Daily Song", schedule: "daily",
    steps: [
      { agent: "Skye Monroe", instruction: "Create today's song concept for AURORA Records' artist NOVA LUX (check trending_videos with categories ['music video'] for what's resonating, but never copy a song): title, theme, genre, mood, and the full chorus." },
      { agent: "Jonah Reed", instruction: "Write the complete lyrics around this chorus: [verse] 1, [chorus], [verse] 2, [chorus], [bridge], [chorus]. Output the title, the style line and the full tagged lyrics." },
      { agent: "Dre Coleman", instruction: "Produce the song with make_song: title, a precise style line (genre, mood, instruments, tempo, vocal type), the full lyrics, ~120 seconds. Report its Library id and the style you chose." },
      { agent: "NOVA LUX", instruction: "Make the cover art with generate_image (neon aurora colors, starlight, artwork only — no text, no realistic people) and write a 2-3 sentence release note in NOVA's voice. Pass along the song's Library id." },
      { agent: "Maya Torres", instruction: "Package the release: one save_deliverable with mediaId = the song's Library id, containing title, artist NOVA LUX, genre, lyrics, credits, the AI-generated disclosure, the cover art reference, and a distribution checklist for the owner." },
    ],
  },
  {
    name: "Insights: Weekly Venture Pitch", schedule: "weekly",
    steps: [
      { agent: "Felix Wang", instruction: "Find the single most promising business we could start with our existing companies and tools (content, music, store, clipping, research, marketing). Gather real market data with sources: demand, competitors, pricing, audience." },
      { agent: "Rosa Delgado", instruction: "Model the economics of this idea: startup costs, pricing, unit economics, break-even, conservative 3-month revenue estimate — all labelled as estimates." },
      { agent: "Imani Brooks", instruction: "Write the full business plan (opportunity, customer, product, how we'd run it, team of 2-5 roles, a standing weekly or daily workflow, costs, revenue path, risks) and score it 1-10 as a no-brainer, with reasons." },
      { agent: "AURORA", instruction: "Decide as lead. If the plan scores 8+ AND is legal, low-cost, doable with our tools and has a clear revenue path, bring it to life with found_company (team with names/roles/personas/jobs, and a pipeline whose steps use those team members). Otherwise send the plan to the owner with save_deliverable and say why it isn't a no-brainer yet." },
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
