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

function escapeCell(v) {
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function run(args) {
  const { shots } = args;
  if (!Array.isArray(shots) || shots.length === 0) throw new Error("shots must be a non-empty array");

  const rows = [];
  shots.forEach((s, i) => {
    if (!s || typeof s.scene !== "string" || typeof s.description !== "string") {
      throw new Error("each shot requires scene (string) and description (string)");
    }
    const shotType = typeof s.shotType === "string" && s.shotType.length > 0 ? s.shotType : "—";
    const notes = typeof s.notes === "string" ? s.notes : "";
    rows.push({ num: i + 1, scene: s.scene, shotType, description: s.description, notes });
  });

  let formatted = "| Shot# | Scene | Type | Description | Notes |\n";
  formatted += "| --- | --- | --- | --- | --- |\n";
  for (const r of rows) {
    formatted += `| ${r.num} | ${escapeCell(r.scene)} | ${escapeCell(r.shotType)} | ${escapeCell(r.description)} | ${escapeCell(r.notes)} |\n`;
  }

  return { formatted: formatted.trimEnd(), totalShots: rows.length };
}
