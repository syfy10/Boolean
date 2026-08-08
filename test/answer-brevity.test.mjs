import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOOLLM_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tools = fs.readFileSync(path.join(root, "src", "tools.js"), "utf8").replace(/\r/g, "");

const policy = booleanAgentPolicy();

// A scheduled monitor answering "what is the price" produced the same three
// facts under "Changes Identified", "Summary of Changes" and "Alert". The
// policy had a dozen rules about correctness and none about length.
test("the policy sizes the answer to the question", () => {
  assert.match(policy, /Match the answer to the question/);
  assert.match(policy, /one or two sentences/);
  assert.match(policy, /never close with a summary, recap, or alert section that repeats/i);
});

test("the policy tells the model when NOT to reach for a tool", () => {
  assert.match(policy, /Do not list files, read notes, inspect the project, or run commands for a question whose answer does not depend on them/);
  assert.match(policy, /A tool call has to earn its place/);
});

test("the policy bans preamble and unrequested next-step menus", () => {
  assert.match(policy, /Skip preamble and filler/);
  assert.match(policy, /unrequested offers and next-step menus/);
});

// The notepad tool used to say "Use proactively when Full access is on", which
// is why a question about a stock pulled in an unrelated saved note.
test("the notepad is not read as background context", () => {
  const read = tools.slice(tools.indexOf('name: "notepad_read"'), tools.indexOf('name: "notepad_write"'));
  assert.doesNotMatch(read, /proactively/i);
  assert.match(read, /only when the user refers to their notes or the answer depends on them/);

  const write = tools.slice(tools.indexOf('name: "notepad_write"'), tools.indexOf('name: "notepad_write"') + 600);
  assert.doesNotMatch(write, /proactively/i);
  assert.match(write, /not on your own initiative/);
});

test("the added rules keep the policy's existing shape", () => {
  // Numbered, one line each, no persona or writing-style prescription.
  assert.equal(BOOLLM_AGENT_RULES.every((rule) => rule.length > 20 && !rule.includes("\n")), true);
  assert.match(policy, /^BOOLLM OPERATING POLICY\n1\. /);
  for (const persona of [/\bfriendly\b/i, /\bcheerful\b/i, /\byou are an?\b/i, /\bpersona\b/i]) {
    assert.doesNotMatch(policy, persona);
  }
});
