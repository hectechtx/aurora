// Web Search skill — queries DuckDuckGo's no-JS HTML endpoint and parses the
// result list. No API key, no dependencies (global fetch). DuckDuckGo's HTML
// endpoint returns server-rendered results whose links are wrapped in a
// redirector (uddg=<encoded target>), which we unwrap back to the real URL.

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

function stripTags(s) {
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();
}

function unwrap(href) {
  // DuckDuckGo wraps targets as //duckduckgo.com/l/?uddg=<encoded>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  return href.startsWith("//") ? "https:" + href : href;
}

async function run(args) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let html;
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (AURORA web_search skill)", "Accept": "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const results = [];
  // Each result: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));
  let m, i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < limit) {
    results.push({ title: stripTags(m[2]), url: unwrap(m[1]), snippet: snippets[i] ?? "" });
    i++;
  }
  return { query, count: results.length, results };
}
