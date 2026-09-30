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

function run(args) {
  const { likes, comments, shares = 0, followersOrViews } = args;
  if (typeof likes !== "number" || !isFinite(likes) || likes < 0) throw new Error("likes must be a non-negative number");
  if (typeof comments !== "number" || !isFinite(comments) || comments < 0) {
    throw new Error("comments must be a non-negative number");
  }
  if (typeof shares !== "number" || !isFinite(shares) || shares < 0) {
    throw new Error("shares must be a non-negative number");
  }
  if (typeof followersOrViews !== "number" || !isFinite(followersOrViews) || followersOrViews <= 0) {
    throw new Error("followersOrViews must be a positive number");
  }

  const totalEngagements = likes + comments + shares;
  const engagementRatePercent = (totalEngagements / followersOrViews) * 100;

  return {
    engagementRatePercent: Math.round(engagementRatePercent * 100) / 100,
    totalEngagements,
  };
}
