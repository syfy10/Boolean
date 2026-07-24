import assert from "node:assert/strict";
import test from "node:test";

import { AgentController } from "../src/controller.js";
import { loadProjectRules, projectBrief } from "../src/agent.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("the model decides completion; evidence is still tracked for context", () => {
  const controller = new AgentController({
    objective: "Update the app layout",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  // No longer gated on a change or a post-change check — the model judges this.
  assert.equal(controller.evaluateCompletion("Done.").complete, true);
  controller.noteTool("read_file", { path: "app.css" }, "body { color: black; }");
  controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  controller.noteTool("run_command", { command: "npm test" }, "tests passed");
  const snap = controller.snapshot();
  assert.ok(snap.mutationCount >= 1, "edits are still recorded");
  assert.ok(snap.inspectionCount >= 1, "inspections are still recorded");
});

test("project preparation is still not counted as a file change", () => {
  const controller = new AgentController({
    objective: "Build a tic-tac-toe game",
    artifactRequired: true
  });
  controller.noteTool("create_project", { name: "TicTacToe" }, "Created project");
  controller.noteTool("run_project", {}, "Preview ready");
  // Bookkeeping is unchanged, but it no longer blocks the model from finishing.
  assert.equal(controller.snapshot().mutationCount, 0);
  assert.equal(controller.evaluateCompletion("Done").complete, true);
});

test("existing projects no longer require an inspection before finishing", () => {
  const controller = new AgentController({
    objective: "Update the existing app",
    artifactRequired: true,
    projectDir: "C:\\project"
  });
  controller.noteTool("edit_file", { path: "app.js" }, "Updated app.js");
  controller.noteTool("run_command", { command: "npm test" }, "Tests passed");
  assert.equal(controller.evaluateCompletion("Fixed").complete, true);
});

test("controller persists its objective, plan, evidence, and recovery state", () => {
  const first = new AgentController({ objective: "Build a game", artifactRequired: true });
  first.noteTool("create_project", { template: "website" }, "created website project");
  first.noteTool("write_file", { path: "script.js" }, "wrote script.js");
  first.noteTool("run_project", {}, "project started at http://localhost:3210");
  const restored = new AgentController({ persisted: first.snapshot() });

  assert.equal(restored.objective, "Build a game");
  assert.equal(restored.mutationCount, 1);
  assert.equal(restored.verificationEvidence.length, 1);
  assert.equal(restored.evaluateCompletion("Built and checked.").complete, true);

  restored.noteTool("run_command", { command: "npm test" }, "error: tests failed");
  assert.equal(restored.snapshot().phase, "recovering");
  assert.match(restored.prompt(), /change strategy/i);
});

test("action requests are detected but no longer gate the final answer", () => {
  const controller = new AgentController({ objective: "Please send the saved email draft" });
  assert.equal(controller.actionRequired, true, "still classified as an action task");
  // Boolean used to refuse this answer; the model now decides.
  assert.equal(controller.evaluateCompletion("The draft was sent.").complete, true);

  controller.noteTool("email_send_draft", { id: "draft-1" }, "sent draft draft-1");
  assert.equal(controller.snapshot().successfulActionCount >= 1, true);
});

test("explicit controller action requirement no longer blocks a status answer", () => {
  const controller = new AgentController({ objective: "are you checking it?", actionRequired: true });
  assert.equal(controller.actionRequired, true);
  assert.equal(controller.evaluateCompletion("Doing it now.").complete, true);
});

test("ordinary questions do not require tools", () => {
  const controller = new AgentController({ objective: "What is a Boolean value?" });
  assert.equal(controller.actionRequired, false);
  assert.equal(controller.evaluateCompletion("A Boolean is true or false.").complete, true);
});

test("debug tasks are detected but edits are never blocked", () => {
  const controller = new AgentController({
    objective: "Fix the notepad first-word caret bug",
    artifactRequired: true,
    projectDir: "C:\\project"
  });

  assert.equal(controller.snapshot().debugRequired, true, "still recognised as a debug task");
  // The model decides when it understands the bug well enough to edit.
  assert.equal(controller.allowTool("edit_file").allowed, true);
});

