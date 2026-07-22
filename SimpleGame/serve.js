// Tiny zero-dependency static file server (Node built-ins only).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3210;
const ROOT = __dirname;
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split("?")[0]);
  if (f === "/") f = "/index.html";
  const fp = path.join(ROOT, path.normalize(f).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("website running at http://localhost:" + PORT));
