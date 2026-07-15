// Zero-dependency JSON API using only Node built-ins.
// Add your own routes in the `routes` table below.
const http = require("http");

const PORT = 3300;

// in-memory data (swap for a real DB later)
const items = [{ id: 1, name: "first item" }];
let nextId = 2;

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && p === "/api/items") return send(res, 200, items);
  if (req.method === "POST" && p === "/api/items") {
    const body = await readJson(req);
    const item = { id: nextId++, name: body.name || "unnamed" };
    items.push(item);
    return send(res, 201, item);
  }
  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log("API running at http://localhost:" + PORT + "/api/health"));
