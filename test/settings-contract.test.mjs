import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { defaultConfig, defaultUiSettings } from "../src/config.js";
import { resolveProviderTarget } from "../src/providers.js";

const uiSource = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("settings defaults are independent and never enable paid-provider switching", () => {
  const first = defaultUiSettings();
  const second = defaultUiSettings();

  first.codingAgent.maxRetries = 5;
  assert.equal(second.codingAgent.maxRetries, 2);
  assert.equal(second.autoRouteModels, false);

  const config = defaultConfig();
  assert.equal(config.provider, "local");
  assert.equal(config.cloudFallback.enabled, false);
  assert.equal(config.openai.apiKey, "");
});

test("cloud endpoint overrides and configured retries reach the provider client", async () => {
  const config = defaultConfig();
  config.provider = "openai";
  config.openai.apiKey = "test-key";
  config.ui.apiOverrides = { openai: "https://example.test/v1/chat/completions" };
  config.ui.codingAgent.maxRetries = 2;

  const target = await resolveProviderTarget(config);
  assert.equal(target.base, "https://example.test/v1");
  assert.equal(target.maxRetries, 3);
});

test("settings UI does not expose unsupported voice, telemetry, or encryption switches", () => {
  assert.doesNotMatch(uiSource, /id="voiceInput"/);
  assert.doesNotMatch(uiSource, /id="voiceTTS"/);
  assert.doesNotMatch(uiSource, /id="privacyTelemetry"/);
  assert.doesNotMatch(uiSource, /id="privacyEncryption"/);
  assert.match(uiSource, /Speech-to-text controls are not available in this build/);
  assert.match(uiSource, /Encrypted local vault/);
  assert.match(uiSource, /Not available yet\. Local files are protected by your Windows account permissions/);
});

test("reset and destructive delete are separate guarded operations", () => {
  assert.match(serverSource, /p === "\/api\/settings\/reset"/);
  assert.match(serverSource, /p === "\/api\/delete-all-data"/);
  assert.match(serverSource, /DELETE ALL BOOLEAN DATA/);
  assert.match(uiSource, /Accounts, API keys, email connections, chats, and projects are preserved/);
  assert.match(uiSource, /permanently removes chats, learned behavior, preferences, API keys, OAuth accounts, and connector credentials/);
});

test("overview exposes local save, private backup, account, and guarded clear controls", () => {
  assert.match(uiSource, /id="overviewAccountName"/);
  assert.match(uiSource, /id="overviewAccountEmail"/);
  assert.match(uiSource, /id="overviewAccountAuth"/);
  assert.match(uiSource, /id="saveLocalData"[^>]*>Save now</);
  assert.match(uiSource, /id="backupLocalData"[^>]*>Create local backup</);
  assert.match(uiSource, /id="clearLocalData"[^>]*>Clear local data</);
  assert.match(uiSource, /Layout, theme, and behavior/);
  assert.match(uiSource, /API keys and selected models/);
  assert.match(uiSource, /Email and connector accounts/);
  assert.match(uiSource, /Chats, notes, and memory/);
  assert.match(uiSource, /including credentials and connection records/);
  assert.match(uiSource, /clearLocalData"\)\.onclick=deleteAllBooleanData/);
});

test("manual local checkpoints persist config and chats and keep sensitive backups on this PC", () => {
  assert.match(serverSource, /p === "\/api\/local-data\/save"/);
  assert.match(serverSource, /p === "\/api\/local-data\/backup"/);
  assert.match(serverSource, /saveConfig\(config\)/);
  assert.match(serverSource, /saveThreads\(\[\.\.\.threads\.values\(\)\]/);
  assert.match(serverSource, /path\.join\(SAZ_DIR, "backups", `manual-\$\{stamp\}`\)/);
  assert.match(serverSource, /"config\.json"/);
  assert.match(serverSource, /"threads\.json"/);
  assert.match(serverSource, /sensitive: true/);
});

test("first-run setup does not promise automatic paid-provider routing", () => {
  assert.doesNotMatch(uiSource, /Both \(smart routing\)/);
  assert.match(uiSource, /will not switch providers or paid APIs without your choice/);
});

test("semantic success states remain green in every theme", () => {
  assert.match(uiSource, /--green:#3fb950;/);
  assert.doesNotMatch(uiSource, /--green:#(?:62676f|a7abb1);/i);
});
