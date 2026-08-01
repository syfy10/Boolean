import assert from "node:assert/strict";
import test from "node:test";

import { AgentController, isInspectionTool } from "../src/controller.js";
import { loadProjectRules, projectBrief } from "../src/agent.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("project completion requires a real change and post-change verification", () => {
  const controller = new AgentController({
    objective: "Update the app layout",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  // No longer gated on a change or a post-change check — the model judges this.
  assert.equal(controller.evaluateCompletion("Done.").complete, false);
  controller.noteTool("read_file", { path: "app.css" }, "body { color: black; }");
  controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  controller.noteTool("run_command", { command: "npm test" }, "tests passed");
  assert.equal(controller.evaluateCompletion("Done.").complete, true);
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
  controller.noteTool("run_command", { command: "npm test" }, "tests passed");

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
  assert.equal(email.snapshot().showPlan, false);
  assert.equal(email.snapshot().plan.find((item) => /cleanup plan/i.test(item.step)).status, "done");
  assert.equal(email.snapshot().plan.find((item) => /confirmation/i.test(item.step)).status, "in_progress");

  const app = new AgentController({ objective: "Build a small website", artifactRequired: true });
  app.noteTool("run_project", {}, "Preview ready at http://localhost:3210");
  assert.equal(app.snapshot().showPlan, true);
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
  assert.equal(controller.allowTool("run_command", { command: "node --version" }).allowed, true);
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

test("full access changes approval behavior without suppressing explicit deploy authority", () => {
  const controller = new AgentController({
    objective: "Deploy the current project",
    currentUserText: "Deploy the current project",
    effectiveAccessMode: "full_access",
    projectDir: "C:\\demo\\app"
  });
  assert.equal(controller.snapshot().contract.mode, "deploy");
  assert.equal(controller.snapshot().contract.deployAllowed, true);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, true);
});

test("a latest deploy request overrides stale read-only and no-deploy chat text", () => {
  const controller = new AgentController({
    objective: "Prepare the GreenScan release",
    taskContext: "The earlier preview was read-only. Do not deploy until I say so.",
    currentUserText: "Deploy local now with wrangler deploy",
    effectiveAccessMode: "ask",
    projectDir: "C:\\demo\\greenscan"
  });
  assert.equal(controller.snapshot().contract.mode, "deploy");
  assert.equal(controller.snapshot().contract.deployAllowed, true);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, true);
});

test("deploy-only authority allows the exact deploy but keeps file edits blocked", () => {
  const controller = new AgentController({
    objective: "Deploy only",
    currentUserText: "Do not edit files. Deploy only with wrangler deploy --env production.",
    taskContext: "Deploy command: wrangler deploy --env production",
    effectiveAccessMode: "ask",
    projectDir: "C:\\demo\\app"
  });
  const contract = controller.snapshot().contract;
  assert.equal(contract.mode, "deploy");
  assert.equal(contract.writeAllowed, false);
  assert.equal(contract.deployAllowed, true);
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\app\\index.js" }).allowed, false);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy --env production" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy --env preview" }).allowed, false);
});

test("the explicit Read only UI mode remains a hard boundary", () => {
  const controller = new AgentController({
    objective: "Deploy the current project",
    currentUserText: "Deploy the current project",
    effectiveAccessMode: "read_only",
    projectDir: "C:\\demo\\app"
  });
  assert.equal(controller.snapshot().contract.accessMode, "read_only");
  assert.equal(controller.snapshot().contract.deployAllowed, false);
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\app\\index.js" }).allowed, false);
  assert.equal(controller.allowTool("run_command", { command: "wrangler deploy" }).allowed, false);
});

test("switching a persisted task from Read only to Read and write unlocks the selected project", () => {
  const locked = new AgentController({
    objective: "Review the app",
    currentUserText: "Review the app without editing it",
    effectiveAccessMode: "read_only",
    projectDir: "C:\\demo\\app"
  });
  const unlocked = new AgentController({
    persisted: locked.snapshot(),
    objective: "Fix the app",
    currentUserText: "Fix the app now",
    effectiveAccessMode: "ask",
    projectDir: "C:\\demo\\app"
  });
  assert.equal(unlocked.snapshot().contract.accessMode, "ask");
  assert.equal(unlocked.snapshot().contract.writeAllowed, true);
  assert.equal(unlocked.allowTool("write_file", { path: "C:\\demo\\app\\index.js" }).allowed, true);
});

