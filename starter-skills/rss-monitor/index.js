// RSS / Atom feed reader — fetches a feed and extracts the latest entries.
// Handles both RSS (<item>) and Atom (<entry>) with a small regex parser; no
// XML dependency. Good enough for well-formed feeds, which nearly all are.

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", async () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  try {
    process.stdout.write(JSON.stringify(await run(payload?.args ?? {})));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

function decode(s) {
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

function atomLink(block) {
  const m = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  return m ? m[1] : "";
}

async function run(args) {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be a full http(s) feed URL");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let xml;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (AURORA read_feed skill)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const feedTitle = tag(xml.split(/<item[\s>]|<entry[\s>]/i)[0] || xml, "title");
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = (xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, limit);

  const entries = blocks.map((b) => ({
    title: tag(b, "title"),
    link: isAtom ? atomLink(b) : tag(b, "link"),
    date: tag(b, "pubDate") || tag(b, "updated") || tag(b, "published"),
    summary: (tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 500),
  }));

  return { feedTitle, count: entries.length, entries };
}
