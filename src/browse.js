// Real-internet browsing for saz3: a shared cookie jar, the /browse proxy that
// lets the UI panel display live websites (external sites block iframes, so
// pages are fetched server-side and instrumented), and the AI's browser tools
// (search / open / click / forms / downloads) which share the same session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

// ── cookie jar (shared by the panel and the AI tools; memory only) ──
const jar = new Map(); // domain -> Map(name -> {value, path})
export function clearCookies() { jar.clear(); }

function domainsFor(host) {
  const parts = host.split(".");
  const out = [host];
  for (let i = 1; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}
function cookiesFor(url) {
  try {
    const u = new URL(url);
    const out = [];
    for (const d of domainsFor(u.hostname)) {
      const m = jar.get(d);
      if (m) for (const [k, v] of m) { if (u.pathname.startsWith(v.path || "/")) out.push(`${k}=${v.value}`); }
    }
    return out.join("; ");
  } catch { return ""; }
}
function storeCookies(url, setCookies) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  for (const line of setCookies || []) {
    const parts = line.split(";");
    const eq = parts[0].indexOf("=");
    if (eq < 1) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let domain = host, cpath = "/", expired = false;
    for (const attr of parts.slice(1)) {
      const [k, v = ""] = attr.split("=").map((s) => s.trim());
      const kl = k.toLowerCase();
      if (kl === "domain" && v) domain = v.replace(/^\./, "");
      else if (kl === "path" && v) cpath = v;
      else if (kl === "max-age" && Number(v) <= 0) expired = true;
      else if (kl === "expires" && Date.parse(v) < Date.now()) expired = true;
    }
    if (!jar.has(domain)) jar.set(domain, new Map());
    if (expired) jar.get(domain).delete(name);
    else jar.get(domain).set(name, { value, path: cpath });
  }
}

/** Fetch with browser headers, cookie jar, and manual redirect following. */
export async function fetchRaw(url, { method = "GET", headers = {}, body, signal, maxRedirects = 8 } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const cookie = cookiesFor(current);
    const res = await fetch(current, {
      method, body, signal,
      redirect: "manual",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...(cookie ? { cookie } : {}),
        ...headers
      }
    });
    storeCookies(current, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { res, finalUrl: current };
      try { res.body?.cancel?.(); } catch { /* ignore */ }
      current = new URL(loc, current).href;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET"; body = undefined;
        delete headers["content-type"]; delete headers["content-length"];
      }
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("too many redirects");
}

// ── HTML helpers ──
export function htmlToText(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
const stripTags = (s) => htmlToText(s).replace(/\s+/g, " ").trim();
function decodeXml(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
}
function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  return m ? stripTags(m[1]).slice(0, 120) : "";
}
function parseLinks(html, base) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m, n = 1;
  while ((m = re.exec(html)) && out.length < 60) {
    let abs;
    try { abs = new URL(m[1], base).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    const text = stripTags(m[2]).slice(0, 90);
    const key = abs + "|" + text;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ n: n++, text, url: abs });
  }
  return out;
}
function parseForms(html, base) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html)) && forms.length < 10) {
    const attrs = m[1], body = m[2];
    const get = (a, s) => { const r = new RegExp(a + `\\s*=\\s*["']([^"']*)["']`, "i").exec(s); return r ? r[1] : ""; };
    let action;
    try { action = new URL(get("action", attrs) || base, base).href; } catch { action = base; }
    const method = (get("method", attrs) || "get").toLowerCase();
    const fields = {};
    const inRe = /<(input|textarea|select)\b([^>]*)>/gi;
    let im;
    while ((im = inRe.exec(body))) {
      const name = get("name", im[2]);
      if (!name) continue;
      const type = (get("type", im[2]) || "text").toLowerCase();
      if (["submit", "button", "image", "file"].includes(type)) continue;
      fields[name] = get("value", im[2]) || "";
    }
    forms.push({ action, method, fields });
  }
  return forms;
}

