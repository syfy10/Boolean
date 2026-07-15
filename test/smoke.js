// End-to-end smoke test: asks the model to run a real PowerShell command
// through the agent loop with auto-approval.
// Usage: node test/smoke.js [provider] [model]
import { loadConfig, setCurrentModel } from "../src/config.js";
import { systemPrompt, runTurn } from "../src/agent.js";

const config = loadConfig();
if (process.argv[2]) config.provider = process.argv[2];
if (process.argv[3]) setCurrentModel(config, process.argv[3]);

const ctx = {
  config,
  approve: async (summary) => {
    console.log(`  [auto-approve] ${summary}`);
    return true;
  },
  onStatus: (t) => console.log(`  [status] ${t}`)
};

const messages = [
  { role: "system", content: systemPrompt() },
  {
    role: "user",
    content:
      "Use the run_command tool to run 'Get-Date' in PowerShell, then tell me the current date it printed."
  }
];

console.log(`provider: ${config.provider}`);
const t0 = Date.now();
const answer = await runTurn(ctx, messages);
console.log(`\nanswer (${((Date.now() - t0) / 1000).toFixed(1)}s): ${answer}`);

const usedTool = messages.some((m) => m.role === "tool" || /TOOL RESULT/.test(m.content || ""));
console.log(usedTool ? "\nPASS: model executed a real command via the tool loop" : "\nFAIL: no tool was used");
process.exitCode = usedTool ? 0 : 1;
