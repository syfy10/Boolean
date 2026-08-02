import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const uiSource = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

test("Coding Agent settings offer Claude Code beside Boolean and Codex", () => {
  assert.match(uiSource, /id="orchestrationSeg"[\s\S]*data-runtime="auto"[\s\S]*data-runtime="boolean"[\s\S]*data-runtime="codex"[\s\S]*data-runtime="claude-code"/);
  assert.match(uiSource, /<b>Claude Code engine<\/b>/);
  assert.match(uiSource, /data-claude-step="install"[\s\S]*Install Claude Code/);
  assert.match(uiSource, /data-claude-step="signin"[\s\S]*Sign in with Claude/);
  assert.match(uiSource, /data-claude-step="ready"[\s\S]*Ready to code/);
});

test("Auto orchestration uses Codex and Claude only as failed code or task fallbacks", () => {
  assert.match(uiSource, /id="modelRoutingCodexSubscription"[\s\S]*Use Codex if the selected API cannot finish code or a project task/);
  assert.match(uiSource, /id="modelRoutingClaudeSubscription"[\s\S]*Use Claude if the selected API cannot finish code or a project task/);
  assert.match(uiSource, /id="modelRoutingSubscriptionPreference"[\s\S]*Codex first[\s\S]*Claude first[\s\S]*First ready/);
  assert.match(uiSource, /if\(route==="coding"\)[\s\S]*engine:codex[\s\S]*engine:claude-code/);
  assert.match(uiSource, /saveCodingEngineSelection\("auto"\)/);
  assert.match(uiSource, /value\.startsWith\("engine:"\)/);
});

test("Claude Code setup requires confirmation and has a guided sign-in recheck", () => {
  const installFunction = uiSource.match(/async function installClaudeCodeCli\(\)\{[\s\S]*?\n  \}\n  async function startClaudeCodeSignIn/)?.[0] || "";
  assert.match(installFunction, /appConfirm\("Install Claude Code\?"/);
  assert.match(installFunction, /fetch\("\/api\/claude-code\/install"/);
  assert.ok(installFunction.indexOf("appConfirm") < installFunction.indexOf('fetch("/api/claude-code/install"'));
  assert.match(uiSource, /claudeLoginStarted=true/);
  assert.match(uiSource, /claudeLoginStarted\?"check":"signin"/);
  assert.match(uiSource, /action==="check"\) await checkClaudeCodeConnection\(\)/);
});

test("Claude Code model and executable controls stay in the guided settings card", () => {
  assert.match(uiSource, /id="claudeCodeModel"[\s\S]*Sonnet[\s\S]*Opus[\s\S]*Haiku/);
  assert.match(uiSource, /<details class="codex-advanced">[\s\S]*id="claudeCodeCommand"[\s\S]*id="claudeCodeCheck"/);
  assert.match(uiSource, /Setup &amp; diagnostics/);
});
