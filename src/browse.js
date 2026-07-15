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
  if (!results.length) return `no results found for "${query}" (the search page may have changed or the network is down)`;
  aiPage = { url, title: `Search: ${query}`, html, text: "", links: results };
  const note = usedEngine !== preferred ? `\n(search fallback used ${usedEngine})` : "";
  return `WEB SEARCH RESULTS for "${query}"${note} (use browser_click with a [number] to open one):\n\n` +
    results.map((r, i) => `[${r.n}] ${r.text}\n    ${r.url}${snippets[i] ? "\n    " + snippets[i] : ""}`).join("\n\n");
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

// ── /browse proxy for the UI browser panel ──────────────────────────────
// External sites refuse to load in iframes (X-Frame-Options / CSP), so the
// panel loads them through this proxy. Pages get a <base> tag (assets load
// directly from the real site) plus a small script that keeps navigation,
// forms, and fetch/XHR inside the proxy and bridges to the app via
// postMessage. The frame is sandboxed WITHOUT allow-same-origin, so page
// scripts can never touch the saz3 app or its API.

const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function injectedScript(realUrl) {
  return `<base href="${escAttr(realUrl)}"><script>(function(){
var BASE=${JSON.stringify(realUrl)};
var q=function(u){return "/browse?u="+encodeURIComponent(u)};
function abs(h){try{return new URL(h,BASE).href}catch(e){return null}}
function nav(){try{parent.postMessage({saz3:"nav",url:BASE,title:document.title},"*")}catch(e){}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",nav);else nav();
setTimeout(nav,800);
function go(u,nt){if(!u||!/^https?:/i.test(u))return;if(nt)parent.postMessage({saz3:"newtab",url:u},"*");else location.href=q(u);}
document.addEventListener("click",function(e){var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#"||/^(javascript|mailto|tel|data|blob):/i.test(h))return;e.preventDefault();e.stopPropagation();go(abs(h),e.ctrlKey||e.metaKey||a.target==="_blank");},true);
document.addEventListener("auxclick",function(e){if(e.button!==1)return;var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#")return;e.preventDefault();go(abs(h),true);},true);
document.addEventListener("contextmenu",function(e){var text="";try{text=String(window.getSelection?window.getSelection():"").trim();}catch(err){}if(!text)return;e.preventDefault();parent.postMessage({saz3:"selectionMenu",text:text.slice(0,200000),x:e.clientX,y:e.clientY,url:BASE,title:document.title},"*");},true);
window.open=function(u){if(u)go(abs(u),true);return null;};
document.addEventListener("submit",function(e){var f=e.target;try{var act=abs(f.getAttribute("action")||BASE)||BASE;var m=(f.getAttribute("method")||"get").toLowerCase();if(m!=="post"){e.preventDefault();var qs=new URLSearchParams(new FormData(f)).toString();var sep=act.indexOf("?")>=0?"&":"?";location.href=q(act+sep+qs);}else{f.action=q(act);}}catch(err){}},true);
var RF=window.fetch;window.fetch=function(u,o){try{var a=abs(typeof u==="string"?u:(u&&u.url));if(a&&/^https?:/i.test(a))return RF(q(a)+"&r=1",o);}catch(e){}return RF(u,o);};
var XO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{var a=abs(u);if(a&&/^https?:/i.test(a))arguments[1]=q(a)+"&r=1";}catch(e){}return XO.apply(this,arguments);};
window.addEventListener("message",function(e){var d=e.data||{};
if(d.cmd==="zoom"){try{document.documentElement.style.zoom=d.z;}catch(err){}}
else if(d.cmd==="fitZoom"){try{var de=document.documentElement,b=document.body||de,prev=de.style.zoom||1;de.style.zoom=1;var pageW=Math.max(de.scrollWidth,b.scrollWidth,de.offsetWidth,b.offsetWidth,1),viewW=Math.max(window.innerWidth||de.clientWidth,1);var z=Math.max(.3,Math.min(1.5,Math.floor((viewW/pageW)*100)/100));de.style.zoom=z;parent.postMessage({saz3:"zoomFit",z:z},"*");}catch(err){}}
else if(d.cmd==="find"){try{window.find(d.q,false,!!d.back,true);}catch(err){}}
else if(d.cmd==="getText"){var t="";try{t=d.what==="selection"?String(window.getSelection?window.getSelection():""):(document.body?document.body.innerText:"");}catch(err){}
parent.postMessage({saz3:"text",what:d.what,text:t.slice(0,200000),url:BASE,title:document.title},"*");}
else if(d.cmd==="control"){var out={saz3:"controlResult",id:d.id,ok:true,url:BASE,title:document.title};try{var q=String(d.text||d.target||"").toLowerCase().trim();
function shown(el){var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";}
function label(el){return [el.innerText,el.value,el.getAttribute("aria-label"),el.getAttribute("title"),el.getAttribute("placeholder"),el.name,el.id].filter(Boolean).join(" ").toLowerCase();}
function findEl(sel){if(!sel)return null;if(/^[.#\\[]/.test(sel)){try{var e=document.querySelector(sel);if(e&&shown(e))return e;}catch(err){}}var all=[].slice.call(document.querySelectorAll("button,a,input,textarea,select,[role=button],[onclick],[tabindex]"));return all.find(function(e){return shown(e)&&label(e).indexOf(sel)>=0;})||null;}
if(d.action==="click"){var el=findEl(q);if(!el)throw new Error("no visible element matching: "+(d.text||""));el.scrollIntoView({block:"center",inline:"center"});el.click();out.result="clicked "+(d.text||q);}
else if(d.action==="type"){var el=findEl(q)||document.activeElement;if(!el)throw new Error("no active input");el.focus();var text=String(d.value||"");if("value" in el){el.value=text;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}else{document.execCommand("insertText",false,text);}if(d.enter){el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));el.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",bubbles:true}));}out.result="typed "+text.length+" chars";}
else if(d.action==="read"){out.text=(document.body?document.body.innerText:"").slice(0,200000);out.result="URL: "+BASE+"\\nTITLE: "+document.title+"\\n\\n"+out.text;}
else throw new Error("unknown action: "+d.action);}catch(err){out.ok=false;out.error=err.message||String(err);}parent.postMessage(out,"*");}});
var lt=document.title;setInterval(function(){if(document.title!==lt){lt=document.title;nav();}},1500);
})();</` + `script>`;
}

