import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("active work uses one accessible Codex-style message card", () => {
  assert.match(ui, /className="status working-card active"/);
  assert.match(ui, /setAttribute\("role","status"\)/);
  assert.match(ui, /setAttribute\("aria-live","polite"\)/);
  assert.match(ui, /data-working-action="output"/);
  assert.match(ui, /data-working-action="cancel"/);
  assert.match(ui, /class="working-card-events" aria-label="Task activity"/);
  assert.match(ui, /\.status\.working-card\{[^}]*width:min\(100%,640px\)/s);
});

test("commentary, tools, approvals, and changed files update the work card", () => {
  assert.match(ui, /ev\.kind==="commentary"\) addWorkingActivity/);
  assert.match(ui, /trackWorkingFiles\(ev\.entry\)/);
  assert.match(ui, /key:"tool:"\+toolGroupKey\(ev\.entry\)/);
  assert.match(ui, /addWorkingActivity\("Waiting for approval"/);
  assert.match(ui, /addWorkingActivity\("Waiting for your input"/);
  assert.match(ui, /name==="apply_patch"/);
  assert.match(ui, /title:"Edited "\+files\.length/);
});

test("the same work card becomes a truthful completion summary", () => {
  assert.match(ui, /function finalizeWorkingCard\(ref\)/);
  assert.match(ui, /"Worked for "\+elapsed/);
  assert.match(ui, /"Paused after "\+elapsed\+" - work saved"/);
  assert.match(ui, /"Stopped after "\+elapsed\+" - work saved"/);
  assert.match(ui, /card\.classList\.add\("finalized",outcome,"collapsed"\)/);
  assert.match(ui, /if\(ref\.liveAI\?\.isConnected\) col\.insertBefore\(card,ref\.liveAI\)/);
  assert.match(ui, /const finishedCard=threadId===tid\?finalizeWorkingCard\(finishedRun\):null/);
  assert.doesNotMatch(ui, /if\(run&&run\.statusEl&&run\.statusEl\.isConnected\) run\.statusEl\.remove\(\)/);
});

test("raw live output stays behind Show output and is restored when work ends", () => {
  assert.match(ui, /\.run-output-hidden \.live-run-output:not\(\.live-plan-output\)\{ display:none; \}/);
  assert.match(ui, /col\.classList\.add\("run-output-hidden"\)/);
  assert.match(ui, /ref\.outputVisible=!ref\.outputVisible/);
  assert.match(ui, /col\.classList\.remove\("run-output-hidden"\)/);
});
