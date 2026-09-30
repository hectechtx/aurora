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

function toList(arr) {
  return Array.isArray(arr) ? arr.map((s) => String(s)) : [];
}

function run(args) {
  const title = String(args.title ?? "").trim();
  const date = String(args.date ?? "").trim();
  const attendees = toList(args.attendees);
  const notes = toList(args.notes);
  const actionItems = args.actionItems != null ? toList(args.actionItems) : [];

  if (!title) throw new Error("title is required");
  if (!date) throw new Error("date is required");
  if (attendees.length === 0) throw new Error("attendees must be a non-empty array");
  if (notes.length === 0) throw new Error("notes must be a non-empty array");

  const sections = [
    `# ${title}`,
    `**Date:** ${date}`,
    "",
    "## Attendees",
    attendees.map((a) => `- ${a}`).join("\n"),
    "",
    "## Discussion",
    notes.map((n) => `- ${n}`).join("\n"),
  ];

  if (actionItems.length > 0) {
    sections.push("", "## Action Items", actionItems.map((a) => `- [ ] ${a}`).join("\n"));
  }

  return { formatted: sections.join("\n") };
}
