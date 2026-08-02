import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultUiSettings } from "../src/config.js";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../shell/Program.cs", import.meta.url), "utf8");

test("Boolean Pet is opt-in and persisted through UI settings", () => {
  assert.equal(defaultUiSettings().desktopPet, false);
  assert.match(ui, /id="desktopPet"/);
  assert.match(ui, /setUi\(\{desktopPet:enabled\}\)/);
  assert.match(ui, /state\.ui\?\.desktopPet===true/);
});

test("native pet is an always-on-top interactive Graphite Floating Terminal", () => {
  assert.match(shell, /sealed class BooleanPetForm : Form/);
  assert.match(shell, /TopMost = true/);
  assert.match(shell, /ShowInTaskbar = false/);
  assert.match(shell, /ShowWithoutActivation => true/);
  assert.doesNotMatch(shell, /WS_EX_NOACTIVATE/);
  assert.match(shell, /Opacity = 0\.96/);
  assert.match(shell, /LinearGradientBrush\(screen, Color\.FromArgb\(59, 61, 64\), Color\.FromArgb\(35, 37, 40\)/);
});

test("pet has only idle, browsing, and coding screen states", () => {
  assert.match(shell, /enum BooleanPetDisplayState \{ Idle, Browsing, Coding \}/);
  assert.doesNotMatch(shell, /BooleanPetDisplayState\.Thinking/);
  assert.match(shell, /DrawBooleanMark\(g, center, 46, Color\.White\)/);
  assert.match(shell, /DrawGlobe\(g, center, 27, green, tick\)/);
  assert.match(shell, /DrawTerminal\(g, display, green\)/);
});

test("coding prompt erases and retypes on a two-second loop", () => {
  assert.match(shell, /_clock\.ElapsedMilliseconds % 2000/);
  assert.match(shell, /cycle < 350 \? ">_" : cycle < 700 \? ">" : cycle < 980 \? ""/);
  assert.match(shell, /Cascadia Mono/);
});

test("real Boolean activities drive the native pet", () => {
  assert.match(ui, /group==="searches"\) postBooleanPet\("browsing"/);
  assert.match(ui, /\["commands","files","inspections"\]\.includes\(group\)\) postBooleanPet\("coding"/);
  assert.match(ui, /type:"pet",cmd:"sync"/);
  assert.match(shell, /if \(type == "pet"\)/);
  assert.match(shell, /HandlePetMessage\(root\)/);
});

test("pet status bubble carries current task title and activity detail", () => {
  assert.match(ui, /function booleanPetChatName\(/);
  assert.match(ui, /function booleanPetTaskTitle\(\)/);
  assert.match(ui, /request\.display\|\|request\.msg\|\|request\.text/);
  assert.match(shell, /DrawStatusBubble\(g\)/);
  assert.match(shell, /_chatName/);
  assert.match(shell, /_title/);
  assert.match(shell, /_detail/);
});

test("hovering the active pet exposes reply and stop shortcuts", () => {
  assert.match(shell, /PlaceholderText = "Reply to this chat\.\.\."/);
  assert.match(shell, /ConfigureReplyButton\(_replyButton, "Reply"/);
  assert.match(shell, /ConfigureReplyButton\(_stopButton, "Stop"/);
  assert.match(shell, /_hoverReply && _active && !_completed/);
  assert.match(shell, /type = "petReply"/);
  assert.match(shell, /type = "petStop"/);
  assert.match(ui, /d\.type==="petReply"/);
  assert.match(ui, /d\.type==="petStop"/);
});

test("finished pet card replaces reply controls with a green check", () => {
  assert.match(ui, /showBooleanPetComplete\(finishedRun\)/);
  assert.match(ui, /completed:true/);
  assert.match(shell, /if \(_completed\)/);
  assert.match(shell, /Color\.FromArgb\(43, 184, 82\)/);
  assert.match(shell, /_replyInput\.Visible = visible/);
  assert.match(shell, /var visible = _hoverReply && _active && !_completed/);
});