test("debug evidence is recorded for context but does not gate completion", () => {
  const controller = new AgentController({
    objective: "Repair the broken notepad typing behavior",
    artifactRequired: true,
    projectDir: "C:\\project"
  });
  controller.noteTool("read_file", { path: "ui.html" }, "current editor code");
  controller.noteTool("record_debug_evidence", { stage: "reproduced", summary: "First word reverses in the preview." }, "recorded");
  controller.noteTool("edit_file", { path: "ui.html" }, "updated ui.html");

  assert.equal(controller.evaluateCompletion("Fixed.").complete, true);
  assert.match(controller.snapshot().reproductionEvidence, /First word reverses/i);
});

test("debug evidence survives task continuation", () => {
  const first = new AgentController({ objective: "Fix the broken layout", artifactRequired: true, projectDir: "C:\\project" });
  first.noteTool("inspect_page_layout", { url: "http://localhost:3210" }, "panel overflows by 20px");
  first.noteTool("record_debug_evidence", { stage: "reproduced", summary: "Panel exceeds its parent by 20px." }, "recorded");
  first.noteTool("read_file", { path: "style.css" }, "width: 100vw");
  first.noteTool("record_debug_evidence", { stage: "root_cause", summary: "100vw ignores the parent rail width." }, "recorded");

  const restored = new AgentController({ persisted: first.snapshot() });
  assert.match(restored.snapshot().reproductionEvidence, /20px/);
  assert.match(restored.snapshot().rootCauseEvidence, /100vw/);
  assert.equal(restored.allowTool("edit_file").allowed, true);
});

test("working memory survives continuation and stays compact", () => {
  const controller = new AgentController({
    objective: "Fix the scanner panel",
    taskContext: [
      "Only work inside C:\\demo\\sandbox.",
      "Do not deploy or use the browser.",
      "Keep the existing authentication behavior.",
      "The scanner drifts while scrolling."
    ].join("\n"),
    artifactRequired: true,
    projectDir: "C:\\demo\\sandbox"
  });
  controller.noteTool("read_file", { path: "style.css" }, "current styles");
  const memory = controller.workingMemory();
  assert.match(memory, /Fix the scanner panel/);
  assert.match(memory, /Do not deploy or use the browser/i);
  assert.match(memory, /style\.css/);
  assert.ok(memory.length <= 3200);

  const restored = new AgentController({ persisted: controller.snapshot() });
  assert.equal(restored.workingMemory(), memory);
});

test("working memory redacts common secrets", () => {
  const controller = new AgentController({
    objective: "Use sk-exampleSecret123456 to test the provider",
    taskContext: "Authorization: Bearer secret.token.value"
  });
  const memory = controller.workingMemory();
  assert.doesNotMatch(memory, /exampleSecret|secret\.token/);
  assert.match(memory, /\[redacted\]/);
});

