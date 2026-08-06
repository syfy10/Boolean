import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../shell/Program.cs", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");

test("whole-app zoom is persistent, bounded, and separate from browser-page zoom", () => {
  assert.match(config, /appZoom:\s*100/);
  assert.match(ui, /id="appZoomOut"/);
  assert.match(ui, /id="appZoomReset"/);
  assert.match(ui, /id="appZoomIn"/);
  assert.match(ui, /Math\.max\(75,Math\.min\(150/);
  assert.match(ui, /action:"appZoom",percent:appZoom/);
  assert.match(ui, /if\(e\.key==="0"\).*changeAppZoom\(0\)/);
  assert.match(ui, /if\(e\.key==="\+"\|\|e\.key==="="\).*changeAppZoom\(10\)/);
  assert.match(ui, /if\(e\.key==="-"\|\|e\.key==="_"\).*changeAppZoom\(-10\)/);
  assert.match(shell, /case "appZoom"/);
  assert.match(shell, /_chat\.ZoomFactor = Math\.Clamp\(percent, 75d, 150d\) \/ 100d/);
  assert.match(shell, /_chat\.CoreWebView2\.Settings\.IsZoomControlEnabled = false/);
  assert.match(shell, /t\.View\.ZoomFactor = Math\.Clamp\(t\.View\.ZoomFactor \+ delta, 0\.3, 3\.0\)/);
});
