function toWords(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

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
  const style = String(args.style ?? "");
  if (!text.trim()) { process.stdout.write(JSON.stringify({ error: "text is required" })); return; }

  const words = toWords(text);
  let result;
  if (style === "camelCase") {
    result = words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  } else if (style === "snake_case") {
    result = words.join("_");
  } else if (style === "kebab-case") {
    result = words.join("-");
  } else if (style === "titlecase") {
    result = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  } else if (style === "uppercase") {
    result = text.toUpperCase();
  } else if (style === "lowercase") {
    result = text.toLowerCase();
  } else {
    process.stdout.write(JSON.stringify({ error: `unknown style "${style}"` }));
    return;
  }

  process.stdout.write(JSON.stringify({ result }));
});