test("task contract blocks browser, deploy, and paths outside an allowed project", () => {
  const controller = new AgentController({
    objective: "Fix the sandbox styles",
    taskContext: "Only work in the sandbox. Do not use browser. Do not deploy.",
    artifactRequired: true,
    projectDir: "C:\\demo\\sandbox"
  });
  // Deploy and workspace-path guards remain — those are real safety rails.
  assert.equal(controller.allowTool("research_web", { query: "Cloudflare Workers docs" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, false);
  assert.equal(controller.allowTool("read_file", { path: "C:\\demo\\production\\app.js" }).allowed, false);
  assert.equal(controller.allowTool("read_file", { path: "C:\\demo\\sandbox\\app.js" }).allowed, true);
});

test("the visible browser is never gated — the model decides when to open it", () => {
  const controller = new AgentController({ objective: "Find current API documentation for this package" });
  assert.equal(controller.allowTool("research_web", { query: "package API docs" }).allowed, true);
  assert.equal(controller.allowTool("visible_browser_open", { url: "https://example.com" }).allowed, true);

  const builder = new AgentController({ objective: "Build a small website", artifactRequired: true });
  assert.equal(builder.allowTool("screenshot_page", { url: "http://localhost:3210" }).allowed, true);

  const email = new AgentController({ objective: "Clean up old Gmail promotions", actionRequired: true });
  assert.equal(email.allowTool("visible_browser_open", { url: "https://mail.google.com/" }).allowed, true);
  assert.match(email.snapshot().plan[0].step, /mailbox/i);
});

test("task-specific plans advance from email and preview tools", () => {
  const email = new AgentController({ objective: "Clean up old Outlook email", actionRequired: true });
  email.noteTool("email_cleanup_preview", { provider: "outlook" }, "Plan ready with 20 candidates");
  assert.equal(email.snapshot().plan.find((item) => /cleanup plan/i.test(item.step)).status, "done");
  assert.equal(email.snapshot().plan.find((item) => /confirmation/i.test(item.step)).status, "in_progress");

  const app = new AgentController({ objective: "Build a small website", artifactRequired: true });
  app.noteTool("run_project", {}, "Preview ready at http://localhost:3210");
  assert.equal(app.snapshot().plan.find((item) => /run the project locally/i.test(item.step)).status, "done");
  assert.equal(app.snapshot().plan.find((item) => /open the result/i.test(item.step)).status, "in_progress");
});

test("task contract discovers an explicit sandbox root from continued chat context", () => {
  const controller = new AgentController({
    objective: "Remove the sandbox login",
    taskContext: "Only work inside this sandbox folder:\n\nC:\\demo\\green scan sandbox\nDo not deploy."
  });
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\green scan sandbox\\app.js" }).allowed, true);
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\production\\app.js" }).allowed, false);
});

test("read-only mode allows checks but blocks side-effect commands", () => {
  const controller = new AgentController({ objective: "Review this code", taskContext: "Read-only. Do not edit anything." });
  assert.equal(controller.allowTool("run_command", { command: "npm test" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "npm install lodash" }).allowed, false);
  assert.equal(controller.allowTool("run_background", { command: "npm run dev" }).allowed, false);
});

test("command path guard handles quoted paths and command separators", () => {
  const controller = new AgentController({ objective: "Test sandbox", projectDir: "C:\\demo\\sandbox" });
  assert.equal(controller.allowTool("run_command", { command: "Set-Location 'C:\\demo\\sandbox'; npm test" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "Get-Content C:\\demo\\production\\app.js" }).allowed, false);
});

test("command path guard allows trusted build toolchain paths outside workspace", () => {
  const controller = new AgentController({ objective: "Build the Windows app", projectDir: "C:\\demo\\sandbox" });
  const command = "dotnet build C:\\demo\\sandbox\\App.csproj -p:XamlCompiler=\"C:\\Users\\S10\\.nuget\\packages\\microsoft.windowsappsdk\\1.7.260224002\\tools\\net472\\XamlCompiler.exe\"";
  const allowed = controller.allowTool("run_command", { command });
  assert.equal(allowed.allowed, true, allowed.reason);
});

test("command path guard allows direct trusted compiler executables outside workspace", () => {
  const controller = new AgentController({ objective: "Build the Windows app", projectDir: "C:\\demo\\sandbox" });
  const command = "\"C:\\Users\\S10\\.nuget\\packages\\microsoft.windowsappsdk\\1.7.260224002\\tools\\net472\\XamlCompiler.exe\" \"C:\\demo\\sandbox\\App.csproj\"";
  const allowed = controller.allowTool("run_command", { command });
  assert.equal(allowed.allowed, true, allowed.reason);
});

test("an explicit deploy task permits deploy commands", () => {
  const controller = new AgentController({ objective: "Deploy the current project" });
  assert.equal(controller.snapshot().contract.mode, "deploy");
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, true);
});

test("deploy completion requires deploy proof and live verification", () => {
  const controller = new AgentController({
    objective: "Deploy",
    taskContext: [
      "Edit folder: C:\\demo\\app",
      "Build command: npm run build",
      "Deploy command: wrangler deploy",
      "Live URL: https://example.com",
      "Verification URL: https://example.com/health"
    ].join("\n")
  });
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, true);
  controller.noteTool("run_command", { command: "wrangler deploy" }, "Deployed version 12345678-1234-1234-1234-123456789abc");
  // Deploy evidence is still captured, but completion is the model's call.
  assert.ok(controller.snapshot().deployEvidence);
  assert.equal(controller.evaluateCompletion("Deployed.").complete, true);
});

