import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "canvas-recorder.html"));
const out = path.join(__dirname, "boolean-email-demo.webm");
try { fs.unlinkSync(out); } catch {}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "POST" && req.url === "/save") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      fs.writeFileSync(out, Buffer.concat(chunks));
      res.writeHead(204);
      res.end();
      setTimeout(() => server.close(), 300);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const profile = path.join(process.env.TEMP || __dirname, "boolean-demo-recorder-profile");
  fs.rmSync(profile, { recursive: true, force: true });
  const args = [
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=1280,720",
    `http://127.0.0.1:${port}/`
  ];
  spawn(chrome, args, { stdio: "ignore", detached: false });
});

const timeout = setTimeout(() => {
  console.error("Timed out waiting for video.");
  process.exitCode = 1;
  server.close();
}, 120000);

server.on("close", () => {
  clearTimeout(timeout);
  if (!fs.existsSync(out)) {
    console.error("Video was not written.");
    process.exitCode = 1;
    return;
  }
  console.log(out);
});
