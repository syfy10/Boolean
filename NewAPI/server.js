// Zero-dependency REST API using only Node built-ins.
// Full CRUD: GET /api/items, GET /api/items/:id, POST /api/items, PUT /api/items/:id, DELETE /api/items/:id
const http = require("http");

const PORT = 3300;

// in-memory data (swap for a real DB later)
let items = [];
let nextId = 1;

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

// Route: /api/items/:id  — extracts numeric id or returns null
function parseItemId(pathname) {
  const m = pathname.match(/^\/api\/items\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // Health check
  if (req.method === "GET" && p === "/api/health")
    return send(res, 200, { ok: true, itemCount: items.length });

  // List all items
  if (req.method === "GET" && p === "/api/items")
    return send(res, 200, { data: items, count: items.length });

  // Get single item
  if (req.method === "GET" && p.startsWith("/api/items/")) {
    const id = parseItemId(p);
    if (id === null) return send(res, 400, { error: "invalid id" });
    const item = items.find((i) => i.id === id);
    if (!item) return send(res, 404, { error: "item not found", id });
    return send(res, 200, item);
  }

  // Create item
  if (req.method === "POST" && p === "/api/items") {
    const body = await readJson(req);
    if (!body.name || typeof body.name !== "string") return send(res, 400, { error: "'name' (string) is required" });
    const item = { id: nextId++, name: body.name.trim(), description: body.description || null, createdAt: new Date().toISOString() };
    items.push(item);
    return send(res, 201, item);
  }

  // Update item
  if (req.method === "PUT" && p.startsWith("/api/items/")) {
    const id = parseItemId(p);
    if (id === null) return send(res, 400, { error: "invalid id" });
    const body = await readJson(req);
    const item = items.find((i) => i.id === id);
    if (!item) return send(res, 404, { error: "item not found", id });
    if (body.name !== undefined) item.name = String(body.name).trim();
    if (body.description !== undefined) item.description = body.description;
    item.updatedAt = new Date().toISOString();
    return send(res, 200, item);
  }

  // Delete item
  if (req.method === "DELETE" && p.startsWith("/api/items/")) {
    const id = parseItemId(p);
    if (id === null) return send(res, 400, { error: "invalid id" });
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return send(res, 404, { error: "item not found", id });
    const removed = items.splice(idx, 1)[0];
    return send(res, 200, { deleted: removed });
  }

  send(res, 404, { error: "not found", method: req.method, path: p });
});

server.listen(PORT, () => console.log("API running at http://localhost:" + PORT + "/api/health"));
