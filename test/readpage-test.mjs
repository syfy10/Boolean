// Verify the read_page tool extracts visible text from a live page.
import { executeTool } from "../src/tools.js";
import { spawn } from "node:child_process";
import path from "node:path";

// start the website template server
const dir = path.join(process.cwd(), "templates", "website");
const srv = spawn("node", ["serve.js"], { cwd: dir, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 3000));

const ctx = { config: { ui: { aiBrowser: true } }, browserUrl: "http://localhost:3210" };
const result = await executeTool("read_page", {}, ctx);
console.log("read_page result:\n" + result.slice(0, 400));

const ok = /It works|My Website|starter/i.test(result);
console.log(ok ? "\nPASS: AI read the visible page text" : "\nFAIL: text not found");
srv.kill();
process.exit(ok ? 0 : 1);
