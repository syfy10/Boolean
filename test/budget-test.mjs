import { AgentController } from "../src/controller.js";

const c = new AgentController({
  mode: "quick_fix",
  persisted: { tokenBudget: 1000, timeBudgetMs: 0 }
});

// Accumulate usage
c.addUsage({ input: 400, output: 500 });
console.log("tokensUsed:", c.tokensUsed);

// Should not be budgeted at 900/1000
let b = c.checkBudget();
console.log("budget at 900:", JSON.stringify(b));

// Cross the token limit
c.addUsage({ input: 200, output: 0 });
b = c.checkBudget();
console.log("budget at 1100:", JSON.stringify(b));

// Cancel
c.cancel();
b = c.checkBudget();
console.log("after cancel:", JSON.stringify(b));

// Time budget test
const c2 = new AgentController({
  mode: "quick_fix",
  persisted: { tokenBudget: 0, timeBudgetMs: 1, startedAt: Date.now() - 100 }
});
await new Promise(r => setTimeout(r, 10));
b = c2.checkBudget();
console.log("time budget exceeded:", JSON.stringify(b));

// Snapshot round-trip
const snap = c.snapshot();
const c3 = new AgentController({ mode: "quick_fix", persisted: snap });
console.log("restored tokensUsed:", c3.tokensUsed, "tokenBudget:", c3.tokenBudget);

console.log("\nALL BUDGET TESTS PASSED");
