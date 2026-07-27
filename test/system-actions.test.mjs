import assert from "node:assert/strict";
import test from "node:test";

import { detectWindowsSettingsRequest } from "../src/system-actions.js";

test("does not combine unrelated project handoff lines into a Windows action", () => {
  const prompt = `StockSignal latest project folder:
C:\\Users\\S10\\OneDrive\\Documents\\StockSignal

Main files:
- src/worker.js = Cloudflare Worker API, Yahoo data, AI, scanner, COT, MCP

Local test:
Open/run the app at http://localhost:4173

can you take over this project?`;
  assert.equal(detectWindowsSettingsRequest(prompt), null);
});

test("does not route long settings roadmap context as a Windows privacy action", () => {
  const prompt = `You: tell me where are we with this project on this list.

I would change Settings from a long options page into a control center.

8. Privacy & Safety
- Local-only mode
- Cloud AI allowed/on/off
- Web access allowed/on/off

Add a guided local vs cloud setup flow, model recommendation by RAM, and a visible privacy data explanation.`;
  assert.equal(detectWindowsSettingsRequest(prompt), null);
});

test("does not route resume/status messages into Windows Settings", () => {
  assert.equal(detectWindowsSettingsRequest("keep going"), null);
  assert.equal(detectWindowsSettingsRequest("why did it stop?"), null);
  assert.equal(detectWindowsSettingsRequest("can you do this now?"), null);
});

test("does not confuse a project update question with Windows Update", () => {
  assert.equal(
    detectWindowsSettingsRequest("whats the last update file you have on this project and what was the last change?"),
    null
  );
});

test("email cleanup recipes never open Windows account settings", () => {
  const noOpenEmail = `Use the sender and subject from the email open in Boollm's browser to call email_cleanup_preview for the connected Gmail or Outlook account.

Connected account: syfy10@gmail.com (gmail).

No open email page was detected.

Before any write action, verify that the saved cleanup plan and connected account belong to the same mailbox.`;
  const openGmail = `Use the sender and subject from the email open in Boollm's browser to call email_cleanup_preview for the connected Gmail or Outlook account.

Connected account: syfy10@gmail.com (gmail).

Email open in Boollm browser: Inbox (5,853) - syfy10@gmail.com - Gmail (https://mail.google.com/mail/u/0/#inbox)

Before any write action, verify that the browser email belongs to the connected account.`;

  assert.equal(detectWindowsSettingsRequest(noOpenEmail), null);
  assert.equal(detectWindowsSettingsRequest(openGmail), null);
});

test("still routes explicit Windows Update settings requests", () => {
  assert.deepEqual(detectWindowsSettingsRequest("Open Windows Update"), {
    name: "windows_settings_open",
    args: { page: "windows_update" }
  });
  assert.deepEqual(detectWindowsSettingsRequest("Open update settings"), {
    name: "windows_settings_open",
    args: { page: "windows_update" }
  });
});

test("still routes explicit display settings requests", () => {
  assert.deepEqual(detectWindowsSettingsRequest("Open display settings"), {
    name: "windows_settings_open",
    args: { page: "display" }
  });
});

test("still routes explicit printer settings requests", () => {
  assert.deepEqual(detectWindowsSettingsRequest("Show my printer settings"), {
    name: "windows_settings_open",
    args: { page: "printers" }
  });
});

test("still routes explicit privacy settings requests", () => {
  assert.deepEqual(detectWindowsSettingsRequest("Open Windows privacy settings"), {
    name: "windows_settings_open",
    args: { page: "privacy" }
  });
});

test("still routes an explicit Windows accounts settings request", () => {
  assert.deepEqual(detectWindowsSettingsRequest("Open Windows account settings"), {
    name: "windows_settings_open",
    args: { page: "accounts" }
  });
});
