// Verify create_project + run_project mechanics (no model involved).
import { executeTool, listTemplates } from "../src/tools.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const base = path.join(os.tmpdir(), "saz-tooltest-" + Date.now());
fs.mkdirSync(base, { recursive: true });
const ctx = { config: { projectsDir: base, commandTimeoutMs: 60000 }, approve: async () => true };

console.log("templates found:", listTemplates());

for (const [tpl, name] of [["website", "mysite"], ["api", "myapi"]]) {
  console.log(`\n=== ${tpl} ===`);
  console.log(await executeTool("create_project", { template: tpl, name }, ctx));
  const runResult = await executeTool("run_project", { name }, ctx);
  console.log("run_project:", runResult);
}
process.exit(0);
