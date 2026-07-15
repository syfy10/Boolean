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
