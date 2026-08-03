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
  const installFunction = uiSource.match(/async function installClaudeCodeCli\(\)\{[\s\S]*?\r?\n  \}\r?\n  async function startClaudeCodeSignIn/)?.[0] || "";
  assert.match(installFunction, /appConfirm\("Set up Claude Code\?"/);
  assert.match(installFunction, /fetch\("\/api\/claude-code\/install"/);
  assert.ok(installFunction.indexOf("appConfirm") < installFunction.indexOf('fetch("/api/claude-code/install"'));
  assert.match(installFunction, /verify it, and open Claude sign-in/);
  assert.match(uiSource, /claudeLoginStarted=true/);
  assert.match(uiSource, /claudeLoginStarted\?"check":"signin"/);
  assert.match(uiSource, /action==="check"\) await checkClaudeCodeConnection\(\)/);
  assert.match(uiSource, /Opening the Claude sign-in terminal and browser verification/);
  assert.match(uiSource, /scheduleClaudeCodeLoginCheck\(\)/);
  assert.match(uiSource, /if\(result\.signedIn===true&&result\.ready===true\)[\s\S]*Claude Code connected/);
});

test("Claude Code model and executable controls stay in the guided settings card", () => {
  assert.match(uiSource, /id="claudeCodeModel"[\s\S]*Sonnet[\s\S]*Opus[\s\S]*Haiku/);
  assert.match(uiSource, /claudeModelControls"\)\.hidden=!installed/);
  assert.match(uiSource, /claudeCodeModel"\)\.disabled=!signedIn/);
  assert.match(uiSource, /Sign in with Claude to choose a model/);
  assert.match(uiSource, /<details class="codex-advanced">[\s\S]*id="claudeCodeCommand"[\s\S]*id="claudeCodeCheck"/);
  assert.match(uiSource, /Setup &amp; diagnostics/);
});

test("Claude Code cannot render active before verified sign-in", () => {
  assert.match(uiSource, /const ready=claude\.ready===true&&signedIn/);
  assert.match(uiSource, /const active=enabled&&ready/);
});

test("the selected orchestration engine is explicit and accessible", () => {
  assert.match(uiSource, /id="orchestrationSelected">Selected: <b>Boolean<\/b>/);
  assert.match(uiSource, /button\.setAttribute\("aria-pressed",String\(selected\)\)/);
  assert.match(uiSource, /#orchestrationSeg button\.on::before\{ content:"✓"/);
});

test("Codex and Claude engine choices show connected or disconnected dots", () => {
  assert.match(uiSource, /const engineConnected=\{[\s\S]*codex:codex\.ready===true&&codex\.account\?\.signedIn===true[\s\S]*"claude-code":state\.claudeCode\?\.ready===true&&state\.claudeCode\?\.signedIn===true/);
  assert.match(uiSource, /class="orchestration-engine-state '\+\(connected\?"connected":""\)/);
  assert.match(uiSource, /button\.setAttribute\("aria-label",label\+": "\+status\)/);
  assert.match(uiSource, /\.orchestration-engine-state\{[^}]*background:var\(--red\)/);
  assert.match(uiSource, /\.orchestration-engine-state\.connected\{[^}]*background:var\(--green\)/);
  assert.match(uiSource, /class="engine-ready '\+\(ready\[runtime\]\?"":"down"\)/);
});

test("the compact model picker can select Auto Boolean Codex or Claude", () => {
  assert.match(uiSource, /id="modelEnginePicker"[\s\S]*data-picker-runtime="auto"[\s\S]*data-picker-runtime="boolean"[\s\S]*data-picker-runtime="codex"[\s\S]*data-picker-runtime="claude-code"/);
  assert.match(uiSource, /Auto starts with Boolean and uses an approved Codex or Claude fallback when needed/);
  assert.match(uiSource, /selectCodingRuntime\(button\.dataset\.pickerRuntime,\{fromPicker:true\}\)/);
  assert.match(uiSource, /const prefix=engine==="auto"\?"Auto · ":engine==="codex"\?"Codex · ":engine==="claude-code"\?"Claude · ":""/);
});

test("switching to Local selects the local Boolean runtime and labels it Local", () => {
  assert.match(uiSource, /if\(net==="local"\)\{[\s\S]*state\.codingEngine="boolean";[\s\S]*JSON\.stringify\(\{provider:"local",codingEngine:"boolean"\}\)/);
  assert.match(uiSource, /const localMode=\(modelPickerNet\|\|\(state\.provider==="local"\?"local":"online"\)\)==="local"/);
  assert.match(uiSource, /runtime==="boolean"&&localMode\?"Local"/);
  assert.match(uiSource, /Local uses the selected model on this PC/);
});
