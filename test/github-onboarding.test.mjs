import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const platform = fs.readFileSync(new URL("../src/platform.js", import.meta.url), "utf8");

test("GitHub settings provides a guided connection instead of terminal instructions", () => {
  assert.match(ui, /id="ghConnect"[^>]*>Connect GitHub</);
  assert.match(ui, /Install GitHub CLI/);
  assert.match(ui, /No command typing is required/);
  assert.match(ui, /id="ghSwitch"/);
  assert.match(ui, /id="ghDisconnect"/);
  assert.match(ui, /id="ghSetupProgress"/);
  assert.match(ui, /https:\/\/cli\.github\.com\//);
  assert.doesNotMatch(ui.slice(ui.indexOf('data-sec="github"'), ui.indexOf('data-sec="skills"')), /run 'gh auth login'/i);
});

test("GitHub setup supports install, secure browser login, and repository choices", () => {
  assert.match(server, /"winget\.exe", \["install", "--id", "GitHub\.cli"/);
  assert.match(server, /\["auth", "login", "--hostname", "github\.com", "--git-protocol", "https", "--web", "--clipboard"\]/);
  assert.match(server, /confirmedBackgroundSpawn/);
  assert.match(server, /-EncodedCommand/);
  assert.match(server, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.match(server, /action === "repo_create"/);
  assert.match(server, /action === "repo_connect"/);
  assert.match(ui, /id="ghCreateRepo"/);
  assert.match(ui, /id="ghConnectRepo"/);
});

test("GitHub status distinguishes a missing CLI from signed-out state", () => {
  assert.match(platform, /function githubCliCommand\(\)/);
  assert.match(platform, /"GitHub CLI", "gh\.exe"/);
  assert.match(platform, /runProcess\(gh, \["--version"\]/);
  assert.match(platform, /fs\.existsSync\(requestedCwd\) \? requestedCwd : process\.cwd\(\)/);
  assert.match(platform, /installed: false, authenticated: false/);
});

test("Claude subscription turns receive the token-protected Boollm browser MCP route", () => {
  assert.match(server, /p === "\/api\/claude\/mcp"/);
  assert.match(server, /body\.method === "tools\/list"/);
  assert.match(server, /body\.method === "tools\/call"/);
  assert.match(server, /browserBridge: \{ url: `http:\/\/127\.0\.0\.1:\$\{serverPort\}\/api\/claude\/mcp/);
});