// ── the AI's page state (its own "tab", shares the cookie jar) ──
let aiPage = null; // { url, title, html, text, links }

function pageReport(html, finalUrl, status, ctx) {
  const text = htmlToText(html);
  const links = parseLinks(html, finalUrl);
  aiPage = { url: finalUrl, title: titleOf(html) || finalUrl, html, text, links };
  ctx?.onBrowse?.(finalUrl);
  const linkList = links.slice(0, 30).map((l) => `[${l.n}] ${l.text} — ${l.url}`).join("\n");
  return `TITLE: ${aiPage.title}\nURL: ${finalUrl} (HTTP ${status})\n\nPAGE TEXT:\n` +
    text.slice(0, 8000) + (text.length > 8000 ? "\n...[truncated]" : "") +
    `\n\nLINKS ON PAGE (use browser_click with a [number]):\n${linkList || "(none)"}`;
}

export async function aiOpen(url, ctx) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const { res, finalUrl } = await fetchRaw(url, { signal: AbortSignal.timeout(20000) });
  const ct = res.headers.get("content-type") || "";
  if (!/html|xml|text|json/i.test(ct)) {
    try { res.body?.cancel?.(); } catch { /* ignore */ }
    return `opened ${finalUrl} — binary content (${ct}, ${res.headers.get("content-length") || "?"} bytes). ` +
      `Use browser_download to save it to the user's Downloads folder.`;
  }
  const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
  return pageReport(html, finalUrl, res.status, ctx);
}

export async function aiSearch(query, ctx) {
  const preferred = ctx?.config?.ui?.searchEngine || "google";
  if (isNewsQuery(query)) {
    const news = await aiNewsSearch(query, preferred, ctx);
    if (news) return news;
  }
  const found = await collectSearchCandidates(query, preferred);
  if (!found.results.length) return `no results found for "${query}" (the search page may have changed or the network is down)`;
  aiPage = { url: found.url, title: `Search: ${query}`, html: found.html, text: "", links: found.results };
  const note = found.usedEngine !== preferred ? `\n(search fallback used ${found.usedEngine})` : "";
  return `WEB SEARCH RESULTS for "${query}"${note} (use browser_click with a [number] to open one):\n\n` +
    found.results.map((r, i) => `[${r.n}] ${r.text}\n    ${r.url}${found.snippets[i] ? "\n    " + found.snippets[i] : ""}`).join("\n\n");
}

async function collectSearchCandidates(query, preferred) {
  const engines = preferred === "bing" ? ["bing", "duckduckgo"] :
    preferred === "duckduckgo" ? ["duckduckgo"] :
    ["google", "bing", "duckduckgo"];
  let url = "", html = "", results = [], snippets = [], usedEngine = engines[0];
  for (const engine of engines) {
    url = searchPageUrl(engine, query, true);
    try {
      const { res } = await fetchRaw(url, { signal: AbortSignal.timeout(6500) });
      html = await res.text();
      ({ results, snippets } = parseSearchResults(engine, html));
      if (results.length) { usedEngine = engine; break; }
    } catch {
      results = []; snippets = [];
    }
  }
  return { url, html, results, snippets, usedEngine };
}

const PRIMARY_SOURCE_HOSTS = new Set([
  "who.int", "cdc.gov", "nih.gov", "fda.gov", "sec.gov", "irs.gov", "nasa.gov",
  "w3.org", "ietf.org", "iso.org", "developer.mozilla.org", "docs.github.com",
  "learn.microsoft.com", "developers.google.com", "developers.cloudflare.com",
  "platform.openai.com", "docs.anthropic.com", "docs.python.org", "nodejs.org"
]);
const LOW_AUTHORITY_HOSTS = /(^|\.)(reddit\.com|quora\.com|pinterest\.|facebook\.com|tiktok\.com|x\.com)$/i;

