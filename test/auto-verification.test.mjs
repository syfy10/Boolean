import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runTurn, systemPrompt } from "../src/agent.js";
import { resetAutoModelHealth } from "../src/model-router.js";

async function mockServer(handler) {
  const requests = [];
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    calls++;
    const message = await handler(calls);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, port: server.address().port };
}

test("codingEngine:auto with only one model finishes instead of looping on verification", async (t) => {
  resetAutoModelHealth();
  // Model returns a valid final answer every time. With one connected model there
  // is no independent reviewer — the run must accept the answer, not re-answer.
  const mock = await mockServer(() => ({ role: "assistant", content: "No — I can't place trades, but here is what I can do." }));
  t.after(() => mock.server.close());
  const cfg = {
    provider: "openai", codingEngine: "auto",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "solo", apiKey: "test" },
    modelCapabilities: {}, autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, autoRouteModels: false, codingAgent: { autopilot: true, autoHandoff: true } },
    connectors: { mcp: [], agents: [] }
  };
  const steps = [];
  const answer = await runTurn({
    config: cfg, approve: async () => true,
    onStatus() {}, onStep(s) { steps.push(s); }, onUsage() {}, onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt("", true, cfg) },
    { role: "user", content: "Buy or sell 5 shares of NVDA for me." }
  ]);

  assert.match(answer, /can't place trades/, "the model's answer is returned, not a paused/looped result");
  assert.ok(mock.requests.length <= 3, `must not re-answer in a loop (saw ${mock.requests.length} calls)`);
  const verif = steps.filter((s) => s.name === "independent_verification");
  assert.ok(verif.length <= 2, "verification is hard-capped");
  if (verif.length) assert.match(String(verif[0].result), /without independent verification|no second connected model/i);
});
