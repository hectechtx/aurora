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
  const creationDate = args.creationDate;
  const retentionYears = args.retentionYears;
  const d = new Date(creationDate);
  if (typeof creationDate !== "string" || isNaN(d.getTime())) {
    throw new Error("creationDate is not a valid date");
  }
  if (typeof retentionYears !== "number" || !isFinite(retentionYears)) {
    throw new Error("retentionYears must be a number");
  }
  d.setFullYear(d.getFullYear() + retentionYears);
  return {
    creationDate,
    retentionYears,
    disposalDate: d.toISOString().slice(0, 10),
  };
}
