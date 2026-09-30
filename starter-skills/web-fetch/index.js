// Web Fetch skill — reads a URL and returns its title + readable text.
// Contract (see server/skills/runner.ts): one JSON line in on stdin
// ({"tool","args"}), one JSON value out on stdout. Uses only Node built-ins
// (global fetch, Node 18+), so there's nothing to npm-install.

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", async () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  const args = payload?.args ?? {};
  try {
    const result = await run(args);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

// Strip <script>/<style> blocks, then all tags, decode a few common entities,
// and collapse whitespace — a lightweight readability pass, no dependencies.
function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  text = text.replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? m);
  return text.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 300) : "";
}

async function run(args) {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("url must be a full http(s) URL");
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 8000, 200), 40000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (AURORA web_fetch skill)", "Accept": "text/html,*/*" },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const ctype = res.headers.get("content-type") || "";
  const body = await res.text();
  if (ctype.includes("application/json")) {
    return { url: res.url, contentType: ctype, text: body.slice(0, maxChars), truncated: body.length > maxChars };
  }
  const text = htmlToText(body);
  return {
    url: res.url,
    title: titleOf(body),
    contentType: ctype,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
