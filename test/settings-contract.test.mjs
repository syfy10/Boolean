import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { defaultConfig, defaultUiSettings } from "../src/config.js";
import { resolveProviderTarget } from "../src/providers.js";

const uiSource = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const toolsSource = fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");

test("Connectors includes a real Cloudflare account control surface", () => {
  assert.match(uiSource, /data-add-connector="cloudflare"/);
  assert.match(uiSource, /id="cloudflareOAuthClientId"/);
  assert.match(uiSource, /id="cloudflareOAuthConnect"/);
  assert.match(uiSource, /id="cloudflareOAuthConnect">Connect Cloudflare/);
  assert.match(uiSource, /id="cloudflareAdvanced"/);
  assert.match(uiSource, /Advanced setup/);
  assert.match(uiSource, /id="cloudflareToken"/);
  assert.match(uiSource, /id="cloudflareAccount"/);
  assert.match(uiSource, /data-cloudflare-resource="workers"/);
  assert.match(uiSource, /data-cloudflare-resource="pages"/);
  assert.match(uiSource, /data-cloudflare-resource="d1"/);
  assert.match(uiSource, /data-cloudflare-resource="r2"/);
  assert.match(serverSource, /p === "\/api\/cloudflare\/connect"/);
  assert.match(serverSource, /p === "\/api\/cloudflare\/oauth\/start"/);
  assert.match(serverSource, /p === "\/cloudflare\/oauth\/callback"/);
  assert.match(serverSource, /p === "\/api\/cloudflare\/resources"/);
  assert.match(uiSource, /type="password" id="cloudflareToken"/);
});

test("Cloudflare fallback controls stay inside the Settings content column", () => {
  assert.match(
    uiSource,
    /id="cloudflareAdvanced"[\s\S]*id="cloudflareOAuthClientId"[\s\S]*id="cloudflareConnect"[^>]*>Verify API token<\/button>[\s\S]*<\/details>\s*<div class="setrow" id="cloudflareAccountRow"/,
  );
  assert.match(uiSource, /id="cloudflareConnectCard"[\s\S]*id="cloudflareOAuthConnect">Connect Cloudflare/);
});

test("MCP approval copy distinguishes reads from account-changing actions", () => {
  assert.match(uiSource, /Read-only MCP calls follow your approval mode/);
  assert.match(uiSource, /Trades, orders, transfers, deletes/);
  assert.match(toolsSource, /mcpToolRequiresExplicitApproval/);
  assert.doesNotMatch(toolsSource, /Boollm always asks the user to confirm MCP actions/);
});

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
  assert.match(serverSource, /DELETE ALL BOOLLM DATA/);
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

test("Notepad and Memory is a searchable, editable local control center", () => {
  assert.match(uiSource, /class="memory-status-grid"/);
  assert.match(uiSource, /id="chatMemoryStatus"/);
  assert.match(uiSource, /id="learningStatus"/);
  assert.match(uiSource, /id="memoryRuleCount"/);
  assert.match(uiSource, /id="memorySearch"[^>]*placeholder="Search saved preferences"/);
  assert.match(uiSource, /Review exactly what Boollm will reuse\. Edit or forget any item\./);
  assert.match(uiSource, /data-action="edit"/);
  assert.match(uiSource, /data-action="forget"/);
  assert.match(uiSource, /View saved example/);
  assert.match(uiSource, /id="turnNoteIntoRule"[^>]*>Add project rule</);
  assert.match(serverSource, /p === "\/api\/preferences\/update"/);
  assert.match(serverSource, /updatePreference\(String\(body\.id \|\| ""\), String\(body\.text \|\| ""\)\)/);
});

test("first-run setup does not promise automatic paid-provider routing", () => {
  assert.doesNotMatch(uiSource, /Both \(smart routing\)/);
  assert.match(uiSource, /will not switch providers or paid APIs without your choice/);
});

test("semantic success states remain green in every theme", () => {
  assert.match(uiSource, /--green:#3fb950;/);
  assert.doesNotMatch(uiSource, /--green:#(?:62676f|a7abb1);/i);
});
