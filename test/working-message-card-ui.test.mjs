import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

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
  assert.match(ui, /<details class="working-activity-group" role="listitem"/);
  assert.match(ui, /<summary><span class="working-activity-glyph"/);
  assert.match(ui, /class="working-commentary" role="listitem"/);
  assert.match(ui, /\.status\.working-card\{[^}]*width:min\(100%,640px\)[^}]*border:0;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.match(ui, /\.status\.working-card\{[^}]*align-items:stretch;/s);
  assert.match(ui, /\.working-card-header\{[^}]*width:100%;[^}]*box-sizing:border-box;/s);
  assert.match(ui, /\.working-card-header\{[^}]*align-items:center;/s);
  assert.match(ui, /class="working-card-actions"><span class="meta"><\/span><button class="working-card-action"/);
  assert.match(ui, /\.working-card \.meta\{[^}]*display:inline-flex;[^}]*align-items:center;[^}]*min-height:24px;/s);
  assert.match(ui, /\.working-card-actions\{[^}]*align-items:center;[^}]*min-height:24px;/s);
  assert.match(ui, /\.working-card-body\{[^}]*width:100%;[^}]*box-sizing:border-box;/s);
  assert.doesNotMatch(ui, /class="working-card-current /);
  assert.doesNotMatch(ui, /class="team-run-progress"/);
});

test("activity is grouped into compact chronological batches", () => {
  assert.match(ui, /ev\.kind==="commentary"\) addWorkingActivity/);
  assert.match(ui, /trackWorkingFiles\(ev\.entry\)/);
  assert.match(ui, /function workingToolActivityGroup\(entry\)/);
  assert.match(ui, /key:"tool:"\+activityGroup\+":"\+run\.activitySequence,group:activityGroup/);
  assert.match(ui, /if\(group==="searches"\) return "Searched "\+count\+" source"\+plural/);
  assert.match(ui, /if\(group==="commands"\) return "Ran "\+count\+" command"\+plural/);
  assert.match(ui, /if\(group==="files"\) return "Changed "\+count\+" file"\+plural/);
  assert.match(ui, /if\(group==="agents"\) return "Messaged "\+count\+" agent"\+plural/);
  assert.match(ui, /if\(segment\?\.kind!=="activity"\|\|segment\.group!==group\)/);
  assert.match(ui, /segments:segments\.slice\(-10\)/);
  assert.match(ui, /items:segment\.items\.slice\(-8\)/);
  assert.match(ui, /if\(segment\.identities\.has\(identity\)\)/);
  assert.doesNotMatch(ui, /const groups=new Map\(\)/);
  assert.doesNotMatch(ui, /<details class="working-activity-group"[^>]* open/);
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

test("the same work card becomes a truthful completion summary", () => {
  assert.match(ui, /function finalizeWorkingCard\(ref\)/);
  assert.match(ui, /"Worked for "\+elapsed/);
  assert.match(ui, /"Paused after "\+elapsed\+" - work saved"/);
  assert.match(ui, /"Stopped after "\+elapsed\+" - work saved"/);
  assert.match(ui, /card\.classList\.add\("finalized",outcome\)/);
  assert.match(ui, /card\.classList\.remove\("collapsed"\)/);
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
  assert.match(ui, /\.working-activity-group summary\{[^}]*grid-template-columns:18px minmax\(0,1fr\) 14px;/s);
  assert.match(ui, /\.working-activity-group summary b\{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/s);
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.working-card-body\{ padding-inline:0; \}/);
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.working-card-actions\{ order:3; margin-left:20px; \}/);
});
