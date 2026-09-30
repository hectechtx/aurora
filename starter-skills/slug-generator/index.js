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
  if (!text.trim()) {
    process.stdout.write(JSON.stringify({ error: "text is required" }));
    return;
  }

  // NFKD splits accented letters into base + combining-mark codepoints
  // (U+0300-U+036F) — drop those marks by code point instead of a regex
  // range, which is easy to get subtly wrong with unicode escapes.
  const stripped = Array.from(text.normalize("NFKD"))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join("");

  let slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const maxLength = Number(args.maxLength);
  if (Number.isFinite(maxLength) && maxLength > 0 && slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, "");
  }

  process.stdout.write(JSON.stringify({ slug }));
});
