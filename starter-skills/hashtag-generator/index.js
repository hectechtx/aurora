const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  const args = payload?.args ?? {};
  try {
    const result = run(args);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

const MODIFIERS = [
  "daily",
  "life",
  "love",
  "community",
  "tips",
  "goals",
  "vibes",
  "style",
  "inspo",
  "content",
  "creator",
];

function clean(word) {
  return String(word)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function run(args) {
  const { keywords, count = 20 } = args;
  if (!Array.isArray(keywords) || keywords.length === 0) throw new Error("keywords must be a non-empty array");
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }

  const seen = new Set();
  const hashtags = [];

  function add(tag) {
    const key = tag.toLowerCase();
    if (!tag || tag === "#" || seen.has(key)) return;
    seen.add(key);
    hashtags.push(tag);
  }

  const cleanedKeywords = keywords.map((k) => clean(k)).filter((k) => k.length > 0);
  if (cleanedKeywords.length === 0) throw new Error("keywords must contain at least one usable word");

  for (const k of cleanedKeywords) {
    add(`#${k}`);
  }
  for (const k of cleanedKeywords) {
    for (const mod of MODIFIERS) {
      add(`#${k}${mod}`);
      if (hashtags.length >= count) break;
    }
    if (hashtags.length >= count) break;
  }

  return { hashtags: hashtags.slice(0, count) };
}
