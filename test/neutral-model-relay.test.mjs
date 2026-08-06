import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { systemPrompt } from "../src/agent.js";
import { BOOLLM_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";

const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("Boollm sends a provider-neutral operating policy and no fabricated persona", () => {
  const prompt = systemPrompt("C:\\Projects", true, {
    ui: { codingAgent: { mode: "deep", autoTest: true, autoCommit: true } }
  });
  assert.ok(prompt.startsWith(booleanAgentPolicy()));
  assert.doesNotMatch(prompt, /PLANNING MODE|wait for one user approval/i);
  assert.equal(BOOLLM_AGENT_RULES.length >= 10, true);
  assert.match(prompt, /latest user request/i);
  assert.match(prompt, /deploy.*require user authority/i);
  assert.match(prompt, /read-only/i);
  assert.match(prompt, /preserve unrelated user work/i);
  assert.match(prompt, /secrets/i);
  assert.match(prompt, /verification proportional to risk/i);
  assert.match(prompt, /stop inspecting and synthesize/i);
  assert.match(prompt, /do not enter recovery loops/i);
  // Normal mode must finish an already-started task. Autopilot expands the
  // consecutive correction window, while real tool progress resets it.
  assert.match(agent, /const MAX_AUTO_CONTINUE = autopilot \? 6 : 3;/);
  assert.match(agent, /completionNudges = 0;/);
  assert.match(agent, /CURRENT TASK CONTRACT/);
  assert.match(server, /function currentAppContext\([^)]*\) \{\s*return "";/);
  for (const fabricatedPersona of [
    "You are Boollm",
    "Always agree with the user",
    "Reveal your chain of thought",
    "Pretend every task succeeded"
  ]) {
    assert.doesNotMatch(prompt + server, new RegExp(fabricatedPersona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
