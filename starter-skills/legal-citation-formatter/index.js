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
  const { caseName, volume, reporter, page, year, court } = args;
  for (const [key, val] of Object.entries({ caseName, volume, reporter, page, year })) {
    if (val === undefined || val === null || String(val).length === 0) {
      throw new Error(`${key} is required`);
    }
  }
  const citation = `${caseName}, ${volume} ${reporter} ${page} (${court ? court + " " : ""}${year}).`;
  return {
    citation,
    disclaimer: "Formatting aid only — verify citation accuracy against current Bluebook rules.",
  };
}
