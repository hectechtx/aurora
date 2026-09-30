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

const LIMITS = {
  instagram: 2200,
  x: 280,
  tiktok: 2200,
  youtube: 5000,
};

function run(args) {
  const { caption, platform } = args;
  if (typeof caption !== "string") throw new Error("caption must be a string");
  if (!Object.prototype.hasOwnProperty.call(LIMITS, platform)) {
    throw new Error("platform must be one of: instagram, x, tiktok, youtube");
  }

  const limit = LIMITS[platform];
  const length = caption.length;
  const withinLimit = length <= limit;

  const result = { length, limit, withinLimit };
  if (!withinLimit) {
    result.truncatedPreview = caption.slice(0, Math.max(0, limit - 3)) + "...";
  }

  return result;
}
