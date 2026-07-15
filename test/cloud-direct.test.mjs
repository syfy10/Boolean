import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { runTurn, systemPrompt } from "../src/agent.js";

test("cloud providers receive current-event questions without local preflight answers", async (t) => {
  let requestBody = null;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requestBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "The cloud model handled this question." } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const port = server.address().port;
  const config = {
    provider: "openai",
    openai: {
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-cloud-model",
      apiKey: "test-key"
    },
    maxToolTurns: 3,
    autoApprove: false,
    projectsDir: "",
    ui: {
      aiBrowser: true,
      contextMode: "balanced",
      referenceChatMemory: true,
      learnedMemory: false
    },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt("", false, config) },
    { role: "user", content: "When is the FIFA World Cup final?" }
  ];

  const answer = await runTurn({
    config,
    approve: async () => false,
    onStatus() {},
    onStep() {},
    onUsage() {}
  }, messages);

  assert.equal(answer, "The cloud model handled this question.");
  assert.equal(requestBody.model, "test-cloud-model");
  assert.equal(requestBody.messages.at(-1).content, "When is the FIFA World Cup final?");
  assert.ok(Array.isArray(requestBody.tools), "cloud model should retain access to app tools");
  assert.equal(messages.at(-1).content, answer);
});
