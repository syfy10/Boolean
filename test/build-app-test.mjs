// Can the LOCAL model actually build + run one app end-to-end via the tools?
import { loadConfig } from "../src/config.js";
import { systemPrompt, runTurn } from "../src/agent.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const config = loadConfig();
config.provider = "local";
config.autoApprove = true;
config.projectsDir = path.join(os.tmpdir(), "saz-buildtest-" + Date.now());
fs.mkdirSync(config.projectsDir, { recursive: true });

const steps = [];
const ctx = {
  config,
  approve: async () => true,
  onStatus: (t) => process.stdout.write("  · " + t + "\n"),
  onStep: (s) => steps.push(s.name),
  onUsage: () => {},
  onToken: () => {}
};

const messages = [
  { role: "system", content: systemPrompt(config.projectsDir) },
  { role: "user", content: "Build a simple website called hellosite and run it to confirm it works." }
];

const t0 = Date.now();
const answer = await runTurn(ctx, messages);
console.log(`\n--- steps: ${steps.join(" → ") || "(none)"}`);
console.log(`--- answer (${((Date.now() - t0) / 1000).toFixed(0)}s): ${answer}`);
const usedCreate = steps.includes("create_project");
const usedRun = steps.includes("run_project");
console.log(usedCreate && usedRun ? "\nPASS: model used create_project + run_project" : `\nRESULT: create=${usedCreate} run=${usedRun}`);
process.exit(0);
