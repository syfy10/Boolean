import assert from "node:assert/strict";
import test from "node:test";
import { listActions, searchActions } from "../src/actions.js";

test("semantic action registry has stable unique ids", () => {
  const actions = listActions();
  assert.ok(actions.length >= 10);
  assert.equal(new Set(actions.map((action) => action.id)).size, actions.length);
});

test("capability search finds actions by aliases", () => {
  assert.equal(searchActions("prospect")[0].id, "workspace.sales");
  assert.equal(searchActions("scratchpad")[0].id, "workspace.notepad");
  assert.equal(searchActions("support bundle")[0].id, "task.diagnostics");
});
