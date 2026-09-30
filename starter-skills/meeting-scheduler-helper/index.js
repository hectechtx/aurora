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

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) throw new Error(`invalid time format: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) throw new Error(`invalid time value: ${hhmm}`);
  return h * 60 + min;
}

function toHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function run(args) {
  const { people, dayStart = "09:00", dayEnd = "17:00" } = args;
  if (!Array.isArray(people) || people.length === 0) throw new Error("people must be a non-empty array");

  const dayStartMin = toMinutes(dayStart);
  const dayEndMin = toMinutes(dayEnd);
  if (dayEndMin <= dayStartMin) throw new Error("dayEnd must be after dayStart");

  const allBusy = [];
  for (const person of people) {
    if (!person || typeof person.name !== "string" || !Array.isArray(person.busy)) {
      throw new Error("each person requires a name (string) and busy (array)");
    }
    for (const interval of person.busy) {
      const s = toMinutes(interval.start);
      const e = toMinutes(interval.end);
      if (e <= s) throw new Error(`busy interval end must be after start for ${person.name}`);
      allBusy.push([Math.max(s, dayStartMin), Math.min(e, dayEndMin)]);
    }
  }

  allBusy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of allBusy) {
    if (e <= dayStartMin || s >= dayEndMin) continue;
    if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  const commonFreeSlots = [];
  let cursor = dayStartMin;
  for (const [s, e] of merged) {
    if (s > cursor) {
      commonFreeSlots.push({ start: toHHMM(cursor), end: toHHMM(s) });
    }
    cursor = Math.max(cursor, e);
  }
  if (cursor < dayEndMin) {
    commonFreeSlots.push({ start: toHHMM(cursor), end: toHHMM(dayEndMin) });
  }

  return { commonFreeSlots };
}
