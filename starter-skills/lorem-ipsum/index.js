const WORDS = ("lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore " +
  "et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea " +
  "commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur " +
  "excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum").split(" ");

function randomWord() { return WORDS[Math.floor(Math.random() * WORDS.length)]; }

function makeSentence(minWords = 6, maxWords = 14) {
  const n = minWords + Math.floor(Math.random() * (maxWords - minWords));
  const words = Array.from({ length: n }, randomWord);
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

function makeParagraph(sentenceCount = 5) {
  return Array.from({ length: sentenceCount }, () => makeSentence()).join(" ");
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
  const unit = String(args.unit ?? "");
  const count = Math.max(1, Math.min(200, Math.round(Number(args.count) || 0)));

  let text;
  if (unit === "words") text = Array.from({ length: count }, randomWord).join(" ");
  else if (unit === "sentences") text = Array.from({ length: count }, () => makeSentence()).join(" ");
  else if (unit === "paragraphs") text = Array.from({ length: count }, () => makeParagraph()).join("\n\n");
  else {
    process.stdout.write(JSON.stringify({ error: 'unit must be "words", "sentences", or "paragraphs"' }));
    return;
  }

  process.stdout.write(JSON.stringify({ text }));
});
