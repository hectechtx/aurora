// Read-only web access for the vessel and its agents — search + fetch, no
// API key (DuckDuckGo's "lite" HTML endpoint, scraped; their JSON API is too
// limited for general search). Both are classified low-risk since they're
// pure outbound GETs with no side effects, but web_fetch still guards
// against SSRF: every hop (including redirects) is checked against
// loopback/private/link-local ranges before the request is made, so an
// agent can't use it to poke at services on your own machine or LAN.
import dns from "node:dns/promises";
import net from "node:net";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_TEXT_CHARS = 8_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUddg(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search request failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const links: { href: string; title: string }[] = [];
  const linkRe = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) links.push({ href: m[1], title: decodeEntities(stripTags(m[2])) });

  const snippets: string[] = [];
  const snippetRe = /class='result-snippet'>\s*([\s\S]*?)<\/td>/g;
  while ((m = snippetRe.exec(html))) snippets.push(decodeEntities(stripTags(m[1])));

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const target = extractUddg(links[i].href);
    if (!target || !links[i].title) continue;
    results.push({ title: links[i].title, url: target, snippet: snippets[i] ?? "" });
  }
  return results;
}

function isPrivateOrLoopback(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) return isPrivateOrLoopback(lower.slice(7)); // IPv4-mapped IPv6
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === "localhost") throw new Error("refuses to fetch localhost or private/internal addresses");
  const addrs = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  for (const addr of addrs) {
    if (isPrivateOrLoopback(addr)) throw new Error(`refuses to fetch a private/internal address (${addr})`);
  }
}

function htmlToText(html: string): string {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n");
  s = stripTags(s);
  s = decodeEntities(s);
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export interface FetchResult {
  url: string;
  title: string;
  text: string;
}

export async function webFetch(targetUrl: string, maxRedirects = 5): Promise<FetchResult> {
  let current: URL;
  try {
    current = new URL(targetUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new Error("only http/https URLs are supported");
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(current.hostname);

    const res = await fetch(current.toString(), {
      headers: { "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirect (${res.status}) had no location header`);
      current = new URL(location, current);
      continue;
    }

    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);

    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("response too large");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error("response too large");

    const contentType = res.headers.get("content-type") ?? "";
    const raw = Buffer.from(buf).toString("utf-8");

    if (!contentType.includes("html")) {
      return { url: current.toString(), title: current.hostname, text: raw.slice(0, MAX_TEXT_CHARS) };
    }

    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])) : current.hostname;
    return { url: current.toString(), title, text: htmlToText(raw).slice(0, MAX_TEXT_CHARS) };
  }

  throw new Error("too many redirects");
}
