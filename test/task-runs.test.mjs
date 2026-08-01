import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTaskRunEvent,
  compactTaskRun,
  createTaskRun,
  publicTaskRun,
  syncTaskRunFromController,
  taskRunToolEvent,
  updateTaskRunVisual
} from "../src/task-runs.js";

test("task runs provide one ordered, sanitized event timeline", () => {
  const run = createTaskRun({ objective: "Build the dashboard" });
  appendTaskRunEvent(run, { type: "run.started", status: "active", title: "Started" });
  taskRunToolEvent(run, "web_search", { query: "pricing", apiKey: "sk-secretvalue" }, "ok");
  appendTaskRunEvent(run, {
    type: "permission.requested",
    status: "waiting",
    title: "Approval needed",
    detail: "Bearer abc.def.ghi"
  });
  const visible = publicTaskRun(run);
  assert.equal(visible.state, "waiting");
  assert.deepEqual(visible.events.map((event) => event.sequence), [1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(visible), /sk-secretvalue|abc\.def\.ghi/);
});

test("controller plan changes become task-run step events without duplicates", () => {
  const run = createTaskRun({ objective: "Fix the app" });
  const controller = {
    plan: [
      { step: "Inspect", status: "done" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" }
    ],
    checks: [],
    changedFiles: [],
    conversationDigest: {}
  };
  syncTaskRunFromController(run, controller);
  const count = run.events.length;
  syncTaskRunFromController(run, controller);
  assert.equal(run.events.length, count);
  assert.equal(run.events.find((event) => event.title === "Inspect").status, "done");
  assert.equal(run.events.find((event) => event.title === "Implement").status, "active");
});

test("structured compaction separates completed, current, and remaining work", () => {
  const run = createTaskRun({ objective: "Ship feature" });
  const compact = compactTaskRun(run, {
    plan: [
      { step: "Inspect", status: "done" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" }
    ],
    checks: ["tests passed"],
    changedFiles: ["src/app.js"],
    conversationDigest: { recentDecisions: ["Use the compact layout"] }
  });
  assert.deepEqual(compact.completedSteps, ["Inspect"]);
  assert.equal(compact.currentStep, "Implement");
  assert.deepEqual(compact.remainingSteps, ["Verify"]);
  assert.deepEqual(compact.verifiedChecks, ["tests passed"]);
});

test("visual build state is durable and only exposes localhost previews", () => {
  const run = createTaskRun({ objective: "Build the preview" });
  updateTaskRunVisual(run, {
    state: "previewing",
    previewUrl: "http://localhost:4173/app",
    cycle: 1,
    forceEvent: true
  });
  const visible = publicTaskRun(run);
  const compact = compactTaskRun(run);
  assert.equal(visible.visual.enabled, true);
  assert.equal(visible.visual.previewUrl, "http://localhost:4173/app");
  assert.equal(compact.visual.state, "previewing");
  assert.equal(visible.events.at(-1).type, "visual.preview");

  const restored = createTaskRun({ persisted: visible });
  assert.equal(restored.visual.cycle, 1);
  assert.equal(restored.visual.previewUrl, "http://localhost:4173/app");

  updateTaskRunVisual(restored, { state: "previewing", previewUrl: "https://example.com/private" });
  assert.equal(restored.visual.previewUrl, "", "remote URLs cannot become trusted local previews");
});
