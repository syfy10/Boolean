import assert from "node:assert/strict";
import test from "node:test";

import { announcesUnperformedAction } from "../src/agent.js";

test("catches bare next-step announcements with no deliverable", () => {
  // The exact GLM stalls from the reported bug.
  assert.equal(announcesUnperformedAction("Let me read both files now."), true);
  assert.equal(announcesUnperformedAction("Let me read both files to understand the current state."), true);
  assert.equal(announcesUnperformedAction("Right, let me actually read the files now."), true);
  assert.equal(announcesUnperformedAction("My apologies — let me actually read them now."), true);
  assert.equal(announcesUnperformedAction("Let me read the files now."), true);
  assert.equal(announcesUnperformedAction("I'll check agent.js to see how ctx is built."), true);
  assert.equal(announcesUnperformedAction("Let me start with src/relay.js to check where we left off."), true);
});

test("ignores real answers, questions, and long substantive text", () => {
  // A genuine answer to a question — no imminent self-action.
  assert.equal(announcesUnperformedAction("The relay executes tools via ctx.executeTool at line 260."), false);
  // Asking the user, not announcing an action to take now.
  assert.equal(announcesUnperformedAction("Which file should I start with, relay.js or agent.js?"), false);
  // Empty / whitespace.
  assert.equal(announcesUnperformedAction(""), false);
  assert.equal(announcesUnperformedAction("   "), false);
  // Long status report that merely mentions future steps is not a bare stall.
  const longStatus = "Here is where we stand. " + "We designed the relay architecture and started building relay.js. ".repeat(12);
  assert.ok(longStatus.length >= 400);
  assert.equal(announcesUnperformedAction(longStatus), false);
});
