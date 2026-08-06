// Detect local development servers that are currently listening, so the browser
// can offer them as one-click entries instead of making the user remember ports.
import { spawnSync } from "node:child_process";

// Ports below this are almost always system services, not dev servers.
const MIN_DEV_PORT = 1024;
// Windows/system listeners that are never interesting in a browser.
const IGNORED_PORTS = new Set([
  135, 139, 445, 5040, 7680,             // RPC / SMB / delivery optimization
  5357,                                   // WSDAPI (always "Service Unavailable")
  16992, 16993, 16994, 16995,             // Intel AMT
  49664, 49665, 49666, 49667, 49668, 49669, 49670
]);

function listeningPorts() {
  const ports = new Set();
  try {
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 4000 });
    const text = String(out.stdout || "");
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      // e.g. "  TCP    127.0.0.1:8765   0.0.0.0:0   LISTENING   1234"
      const match = line.match(/\s(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d+)\s/);
      if (!match) continue;
      const port = Number(match[1]);
      if (!Number.isFinite(port) || port < MIN_DEV_PORT || port > 65535) continue;
      if (IGNORED_PORTS.has(port)) continue;
      ports.add(port);
    }
  } catch {
    /* netstat unavailable — fall back to an empty list */
  }
  return [...ports].sort((a, b) => a - b);
}

function titleFrom(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, 60);
}

// Probe one port for an HTTP server and read its page title for a friendly name.
async function probe(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const type = String(response.headers.get("content-type") || "");
    let name = "";
    if (/text\/html/i.test(type)) {
      name = titleFrom(await response.text().catch(() => ""));
    }
    return { port, url, name: name || `localhost:${port}`, status: response.status };
  } catch {
    return null; // not an HTTP server, or too slow to matter
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the local HTTP servers worth offering in the browser.
 * @param {object} options
 * @param {number} [options.timeoutMs] per-port probe budget
 * @param {number} [options.excludePort] Boollm's own port, when it should be hidden
 * @returns {Promise<Array<{port:number,url:string,name:string,status:number}>>}
 */
export async function detectLocalServers({ timeoutMs = 700, excludePort = 0, limit = 12 } = {}) {
  const ports = listeningPorts().filter((port) => port !== Number(excludePort));
  if (!ports.length) return [];
  const results = await Promise.all(ports.map((port) => probe(port, timeoutMs)));
  const seen = new Set();
  return results
    // Only pages a browser can actually show. A 404/401/503 at the root is a
    // background service, not something worth offering as a shortcut.
    .filter((item) => item && item.status < 400)
    .sort((a, b) => a.port - b.port)
    // Collapse duplicates: several instances of the same app (a few stray dev
    // servers of the same project) should read as one entry, not a wall of them.
    .filter((item) => {
      const key = item.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