test("source of truth blocks a different deploy command", () => {
  const controller = new AgentController({
    objective: "Deploy",
    taskContext: "Deploy command: wrangler deploy --env production"
  });
  assert.equal(controller.allowTool("run_command", { command: "npm run deploy" }).allowed, false);
  assert.match(controller.allowTool("run_command", { command: "npm run deploy" }).reason, /source-of-truth/i);
});

test("blocked means stop after repeated blocked actions", () => {
  const controller = new AgentController({ objective: "Fix code", taskContext: "Read-only." });
  const gate = controller.allowTool("write_file", { path: "app.js" });
  assert.equal(gate.allowed, false);
  assert.equal(controller.noteBlockedTool("write_file", { path: "app.js" }, gate.reason).stop, false);
  assert.equal(controller.noteBlockedTool("write_file", { path: "app.js" }, gate.reason).stop, false);
  assert.equal(controller.noteBlockedTool("write_file", { path: "app.js" }, gate.reason).stop, true);
  assert.match(controller.handoffReport(), /Last failure: write_file blocked/);
});

test("loop guard blocks a third identical inspection and resets after a change", () => {
  const controller = new AgentController({ objective: "Inspect and update the app", artifactRequired: true, loopStop: true });
  const args = { path: "app.css" };
  controller.noteTool("read_file", args, "first read");
  controller.noteTool("read_file", args, "second read");
  assert.match(controller.allowTool("read_file", args).reason, /Loop guard/i);

  controller.noteTool("write_file", args, "wrote app.css");
  assert.equal(controller.allowTool("read_file", args).allowed, true);
});