function rewriteHtml(html, realUrl) {
  // remove CSP metas (we serve the page ourselves) and reroute meta-refresh
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, "");
  html = html.replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"';]*;\s*url=)([^"']+)/gi,
    (m, pre, u) => { try { return pre + "/browse?u=" + encodeURIComponent(new URL(u.trim(), realUrl).href); } catch { return m; } });
  const inject = injectedScript(realUrl);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + inject + "</head>");
  return inject + html;
}

const errPage = (msg) =>
  `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;color:#888;background:#fff;display:grid;place-items:center;height:95vh"><div style="max-width:420px;text-align:center"><b style="color:#444">Page failed to load</b><br><br>${escAttr(msg)}</div></body>`;

async function readReqBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/** HTTP handler for GET/POST /browse?u=<url>[&r=1][&dl=1] */
export async function handleBrowse(req, res, urlObj, config) {
  const target = urlObj.searchParams.get("u") || "";
  const raw = urlObj.searchParams.get("r") === "1";
  const forceDl = urlObj.searchParams.get("dl") === "1";
  const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8", ...cors });
    res.end(errPage("invalid or missing url"));
    return;
  }
  try {
    const opts = { method: req.method, signal: AbortSignal.timeout(30000) };
    if (req.method === "POST") {
      opts.body = await readReqBody(req);
      opts.headers = { "content-type": req.headers["content-type"] || "application/x-www-form-urlencoded" };
    }
    const { res: up, finalUrl } = await fetchRaw(target, opts);
    const ct = up.headers.get("content-type") || "application/octet-stream";
    const cd = up.headers.get("content-disposition") || "";
    const isHtml = /text\/html|application\/xhtml/i.test(ct);
    const isDownload = forceDl || /attachment/i.test(cd);

    if (isDownload) {
      const perms = config?.ui?.browserPerms || {};
      if (perms.downloads === false) {
        try { up.body?.cancel?.(); } catch { /* ignore */ }
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", ...cors });
        res.end(errPage("Downloads are disabled — enable them in Settings → Browser."));
        return;
      }
      const name = path.basename(new URL(finalUrl).pathname) || "download";
      res.writeHead(up.status, {
        "content-type": ct, ...cors,
        "content-disposition": cd || `attachment; filename="${name.replace(/"/g, "")}"`
      });
      for await (const chunk of up.body) res.write(chunk);
      res.end();
      return;
    }

    if (isHtml && !raw) {
      const buf = Buffer.from(await up.arrayBuffer());
      const charset = (/charset=([\w-]+)/i.exec(ct) || [])[1] || "utf-8";
      let html;
      try { html = new TextDecoder(charset).decode(buf); } catch { html = buf.toString("utf8"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors });
      res.end(rewriteHtml(html, finalUrl));
      return;
    }

    // raw passthrough (subresources, JSON, images, pdf, …)
    res.writeHead(up.status, { "content-type": ct, ...cors });
    if (up.body) for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "text/html; charset=utf-8", ...cors });
    res.end(errPage(err.message || "network error"));
  }
}
