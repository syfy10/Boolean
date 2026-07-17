import assert from "node:assert/strict";
import test from "node:test";

import { AgentController } from "../src/controller.js";

test("artifact tasks cannot complete before a change and post-change verification", () => {
  const controller = new AgentController({
    objective: "Fix the app layout",
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
    objective: "Fix the existing app",
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

test("ordinary questions do not require tools", () => {
  const controller = new AgentController({ objective: "What is a Boolean value?" });
  assert.equal(controller.actionRequired, false);
  assert.equal(controller.evaluateCompletion("A Boolean is true or false.").complete, true);
});
