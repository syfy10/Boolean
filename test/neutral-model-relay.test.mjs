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
  assert.ok(prompt.startsWith(booleanAgentPolicy()));
  assert.match(prompt, /PLANNING MODE: AUTO/);
  assert.equal(BOOLEAN_AGENT_RULES.length >= 10, true);
  assert.match(prompt, /latest user request/i);
  assert.match(prompt, /deploy.*require user authority/i);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /preserve unrelated user work/i);
  assert.match(prompt, /secrets/i);
  assert.match(prompt, /verification proportional to risk/i);
  assert.match(prompt, /stop inspecting and synthesize/i);
  assert.match(prompt, /do not enter recovery loops/i);
  // Neutral by default: the model owns its own tool loop unless the user opts into
  // autopilot (the controller's auto-continue stays at 0 otherwise).
  assert.match(agent, /const MAX_AUTO_CONTINUE = autopilot \? 1 : 0;/);
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
