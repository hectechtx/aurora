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

function toLastFirst(author) {
  if (author.includes(",")) return author;
  const parts = author.trim().split(/\s+/);
  if (parts.length < 2) return author;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

function run(args) {
  const style = String(args.style ?? "").toLowerCase();
  if (!["apa", "mla", "chicago"].includes(style)) {
    throw new Error("style must be apa, mla, or chicago");
  }
  const author = String(args.author ?? "").trim();
  const title = String(args.title ?? "").trim();
  const year = String(args.year ?? "").trim();
  const publisher = args.publisher != null ? String(args.publisher).trim() : "";
  if (!author || !title || !year) throw new Error("author, title, and year are required");

  let citation;
  if (style === "apa") {
    const apaAuthor = toLastFirst(author);
    citation = `${apaAuthor}. (${year}). ${title}.${publisher ? " " + publisher + "." : ""}`;
  } else if (style === "mla") {
    const mlaAuthor = toLastFirst(author);
    citation = `${mlaAuthor}. ${title}.${publisher ? " " + publisher + "," : ""} ${year}.`;
  } else {
    const chicagoAuthor = toLastFirst(author);
    citation = `${chicagoAuthor}. ${title}.${publisher ? " " + publisher + "," : ""} ${year}.`;
  }
  return { citation };
}
