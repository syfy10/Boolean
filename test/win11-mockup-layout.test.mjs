import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const mockup = fs.readFileSync(new URL("../site/win11-main.html", import.meta.url), "utf8");

test("Win11 mockup top controls match Boolean spacing and icon sizing", () => {
  assert.match(mockup, /\.top-bar \{[\s\S]*?height: 38px;[\s\S]*?gap: 5px;[\s\S]*?padding: 0 10px;/);
  assert.match(mockup, /\.top-bar \{[\s\S]*?background: transparent;[\s\S]*?border-bottom: 0;/);
  assert.match(mockup, /\.win-btn \{ width: 30px; height: 30px;/);
  assert.match(mockup, /\.app-tabs \{ height:40px;[\s\S]*?gap: 24px;[\s\S]*?padding: 0 8px;/);
  assert.match(mockup, /\.app-tab \{[\s\S]*?border-bottom: 2px solid transparent;[\s\S]*?font: 14px var\(--font\); padding: 0 12px;/);
  assert.match(mockup, /\.app-tab\.active \{[\s\S]*?border-bottom-color: var\(--text\);/);
  assert.match(mockup, /\.cmd-bar \{ height:47px;[\s\S]*?gap: 4px;[\s\S]*?padding: 0 12px;/);
  assert.match(mockup, /\.cmd-ico \{ min-width: 34px; height: 34px;[\s\S]*?display: flex;/);
  assert.match(mockup, /\.cmd-commit \{ height:31px;[\s\S]*?background: #2b2b2b;/);
  assert.match(mockup, /<span>File<\/span>[\s\S]*?<span>Test<\/span>[\s\S]*?<span>Web<\/span>[\s\S]*?<span>Note<\/span>/);
  assert.match(mockup, /title="Context panel"/);
  assert.doesNotMatch(mockup, /title="Split view"/);
  assert.match(mockup, /<div class="nav-footer">[\s\S]*?<span>Local<\/span>[\s\S]*?<span>GLM-5\.2<\/span>[\s\S]*?<span>3 files<\/span>[\s\S]*?<span>42k \/ 200k<\/span>[\s\S]*?<span>Idle<\/span>/);
  assert.match(mockup, /\.nav-footer \{[\s\S]*?border-top: 0;/);
  assert.doesNotMatch(mockup, /class="statusbar"/);
  assert.match(mockup, /\.chat-area \{[\s\S]*?-webkit-mask-image: linear-gradient\(to bottom, transparent 0, #000 24px, #000 calc\(100% - 28px\), transparent 100%\);/);
  assert.match(mockup, /\.composer \{[\s\S]*?border-top: 0;/);
});
