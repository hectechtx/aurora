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
  const { projectName, shootDate, location, generalCallTime, crew, schedule } = args;
  if (typeof projectName !== "string" || !projectName) throw new Error("projectName is required");
  if (typeof shootDate !== "string" || !shootDate) throw new Error("shootDate is required");
  if (typeof location !== "string" || !location) throw new Error("location is required");
  if (typeof generalCallTime !== "string" || !generalCallTime) throw new Error("generalCallTime is required");
  if (!Array.isArray(crew) || crew.length === 0) throw new Error("crew must be a non-empty array");

  let out = "";
  out += `CALL SHEET\n`;
  out += `${"=".repeat(40)}\n`;
  out += `Project:      ${projectName}\n`;
  out += `Shoot Date:   ${shootDate}\n`;
  out += `Location:     ${location}\n`;
  out += `General Call: ${generalCallTime}\n`;
  out += `${"=".repeat(40)}\n\n`;

  out += `CREW\n`;
  out += `${"-".repeat(40)}\n`;
  out += `Role                 Name                 Call Time\n`;
  for (const c of crew) {
    if (!c || typeof c.role !== "string" || typeof c.name !== "string") {
      throw new Error("each crew member requires role (string) and name (string)");
    }
    const callTime = typeof c.callTime === "string" && c.callTime ? c.callTime : generalCallTime;
    out += `${c.role.padEnd(20)} ${c.name.padEnd(20)} ${callTime}\n`;
  }

  if (Array.isArray(schedule) && schedule.length > 0) {
    out += `\nSCHEDULE\n`;
    out += `${"-".repeat(40)}\n`;
    for (const s of schedule) {
      if (!s || typeof s.time !== "string" || typeof s.item !== "string") {
        throw new Error("each schedule item requires time (string) and item (string)");
      }
      out += `${s.time.padEnd(10)} ${s.item}\n`;
    }
  }

  return { formatted: out.trimEnd() };
}
