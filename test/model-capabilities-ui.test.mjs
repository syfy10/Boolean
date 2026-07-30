import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("the selected model exposes a visible capability matrix and limited-coding warning", () => {
  assert.match(ui, /id="modelCapabilityCard"/);
  assert.match(ui, /id="modelCapabilityGrid"/);
  assert.match(ui, /id="modelCapabilityBanner"/);
  assert.match(ui, /id="modelCapabilityTest"/);
  assert.match(ui, /id="modelCapabilityTestStatus"/);
  assert.match(ui, /Chat[\s\S]*Review[\s\S]*File edit[\s\S]*Terminal[\s\S]*Browser[\s\S]*Deploy[\s\S]*Vision/);
  assert.match(ui, /This model can review code but may not reliably edit or deploy/);
  assert.match(ui, /Patch only/);
});

test("unknown selected models receive one safe cached capability probe with a manual retry", () => {
  assert.match(ui, /runModelCapabilityProbe\(\{automatic:true\}\)/);
  assert.match(ui, /fetch\("\/api\/model-capabilities\/probe"/);
  assert.match(ui, /force:true/);
  assert.match(ui, /Safe check only - no tools will run/);
  assert.match(server, /p === "\/api\/model-capabilities\/probe"/);
  assert.match(server, /noStream:\s*true/);
  assert.match(server, /evaluateCapabilityProbeReply/);
});

test("coding-agent settings offer automatic, exact-patch, and review-only compatibility modes", () => {
  assert.match(ui, /id="agentCompatibilityMode"/);
  assert.match(ui, /value="auto">Auto/);
  assert.match(ui, /value="patch">Force Patch/);
  assert.match(ui, /value="review">Review only/);
  assert.match(ui, /updateCodingAgent\(\{compatibilityMode:e\.target\.value\}\)/);
});

test("recovery actions preserve saved evidence and offer patch or model alternatives", () => {
  assert.match(ui, /Use saved evidence/);
  assert.match(ui, /Create one patch/);
  assert.match(ui, /Switch model/);
  assert.match(ui, /Review only/);
});

test("state and status APIs publish the current model capability profile", () => {
  assert.match(server, /modelCapability:\s*publicModelCapability\(/);
  assert.match(server, /function publicModelCapability/);
});
