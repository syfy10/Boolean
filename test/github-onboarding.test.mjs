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
  assert.doesNotMatch(ui.slice(ui.indexOf('data-sec="github"'), ui.indexOf('data-sec="skills"')), /run 'gh auth login'/i);
});

test("GitHub setup supports install, secure browser login, and repository choices", () => {
  assert.match(server, /winget install --id GitHub\.cli/);
  assert.match(server, /gh auth login --hostname github\.com --git-protocol https --web/);
  assert.match(server, /action === "repo_create"/);
  assert.match(server, /action === "repo_connect"/);
  assert.match(ui, /id="ghCreateRepo"/);
  assert.match(ui, /id="ghConnectRepo"/);
});

test("GitHub status distinguishes a missing CLI from signed-out state", () => {
  assert.match(platform, /runProcess\("gh", \["--version"\]/);
  assert.match(platform, /installed: false, authenticated: false/);
});
