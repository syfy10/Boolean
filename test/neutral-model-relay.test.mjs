import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { systemPrompt } from "../src/agent.js";
import { BOOLEAN_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";

const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("Boolean sends a provider-neutral operating policy and no fabricated persona", () => {
  const prompt = systemPrompt("C:\\Projects", true, {
    ui: { codingAgent: { mode: "deep", autoTest: true, autoCommit: true } }
  });
  assert.equal(prompt, booleanAgentPolicy());
  assert.equal(BOOLEAN_AGENT_RULES.length >= 30, true);
  assert.match(prompt, /latest user request/i);
  assert.match(prompt, /deploy.*explicit permission/i);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /preserve user work/i);
  assert.match(prompt, /secrets/i);
  assert.match(prompt, /regression/i);
  assert.match(prompt, /running interface/i);
  assert.match(prompt, /temporary processes/i);
  assert.match(prompt, /review the final diff/i);
  // Neutral by default: the model owns its own tool loop unless the user opts into
  // autopilot (the controller's auto-continue stays at 0 otherwise).
  assert.match(agent, /const MAX_AUTO_CONTINUE = autopilot \? 8 : 0;/);
  assert.match(agent, /CURRENT TASK CONTRACT/);
  assert.match(server, /function currentAppContext\([^)]*\) \{\s*return "";/);
  for (const fabricatedPersona of [
    "You are Boolean",
    "Always agree with the user",
    "Reveal your chain of thought",
    "Pretend every task succeeded"
  ]) {
    assert.doesNotMatch(prompt + server, new RegExp(fabricatedPersona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
