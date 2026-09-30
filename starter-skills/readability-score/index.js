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
  const text = String(payload?.args?.text ?? "").trim();
  if (!text) {
    process.stdout.write(JSON.stringify({ error: "text is required" }));
    return;
  }

  function countSyllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    const groups = w.match(/[aeiouy]+/g) || [];
    let count = groups.length;
    if (w.endsWith("e") && count > 1) count -= 1;
    return Math.max(1, count);
  }

  const words = text.split(/\s+/).filter(Boolean);
  const sentences = Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) || []).length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordCount = Math.max(1, words.length);

  const fleschReadingEase = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
  const fleschKincaidGrade = 0.39 * (wordCount / sentences) + 11.8 * (syllables / wordCount) - 15.59;

  function band(score) {
    if (score >= 90) return "very easy (5th grade)";
    if (score >= 70) return "easy (7th grade)";
    if (score >= 60) return "standard (8th-9th grade)";
    if (score >= 50) return "fairly difficult (10th-12th grade)";
    if (score >= 30) return "difficult (college)";
    return "very difficult (college graduate)";
  }

  process.stdout.write(JSON.stringify({
    fleschReadingEase: Math.round(fleschReadingEase * 10) / 10,
    fleschKincaidGrade: Math.round(fleschKincaidGrade * 10) / 10,
    band: band(fleschReadingEase),
    wordCount, sentenceCount: sentences,
  }));
});
