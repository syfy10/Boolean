import assert from "node:assert/strict";
import test from "node:test";
import { CodexOrchestrator } from "../src/orchestrator.js";

test("Codex-style orchestration streams one Thread Turn Item lifecycle", () => {
  const events = [];
  const flow = new CodexOrchestrator({ onEvent: (event) => events.push(event) });
  const turn = flow.startTurn("Inspect the project and summarize it.");
  const tool = flow.startItem("tool_call", { title: "list files" });
  flow.completeItem(tool.id, { detail: "3 files" });
  const answer = flow.startItem("agent_message", { title: "Answer" });
  flow.delta(answer.id, "Short ");
  flow.delta(answer.id, "summary");
  flow.completeItem(answer.id);
  flow.completeTurn("Short summary");
  assert.equal(turn.status, "completed");
  assert.deepEqual(events.map((event) => event.method), [
    "turn/started", "item/started", "item/completed", "item/started", "item/completed",
    "item/started", "item/agentMessage/delta", "item/agentMessage/delta", "item/completed", "turn/completed"
  ]);
});

test("active turns support steering approvals persistence and interruption", () => {
  const flow = new CodexOrchestrator();
  const turn = flow.startTurn("Deploy the app.");
  flow.steer("Local only.");
  const approval = flow.requestApproval("Run the exact local install command.");
  assert.equal(turn.status, "waiting");
  flow.resolveApproval(approval.id, true);
  assert.equal(turn.status, "in_progress");
  const restored = new CodexOrchestrator({ persisted: flow.snapshot() });
  assert.equal(restored.activeTurn().steering[0].text, "Local only.");
  restored.interruptTurn();
  assert.equal(restored.thread.turns.at(-1).status, "interrupted");
});

test("orchestration is wired through the server and compact chat presentation", async () => {
  const fs = await import("node:fs");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(server, /onOrchestration: \(event, orchestration\)/);
  assert.match(server, /send\(\{ type: "orchestration", event, orchestration \}\)/);
  assert.match(server, /ctx\.orchestration\?\.failTurn/);
  assert.match(server, /turnStatus === "completed" \? "answer" : "paused"/);
  assert.match(store, /orchestration: t\.orchestration/);
  assert.match(ui, /function renderTurnActivity\(orchestration\)/);
  assert.match(ui, /else if\(ev\.type==="orchestration"\)/);
  assert.match(ui, /function latestOrchestrationTurn\(snapshot\)/);
  assert.match(ui, /renderWorkingCardActivity\(run\)/);
});
