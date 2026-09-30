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

const WINDOWS = {
  instagram: ["11am-1pm", "7pm-9pm"],
  tiktok: ["6am-10am", "7pm-11pm"],
  x: ["8am-10am", "6pm-9pm"],
  youtube: ["2pm-4pm", "7pm-10pm (weekends)"],
  linkedin: ["7am-9am (weekdays)", "12pm-1pm (weekdays)"],
};

function run(args) {
  const { platform } = args;
  if (!Object.prototype.hasOwnProperty.call(WINDOWS, platform)) {
    throw new Error("platform must be one of: instagram, tiktok, x, youtube, linkedin");
  }

  return {
    platform,
    suggestedWindows: WINDOWS[platform],
    disclaimer:
      "General industry rule-of-thumb — check your own account's analytics for what actually works for your audience.",
  };
}
