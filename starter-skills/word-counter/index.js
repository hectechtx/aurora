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
  const { args } = payload;
  const text = String(args?.text ?? "");
  if (!text.trim()) {
    process.stdout.write(JSON.stringify({ error: "text is required" }));
    return;
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, "").length;
  const sentences = (text.match(/[.!?]+(?=\s|$)/g) || []).length || (text.trim() ? 1 : 0);
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length || (text.trim() ? 1 : 0);
  const readingTimeMinutes = Math.max(1, Math.round(words.length / 200));

  process.stdout.write(JSON.stringify({
    words: words.length,
    characters,
    charactersNoSpaces,
    sentences,
    paragraphs,
    estimatedReadingTimeMinutes: readingTimeMinutes,
  }));
});
