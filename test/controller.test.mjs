import assert from "node:assert/strict";
import test from "node:test";

import { AgentController } from "../src/controller.js";

test("artifact tasks cannot complete before a change and post-change verification", () => {
  const controller = new AgentController({
    objective: "Update the app layout",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  assert.equal(controller.evaluateCompletion("Done.").complete, false);
  controller.noteTool("read_file", { path: "app.css" }, "body { color: black; }");
  controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  assert.match(controller.evaluateCompletion("Fixed it.").reason, /not been checked/i);
  controller.noteTool("run_command", { command: "npm test" }, "tests passed");
  assert.equal(controller.evaluateCompletion("Fixed and tested.").complete, true);
  assert.equal(controller.snapshot().phase, "completed");
});

test("project preparation alone is not treated as implementation", () => {
  const controller = new AgentController({
    objective: "Build a tic-tac-toe game",
    artifactRequired: true
  });
  controller.noteTool("create_project", { name: "TicTacToe" }, "Created project");
  controller.noteTool("run_project", {}, "Preview ready");
  assert.equal(controller.evaluateCompletion("Done").complete, false);
  assert.equal(controller.snapshot().mutationCount, 0);
});

test("existing projects must be inspected before completion", () => {
  const controller = new AgentController({
    objective: "Update the existing app",
    artifactRequired: true,
    projectDir: "C:\\project"
  });
  controller.noteTool("edit_file", { path: "app.js" }, "Updated app.js");
  controller.noteTool("run_command", { command: "npm test" }, "Tests passed");
  assert.equal(controller.evaluateCompletion("Fixed").complete, false);
  controller.noteTool("read_file", { path: "app.js" }, "current source");
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

test("direct action requests require a successful action result", () => {
  const controller = new AgentController({ objective: "Please send the saved email draft" });
  assert.equal(controller.actionRequired, true);
  assert.match(controller.evaluateCompletion("The draft was sent.").reason, /not been performed/i);

  controller.noteTool("email_send_draft", { id: "draft-1" }, "sent draft draft-1");
  assert.equal(controller.evaluateCompletion("The draft was sent.").complete, true);
});

test("explicit controller action requirement blocks status-only completion", () => {
  const controller = new AgentController({ objective: "are you checking it?", actionRequired: true });
  assert.equal(controller.actionRequired, true);
  assert.match(controller.evaluateCompletion("Doing it now.").reason, /not been performed/i);

  controller.noteTool("mcp_call_tool", { server: "stocksignal", tool: "get_signals" }, "KMB active setup");
  assert.equal(controller.evaluateCompletion("KMB active setup.").complete, true);
});

test("ordinary questions do not require tools", () => {
  const controller = new AgentController({ objective: "What is a Boolean value?" });
  assert.equal(controller.actionRequired, false);
  assert.equal(controller.evaluateCompletion("A Boolean is true or false.").complete, true);
});

test("debug tasks require reproduction and root-cause evidence before editing", () => {
  const controller = new AgentController({
    objective: "Fix the notepad first-word caret bug",
    artifactRequired: true,
    projectDir: "C:\\project"
  });

  assert.equal(controller.snapshot().debugRequired, true);
  assert.equal(controller.allowTool("edit_file").allowed, false);

  controller.noteTool("read_file", { path: "ui.html" }, "current editor code");
  controller.noteTool("run_command", { command: "npm test -- notepad" }, "error: first word reversed");
  controller.noteTool("record_debug_evidence", {
    stage: "reproduced",
    summary: "Typing Firstword produces reversed characters before any edit."
  }, "Recorded reproduced debug evidence");
  assert.equal(controller.allowTool("edit_file").allowed, false);

  controller.noteTool("record_debug_evidence", {
    stage: "root_cause",
    summary: "Input refresh replaces the active text node and invalidates the caret."
  }, "Recorded root-cause debug evidence");
  assert.equal(controller.allowTool("edit_file").allowed, true);
});

test("debug tasks cannot complete until the original scenario passes after the fix", () => {
  const controller = new AgentController({
    objective: "Repair the broken notepad typing behavior",
    artifactRequired: true,
    projectDir: "C:\\project"
  });
  controller.noteTool("read_file", { path: "ui.html" }, "current editor code");
  controller.noteTool("run_project", {}, "Preview shows the first word reversed");
  controller.noteTool("record_debug_evidence", { stage: "reproduced", summary: "First word reverses in the preview." }, "recorded");
  controller.noteTool("record_debug_evidence", { stage: "root_cause", summary: "Selection is invalidated by DOM replacement." }, "recorded");
  controller.noteTool("edit_file", { path: "ui.html" }, "updated ui.html");
  controller.noteTool("run_project", {}, "Preview now types Firstword second in order");

  assert.match(controller.evaluateCompletion("Fixed.").reason, /original reproduction/i);
  controller.noteTool("record_debug_evidence", { stage: "verified", summary: "The same typing sequence now passes." }, "recorded");
  assert.equal(controller.evaluateCompletion("Fixed and verified.").complete, true);
  assert.equal(controller.snapshot().phase, "completed");
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
  assert.equal(controller.allowTool("visible_browser_open", { url: "http://localhost:3000" }).allowed, false);
  assert.equal(controller.allowTool("research_web", { query: "Cloudflare Workers docs" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, false);
  assert.equal(controller.allowTool("read_file", { path: "C:\\demo\\production\\app.js" }).allowed, false);
  assert.equal(controller.allowTool("read_file", { path: "C:\\demo\\sandbox\\app.js" }).allowed, true);
});

test("visible browser is blocked by default while background research remains available", () => {
  const controller = new AgentController({ objective: "Find current API documentation for this package" });
  assert.equal(controller.allowTool("research_web", { query: "package API docs" }).allowed, true);
  assert.equal(controller.allowTool("visible_browser_open", { url: "https://example.com" }).allowed, false);
  assert.match(controller.allowTool("visible_browser_open", { url: "https://example.com" }).reason, /background research/i);

  const builder = new AgentController({ objective: "Build a small website", artifactRequired: true });
  assert.equal(builder.allowTool("screenshot_page", { url: "http://localhost:3210" }).allowed, true);
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
  assert.match(controller.evaluateCompletion("Done").reason, /not been checked/i);
  controller.noteTool("run_command", { command: "curl https://example.com/health" }, "HTTP 200 OK");
  assert.equal(controller.evaluateCompletion("Deployed and verified.").complete, true);
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
  assert.match(controller.continuationPrompt(blocked.reason), /Do not inspect the same files/i);
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
  assert.match(controller.prompt(), /Loop guard is advisory/i);
});

test("working memory tracks temporary processes and exposes a handoff report", () => {
  const controller = new AgentController({ objective: "Fix and preview the app", artifactRequired: true });
  controller.noteTool("run_background", { name: "preview", command: "npm run dev" }, "Started background process 'preview' - running (pid 42).");
  assert.match(controller.workingMemory(), /Open temporary processes: preview/);
  assert.match(controller.handoffReport(), /Open processes: preview/);
  controller.noteTool("stop_process", { name: "preview" }, "stopped 'preview'");
  assert.doesNotMatch(controller.handoffReport(), /Open processes: preview/);
});
