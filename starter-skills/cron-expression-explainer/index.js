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

function describeField(field, unit, pluralUnit) {
  if (field === "*") return `every ${unit}`;
  if (/^\*\/\d+$/.test(field)) {
    const n = field.slice(2);
    return `every ${n} ${pluralUnit}`;
  }
  if (/^\d+-\d+$/.test(field)) {
    const [a, b] = field.split("-");
    return `${unit} ${a} through ${b}`;
  }
  if (/^\d+(,\d+)+$/.test(field)) {
    return `at ${field.split(",").join(", ")}`;
  }
  if (/^\d+$/.test(field)) {
    return `at ${field}`;
  }
  return field;
}

function run(args) {
  const expression = String(args.expression ?? "").trim();
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("expression must have exactly 5 fields: minute hour day month weekday");
  }
  const [minute, hour, day, month, weekday] = fields;

  const parts = [];

  const minuteIsPlain = /^\d+$/.test(minute);
  const hourIsPlain = /^\d+$/.test(hour);
  if (minuteIsPlain && hourIsPlain) {
    const hh = hour.padStart(2, "0");
    const mm = minute.padStart(2, "0");
    parts.push(`at ${hh}:${mm}`);
  } else {
    parts.push(`minute: ${describeField(minute, "minute", "minutes")}`);
    parts.push(`hour: ${describeField(hour, "hour", "hours")}`);
  }

  if (day !== "*") {
    parts.push(`day of month: ${describeField(day, "day", "days")}`);
  }
  if (month !== "*") {
    parts.push(`month: ${describeField(month, "month", "months")}`);
  }
  if (weekday !== "*") {
    parts.push(`weekday: ${describeField(weekday, "weekday", "weekdays")}`);
  }

  const description = parts.join(", ");
  return { expression, description };
}
