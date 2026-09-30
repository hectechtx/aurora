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

const PRESETS = {
  social: [
    { name: "Instagram Post", widthPx: 1080, heightPx: 1080 },
    { name: "Instagram Story", widthPx: 1080, heightPx: 1920 },
    { name: "Facebook Cover", widthPx: 820, heightPx: 312 },
    { name: "Twitter/X Post", widthPx: 1600, heightPx: 900 },
    { name: "LinkedIn Post", widthPx: 1200, heightPx: 1200 },
    { name: "YouTube Thumbnail", widthPx: 1280, heightPx: 720 },
  ],
  print: [
    { name: "US Letter @300dpi", widthPx: 2550, heightPx: 3300 },
    { name: "Business Card @300dpi", widthPx: 1050, heightPx: 600 },
    { name: "A4 @300dpi", widthPx: 2480, heightPx: 3508 },
  ],
  ads: [
    { name: "Leaderboard", widthPx: 728, heightPx: 90 },
    { name: "Medium Rectangle", widthPx: 300, heightPx: 250 },
    { name: "Wide Skyscraper", widthPx: 160, heightPx: 600 },
  ],
};

function run(args) {
  const category = args.category ?? "all";
  if (!["social", "print", "ads", "all"].includes(category)) {
    throw new Error("category must be social, print, ads, or all");
  }
  if (category === "all") {
    const presets = [];
    for (const cat of ["social", "print", "ads"]) {
      for (const p of PRESETS[cat]) presets.push({ ...p, category: cat });
    }
    return { presets };
  }
  return { presets: PRESETS[category].map((p) => ({ ...p })) };
}