export function researchAuthority(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return { score: -100, label: "invalid" }; }
  if (host.endsWith(".gov") || host.endsWith(".mil")) return { score: 80, label: "government primary source" };
  if (PRIMARY_SOURCE_HOSTS.has(host)) return { score: 70, label: "official primary source" };
  if (host.endsWith(".edu")) return { score: 55, label: "academic source" };
  if (/^(docs|developer|developers|support)\./.test(host)) return { score: 45, label: "official documentation" };
  if (LOW_AUTHORITY_HOSTS.test(host)) return { score: -30, label: "community source" };
  return { score: 10, label: "web source" };
}

function researchTerms(query) {
  const stop = new Set(["about", "after", "before", "could", "does", "from", "have", "into", "official", "should", "that", "their", "there", "these", "this", "what", "when", "where", "which", "with", "would"]);
  return [...new Set(String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) || [])]
    .filter((term) => !stop.has(term));
}

export function rankResearchCandidates(results, snippets = [], policy = "authoritative", query = "") {
  const terms = researchTerms(query);
  const scored = results.map((item, index) => {
    const authority = researchAuthority(item.url);
    let host = "";
    try { host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* invalid ranks last */ }
    const policyWeight = policy === "broad" ? 0.25 : policy === "balanced" ? 0.65 : 1;
    const searchText = `${item.text || ""} ${snippets[index] || ""} ${item.url || ""}`.toLowerCase();
    const relevance = terms.reduce((score, term) => score + (searchText.includes(term) ? 9 : 0), 0);
    return { ...item, snippet: snippets[index] || "", host, authority: authority.label, score: authority.score * policyWeight + relevance };
  }).sort((a, b) => b.score - a.score);
  const hostUses = new Map();
  for (const item of scored) {
    const uses = hostUses.get(item.host) || 0;
    item.score -= uses * 35;
    hostUses.set(item.host, uses + 1);
  }
  return scored.sort((a, b) => b.score - a.score);
}

function researchPageText(html, fallback = "", query = "") {
  const lines = htmlToText(html)
    .split(/\n+/).map((line) => line.trim())
    .filter((line) => line.length >= 35 && !/^(menu|sign in|log in|cookie|privacy|advertisement|skip to)/i.test(line));
  const terms = researchTerms(query);
  if (!lines.length) return (fallback || "No extract available.").slice(0, 1800);
  const ranked = lines.map((line, index) => ({
    index,
    score: terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? 1 : 0), 0)
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 6);
  if (!ranked.length) return lines.join("\n").slice(0, 1800);
  const selected = new Set();
  for (const item of ranked) {
    selected.add(item.index);
    if (item.index > 0) selected.add(item.index - 1);
    if (item.index + 1 < lines.length) selected.add(item.index + 1);
  }
  return [...selected].sort((a, b) => a - b).map((index) => lines[index]).join("\n").slice(0, 1800);
}

export function formatResearchEvidence(query, items) {
  return `RESEARCH EVIDENCE for "${query}"\n` +
    "Answer the user's question from this evidence. Cite factual claims with [1], [2], etc. Do not invent citations.\n\n" +
    items.map((item, index) => `[${index + 1}] ${item.title || item.text || item.url}\n` +
      `Source: ${item.host || item.url} | ${item.authority || "web source"}${item.published ? ` | Published: ${item.published}` : ""}\n` +
      `URL: ${item.url}\nEvidence: ${item.evidence || item.snippet || "No extract available."}`).join("\n\n");
}

