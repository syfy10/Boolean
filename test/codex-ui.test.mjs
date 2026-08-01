import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("Codex questions and approvals survive active-task navigation", () => {
  assert.match(ui, /pendingApprovals:\[\], pendingCodexInputs:\[\]/);
  assert.match(ui, /function syncRunPendingActionsFromState\(\)/);
  assert.match(ui, /run\.pendingApprovals=merge\(run\.pendingApprovals,state\.codexPendingApprovals,resolvedApprovalIds\)/);
  assert.match(ui, /run\.pendingCodexInputs=merge\(run\.pendingCodexInputs,state\.codexPendingInputs,resolvedCodexInputIds\)/);
  assert.match(ui, /if\(viewingRun\(\)\)\{ run\.statusEl=null; run\.liveAI=null; syncRunPendingActionsFromState\(\);/);
  assert.match(ui, /run\.pendingCodexInputs=\(run\.pendingCodexInputs\|\|\[\]\).*\.concat\(ev\)/);
  assert.match(ui, /for\(const ev of run\.pendingCodexInputs\|\|\[\]\)/);
});

test("Codex approval cards honor backend decisions and show action context", () => {
  assert.match(ui, /ev\.availableDecisions\?\?ev\.allowedDecisions\?\?ev\.decisions/);
  assert.match(ui, /ev\.commandActions\|\|context\.commandActions\|\|params\.commandActions/);
  assert.match(ui, /ev\.changes\|\|context\.changes\|\|params\.changes/);
  assert.match(ui, /ev\.networkApprovalContext\|\|context\.networkApprovalContext\|\|params\.networkApprovalContext/);
  assert.match(ui, /data-decision="'\+decision\+'"/);
  assert.match(ui, /button\.onclick=\(\)=>decide\(button\.dataset\.decision\)/);
});

test("Codex is enabled only after a successful app-server check", () => {
  assert.match(ui, /async function checkAndEnableCodex/);
  assert.match(ui, /saveCodexSettings\(\{enabled:false,command\}\)[\s\S]*refreshCodexStatus\(\{start:true,quiet:true\}\)[\s\S]*result\.ok!==true\|\|result\.ready!==true[\s\S]*saveCodexSettings\(\{enabled:true,command\}\)/);
  assert.match(ui, /catch\(error\)\{[\s\S]*enabled:false,command,error:/);
  assert.match(ui, /if\(enabled\)\{ codexSetupOpen=true; renderCodexSettings\(\); await checkAndEnableCodex\(\); return; \}/);
  assert.doesNotMatch(ui, /const enabled=button\.dataset\.runtime==="codex";\s*if\(!await saveCodexSettings\(\{enabled\}\)\)/);
});

test("Codex question dismissal is described as Skip, not an interrupt", () => {
  assert.match(ui, /<button class="deny">Skip<\/button>/);
  assert.match(ui, /textContent:skipped\?"skipped":"sent"/);
  assert.doesNotMatch(ui, /<button class="deny">Cancel<\/button>'; card\.appendChild\(buttons\)/);
});

test("Codex prompts disappear when app-server resolves them elsewhere", () => {
  assert.match(ui, /ev\.type==="codexRequestResolved"/);
  assert.match(ui, /resolvedApprovalIds\.add\(id\)/);
  assert.match(ui, /resolvedCodexInputIds\.add\(id\)/);
  assert.match(ui, /data-codex-input-id/);
});
