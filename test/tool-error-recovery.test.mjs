import test from "node:test";
import assert from "node:assert/strict";
import { recoverableToolErrorResult } from "../src/agent.js";

test("recoverable tool errors keep the task active and request a precise correction", () => {
  const result = recoverableToolErrorResult(
    "manage_automation",
    new Error("enter a valid run time or interval")
  );

  assert.match(result, /^recoverable tool error \(manage_automation\):/);
  assert.match(result, /enter a valid run time or interval/);
  assert.match(result, /task is still active/i);
  assert.match(result, /correct the tool arguments and retry now/i);
  assert.match(result, /ask the user one short, specific question/i);
});

test("recoverable tool errors do not stringify as a terminal Error banner", () => {
  const result = recoverableToolErrorResult("some_tool", "missing required date");

  assert.doesNotMatch(result, /^Error:/);
  assert.match(result, /likely correction/i);
});