export async function aiResearch(query, args = {}, ctx) {
  const preferred = ctx?.config?.ui?.searchEngine || "google";
  const policy = ["authoritative", "balanced", "broad"].includes(args.source_policy)
    ? args.source_policy : (ctx?.config?.ui?.researchPolicy || "authoritative");
  const maxSources = Math.max(2, Math.min(6, Number(args.max_sources || 4)));
  const found = await collectSearchCandidates(query, preferred);
  if (!found.results.length) return `no research sources found for "${query}"`;
  const ranked = rankResearchCandidates(found.results, found.snippets, policy, query).slice(0, maxSources);
  const items = await Promise.all(ranked.map(async (item) => {
    try {
      const { res, finalUrl } = await fetchRaw(item.url, { signal: AbortSignal.timeout(10000) });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !/html|xml|text|json/i.test(type)) throw new Error("not readable");
      const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
      let published = "";
      const date = /<(?:meta|time)[^>]+(?:datePublished|article:published_time|datetime)[^>]+(?:content|datetime)=["']([^"']+)/i.exec(html);
      if (date) published = date[1].slice(0, 40);
      let host = item.host;
      try { host = new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* keep */ }
      return { ...item, url: finalUrl, host, title: titleOf(html) || item.text, published, evidence: researchPageText(html, item.snippet, query) };
    } catch {
      return { ...item, title: item.text, evidence: item.snippet || "The source could not be opened; use only the title and URL." };
    }
  }));
  aiPage = { url: found.url, title: `Research: ${query}`, html: found.html, text: "", links: items.map((item, index) => ({ n: index + 1, text: item.title, url: item.url })) };
  return formatResearchEvidence(query, items);
}

function isNewsQuery(query) {
  return /\b(news|headline|headlines|top stories|breaking)\b/i.test(String(query || ""));
}

async function aiNewsSearch(query, preferred, ctx) {
  const generalTop = /\b(top news|headlines|today|united states|u\.s\.|us)\b/i.test(query);
  const rssUrl = generalTop
    ? "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"
    : "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  try {
    const { res } = await fetchRaw(rssUrl, { signal: AbortSignal.timeout(6500) });
    const xml = await res.text();
    const items = [];
    const re = /<item\b[\s\S]*?<\/item>/gi;
    let m;
    while ((m = re.exec(xml)) && items.length < 10) {
      const block = m[0];
      const title = decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] || "");
      const link = decodeXml(/<link>([\s\S]*?)<\/link>/i.exec(block)?.[1] || "");
      const source = decodeXml(/<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(block)?.[1] || "");
      const pub = decodeXml(/<pubDate>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1] || "");
      if (!title || !/^https?:/i.test(link)) continue;
      items.push({ n: items.length + 1, text: title.slice(0, 140), url: link, source, pub });
    }
    if (!items.length) return "";
    aiPage = { url: rssUrl, title: `News: ${query}`, html: xml, text: "", links: items.map(({ n, text, url }) => ({ n, text, url })) };
    return `CURRENT NEWS HEADLINES for "${query}" (summarize these stories; do not answer with a list of news sites):\n\n` +
      items.map((r) => `[${r.n}] ${r.text}\n    ${r.source ? "Source: " + r.source + "\n    " : ""}${r.pub ? "Published: " + r.pub + "\n    " : ""}${r.url}`).join("\n\n");
  } catch {
    return "";
  }
}

function searchPageUrl(engine, query, fetchable = false) {
  const q = encodeURIComponent(query);
  if (engine === "bing") return `https://www.bing.com/search?q=${q}`;
  if (engine === "duckduckgo") return fetchable ? `https://html.duckduckgo.com/html/?q=${q}` : `https://duckduckgo.com/?q=${q}`;
  return `https://www.google.com/search?q=${q}`;
}

