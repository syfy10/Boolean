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

test("Codex is enabled only after a successful check and ChatGPT sign-in", () => {
  assert.match(ui, /async function checkAndEnableCodex/);
  assert.match(ui, /saveCodexSettings\(\{enabled:false,command\}\)[\s\S]*checkCodexConnection\(\{command,quiet:true\}\)/);
  assert.match(ui, /if\(!ready\)\{[\s\S]*enabled:false,command[\s\S]*return false/);
  assert.match(ui, /if\(state\.codex\?\.account\?\.signedIn!==true\)\{[\s\S]*enabled:false,command[\s\S]*return false/);
  assert.match(ui, /saveCodexSettings\(\{enabled:true,command\}\)/);
  assert.match(ui, /if\(state\.codex\?\.ready===true&&state\.codex\?\.account\?\.signedIn===true\)\{ await checkAndEnableCodex\(\{quiet:true\}\); return; \}/);
  assert.doesNotMatch(ui, /const enabled=button\.dataset\.runtime==="codex";\s*if\(!await saveCodexSettings\(\{enabled\}\)\)/);
});

test("Codex reconnects after Boolean restarts even when Auto is selected", () => {
  assert.match(ui, /if\(!state\.codex\?\.ready&&!codexAutoCheckStarted\)\{ codexAutoCheckStarted=true; whenIdle\(\(\)=>refreshCodexStatus\(\{start:true,quiet:true\}\)\); \}/);
  assert.doesNotMatch(ui, /if\(state\.codex\?\.enabled===true&&!state\.codex\.ready&&!codexAutoCheckStarted\)/);
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
