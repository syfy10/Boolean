import assert from "node:assert/strict";
import test from "node:test";

import { BOOLEAN_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";
import { systemPrompt } from "../src/agent.js";

test("operating policy uses one concise Codex-style task contract", () => {
  const policy = booleanAgentPolicy();
  const required = [
    /latest user request/i,
    /task behavior from intent/i,
    /stop inspecting and synthesize/i,
    /exact selected workspace.*account.*mailbox/i,
    /preserve unrelated user work/i,
    /smallest coherent change/i,
    /security and authority separate from reasoning/i,
    /destructive actions/i,
    /current task/i,
    /Do not announce work as a substitute/i,
    /coding work/i,
    /verification proportional to risk/i,
    /Never claim/i,
    /build is not a deployment/i,
    /tool failures as evidence/i,
    /Finish when the requested answer or outcome is delivered/i
  ];
  for (const pattern of required) assert.match(policy, pattern);
  assert.equal(BOOLEAN_AGENT_RULES.every((rule) => rule.length > 20), true);
});

test("planning modes scale implementation pauses to task risk", () => {
  const prompt = (planningMode) => systemPrompt("", false, { ui: { codingAgent: { planningMode } } });
  assert.match(prompt("auto"), /PLANNING MODE: AUTO[\s\S]*Work directly on clear requests[\s\S]*pause only for a genuinely blocking choice/);
  assert.match(prompt("quick"), /PLANNING MODE: QUICK[\s\S]*implement and verify immediately without stopping/);
  assert.match(prompt("plan-first"), /PLANNING MODE: PLAN FIRST[\s\S]*Blocking questions \(0-3[\s\S]*wait for one user approval[\s\S]*without requesting the same approval again/);
});
