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

const WORD_LIST = [
  "cat", "hat", "bat", "mat", "rat", "sat", "fat", "pat", "flat", "chat",
  "dog", "log", "fog", "jog", "bog", "cog", "hog", "frog",
  "day", "way", "say", "play", "stay", "gray", "tray", "clay", "pray", "sway",
  "light", "night", "sight", "fight", "right", "bright", "flight", "might", "tight", "slight",
  "love", "dove", "above", "glove", "shove",
  "time", "rhyme", "climb", "chime", "lime", "dime", "prime", "crime", "grime", "slime",
  "star", "far", "car", "bar", "jar", "scar", "tar", "war",
  "tree", "free", "sea", "bee", "see", "key", "knee", "flee", "three", "agree",
  "moon", "soon", "spoon", "noon", "tune", "june", "balloon",
  "rain", "pain", "gain", "main", "train", "brain", "chain", "plain", "stain", "again",
  "blue", "true", "glue", "new", "grew", "flew", "threw", "crew", "drew", "shoe",
  "song", "long", "strong", "wrong", "along", "belong",
  "heart", "start", "part", "art", "smart", "chart", "dart", "cart",
  "wind", "kind", "find", "mind", "blind", "grind", "behind",
  "hand", "land", "sand", "band", "stand", "grand", "brand",
  "green", "seen", "mean", "clean", "queen", "scene", "screen", "between",
  "house", "mouse", "blouse", "spouse",
  "grow", "know", "show", "slow", "flow", "blow", "snow", "throw", "glow",
  "fire", "wire", "hire", "tire", "desire", "inspire",
];

function run(args) {
  const word = String(args.word ?? "").trim();
  if (!word) throw new Error("word is required");
  const lowerWord = word.toLowerCase();
  const suffix = lowerWord.slice(-3);
  const rhymes = WORD_LIST.filter(
    (w) => w.toLowerCase() !== lowerWord && w.toLowerCase().endsWith(suffix)
  );
  return { word, rhymes };
}
