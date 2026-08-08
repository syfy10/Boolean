import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8").replace(/\r/g, "");
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");

// A scheduled ENPH monitor reported "Current: ENPH Price: $40.31, P&L +$220.00,
// Volume 16,500" and raised a significant-change alert. Nothing had read the
// page — the task is prompt-type (no tools) and the browser snapshot had gone
// stale, so the model was handed "read the visible browser page" with no page
// and filled the blank itself.
test("a scheduled task with no page snapshot is told, and told not to guess", () => {
  const start = server.indexOf("const needsVisiblePage =");
  const end = server.indexOf("const provider =", start);
  assert.ok(start >= 0 && end > start, "the scheduled prompt builder was not found");
  const block = server.slice(start, end);

  assert.match(block, /const missingPage = needsVisiblePage && !liveBrowserContext/);
  assert.match(block, /NO PAGE SNAPSHOT IS AVAILABLE/);
  // The three ways a blank gets filled: inventing, assuming, and recycling the
  // baseline as if it were a fresh reading.
  assert.match(block, /Do NOT estimate, assume, or repeat earlier values as if they were current/);
  assert.match(block, /do NOT raise an alert/);
  // An agent task can still go and read it; a prompt task cannot, and saying so
  // is the difference between a useful retry and a fabricated one.
  assert.match(block, /visible_browser_read before answering/);
  assert.match(block, /no tools, so there is no way to read the page on this run/);
});

test("the gap names why there is no page, not just that there isn't one", () => {
  const start = server.indexOf("const browserSnapshotGap =");
  const end = server.indexOf("const browserSnapshotText =", start);
  assert.ok(start >= 0 && end > start, "browserSnapshotGap was not found");
  const gap = server.slice(start, end);
  assert.match(gap, /no page has been read from Boollm's built-in browser yet/);
  assert.match(gap, /stale beyond the 120-second limit/);
  // The staleness cutoff the gap reports has to be the same one the snapshot
  // reader enforces, or the explanation would contradict the behaviour.
  const reader = server.slice(server.indexOf("const browserSnapshotText ="), server.indexOf("// ── broker snapshot"));
  assert.match(reader, /ageMs > 120000/);
  assert.match(gap, /120/);
});

// Prompt tasks answer with no tools at all; only agent tasks get them. A
// monitor written as a prompt task can therefore never fetch a page itself.
test("the scheduler is explicit that prompt tasks have no tools", () => {
  assert.match(ui, /Runs unattended with tools\. Auto-approve must be enabled when saved\./);
  assert.match(ui, /Answers in this chat without using tools\./);
  assert.match(server, /if \(item\.actionType === "agent"\) \{/);
  assert.match(server, /needs Auto-approve/);
});
