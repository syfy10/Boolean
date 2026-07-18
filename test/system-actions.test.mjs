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
