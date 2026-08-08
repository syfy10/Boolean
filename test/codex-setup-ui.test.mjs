import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const uiSource = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8").replace(/\r/g, "");

test("Codex setup uses one guided three-step card instead of exposed app-server controls", () => {
  assert.match(uiSource, /<b>Codex coding engine<\/b>/);
  assert.match(uiSource, /data-codex-step="install"[\s\S]*Install Codex CLI/);
  assert.match(uiSource, /data-codex-step="signin"[\s\S]*Sign in with ChatGPT/);
  assert.match(uiSource, /data-codex-step="ready"[\s\S]*Ready to use/);
  assert.equal((uiSource.match(/id="codexPrimaryAction"/g) || []).length, 1);
  assert.match(uiSource, /id="codexPrimaryAction"[^>]*>Set up Codex<\/button>/);
  assert.doesNotMatch(uiSource, /<b>Codex app-server<\/b>/);
});

test("Codex installation requires confirmation and auto-checks after the explicit install POST", () => {
  const installFunction = uiSource.match(/async function installCodexCli\(\)\{[\s\S]*?\n  \}\n  async function startCodexSignIn/)?.[0] || "";
  assert.match(installFunction, /appConfirm\("Install Codex CLI\?"/);
  assert.match(installFunction, /fetch\("\/api\/codex\/install",\{method:"POST",headers:\{"content-type":"application\/json","x-saz":"1"\},body:"\{\}"\}\)/);
  assert.ok(installFunction.indexOf("appConfirm") < installFunction.indexOf('fetch("/api/codex/install"'));
  assert.match(installFunction, /const raw=await response\.text\(\)/);
  assert.match(installFunction, /response\.status===404[\s\S]*backend is out of date\. Restart Boollm/);
  assert.match(installFunction, /await refreshCodexStatus\(\{start:true,quiet:true\}\)/);
  assert.match(uiSource, /installing\?"Installing Codex…"/);
});

test("Codex sign-in exposes a visible waiting state, timeout, and retry path", () => {
  assert.match(uiSource, /codexAuthPending\?"Waiting for sign-in…"/);
  assert.match(uiSource, /Date\.now\(\)-startedAt>=300000/);
  assert.match(uiSource, /Sign-in timed out\. Finish the browser sign-in, then try again\./);
  assert.match(uiSource, /codexAuthTimedOut\?"Try sign-in again":"Sign in with ChatGPT"/);
  assert.match(uiSource, /codexAuthPollTimer=setTimeout\(poll,2000\)/);
  assert.match(uiSource, /await cancelCodexLogin\(\)/);
  assert.match(uiSource, /fetch\("\/api\/codex\/auth\/cancel"[\s\S]*JSON\.stringify\(\{loginId\}\)/);
});

test("Codex OAuth navigation accepts only bounded ChatGPT HTTPS URLs", () => {
  assert.match(uiSource, /function safeCodexAuthUrl\(value\)/);
  assert.match(uiSource, /raw\.length>2048/);
  assert.match(uiSource, /url\.protocol!=="https:"\|\|url\.username\|\|url\.password/);
  assert.match(uiSource, /host!=="chatgpt\.com"&&!host\.endsWith\("\.chatgpt\.com"\)/);
  assert.match(uiSource, /const authUrl=safeCodexAuthUrl\(result\.authUrl\)/);
  assert.match(uiSource, /popup\.opener=null;\}catch\{\} popup\.location=authUrl/);
  assert.match(uiSource, /unsafe sign-in address\. Sign-in was cancelled/);
});

test("models stay hidden until sign-in and technical controls live under Advanced", () => {
  assert.match(uiSource, /if\(\$\("codexModelControls"\)\) \$\("codexModelControls"\)\.hidden=!signedIn/);
  assert.match(uiSource, /\.codex-progress\[hidden\],\.codex-models\[hidden\]\{ display:none; \}/);
  assert.match(uiSource, /<details class="codex-advanced" id="codexAdvanced">[\s\S]*<summary>Advanced<\/summary>/);
  assert.match(uiSource, /id="codexAdvanced"[\s\S]*id="codexCommand"[\s\S]*id="codexCheck"[\s\S]*id="codexSetupGuide"[\s\S]*id="codexSignOut"/);
  assert.match(uiSource, /Setup &amp; diagnostics/);
});

test("missing CLI state stays guided instead of exposing npm commands", () => {
  assert.match(uiSource, /const missingCliExpected=!installed&&\/\(\?:Codex CLI was not found\|npm install -g @openai\\\/codex\)\/i\.test\(setupError\)/);
  assert.match(uiSource, /const error=missingCliExpected\?"":setupError/);
});

test("Microsoft Store desktop paths never render in the executable field", () => {
  assert.match(uiSource, /function codexDisplayCommand\(value\)/);
  assert.ok(uiSource.includes(String.raw`/[\\/]WindowsApps[\\/].*OpenAI\.Codex_/i.test(command)?"codex":command`));
  assert.match(uiSource, /\?"codex":command/);
  assert.match(uiSource, /\$\("codexCommand"\)\.value=codexDisplayCommand\(codex\.command\)/);
  assert.match(uiSource, /command:codexDisplayCommand\(patch\.command\?\?previous\.command\)/);
});

test("image inputs attach before Auto chooses a vision-capable model", () => {
  assert.doesNotMatch(uiSource, /if\(!visionOk\(\)\)\{ visionBlockNote\(\); return/);
  assert.match(uiSource, /Auto will route it to a ready vision-capable model/);
  assert.match(uiSource, /function addImageDataURL\([\s\S]*?attachments\.push\(\{kind:"image"/);
});
