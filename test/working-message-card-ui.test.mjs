import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("project plan output hiding never hides the live working card", () => {
  assert.match(ui, /function markCurrentPlanOutput\(\)[\s\S]*?!node\.classList\?\.contains\("working-card"\)/);
  assert.match(ui, /run\.statusEl\?\.classList\.remove\("live-plan-output"\);\s*col\.classList\.add\("plan-output-hidden"\)/);
});

function functionSource(name) {
  const start = ui.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  const body = ui.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < ui.length; index += 1) {
    if (ui[index] === "{") depth += 1;
    else if (ui[index] === "}") {
      depth -= 1;
      if (depth === 0) return ui.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is incomplete`);
}

test("active work uses one accessible inline activity timeline", () => {
  assert.match(ui, /className="status working-card active"/);
  assert.match(ui, /setAttribute\("role","status"\)/);
  assert.match(ui, /setAttribute\("aria-live","polite"\)/);
  assert.match(ui, /data-working-action="output"/);
  assert.match(ui, /data-working-action="cancel"/);
  assert.match(ui, /class="working-card-events" role="list" aria-label="Task activity"/);
  assert.match(ui, /class="working-card-worker"/);
  assert.match(ui, /function workingModelLabel\(provider,model,aiLabel=""\)/);
  assert.match(ui, /const workerLabel=workingModelLabel\(run\.provider,run\.model,run\.aiLabel\)/);
  assert.match(ui, /setTitle\(worker,"Currently working: "\+workerLabel\)/);
  assert.match(ui, /worker\.textContent="Completed by "\+completedBy/);
  assert.match(ui, /sender\.textContent="Completed by "\+run\.aiLabel/);
  assert.match(ui, /run\.workerTrail\.join\(" → "\)/);
  assert.match(ui, /ev\.escalated\?"Handed work to ":"Working with "/);
  assert.match(ui, /<span class="msg-sender">Completed by /);
  // Rows are reconciled in place rather than rebuilt from an HTML string, so
  // the element, class, and listitem role are asserted where they are set.
  assert.match(ui, /document\.createElement\(commentary\?"p":"details"\)/);
  assert.match(ui, /next\.className=commentary\?"working-commentary":"working-activity-group"/);
  assert.match(ui, /next\.setAttribute\("role","listitem"\)/);
  assert.match(ui, /<summary><span class="working-activity-glyph"/);
  // An expanded group must survive the next activity event.
  assert.match(ui, /const open=node\.open===true;[\s\S]{0,120}if\(!commentary\) node\.open=open;/);
  assert.match(ui, /\.status\.working-card\{[^}]*width:min\(100%,640px\)[^}]*border:0;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.match(ui, /\.status\.working-card\{[^}]*align-items:stretch;/s);
  assert.match(ui, /\.working-card-header\{[^}]*width:100%;[^}]*box-sizing:border-box;/s);
  assert.match(ui, /\.working-card-header\{[^}]*align-items:center;/s);
  assert.match(ui, /\.working-card-worker\{[^}]*flex:0 0 auto;[^}]*white-space:nowrap;/s);
  assert.match(ui, /\.working-card \.stx\{[^}]*min-width:120px;[^}]*flex:1 1 120px;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/s);
  assert.match(ui, /class="working-card-actions"><button class="working-card-action meta" type="button" data-working-action="steps"/);
  assert.match(ui, /\.working-card \.meta\{[^}]*display:inline-flex;[^}]*align-items:center;[^}]*min-height:24px;/s);
  assert.match(ui, /\.working-card-actions\{[^}]*align-items:center;[^}]*min-height:24px;/s);
  assert.match(ui, /\.working-card-body\{[^}]*width:100%;[^}]*box-sizing:border-box;/s);
  assert.doesNotMatch(ui, /class="working-card-current /);
  assert.doesNotMatch(ui, /class="team-run-progress"/);
});

test("Codex and Claude work labels identify the API and exact model", () => {
  const context = vm.createContext({
    friendlyModelName: value => String(value || ""),
    shortAiName: (_provider, model) => model || "AI"
  });
  vm.runInContext(functionSource("workingModelLabel"), context);
  assert.equal(context.workingModelLabel("codex", "gpt-5.6"), "Codex · gpt-5.6 · OpenAI API");
  assert.equal(context.workingModelLabel("claude-code", "opus"), "Claude Code · opus · Anthropic API");
});

test("activity is grouped into compact chronological batches", () => {
  assert.match(ui, /if\(narration\) addWorkingActivity\(narration,/);
  assert.match(ui, /trackWorkingFiles\(ev\.entry\)/);
  assert.match(ui, /function workingToolActivityGroup\(entry\)/);
  assert.match(ui, /key:"tool:"\+activityGroup\+":"\+run\.activitySequence,group:activityGroup/);
  assert.match(ui, /if\(group==="searches"\) return "Researched the needed sources"/);
  assert.match(ui, /if\(group==="commands"\) return \/check\|test\|build/);
  assert.match(ui, /if\(group==="files"\) return count===1\?"Updated a project file"/);
  assert.match(ui, /if\(group==="agents"\) return count===1\?"Asked another model for help"/);
  assert.match(ui, /if\(group==="inspections"\) return \/browser\|page\/.+\?"Checked the page":"Reviewed the project files"/);
  assert.match(ui, /workingActivityGroupLabel\(item\.group,item\.count,item\.items\)/);
  assert.match(ui, /workingChangeStatHtml\(item\.items\)/);
  assert.match(ui, /changeStat:workingStepChangeStat\(ev\.entry\)/);
  assert.match(ui, /\.working-change-stat \.add\{ color:#16a05d; \}/);
  assert.match(ui, /\.working-change-stat \.del\{ color:#df3154; \}/);
  assert.match(ui, /if\(segment\?\.kind!=="activity"\|\|segment\.group!==group\)/);
  assert.match(ui, /segments:segments\.slice\(-10\)/);
  assert.match(ui, /items:segment\.items\.slice\(-8\)/);
  assert.match(ui, /if\(segment\.identities\.has\(identity\)\)/);
  assert.doesNotMatch(ui, /const groups=new Map\(\)/);
  assert.doesNotMatch(ui, /<details class="working-activity-group"[^>]* open/);
});

test("verified file edits show exact added and removed line counts", () => {
  const context = vm.createContext({});
  vm.runInContext([
    functionSource("workingStepChangeStat"),
    functionSource("workingChangeStatHtml"),
  ].join("\n"), context);
  const stat = context.workingStepChangeStat({
    name: "apply_patch",
    verified: true,
    args: { changes: [
      { path: "src/a.js", diff: "--- a/src/a.js\n+++ b/src/a.js\n-old\n+new\n+more" },
      { path: "src/b.js", diff: "@@\n-gone\n+here" },
    ] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(stat)), { files: 2, additions: 3, deletions: 2 });
  assert.match(context.workingChangeStatHtml([{ changeStat: stat }]), />\+3<.*>-2</);
  assert.match(server, /result: step\.result, verified: step\.verified === true/);
});

test("grouped activity rows name what the work was actually done to", () => {
  const context = vm.createContext({ esc: value => String(value) });
  vm.runInContext([
    functionSource("toolCommandText"),
    functionSource("workingStepFiles"),
    functionSource("workingToolActivitySubject"),
    functionSource("workingActivitySubjectText"),
    functionSource("workingActivitySubjectHtml"),
  ].join("\n"), context);

  assert.equal(context.workingToolActivitySubject({ name: "read_file", args: { path: "C:\\proj\\src\\ui.html" } }), "C:\\proj\\src\\ui.html");
  assert.equal(context.workingToolActivitySubject({ name: "web_search", args: { query: "cloudflare pages deploy" } }), "cloudflare pages deploy");
  assert.equal(context.workingToolActivitySubject({ name: "find_symbol", args: { symbol: "runTurn" } }), "runTurn");
  assert.equal(context.workingToolActivitySubject({ name: "run_command", args: { command: "npm test" } }), "npm test");
  assert.equal(context.workingToolActivitySubject({ name: "team_worker", args: { role: "Reviewer" } }), "reviewer");

  // A path is worth showing only as its tail; a sentence keeps its head.
  assert.equal(context.workingActivitySubjectText({ subject: "C:\\proj\\src\\ui.html" }), "ui.html");
  assert.equal(context.workingActivitySubjectText({ subject: "", detail: "Searched web: pages deploy" }), "Searched web: pages deploy");
  assert.equal(context.workingActivitySubjectText({ subject: "x".repeat(40) }), "x".repeat(31) + "\u2026");
  assert.equal(context.workingActivitySubjectText({}), "");

  const html = context.workingActivitySubjectHtml([
    { subject: "src/ui.html" }, { subject: "src/tools.js" }, { subject: "src/agent.js" },
  ]);
  assert.match(html, /class="working-activity-subject">ui\.html, tools\.js \+1</);
  assert.equal(context.workingActivitySubjectHtml([{ title: "" }]), "");
  assert.match(ui, /workingActivityGroupLabel\(item\.group,item\.count,item\.items\)\)\+workingActivitySubjectHtml\(item\.items\)/);
  assert.match(ui, /\.working-activity-subject\{[^}]*font-style:normal;/);
});

test("model narration is instrumented so the empty commentary lane is measurable", () => {
  const codexRunner = fs.readFileSync(new URL("../src/codex-runner.js", import.meta.url), "utf8");
  const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");

  // Only Codex tags narration as commentary; the generic loop never does. The
  // transport spreads detail onto the event, so the kind tag survives to the UI
  // and a zero count means the model stayed silent, not that we dropped it.
  assert.match(codexRunner, /callback\(run\.callbacks\.onStatus, text, \{ kind: "commentary" \}\)/);
  assert.doesNotMatch(agent, /kind: "commentary"/);
  assert.match(server, /onStatus: \(text, detail\) => send\(\{ type: "status", text, \.\.\.\(detail \|\| \{\}\) \}\)/);
  assert.match(ui, /tapNarration\(ev,flattened,!!narration\)/);
  assert.match(ui, /narrationTap\.phaseOverwrites=\(narrationTap\.phaseOverwrites\|\|0\)\+1/);

  const context = vm.createContext({
    window: {},
    run: { provider: "zai", model: "glm-5.1" },
    narrationTap: { total: 0, commentary: 0, rendered: 0, flattened: 0, byKind: {}, byProvider: {}, recent: [] },
  });
  vm.runInContext(functionSource("tapNarration"), context);
  context.tapNarration({ text: "running edit_file..." }, "Updating the project files...", false);
  context.tapNarration({ text: "Starting with the config.", kind: "commentary" }, "Starting with the config.", true);

  const tap = context.window.__booleanNarration;
  assert.equal(tap.total, 2);
  assert.equal(tap.commentary, 1);
  assert.equal(tap.rendered, 1);
  assert.equal(tap.flattened, 1, "plainWorkingStatus rewrote one of the two");
  assert.deepEqual(tap.byKind, { plain: 1, commentary: 1 });
  assert.deepEqual(tap.byProvider, { "zai/glm-5.1": 2 });
  assert.equal(tap.recent[0].raw, "running edit_file...");
  assert.equal(tap.recent[0].shown, "Updating the project files...");
});

test("every provider's own narration reaches the card, not just Codex's", () => {
  const context = vm.createContext({});
  const echo = ui.match(/const narrationEcho=\/.+?\/i;/);
  assert.ok(echo, "narrationEcho is present");
  vm.runInContext([echo[0], functionSource("narrationRowText")].join("\n"), context);
  const row = ev => context.narrationRowText(ev);

  // Explanations the generic loop already writes now earn a row of their own.
  assert.equal(row({ text: "applying compatibility edit to index.html..." }), "applying compatibility edit to index.html...");
  assert.equal(row({ text: "the model's native tool call was malformed - switching to the compatibility tool bridge..." }),
    "the model's native tool call was malformed - switching to the compatibility tool bridge...");
  assert.equal(row({ text: "Verified by glm-5.1." }), "Verified by glm-5.1.");
  assert.equal(row({ text: "Codex said this", kind: "commentary" }), "Codex said this");

  // Tool echoes already have a row; engine progress has its own UI.
  assert.equal(row({ text: "running edit_file..." }), "");
  assert.equal(row({ text: "Writing your answer..." }), "");
  assert.equal(row({ text: "auto-approved: edit index.html" }), "");
  assert.equal(row({ text: "glm-5.1 is ready.", kind: "local-model-load" }), "");
  assert.equal(row({ text: "Done." }), "", "too short to be an explanation");
  assert.equal(row({}), "");

  assert.match(ui, /if\(narration\) addWorkingActivity\(narration,\{key:"commentary:"\+narration\.slice\(0,80\),group:"commentary"\}/);
});

test("parallel workers are shown, not just tracked invisibly", () => {
  const tone = ui.match(/const TEAM_WORKER_TONE=\{[^}]*\};/);
  const active = ui.match(/const TEAM_WORKER_ACTIVE=\[[^\]]*\];/);
  assert.ok(tone && active, "the worker state tables are present");

  const context = vm.createContext({
    esc: value => String(value),
    fmtWorkedTime: ms => `${Math.round(ms / 1000)}s`,
    compactActivityText: value => String(value || ""),
  });
  vm.runInContext([tone[0], functionSource("teamWorkerRowHtml")].join("\n"), context);
  const now = Date.now();
  const live = context.teamWorkerRowHtml({ role: "Agent 1", provider: "zai", model: "glm-5.1", state: "working", attempt: 1, objective: "Editing browser preview", branch: "boolean/agent/x", startedAt: now - 42000, endedAt: 0 });
  assert.match(live, /data-tone="active"/);
  assert.match(live, /glm-5\.1/);
  assert.match(live, /Editing browser preview/);
  assert.match(live, /42s/, "a running worker's clock is still moving");
  const done = context.teamWorkerRowHtml({ role: "Agent 2", model: "claude", state: "done", attempt: 2, objective: "Adding preview tests", startedAt: now - 10000, endedAt: now - 4000 });
  assert.match(done, /data-tone="done"/);
  assert.match(done, /done ·2/, "a retried worker shows its attempt");
  assert.match(done, /6s/, "a finished worker's clock is frozen at its end");

  // The record carried no timestamps, so elapsed needed a start and a stop.
  const runtime = vm.createContext({ run: {}, renderTeamWorkers() {} });
  vm.runInContext([active[0], functionSource("updateTeamWorker")].join("\n"), runtime);
  runtime.updateTeamWorker({ name: "team_worker", args: { role: "Agent 1", state: "working", provider: "zai", model: "glm-5.1", objective: "Edit preview", branch: "b1" }, result: "" });
  const first = runtime.run.teamWorkers["Agent 1"];
  assert.ok(first.startedAt > 0);
  assert.equal(first.endedAt, 0);
  runtime.updateTeamWorker({ name: "team_worker", args: { role: "Agent 1", state: "done" }, result: "1 file changed" });
  const second = runtime.run.teamWorkers["Agent 1"];
  assert.equal(second.startedAt, first.startedAt, "the clock keeps its original start");
  assert.ok(second.endedAt > 0, "the clock stops when the worker finishes");
  assert.equal(second.objective, "Edit preview", "the objective carries across events");
  assert.equal(second.branch, "b1");

  assert.match(ui, /<div class="team-worker-panel" role="list" aria-label="Parallel agents" hidden><\/div>/);
  assert.match(ui, /renderTeamWorkers\(run\);\s+renderWorkingCardActivity\(run\)/);
  assert.match(ui, /m\.textContent=" · "\+parts\.join\(" · "\);[\s\S]{0,120}renderTeamWorkers\(run\)/, "the elapsed clock ticks with the existing one-second timer");
  assert.match(ui, /\.team-worker\{[^}]*display:grid;/);
});

test("command and agent batches keep their true timeline order", () => {
  const context = vm.createContext({
    run: null,
    compactActivityText: value => String(value || ""),
    latestOrchestrationTurn: () => null,
  });
  vm.runInContext([
    functionSource("workingEventTone"),
    functionSource("workingActivityRows"),
    functionSource("inferredWorkingActivityGroup"),
    functionSource("workingActivityRowSignature"),
    functionSource("workingActivitySummary"),
  ].join("\n"), context);
  const activityItems = [
    { key: "commentary:1", title: "I inspected the project.", status: "done", group: "commentary" },
    ...Array.from({ length: 7 }, (_, index) => ({ key: `command:a:${index}`, title: "Run command", status: "done", group: "commands" })),
    ...["mapper", "test analyst", "reviewer"].map(role => ({ key: `agent:a:${role}`, title: role, subject: role, status: "done", group: "agents" })),
    ...Array.from({ length: 12 }, (_, index) => ({ key: `command:b:${index}`, title: "Run command", status: "done", group: "commands" })),
    { key: "agent:b:reviewer", title: "reviewer", subject: "reviewer", status: "done", group: "agents" },
    { key: "commentary:2", title: "I will verify this in the browser next.", status: "active", group: "commentary" },
  ];
  const summary = context.workingActivitySummary({ activityItems, changedFiles: new Set(), status: "working" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(summary.segments.map(item => item.kind === "commentary" ? [item.kind, item.item.title] : [item.group, item.count]))),
    [
      ["commentary", "I inspected the project."],
      ["commands", 7],
      ["agents", 3],
      ["commands", 12],
      ["agents", 1],
    ],
  );
  assert.equal(summary.current.title, "I will verify this in the browser next.");
});

test("approvals, input requests, errors, and changed files remain visible", () => {
  assert.match(ui, /addWorkingActivity\("Waiting for approval"/);
  assert.match(ui, /addWorkingActivity\("Waiting for your input"/);
  assert.match(ui, /name==="apply_patch"/);
  assert.match(ui, /key:"changed-file:"\+path/);
  assert.match(ui, /const card=insertAbove\(makeApprovalCard\(ev\)\)/);
  assert.match(ui, /insertAbove\(makeErr\(ev\)\)/);
  assert.match(ui, /!node\.classList\?\.contains\("model-error"\)/);
});

test("file totals stay visible on their own row during and after work", () => {
  assert.match(ui, /\.change-summary-row\{[^}]*display:flex;[^}]*opacity:1; visibility:visible;/s);
  assert.match(ui, /last\.querySelector\(":scope > \.change-summary-row"\)/);
  assert.match(ui, /last\.insertBefore\(row,foot\)/);
  assert.match(ui, /row\.innerHTML=changeSummaryHtml\(stat\)/);
  assert.match(ui, /if\(completionSummary && completionSummary\.text!==lastCompletionDiffText\) renderLatestChangeFooter/);
  assert.doesNotMatch(ui, /foot\.insertAdjacentHTML\("afterbegin",changeSummaryHtml/);
});

test("the same work card becomes a truthful completion summary", () => {
  assert.match(ui, /function finalizeWorkingCard\(ref\)/);
  assert.match(ui, /"Worked for "\+elapsed/);
  assert.match(ui, /"Paused after "\+elapsed\+" - work saved"/);
  assert.match(ui, /"Stopped after "\+elapsed\+" - work saved"/);
  assert.match(ui, /card\.classList\.add\("finalized",outcome\)/);
  assert.match(ui, /card\.classList\.add\("collapsed"\)/);
  assert.match(ui, /if\(ref\.liveAI\?\.isConnected\) col\.insertBefore\(card,ref\.liveAI\)/);
  assert.match(ui, /const finishedCard=threadId===tid\?finalizeWorkingCard\(finishedRun\):null/);
  assert.doesNotMatch(ui, /if\(run&&run\.statusEl&&run\.statusEl\.isConnected\) run\.statusEl\.remove\(\)/);
});

test("raw live output stays behind Show output and is restored when work ends", () => {
  assert.match(ui, /\.run-output-hidden \.live-run-output\{ display:none; \}/);
  assert.doesNotMatch(ui, /\.run-output-hidden \.live-run-output:not\(\.live-plan-output\)/);
  assert.match(ui, /col\.classList\.add\("run-output-hidden"\)/);
  assert.match(ui, /ref\.outputVisible=!ref\.outputVisible/);
  assert.match(ui, /col\.classList\.remove\("run-output-hidden"\)/);
});

test("compact activity stays usable in a narrow chat pane", () => {
  assert.match(ui, /\.working-card-events\{[^}]*min-width:0;/s);
  assert.match(ui, /\.working-activity-group summary\{[^}]*grid-template-columns:18px minmax\(0,1fr\) auto 14px;/s);
  assert.match(ui, /\.working-activity-group summary b\{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/s);
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.working-card-body\{ padding-inline:0; \}/);
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.working-card-actions\{ order:3; margin-left:20px; \}/);
});

test("live tool activity is painted after the progress card exists", () => {
  const ensureIndex = ui.indexOf("Ensure the live card exists before adding the event");
  const addIndex = ui.indexOf("addWorkingActivity(toolLabel", ensureIndex);
  assert.ok(ensureIndex >= 0, "the step handler creates the live progress card first");
  assert.ok(addIndex > ensureIndex, "the current tool activity is added after the card exists");
  assert.match(ui, /wireWorkingCard\(run\.statusEl,run\);[\s\S]{0,400}renderWorkingCardActivity\(run\);/);
});

test("tool calls do not erase text already streamed to the message board", () => {
  const step = ui.slice(ui.indexOf('else if(ev.type==="step")'), ui.indexOf('else if(ev.type==="approval")'));
  assert.doesNotMatch(step, /run\.raw=""/);
  assert.doesNotMatch(step, /run\.liveAI=null/);
  assert.match(ui, /Completed "\+count\+" steps/);
  assert.doesNotMatch(ui, /Completed "\+count\+" project steps/);
});

test("a completed background research answer is restored to the message board", () => {
  assert.match(ui, /const finalText=String\(ev\.text\|\|""\)/);
  assert.match(ui, /if\(finalText\.trim\(\)\|\|!String\(run\.raw\|\|""\)\.trim\(\)\) run\.raw=finalText/);
  assert.match(ui, /if\(threadId===tid&&String\(finishedRun\?\.raw\|\|""\)\.trim\(\)&&!finishedRun\.liveAI\?\.isConnected\)/);
  assert.match(ui, /finishedRun\.liveAI=makeAI\(finishedRun\.raw,null,finishedRun\.provider,finishedRun\.model,finishedRun\.aiLabel\)/);
  assert.match(ui, /ref\.liveAI\?\.classList\.remove\("live-run-output","live-plan-output"\)/);
  assert.match(ui, /if\(threadId===tid&&finishedRun\?\.liveAI\?\.isConnected\) scrollDown\(true\)/);
});

test("completed research collapses to a clickable step summary", () => {
  const finalize = ui.slice(ui.indexOf("function finalizeWorkingCard"), ui.indexOf("function makeUsage"));
  assert.match(finalize, /card\.classList\.add\("collapsed"\)/);
  assert.match(finalize, /ref\.workCardCollapsed=true/);
  assert.match(finalize, /col\.classList\.add\("run-output-hidden"\)/);
  assert.doesNotMatch(finalize, /remove\("run-output-hidden"\)/);
  assert.match(ui, /data-working-action="steps"/);
  assert.match(ui, /steps\.textContent=count\+" Step"/);
  assert.match(ui, /View research steps/);
  assert.match(ui, /card\.querySelectorAll\("\.working-activity-group"\)\.forEach\(item=>item\.open=true\)/);
  assert.match(ui, /function compactSavedResearchLogs\(root=col\)/);
  assert.match(ui, /saved-research-card/);
  assert.match(ui, /if\(!viewingRun\(\)\) compactSavedResearchLogs\(col\)/);
  assert.match(ui, /tools\.forEach\(item=>events\.appendChild\(item\)\)/);
});
