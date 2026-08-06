import assert from "node:assert/strict";
import test from "node:test";

import { BOOLEAN_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";
import { projectBrief, systemPrompt } from "../src/agent.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("Boolean does not override a model with a product-authored planning mode", () => {
  const prompts = ["auto", "quick", "plan-first"].map((planningMode) =>
    systemPrompt("", false, { ui: { codingAgent: { planningMode } } })
  );
  assert.equal(new Set(prompts).size, 1);
  assert.doesNotMatch(prompts[0], /PLANNING MODE|Blocking questions \(0-3|wait for one user approval/i);
});

test("project builds require an early persistent live preview", (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-preview-policy-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const prompt = projectBrief(projectDir);
  assert.match(prompt, /LIVE PROJECT PREVIEW/);
  assert.match(prompt, /call run_project as soon as the existing project can start/);
  assert.match(prompt, /Never use a file:\/\/ URL/);
});