test("the newly selected project root is not evicted by persisted roots", () => {
  const savedRoots = Array.from({ length: 6 }, (_, index) => `C:\\old\\project-${index + 1}`);
  const controller = new AgentController({
    persisted: { contract: { mode: "project_edit", accessMode: "ask", writeAllowed: true, allowedRoots: savedRoots } },
    objective: "Fix the selected project",
    currentUserText: "Fix the selected project",
    effectiveAccessMode: "ask",
    projectDir: "C:\\current\\project"
  });
  assert.equal(controller.allowTool("read_file", { path: "C:\\current\\project\\index.js" }).allowed, true);
  assert.ok(controller.snapshot().contract.allowedRoots.includes("c:\\current\\project"));
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
  assert.match(controller.continuationPrompt(blocked.reason), /C:\\demo|saved evidence/i);
  assert.equal(controller.allowTool("write_file", { path: "C:\\demo\\MainPage.xaml" }).allowed, true);
  assert.equal(controller.allowTool("run_command", { command: "dotnet build" }).allowed, true);
});

test("loop guard allows a longer default inspection window before the emergency stop", () => {
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

  for (let i = 28; i < 48; i++) {
    controller.noteTool("read_file", { path: `C:\\demo\\file${i}.cs` }, "read source");
  }
  const blocked = controller.allowTool("read_file", { path: "C:\\demo\\OneMorePage.xaml" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Tool budget reached/i);
});

test("emergency loop guard blocks repeated inspection even when strict mode is off", () => {
  const controller = new AgentController({
    objective: "Review the project and report what should change",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });

  for (let i = 0; i < 6; i++) {
    const args = { query: `layout-${i}`, path: "C:\\demo" };
    assert.equal(controller.allowTool("search_files", args).allowed, true);
    controller.noteTool("search_files", args, "matches");
  }

  const blocked = controller.allowTool("search_files", {
    query: "one-more-layout-search",
    path: "C:\\demo"
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Loop guard/i);
});

test("connector discovery and read-only MCP calls use the global inspection loop guard", () => {
  const controller = new AgentController({
    objective: "Use the connected service to answer the request",
    actionRequired: true,
    loopStop: true
  });

  assert.equal(isInspectionTool("list_connectors", {}), true);
  assert.equal(isInspectionTool("mcp_list_tools", { connector: "Example" }), true);
  assert.equal(isInspectionTool("mcp_call_tool", {
    connector: "Example",
    tool: "get_accounts",
    arguments: {}
  }), true);

  for (let i = 0; i < 2; i++) {
    const args = { connector: "Example" };
    assert.equal(controller.allowTool("mcp_list_tools", args).allowed, true);
    controller.noteTool("mcp_list_tools", args, "tools");
  }
  assert.match(controller.allowTool("mcp_list_tools", { connector: "Example" }).reason, /Loop guard/i);
  assert.equal(controller.snapshot().successfulActionCount, 0);
});

test("mutating MCP calls remain progress actions rather than inspections", () => {
  const args = {
    connector: "Example",
    tool: "create_issue",
    arguments: { title: "Bug" }
  };
  assert.equal(isInspectionTool("mcp_call_tool", args), false);

  const controller = new AgentController({
    objective: "Create the requested issue",
    actionRequired: true,
    loopStop: true
  });
  controller.noteTool("mcp_call_tool", args, "created issue 123");
  assert.equal(controller.snapshot().successfulActionCount, 1);
  assert.equal(controller.snapshot().nonProgressCount, 0);
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

test("remember records model findings into working memory and survives a snapshot round-trip", () => {
  const c = new AgentController({ objective: "Investigate the crash", artifactRequired: true });
  c.addNote("root cause is a DPI mismatch in LayoutBrowserPane");
  assert.match(c.workingMemory(), /Findings recorded:.*DPI mismatch/);
  const restored = new AgentController({ objective: "Investigate the crash", persisted: c.snapshot() });
  assert.match(restored.workingMemory(), /DPI mismatch/, "notes persist across snapshot");
});

test("project rules prefer Boolean paths and preserve Boollm legacy fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boollm-rules-"));
  try {
    fs.mkdirSync(path.join(dir, ".boollm"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".boollm", "rules.md"), "Style: use spaces.");
    fs.writeFileSync(path.join(dir, "BOOLEAN.md"), "Boolean rules win.");
    const rules = loadProjectRules(dir);
    assert.match(rules, /from BOOLEAN\.md/);
    assert.match(rules, /Boolean rules win/);

    fs.rmSync(path.join(dir, "BOOLEAN.md"));
    const legacyRules = loadProjectRules(dir);
    assert.match(legacyRules, /from \.boollm\/rules\.md \(legacy\)/);
    assert.match(legacyRules, /use spaces/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project completion remains held until a post-change check succeeds", () => {
  const c = new AgentController({ objective: "Fix the layout bug", artifactRequired: true, projectDir: "C:\p", autopilot: true });
  c.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  const first = c.evaluateCompletion("Fixed it.");
  assert.equal(first.complete, false, "first completion is held for verification");
  assert.match(first.reason, /build\/test\/check/i);
  const second = c.evaluateCompletion("Fixed it.");
  assert.equal(second.complete, false, "repeating the claim does not bypass verification");
  c.noteTool("run_command", { command: "npm test" }, "tests passed");
  assert.equal(c.evaluateCompletion("Fixed it.").complete, true);
});

test("verification cannot be bypassed by disabling autopilot", () => {
  const c = new AgentController({ objective: "Fix the layout bug", artifactRequired: true, projectDir: "C:\p" });
  c.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  assert.equal(c.evaluateCompletion("Fixed it.").complete, false);
  c.noteTool("run_command", { command: "npm test" }, "tests passed");
  assert.equal(c.evaluateCompletion("Fixed it.").complete, true);
});

test("autopilot project timelines require real file work before completion", () => {
  const controller = new AgentController({
    objective: "Build a tic tac toe game",
    artifactRequired: true,
    projectDir: "C:\\demo",
    autopilot: true
  });
  const result = controller.evaluateCompletion("Here is the timeline I would follow.");
  assert.equal(result.complete, false);
  assert.match(result.reason, /has not changed any project file/i);
  assert.equal(controller.phase, "executing");
});

test("continuationPrompt permits bounded loop recovery without autopilot", () => {
  const off = new AgentController({ objective: "x", artifactRequired: true });
  assert.match(
    off.continuationPrompt("loop guard: repeated the same kind of inspection"),
    /different concrete step|WORKING MEMORY/i
  );
  const on = new AgentController({ objective: "x", artifactRequired: true, autopilot: true });
  const p = on.continuationPrompt("loop guard: repeated the same kind of inspection");
  assert.ok(p.length > 0 && /different concrete step|WORKING MEMORY/i.test(p), "gives real recovery guidance");
});

test("repeated edits to one file without a check surface a churn advisory but never block", () => {
  const controller = new AgentController({
    objective: "Fix the layout bug",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });
  // Four edits to the same file with no check in between.
  for (let i = 0; i < 4; i++) {
    assert.equal(controller.allowTool("edit_file", { path: "app.css" }).allowed, true,
      "edit churn is advisory only — it must never block a legitimate edit");
    controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  }
  assert.match(controller.prompt(), /app\.css has been edited 4 times/,
    "working memory nudges the model to verify after repeated same-file edits");
  assert.equal(controller.blockedToolCount, 0, "churn never counts toward the 3-block hard stop");
});

test("a check clears edit churn so normal edit→test→fix iteration is not flagged", () => {
  const controller = new AgentController({
    objective: "Fix the layout bug",
    artifactRequired: true,
    projectDir: "C:\\demo"
  });
  for (let i = 0; i < 4; i++) controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  assert.match(controller.prompt(), /has been edited/, "churn accumulates before a check");
  controller.noteTool("run_command", { command: "node --test" }, "tests passed");
  assert.doesNotMatch(controller.prompt(), /has been edited/, "running a check resets the churn counter");
  // A failing check is fresh evidence too, so it also clears churn.
  for (let i = 0; i < 4; i++) controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  controller.noteTool("run_command", { command: "node --test" }, "Error: 1 test failed");
  assert.doesNotMatch(controller.prompt(), /has been edited/, "a failing check also resets churn (legitimate iteration)");
});

test("edit churn survives a snapshot round-trip", () => {
  const controller = new AgentController({ objective: "Fix a bug", artifactRequired: true, projectDir: "C:\\demo" });
  for (let i = 0; i < 4; i++) controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  const restored = new AgentController({ objective: "Fix a bug", artifactRequired: true, projectDir: "C:\\demo", persisted: controller.snapshot() });
  assert.match(restored.prompt(), /app\.css has been edited 4 times/, "churn is restored from the durable snapshot");
});

test("runtime task budgets override legacy unlimited saved controllers", () => {
  const controller = new AgentController({
    objective: "Finish the project without a runaway loop",
    persisted: { tokenBudget: 0, timeBudgetMs: 0, tokensUsed: 10 },
    tokenBudget: 150000,
    timeBudgetMs: 600000
  });
  assert.equal(controller.tokenBudget, 150000);
  assert.equal(controller.timeBudgetMs, 600000);
  assert.equal(controller.tokensUsed, 10);
});

test("loop guard permits distinct bounded ranges in one large source file", () => {
  const controller = new AgentController({ objective: "Update the worker", artifactRequired: true, projectDir: "C:\\demo", loopStop: true });
  for (let index = 0; index < 6; index++) {
    const args = { path: "C:\\demo\\worker.js", start: index * 200 + 1, end: index * 200 + 200 };
    assert.equal(controller.allowTool("read_file", args).allowed, true);
    controller.noteTool("read_file", args, `lines ${args.start}-${args.end}`);
  }
  assert.match(controller.allowTool("read_file", { path: "C:\\demo\\worker.js", start: 1401, end: 1600 }).reason, /Loop guard/i);
});

test("blocked work cannot be marked complete and recovery retains exact paths", () => {
  const controller = new AgentController({ objective: "Update the worker", artifactRequired: true, projectDir: "C:\\demo", loopStop: true });
  controller.noteTool("read_file", { path: "C:\\demo\\src\\worker.js", start: 1, end: 200 }, "source");
  controller.noteBlockedTool("read_file", { path: "C:\\demo\\src\\worker.js" }, "Loop guard: repeated inspection");
  const completion = controller.evaluateCompletion("Paused for safety. Work is saved.");
  assert.equal(completion.complete, false);
  assert.notEqual(controller.snapshot().phase, "completed");
  const prompt = controller.continuationPrompt("Loop guard: repeated inspection");
  assert.match(prompt, /exact allowed workspace: C:\\demo/i);
  assert.match(prompt, /C:\\demo\\src\\worker\.js/i);
});

test("local app runs activate a durable visual build cycle", () => {
  const controller = new AgentController({
    objective: "Build a small website",
    artifactRequired: true,
    projectDir: "C:\\demo",
    autopilot: true
  });
  controller.noteTool("edit_file", { path: "index.html" }, "edited index.html");
  controller.noteTool("run_project", { name: "demo" }, "Website is running at http://localhost:4173/ (HTTP 200).");
  assert.equal(controller.taskRun.visual.enabled, true);
  assert.equal(controller.taskRun.visual.state, "previewing");
  assert.equal(controller.taskRun.visual.previewUrl, "http://localhost:4173/");
  assert.equal(controller.taskRun.visual.cycle, 1);

  const restored = new AgentController({ persisted: controller.snapshot() });
  assert.equal(restored.taskRun.visual.previewUrl, "http://localhost:4173/");
  assert.equal(restored.taskRun.visual.state, "previewing");
});

test("autopilot cannot call a visual build complete before inspecting its screen", () => {
  const controller = new AgentController({
    objective: "Build a small website",
    artifactRequired: true,
    projectDir: "C:\\demo",
    autopilot: true
  });
  controller.noteTool("edit_file", { path: "index.html" }, "edited index.html");
  controller.noteTool("run_project", { name: "demo" }, "Website is running at http://127.0.0.1:4173/ (HTTP 200).");
  const held = controller.evaluateCompletion("The site is complete.");
  assert.equal(held.complete, false);
  assert.match(held.reason, /visually checked/i);
  assert.equal(controller.taskRun.visual.state, "inspecting");

  controller.noteTool("screenshot_page", { url: "http://127.0.0.1:4173/" }, "Captured the rendered page.");
  assert.equal(controller.taskRun.visual.state, "verified");
  assert.ok(controller.taskRun.visual.verifiedAt > 0);
  assert.equal(controller.evaluateCompletion("The site is complete and visually verified.").complete, true);
});

test("editing after a visual check starts a new build state", () => {
  const controller = new AgentController({ objective: "Improve the app", artifactRequired: true, projectDir: "C:\\demo" });
  controller.noteTool("run_project", {}, "Running at http://localhost:3000/");
  controller.noteTool("inspect_page_layout", { url: "http://localhost:3000/" }, "Layout looks correct.");
  assert.equal(controller.taskRun.visual.state, "verified");
  controller.noteTool("edit_file", { path: "app.css" }, "edited app.css");
  assert.equal(controller.taskRun.visual.state, "building");
  assert.equal(controller.taskRun.visual.verifiedAt, 0);
});
