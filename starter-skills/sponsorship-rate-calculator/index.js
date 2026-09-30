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

const POST_TYPE_MULTIPLIERS = { feed: 1, story: 0.5, reel: 1.3 };

function run(args) {
  const { followers, engagementRatePercent, postType = "feed" } = args;
  if (typeof followers !== "number" || !isFinite(followers) || followers < 0) {
    throw new Error("followers must be a non-negative number");
  }
  if (typeof engagementRatePercent !== "number" || !isFinite(engagementRatePercent) || engagementRatePercent < 0) {
    throw new Error("engagementRatePercent must be a non-negative number");
  }
  if (!Object.prototype.hasOwnProperty.call(POST_TYPE_MULTIPLIERS, postType)) {
    throw new Error("postType must be one of: feed, story, reel");
  }

  const baseRate = followers * 0.01;
  let engagementMultiplier = engagementRatePercent / 3;
  engagementMultiplier = Math.min(3, Math.max(0.3, engagementMultiplier));
  const postTypeMultiplier = POST_TYPE_MULTIPLIERS[postType];

  const estimatedRate = baseRate * engagementMultiplier * postTypeMultiplier;

  return {
    estimatedRate: Math.round(estimatedRate * 100) / 100,
    disclaimer:
      "Rough rule-of-thumb estimate — actual rates vary widely by niche, audience quality, and negotiation. Use as a starting point only.",
  };
}
