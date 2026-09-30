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
  const { baseUrl, source, medium, campaign, term, content } = args;
  if (typeof baseUrl !== "string" || !baseUrl) throw new Error("baseUrl is required");
  if (typeof source !== "string" || !source) throw new Error("source is required");
  if (typeof medium !== "string" || !medium) throw new Error("medium is required");
  if (typeof campaign !== "string" || !campaign) throw new Error("campaign is required");

  const params = [
    ["utm_source", source],
    ["utm_medium", medium],
    ["utm_campaign", campaign],
  ];
  if (typeof term === "string" && term) params.push(["utm_term", term]);
  if (typeof content === "string" && content) params.push(["utm_content", content]);

  const queryString = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const separator = baseUrl.includes("?") ? "&" : "?";

  return { url: `${baseUrl}${separator}${queryString}` };
}