function parseSearchResults(engine, html) {
  const results = [];
  const snippets = [];
  if (engine === "duckduckgo") {
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 10) {
    let href = m[1];
    const dec = /uddg=([^&"]+)/.exec(href);
    if (dec) { try { href = decodeURIComponent(dec[1]); } catch { /* keep */ } }
    if (!/^https?:/i.test(href)) continue;
    results.push({ n: results.length + 1, text: stripTags(m[2]).slice(0, 100), url: href });
  }
    snippets.push(...[...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((s) => stripTags(s[1]).slice(0, 200)));
    return { results, snippets };
  }
  if (engine === "bing") {
    const re = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < 10) {
      const href = m[1];
      if (!/^https?:/i.test(href) || /bing\.com\/(search|ck\/a)/i.test(href)) continue;
      results.push({ n: results.length + 1, text: stripTags(m[2]).slice(0, 100), url: href });
      const block = m[0];
      const sn = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      snippets.push(sn ? stripTags(sn[1]).slice(0, 200) : "");
    }
    return { results, snippets };
  }
  const re = /<a[^>]+href="\/url\?q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 10) {
    let href = "";
    try { href = decodeURIComponent(m[1]); } catch { href = m[1]; }
    if (!/^https?:/i.test(href) || /google\./i.test(new URL(href).hostname)) continue;
    const text = stripTags(m[2]).replace(/^(Cached|Similar)\s+/i, "").slice(0, 100);
    if (!text) continue;
    results.push({ n: results.length + 1, text, url: href });
    snippets.push("");
  }
  return { results, snippets };
}

export async function aiClick(link, ctx) {
  if (!aiPage || !aiPage.links?.length) return "no page is open yet — use browser_open or web_search first.";
  const s = String(link ?? "").trim();
  const num = parseInt(s.replace(/[^\d]/g, ""), 10);
  let hit = Number.isFinite(num) ? aiPage.links.find((l) => l.n === num) : null;
  if (!hit && s) {
    const sl = s.toLowerCase();
    hit = aiPage.links.find((l) => l.text.toLowerCase() === sl) ||
          aiPage.links.find((l) => l.text.toLowerCase().includes(sl));
  }
  if (!hit) return `no link matching "${s}" on the current page. Links:\n` +
    aiPage.links.slice(0, 30).map((l) => `[${l.n}] ${l.text}`).join("\n");
  return await aiOpen(hit.url, ctx);
}

export async function aiForm(args, ctx) {
  if (!aiPage?.html) return "no page is open yet — use browser_open first.";
  const forms = parseForms(aiPage.html, aiPage.url);
  if (!forms.length) return "no forms found on the current page.";
  const idx = Math.min(Math.max(0, (args.form || 1) - 1), forms.length - 1);
  const f = forms[idx];
  const fields = { ...f.fields, ...(args.fields || {}) };
  const qs = new URLSearchParams(fields).toString();
  let out;
  if (f.method === "post") {
    out = await fetchRaw(f.action, {
      method: "POST", body: qs, signal: AbortSignal.timeout(20000),
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
  } else {
    const sep = f.action.includes("?") ? "&" : "?";
    out = await fetchRaw(f.action + sep + qs, { signal: AbortSignal.timeout(20000) });
  }
  const html = (await out.res.text()).slice(0, MAX_PAGE_BYTES);
  return "form submitted.\n\n" + pageReport(html, out.finalUrl, out.res.status, ctx);
}

export async function aiDownload(url, filename, ctx) {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const { res, finalUrl } = await fetchRaw(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return `download failed: HTTP ${res.status} from ${finalUrl}`;
  const dir = path.join(os.homedir(), "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  let name = (filename || "").replace(/[\\/:*?"<>|]/g, "").trim();
  if (!name) {
    const cd = res.headers.get("content-disposition") || "";
    const cm = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    name = cm ? decodeURIComponent(cm[1].replace(/"/g, "")) : path.basename(new URL(finalUrl).pathname) || "download";
  }
  let dest = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(name);
    dest = path.join(dir, `${path.basename(name, ext)} (${i++})${ext}`);
  }
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  for await (const chunk of res.body) { bytes += chunk.length; out.write(chunk); }
  await new Promise((r) => out.end(r));
  return `✓ downloaded ${Math.round(bytes / 1024)} KB to ${dest}`;
}
