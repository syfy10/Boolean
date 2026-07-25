import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import { announcesUnperformedAction, focusedMessagesForTurn } from "../src/agent.js";

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

test("inspect context keeps the original request after many native tool calls", () => {
  const request = "Review app/styles.css and report the responsive layout bugs. Do not edit.";
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: request }
  ];
  for (let i = 0; i < 7; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }]
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `CSS snippet ${i}` });
  }

  const focused = focusedMessagesForTurn(messages, "inspect");
  assert.equal(focused.some((message) => message.role === "user" && message.content === request), true);
  assert.equal(focused.at(-1).content, "CSS snippet 6");
});

test("inspect context does not mistake compatibility tool results for the user request", () => {
  const request = "Find every .app-shell width rule and summarize them.";
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: request }
  ];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: `{\"name\":\"search_files\",\"arguments\":{\"query\":\"app-shell-${i}\"}}` });
    messages.push({ role: "user", content: `TOOL RESULT for search_files:\nmatch ${i}` });
  }

  const focused = focusedMessagesForTurn(messages, "inspect");
  const userPrompts = focused.filter((message) => message.role === "user").map((message) => message.content);
  assert.equal(userPrompts.includes(request), true);
  assert.equal(userPrompts.filter((text) => /^TOOL RESULT for /i.test(text)).length > 0, true);
});

test("unfinished action announcements are retried even after earlier tool work", () => {
  const source = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(source, /const MAX_ANNOUNCE_NUDGES = neutralModelRelay \? 2 : 3;/);
  assert.match(source, /if \(activeToolDefinitions\.length && !signal\?\.aborted[\s\S]*?announcesUnperformedAction\(assistantContent\)\)/);
  assert.doesNotMatch(source, /activeToolDefinitions\.length && !completedToolWork && !signal\?\.aborted/);
});