test("loop guard catches repeated PowerShell inspection variants", () => {
  const controller = new AgentController({
    objective: "Find why the tab close button does not work",
    artifactRequired: true,
    projectDir: "C:\\demo",
    loopStop: true
  });

  const variants = [
    "Get-Content index.html -Raw | Select-String closeButton",
    "$content = Get-Content index.html -Raw; $content.IndexOf('closeButton')",
    "$matches = [regex]::Matches((Get-Content index.html -Raw),'closeButton'); $matches.Count"
  ];
  for (const command of variants) {
    assert.equal(controller.allowTool("run_command", { command }).allowed, true);
    controller.noteTool("run_command", { command }, "found matching text");
  }

  const blocked = controller.allowTool("run_command", {
    command: "Select-String -Path index.html -Pattern closeButton"
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Loop guard/i);
  assert.equal(controller.snapshot().successfulActionCount, 0);
});

test("loop guard recovery allows progress actions but blocks more inspection", () => {
  const controller = new AgentController({
    objective: "Finish building the WinUI app",
    artifactRequired: true,
    projectDir: "C:\\demo",
    loopStop: true
  });

  for (let i = 0; i < 28; i++) {
    controller.noteTool("read_file", { path: `C:\\demo\\file${i}.cs` }, "read source");
  }

  const blocked = controller.allowTool("read_file", { path: "C:\\demo\\MainPage.xaml" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Do not inspect again/i);

  controller.noteBlockedTool("read_file", { path: "C:\\demo\\MainPage.xaml" }, blocked.reason);
  assert.match(controller.prompt(), /LOOP RECOVERY/i);
  assert.equal(controller.continuationPrompt(blocked.reason), "");
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\MainPage.xaml" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "dotnet build" }).allowed, true);
});

test("loop guard is advisory by default so long tasks keep working", () => {
  const controller = new AgentController({
    objective: "Finish building the WinUI app",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  const args = { path: "C:\\demo\\MainPage.xaml" };
  controller.noteTool("read_file", args, "first read");
  controller.noteTool("read_file", args, "second read");
  assert.equal(controller.allowTool("read_file", args).allowed, true);

  for (let i = 0; i < 28; i++) {
    controller.noteTool("read_file", { path: `C:\\demo\\file${i}.cs` }, "read source");
  }

  const allowed = controller.allowTool("read_file", { path: "C:\\demo\\OtherPage.xaml" });
  assert.equal(allowed.allowed, true, allowed.reason);
  // The prompt notes the lack of progress without lecturing the model about it.
  assert.match(controller.prompt(), /several inspections have run/i);
});

test("working memory tracks temporary processes and exposes a handoff report", () => {
  const controller = new AgentController({ objective: "Fix and preview the app", artifactRequired: true });
  controller.noteTool("run_background", { name: "preview", command: "npm run dev" }, "Started background process 'preview' - running (pid 42).");
  assert.match(controller.workingMemory(), /Open temporary processes: preview/);
  assert.match(controller.handoffReport(), /Open processes: preview/);
  controller.noteTool("stop_process", { name: "preview" }, "stopped 'preview'");
  assert.doesNotMatch(controller.handoffReport(), /Open processes: preview/);
});

test("optional visual inspection failure after successful verification does not trap completion", () => {
  const controller = new AgentController({
    objective: "Improve the browser layout",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  controller.noteTool("read_file", { path: "C:\\demo\\src\\ui.html" }, "current source");
  controller.noteTool("edit_file", { path: "C:\\demo\\src\\ui.html" }, "edited ui.html");
  controller.noteTool("read_page", { url: "http://127.0.0.1:3210" }, "HTTP 200 Boolean page loaded");
  controller.noteTool("inspect_page_layout", { selector: "#browser" }, "visible browser error: The JSON value could not be converted to System.String.");

  const result = controller.evaluateCompletion("Updated and checked.");
  assert.equal(result.complete, true, result.reason);
  assert.match(controller.handoffReport(), /optional visual verification failed/i);
});

test("artifact tasks must close temporary background processes before completion", () => {
  const controller = new AgentController({
    objective: "Preview the app",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  controller.noteTool("read_file", { path: "C:\\demo\\src\\ui.html" }, "current source");
  controller.noteTool("edit_file", { path: "C:\\demo\\src\\ui.html" }, "edited ui.html");
  controller.noteTool("run_background", { name: "preview", command: "npm run dev" }, "Started background process 'preview' - running (pid 42).");
  controller.noteTool("read_page", { url: "http://127.0.0.1:3210" }, "HTTP 200 Boolean page loaded");

  const blocked = controller.evaluateCompletion("Done.");
  assert.equal(blocked.complete, false);
  assert.match(blocked.reason, /Temporary process still running: preview/);

  controller.noteTool("stop_process", { name: "preview" }, "stopped 'preview'");
  assert.equal(controller.evaluateCompletion("Done.").complete, true);
});

test("project rules load from BOOLEAN.md and inject into project brief", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-rules-"));
  try {
    fs.writeFileSync(path.join(dir, "BOOLEAN.md"), "# My Project\n\nBuild with foo --bar\nNever deploy.");
    const rules = loadProjectRules(dir);
    assert.match(rules, /PROJECT RULES/);
    assert.match(rules, /Build with foo --bar/);
    assert.match(rules, /Never deploy/);
    assert.doesNotMatch(rules, /^# My Project/m, "H1 title should be stripped");

    // projectBrief should include rules + file map
    fs.writeFileSync(path.join(dir, "main.js"), "console.log(1);");
    const brief = projectBrief(dir);
    assert.match(brief, /PROJECT RULES/);
    assert.match(brief, /Build with foo --bar/);
    assert.match(brief, /File map:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project rules load from .boolean/rules.md fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-rules2-"));
  try {
    fs.mkdirSync(path.join(dir, ".boolean"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".boolean", "rules.md"), "Style: use tabs.");
    const rules = loadProjectRules(dir);
    assert.match(rules, /\.boolean\/rules\.md/);
    assert.match(rules, /use tabs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project rules return empty when no rules file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-norules-"));
  try {
    assert.equal(loadProjectRules(dir), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
