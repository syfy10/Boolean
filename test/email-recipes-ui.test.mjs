import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("Email Recipes include connected-mail and cleanup workflows", () => {
  const html = read("../src/ui.html");
  for (const id of [
    "email-briefing",
    "email-current",
    "email-needs-reply",
    "email-draft",
    "email-tasks",
    "email-important",
    "email-attachments",
    "email-clean-sender",
    "email-cleanup"
  ]) {
    assert.match(html, new RegExp(`id:\\"${id}\\"`));
  }
  assert.match(html, /Maximum to scan/);
  assert.match(html, /value="5000"/);
  assert.match(html, /Nothing moves until you confirm a reviewed batch/);
});

test("built-in browser switches to email actions for Gmail and Outlook", () => {
  const html = read("../src/ui.html");
  const shell = read("../shell/Program.cs");
  for (const action of ["email_summary", "email_reply", "email_tasks", "email_save", "email_clean", "email_more"]) {
    assert.match(html, new RegExp(action));
  }
  assert.match(html, /mail\.google\.com/);
  assert.match(html, /outlook\.office365\.com/);
  assert.match(shell, /mail\.google\.com/);
  assert.match(shell, /outlook\.office365\.com/);
  assert.match(shell, /UpdateBrowserTasks/);
});

test("email cleanup exposes preview, reversible Trash, and Undo only", () => {
  const tools = read("../src/tools.js");
  const email = read("../src/email.js");
  assert.match(tools, /name: "email_cleanup_preview"/);
  assert.match(tools, /name: "email_cleanup_trash"/);
  assert.match(tools, /name: "email_cleanup_undo"/);
  assert.doesNotMatch(tools, /name: "email_cleanup_(?:delete|purge)"/);
  assert.doesNotMatch(email, /users\/messages\/batchDelete/);
});

test("email connection UI supports one-click managed setup and manual fallback", () => {
  const html = read("../src/ui.html");
  const server = read("../src/server.js");
  assert.match(html, /Connect once with Google or Microsoft/);
  assert.match(html, /Advanced OAuth setup/);
  assert.match(html, /gmailManualConnect/);
  assert.match(html, /outlookManualConnect/);
  assert.match(html, /\/api\/email\/test/);
  assert.match(html, /data-connect-email/);
  assert.match(server, /mode === "manual"/);
  assert.match(server, /emailOAuthRedirectUri/);
  assert.match(server, /emailOAuthCallbackRequest/);
});
