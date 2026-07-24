import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { systemPrompt } from "../src/agent.js";

const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("Boolean sends no persona, response, coding, or controller prompt to the model", () => {
  assert.equal(systemPrompt("C:\\Projects", true, {
    ui: { codingAgent: { mode: "deep", autoTest: true, autoCommit: true } }
  }), "");
  assert.match(agent, /function withTurnModeSystem\(messages, mode, config\) \{\s*return messages;\s*\}/);
  assert.match(agent, /function withActionNudge\(messages, bootstrapContext = "", projectBound = false\) \{\s*return messages;\s*\}/);
  assert.match(agent, /const withController = \(source\) => source;/);
  assert.match(agent, /const MAX_AUTO_CONTINUE = neutralModelRelay \? 0 : 8;/);
  assert.match(server, /function currentAppContext\([^)]*\) \{\s*return "";/);
  for (const hiddenDirection of [
    "You are Boolean",
    "ACTION REQUIRED",
    "CONTINUE REQUIRED",
    "BOOLEAN CONTROLLER: Do not stop yet",
    "Answer the latest message directly",
    "Keep normal replies short"
  ]) {
    assert.doesNotMatch(agent + server, new RegExp(hiddenDirection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
