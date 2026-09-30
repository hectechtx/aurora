const crypto = require("node:crypto");

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stdout.write(JSON.stringify({ error: "invalid stdin payload" }));
    return;
  }
  const args = payload?.args ?? {};
  const text = String(args.text ?? "");
  const algorithm = String(args.algorithm ?? "");
  if (!["md5", "sha1", "sha256"].includes(algorithm)) {
    process.stdout.write(JSON.stringify({ error: "algorithm must be md5, sha1, or sha256" }));
    return;
  }
  const digest = crypto.createHash(algorithm).update(text, "utf8").digest("hex");
  process.stdout.write(JSON.stringify({ algorithm, digest }));
});
