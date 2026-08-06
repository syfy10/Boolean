import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../shell/Program.cs", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
const browse = fs.readFileSync(new URL("../src/browse.js", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const website = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const installer = fs.readFileSync(new URL("../build/installer.iss", import.meta.url), "utf8");

test("product branding is Boollm while the website remains boollm.com", () => {
  assert.match(ui, /<title>Boollm<\/title>/);
  assert.match(ui, /<div class="brand-name">Boollm<\/div>/);
  assert.doesNotMatch(ui, />Boolean</);
  assert.match(shell, /Text = "Boollm"/);
  assert.match(installer, /#define AppName "Boollm"/);
  assert.match(installer, /OutputBaseFilename=Boollm-setup/);
  assert.match(website, /https:\/\/boollm\.com\//);
  assert.doesNotMatch(website, /https:\/\/boolean\.com\//i);
});

test("maximize control offers left, maximize, and right window layouts", () => {
  const options = [...ui.matchAll(/data-window-place="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, ["snapleft", "max", "snapright"]);
  assert.match(ui, /id="windowLayoutMenu" role="menu"/);
  assert.match(ui, /document\.body\.appendChild\(windowLayoutMenu\)/);
  assert.match(ui, /windowLayoutMenu\.classList\.add\("open"\)/);
  assert.match(ui, /if\(e\.key==="Escape"\) closeWindowLayoutMenu\(\)/);
});

test("approved layout keeps the compact app rail beside the floating sidebar", () => {
  assert.match(ui, /<nav id="sideRail" aria-label="Compact app rail">/);
  assert.match(ui, /#sideRail\{ display:none; width:0; flex:0 0 0; overflow:hidden; opacity:0; pointer-events:none; border-right:0; \}/);
  assert.match(ui, /body\.collapsed #sideRail,\s*body\.collapsed\.rail-expanded #sideRail\{ width:0; flex-basis:0; opacity:0; pointer-events:none; padding:0; border-right:0; \}/);
  for (const action of ["search", "projects", "browser", "context", "git", "recipes", "automations", "notes", "settings"]) {
    assert.match(ui, new RegExp(`data-rail="${action}"`));
  }
  assert.doesNotMatch(ui, /data-rail="sidechat"/);
  assert.doesNotMatch(ui, /data-rail="toggle"/);
  assert.match(ui, /#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{[\s\S]*?display:flex;[\s\S]*?flex:0 0 37px;[\s\S]*?opacity:1; pointer-events:auto;/);
  assert.match(ui, /<div class="rail-brand sidebar-brand" aria-hidden="true">[\s\S]*<div class="brand-name">Boollm<\/div>[\s\S]*id="railBrandReady"[\s\S]*id="railBrandDot"[\s\S]*id="railBrandStatus"[\s\S]*class="brand-about"/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-brand\{ display:flex; \}/);
  assert.match(ui, /\.rail-brand\{[^}]*min-height:52px;[^}]*padding:7px 8px;/s);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-main\{ padding:4px 7px; \}/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-footer\{ flex-direction:row; align-items:stretch; gap:0; border-top:1px solid var\(--border\); padding:0; \}/);
  assert.match(ui, /if\(\$\("railBrandDot"\)\) \$\("railBrandDot"\)\.className="dot"\+\(ready\?"":" down"\);/);
  assert.match(ui, /if\(\$\("railBrandStatus"\)\) \$\("railBrandStatus"\)\.textContent=label;/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-label\{ display:block; \}/);
  assert.match(ui, /id="panelToggle"[\s\S]*id="appBack"[\s\S]*id="netmode"/);
  assert.match(ui, /id="appBack" title="Go back"[\s\S]*id="appForward" title="Go forward"[\s\S]*id="netmode"/);
  assert.match(ui, /id="panelToggle" title="Show projects and chats" aria-label="Show projects and chats"/);
  assert.doesNotMatch(ui, /body\.collapsed \.topbar #panelToggle/);
  assert.match(ui, /data-rail="projects" title="Open project folder" aria-label="Open project folder"[\s\S]*<span class="rail-label">Open folder<\/span>/);
  assert.match(ui, /data-rail="git" title="Git" aria-label="Git"[\s\S]*<span class="rail-label">Git<\/span>/);
  assert.match(ui, /<div class="rail-stack rail-main">/);
  assert.match(ui, /<div class="rail-stack rail-footer">[\s\S]*data-rail="settings"[\s\S]*class="rail-user"/);
  assert.match(ui, /class="rail-user-initial">B<\/span><span class="rail-user-copy"><span class="rail-user-name">Boollm<\/span><span class="rail-user-email">Local Boollm workspace<\/span><\/span>/);
  assert.match(ui, /body\.rail-menu-open #sideRail \.rail-user,[\s\S]*?grid-template-columns:24px minmax\(0,1fr\);[\s\S]*?justify-content:start;/);
  assert.match(ui, /body\.rail-menu-open #sideRail \.rail-user-copy\{ display:grid;[\s\S]*?body\.rail-menu-open #sideRail \.rail-user-email\{ display:block;/);
  assert.doesNotMatch(ui, /id="railReadyStatus"/);
  assert.doesNotMatch(ui, /id="railStatusText"/);
  assert.doesNotMatch(ui, /class="rail-ready"/);
  assert.doesNotMatch(ui, /id="railGuide"/);
  assert.doesNotMatch(ui, /function toggleRailGuide/);
  assert.doesNotMatch(ui, /if\(action==="toggle"\)/);
  assert.match(ui, /\$\("panelToggle"\)\.onclick=\(\)=>\{/);
  assert.match(ui, /document\.body\.classList\.toggle\("collapsed"\);\s*sidebarManualState=document\.body\.classList\.contains\("collapsed"\);\s*if\(!document\.body\.classList\.contains\("collapsed"\) && SHELL\) hostPost\(\{type:"window",action:"growContext"\}\);\s*scheduleResponsiveClasses\(\);\s*syncPanelButtons\(\);/);
  assert.match(ui, /if\(action==="projects"\)\{ adoptProject\(\); return; \}/);
  assert.match(ui, /let sidebarManualState=null;/);
  assert.match(ui, /const auxiliaryNeedsRoom=auxiliaryPairOpen&&estimatedOpenMainW<620;/);
  assert.match(ui, /document\.body\.classList\.toggle\("collapsed",auxiliaryNeedsRoom\|\|recipesNeedRoom\|\|educationNeedsRoom\s*\?true\s*:\(sidebarManualState===null\?shouldCollapseApprovedSidebar:sidebarManualState\)\);/);
  assert.match(ui, /\$\("panelToggle"\)\.title=sidebarPopover\?"Close projects and chats":sidebarClosed\?"Show projects and chats":"Hide projects and chats";/);
  assert.match(ui, /let navForward=\[\];/);
  assert.match(ui, /navForward\.push\(currentAppView\(\)\);\s*await restoreAppView\(view\);/);
  assert.match(ui, /async function goForwardInApp\(\)\{[\s\S]*navHistory\.push\(currentAppView\(\)\);[\s\S]*await restoreAppView\(view\);/);
  assert.match(ui, /\$\("appForward"\)\.onclick=goForwardInApp;/);
  assert.match(ui, /e\.altKey&&e\.key==="ArrowRight"[\s\S]*goForwardInApp\(\);/);
  assert.match(ui, /else if\(action==="git"\)\{ setWorkspaceTab\("git"\); \}/);
  assert.doesNotMatch(ui, /class="ws-tab" data-ws="git"/);
  assert.match(ui, /document\.querySelectorAll\("#sideRail \[data-rail\]"\)/);
  assert.doesNotMatch(ui, /data-ws="chat" title="Chat workspace"[\s\S]*id="sideChatToggle"[\s\S]*data-ws="code"/);
  assert.match(ui, /<button class="side-chat-launch" id="sideChatToggle" title="Open side AI chat"/);
});

test("compact rail uses the matching notepad icon and Boollm search", () => {
  assert.match(ui, /data-rail="notes" title="Notepad" aria-label="Notepad"/);
  assert.match(ui, /data-rail="notes"[\s\S]*viewBox="0 0 64 64"[\s\S]*class="notepad-paper"/);
  assert.match(ui, /\.rail-btn\[data-rail="notes"\] \.notepad-paper/);
  assert.match(ui, /data-rail="search" title="Search Boollm" aria-label="Search Boollm"/);
  assert.match(ui, /placeholder="Search Boollm\.\.\. chats, projects, commands\.\.\."/);
  assert.match(ui, /function cmdRecentThreads\(query\)/);
  assert.match(ui, /id: "chat:" \+ t\.id/);
  assert.ok(ui.indexOf('id="cmdPalette"') < ui.indexOf("<script>"), "search palette must exist before handlers bind");
  assert.match(ui, /if\(action==="search"\)\{ if\(typeof openCmdPalette==="function"\) openCmdPalette\(\);/);
});

test("open project is visible in the Projects and Chats pane and uses the standard Windows folder picker", () => {
  assert.match(ui, /list\.appendChild\(accordion\);[\s\S]*className="project-open-action"[\s\S]*setAttribute\("aria-label","Open project"\)[\s\S]*<span>Open project<\/span>[\s\S]*openProject\.onclick=adoptProject;[\s\S]*list\.appendChild\(openProject\);[\s\S]*const chatHead=/);
  assert.doesNotMatch(ui, /#sidebar \.thread-search-wrap,#sidebar \.pinned-list,#sidebar \.grouphead\.foldable:first-child,#sidebar \.project-open-action\{ display:none!important; \}/);
  assert.match(shell, /using var dialog = new FolderBrowserDialog/);
  assert.match(shell, /AutoUpgradeEnabled = true/);
  assert.match(shell, /UseDescriptionForTitle = true/);
  assert.match(shell, /ShowNewFolderButton = true/);
  assert.match(shell, /dialog\.SelectedPath = initialPath/);
  assert.doesNotMatch(shell, /FileName = "Select this folder"/);
});

test("recipes use a flat category rail, recipe list, and detail editor", () => {
  const rail=ui.indexOf('class="recipes-category-rail"');
  const list=ui.indexOf('class="recipes-main"');
  const detail=ui.indexOf('class="recipes-detail" id="recipeDetail"');
  assert.ok(rail>=0&&rail<list&&list<detail);
  assert.match(ui,/\.recipes-panel\{[^}]*overflow:hidden;[^}]*container-type:inline-size;/s);
  assert.match(ui,/\.recipes-shell\{[^}]*grid-template-columns:minmax\(112px,148px\) minmax\(190px,270px\) minmax\(0,1fr\);[^}]*gap:0;[^}]*overflow:hidden;/s);
  assert.match(ui,/\.recipes-category-rail\{[^}]*border-right:1px solid var\(--border\);[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s);
  assert.match(ui,/\.recipes-main\{[^}]*overflow:hidden;[^}]*border-right:1px solid var\(--border\);/s);
  assert.match(ui,/\.recipes-role-pills\{[^}]*flex-direction:column;/s);
  assert.match(ui,/\.recipe-grid\{[^}]*grid-template-columns:1fr;[^}]*overflow-y:auto;/s);
  assert.match(ui,/\.recipe-card\{[^}]*border:0;[^}]*border-bottom:1px solid var\(--border\);[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(ui,/\.recipes-detail\{[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s);
  assert.match(ui,/\.recipe-actions\{[^}]*position:sticky;[^}]*bottom:0;/s);
  assert.match(ui,/@container\(max-width:640px\)\{[\s\S]*?\.recipes-shell\{ grid-template-columns:minmax\(168px,31%\) minmax\(0,1fr\); grid-template-rows:auto minmax\(0,1fr\); \}/s);
  assert.match(ui,/@container\(max-width:640px\)\{[\s\S]*?\.recipes-category-rail\{[^}]*grid-column:1\/-1; grid-row:1; flex-direction:row;[^}]*overflow-x:auto; overflow-y:hidden;/s);
  assert.match(ui,/@container\(max-width:640px\)\{[\s\S]*?\.recipes-main\{ grid-column:1; grid-row:2;[^}]*border-right:1px solid var\(--border\);[\s\S]*?\.recipes-detail\{ grid-column:2; grid-row:2;/s);
  assert.doesNotMatch(ui,/recipes-close|recipesClose/);
});

test("project runs never display Boollm-authored plan checklists", () => {
  assert.match(ui, /function shouldShowProjectPlan\(snapshot\)/);
  // The plan chip follows the controller's showPlan only. artifactRequired is a
  // classification, and on its own it used to raise a "1/7" plan for turns that
  // never ran a tool — including questions Boollm had misread as build requests.
  assert.match(ui, /function shouldShowProjectPlan\(snapshot\) \{\s*return false;\s*\}/);
  assert.doesNotMatch(ui, /snapshot\?\.showPlan === true \|\| snapshot\?\.artifactRequired === true/);
  assert.match(ui, /!shouldShowProjectPlan\(snapshot\)/);
  assert.match(ui, /function markCurrentPlanOutput\(\)/);
  assert.match(ui, /markCurrentPlanOutput\(\);[\s\S]*?run\.statusEl\?\.classList\.remove\("live-plan-output"\);\s*col\.classList\.add\("plan-output-hidden"\)/);
  assert.match(ui, /const hasOutput=live\|\|Boolean\(col\.querySelector\("\.live-plan-output"\)\)/);
  assert.match(ui, /hasOutput\?'<button class="plan-checklist-action"[^]*data-plan-action="raw"/);
  assert.match(ui, /if\(!planEl\?\.isConnected\) col\.classList\.remove\("plan-output-hidden"\)/);
});

test("project tasks show a compact live visual build lifecycle", () => {
  assert.match(ui, /\.visual-build-card\{[^}]*border:1px solid var\(--border\);[^}]*background:color-mix/s);
  assert.match(ui, /\.visual-build-steps\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/s);
  assert.match(ui, /function buildVisualBuildHTML\(taskRun\)/);
  assert.match(ui, /const stages=\["Build","Launch","Inspect","Ready"\]/);
  assert.match(ui, /buildVisualBuildHTML\(snapshot\.taskRun\)/);
  assert.match(ui, /data-plan-action="open-preview"/);
  assert.match(ui, /if\(openPreview\) openPreview\.onclick=.*aiNavigate\(url\)/);
});

test("terminal respects manual hiding while Code opens its dedicated workspace", () => {
  assert.match(ui, /let terminalAutoReveal = true;/);
  assert.match(ui, /function toggleTerminal\(force, userInitiated=false\)/);
  assert.match(ui, /if\(userInitiated\) terminalAutoReveal=open;/);
  assert.match(ui, /if\(terminalAutoReveal\) toggleTerminal\(true\);/);
  assert.match(ui, /\$\("termToggle"\)\.onclick = \(\) => toggleTerminal\(false,true\)/);
  assert.match(ui, /ws === "code"\) \{ ensureCodeWorkspace\(\); \}/);
  assert.match(ui, /document\.body\.classList\.toggle\("code-open", activeWsTab === "code"\)/);
  assert.match(ui, /const terminalRunComplete=finishedRun&&!holdQueue&&finishedRun\.outcome!=="paused"&&finishedRun\.outcome!=="error"/);
  assert.match(ui, /if\(terminalRunComplete&&!\(q&&q\.length\)&&document\.body\.classList\.contains\("ws-terminal-open"\)\)\{[\s\S]*?terminalAutoReveal=false;[\s\S]*?setTimeout\(\(\)=>toggleTerminal\(false\),260\)/);
});

test("Recipes reclaims sidebar space but lets the user reopen Projects and Chats", () => {
  assert.match(ui, /let recipesSidebarAutoClosed=false;/);
  assert.match(ui, /recipesNeedRoom=document\.body\.classList\.contains\("recipes-open"\)&&recipesSidebarAutoClosed/);
  assert.match(ui, /ws === "recipes"\) \{[\s\S]*?recipesSidebarAutoClosed=!document\.body\.classList\.contains\("collapsed"\);[\s\S]*?document\.body\.classList\.add\("collapsed"\)/);
  assert.match(ui, /if\(document\.body\.classList\.contains\("recipes-open"\)\) recipesSidebarAutoClosed=false;/);
  assert.match(ui, /if\(grid\) grid\.scrollTop=0;[\s\S]*?if\(detail\) detail\.scrollTop=0;/);
});

test("native browser and notepad reflow without resizing the app window", () => {
  assert.match(shell, /case "growContext":\s*if \(_browserOpen && !_full\) BeginInvoke\(new Action\(FitBrowserSplit\)\);/);
  assert.doesNotMatch(shell, /case "growContext":\s*GrowForBrowser\(\);/);
  assert.doesNotMatch(shell, /HideBrowserPill\(\);\s*GrowForBrowser\(\);/);
});

test("browser tabs, address clearing, and device presets stay explicit", () => {
  assert.match(server, /var x = document\.createElement\("span"\); x\.className="x"/);
  assert.match(server, /if\(e\.target===x\)\{ act\("closeTab",\{id:t\.id\}\); \}/);
  assert.match(server, /clr\.onclick = function\(\)\{ url\.value=""; clr\.style\.display="none"; url\.focus\(\); \}/);
  assert.match(shell, /\("desktop", "Desktop", 0, 0, false,/);
  assert.match(shell, /\("tablet",\s*"Tablet 834 [^"]* 1112", 834, 1112, false,/);
  assert.match(shell, /\("mobile",\s*"Mobile 390 [^"]* 844", 390, 844, true,/);
  // The address bar lives in the shell chrome page now (server.js), not ui.html.
  assert.match(server, /id="url" placeholder="Search or enter a URL"/);
  assert.match(server, /clr\.onclick = function\(\)\{ url\.value=""; clr\.style\.display="none"; url\.focus\(\); \}/);
  assert.match(ui, /body\.chat-micro #notesToggle,body\.chat-micro #exploreToggle,body\.chat-micro #browserToggle\{ display:grid; \}/);
});

test("responsive preview lays the page out at the preview width and can be dragged", () => {
  // The page view is sized to the preview width, so the pane shows the real layout at
  // that width instead of a full-width view scaled by a metrics override.
  assert.match(shell, /Rectangle PreviewViewport\(Rectangle area\)/);
  assert.match(shell, /if \(_deviceWidth <= 0\) return area;/);
  assert.match(shell, /foreach \(var t in _tabs\)\s*if \(t\.View\.Bounds != viewport\) t\.View\.Bounds = viewport;/);
  assert.match(shell, /t\.View\.Dock = DockStyle\.None;\s*t\.View\.Bounds = PreviewViewport\(_content\.ClientRectangle\);/);
  // Only mobile still needs an emulation override; a width override on a wider control
  // is what made the preview show a scaled page.
  assert.match(shell, /if \(_deviceWidth <= 0 \|\| !m\.mobile\)\s*\{\s*await cw\.CallDevToolsProtocolMethodAsync\("Emulation\.clearDeviceMetricsOverride"/);
  // Drag the preview's right edge to any width.
  assert.match(shell, /readonly Panel _previewGrip = new\(\) \{ TabStop = false, Visible = false, Cursor = Cursors\.SizeWE \};/);
  assert.match(shell, /_deviceWidth = next;\s*_deviceCustomWidth = true;\s*LayoutContentViews\(\);/);
  assert.match(shell, /deviceWidth = _deviceWidth,/);
  assert.match(server, /devw\.classList\.toggle\("on", !!s\.deviceLabel\);/);
});

test("notepad has a functional clipboard paste action", () => {
  assert.match(ui, /id="notePaste" title="Paste" aria-label="Paste"/);
  assert.match(ui, /\$\("notePaste"\)\.onclick=async\(\)=>\{[\s\S]*?await readClipboardText\(\);[\s\S]*?insertHtmlAtCursor\(/);
  assert.match(ui, /"noteCopy","notePaste","noteMore"/);
});

test("composer footer does not duplicate settings gear", () => {
  assert.doesNotMatch(ui, /id="composerSettings"/);
  assert.match(ui, /if\(\$\("composerSettings"\)\) \$\("composerSettings"\)\.onclick/);
});

test("settings and account stay on the rail while status moves into the sidebar footer", () => {
  assert.doesNotMatch(ui, /<aside id="sidebar">[\s\S]*<div class="sidefoot-nav">[\s\S]*id="topSettings"/);
  assert.doesNotMatch(ui, /composer-footer-nav/);
  assert.match(ui, /<div class="app-footer" aria-label="App footer">\s*<div class="sidefoot-nav" aria-label="Settings and account">[\s\S]*id="topSettings" title="Settings" aria-label="Settings"[\s\S]*id="cloudSignIn" title="Sign in to your Boollm account" aria-label="Account"/);
  assert.match(ui, /\.sidefoot-nav\{[^}]*display:flex;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.match(ui, /--app-footer-h:28px/);
  assert.match(ui, /if\(approvedFooter&&approvedSidebar\) approvedSidebar\.insertBefore\(approvedFooter,approvedSidefoot\|\|null\);/);
  assert.match(ui, /\.app-footer\{[\s\S]*?left:8px; right:8px; bottom:7px;[\s\S]*?border:0; background:var\(--sidebar\);/);
  assert.match(ui, /\.app-footer \.sidefoot-nav,\.app-footer-version\{ display:none; \}/);
  assert.match(ui, /id="footerVersion" aria-label="Boollm version"/);
  assert.match(ui, /\.app-footer-version\{[^}]*margin-left:auto;[^}]*font:7\.5px\/1 var\(--mono\);/s);
  assert.match(ui, /if\(\$\("footerVersion"\)\) \$\("footerVersion"\)\.textContent="Boollm "\+\(state\.displayVersion/);
  assert.match(ui, /if\(info\) info\.innerHTML="";/);
  assert.doesNotMatch(ui, /composer-brand/);
  assert.doesNotMatch(ui, /\.composer-tools > \.sidefoot-nav\{ display:flex; \}/);
  assert.match(ui, /\.composer-wrap\{[^}]*--composer-bottom:20px;[^}]*bottom:var\(--app-footer-h\);/s);
  assert.match(ui, /body\.composer-simple \.composer-wrap\{[^}]*--composer-bottom:4px;/s);
  assert.match(ui, /#topSettings,#cloudSignIn\{[^}]*width:25px;[^}]*height:25px;[^}]*font-size:0;/s);
  assert.match(ui, /#cloudSignInText\{ display:none; \}/);
});

test("account settings and project navigation surfaces are mutually exclusive", () => {
  assert.match(ui, /if\(opening&&\$\("settingsPanel"\)\?\.classList\.contains\("open"\)\) closeSettingsPanel\(\)/);
  assert.match(ui, /function openSettings\(sec,[\s\S]{0,180}closeAccountMenu\(\);closeNavigationMenu\(\)/);
  assert.match(ui, /if\(t\.kind==="project"\)[\s\S]{0,260}classList\.add\("collapsed"\)/);
});

test("expanded navigation has one account and teamwork lives in the API picker", () => {
  assert.match(ui, /body\.rail-menu-open #sidebar \.sidebar-account-card\{ display:none!important; \}/);
  assert.match(ui, /\$\("modelmenu"\)\) \$\("modelmenu"\)\.insertBefore\(\$\("teamAnchor"\)/);
  assert.match(ui, /#modelmenu #teamAnchor\{ position:absolute; top:8px; left:8px/);
});

test("about page shows build metadata, release history, and working links", () => {
  assert.equal((ui.match(/id="aboutVersion"/g) || []).length, 1);
  assert.match(ui, /data-settings-tab="about" title="About Updates"/);
  assert.match(ui, /id="aboutChannel"/);
  assert.match(ui, /id="aboutBranch"/);
  assert.match(ui, /id="aboutCommit"/);
  assert.match(ui, /id="aboutReleaseDate"/);
  assert.match(ui, /id="aboutChangelog"/);
  assert.match(ui, /id="aboutGitList"/);
  assert.match(ui, /async function loadAboutInfo/);
  assert.match(ui, /if\(section\.dataset\.sec==="about"\) loadAboutInfo\(\);/);
  assert.match(ui, /aboutSource:"https:\/\/github\.com\/syfy10\/Boollm"/);
  assert.match(ui, /aboutReleases:"https:\/\/github\.com\/syfy10\/Boollm\/releases"/);
  assert.match(server, /if \(req\.method === "GET" && p === "\/api\/about"\)/);
  assert.match(server, /"log", "-6", "--date=short"/);
  assert.match(server, /releases: ABOUT_RELEASES/);
});

test("chat keeps the top edge clear and fades only into the composer", () => {
  assert.match(ui, /#chat\{[\s\S]*?-webkit-mask-image:none; mask-image:none;/);
  assert.match(ui, /\/\* Seamless chat:[\s\S]*?#chat\{\s*min-height:0; margin:0; padding:20px 16px 0;/);
  assert.match(ui, /\.composer-wrap,body\.composer-simple \.composer-wrap\{[\s\S]*?background:var\(--approved-card\);[\s\S]*?border-radius:0 0 12px 12px; overflow:hidden;/);
  assert.match(ui, /body\.composer-simple \.composer-wrap\{\s*background:linear-gradient\(to bottom,transparent 0 28px,var\(--approved-card\) 28px 100%\);/);
  assert.match(ui, /body\.composer-simple \.composer-top-strip\{\s*display:flex !important; min-height:28px; height:28px; padding:0 6px;/);
  assert.match(ui, /main::before\{\s*display:none;\s*\}/);
  assert.match(ui, /main::after,body\.composer-simple main::after\{[\s\S]*?bottom:79px; height:28px;[\s\S]*?background:linear-gradient\(to bottom,transparent,var\(--approved-card\)\);/);
  assert.match(ui, /\.composer,body\.composer-simple \.composer\{[\s\S]*?border:0; border-top:0; border-right:0; border-bottom:0; border-left:0;/);
  assert.match(ui, /body\.composer-simple \.composer\{ border-top:1px solid #202020; \}/);
  assert.match(ui, /\.composer:hover\{[\s\S]*?border:0; border-top:0; border-right:0; border-bottom:0; border-left:0;/);
  assert.match(ui, /body\.composer-simple \.composer:hover\{[\s\S]*?border:0; border-top:1px solid #202020; border-right:0; border-bottom:0; border-left:0;/);
});

test("narrow settings tabs do not leave a spacer under the header", () => {
  assert.match(ui, /@media \(max-width:720px\)\{[\s\S]*?\.settings-tabs\{ top:0; flex-direction:row;/);
});

test("readiness dots keep green ready and red down states", () => {
  assert.match(ui, /\.dot\{[^}]*background:var\(--ready\);/s);
  assert.match(ui, /\.dot:not\(\.down\)\{ background:var\(--ready\); \}/);
  assert.match(ui, /\.dot\.down\{ background:var\(--not-ready\); \}/);
  assert.match(ui, /if\(\$\("statusdot"\)\) \$\("statusdot"\)\.className="dot"\+\(ready\?"":" down"\);/);
  assert.match(ui, /if\(\$\("railBrandDot"\)\) \$\("railBrandDot"\)\.className="dot"\+\(ready\?"":" down"\);/);
  assert.match(ui, /--ready:#22a559; --not-ready:#dc3f42/);
  assert.match(ui, /\.app-footer \.cmd-chip-dot\.ok\{ background:var\(--green\); \}/);
});

test("duplicate sidebar footer status is hidden because readiness lives under Boollm", () => {
  assert.match(ui, /<div class="app-footer" aria-label="App footer">[\s\S]*id="cmdProjectStatus"/);
  assert.match(ui, /\.workspace-tabs \.cmd-status\{ display:none; \}/);
  assert.match(ui, /\.app-footer\{[\s\S]*?display:none !important;[\s\S]*?background:var\(--sidebar\);/);
  assert.match(ui, /\.app-footer \.cmd-chip\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(ui, /\.app-footer #cmdProjectStatus #cmdFilesChip,\.app-footer #cmdProjectStatus #cmdServerChip\{ display:inline-flex; \}/);
  assert.doesNotMatch(ui, /insertAdjacentElement\("afterend",status\)/);
  assert.doesNotMatch(ui, /function placeProjectStatusChip/);
});

test("workspace tabs and labeled command actions match the approved compact mockup", () => {
  assert.match(ui, /\.workspace-tabs\{[\s\S]*?height:32px; min-height:32px;[\s\S]*?gap:19px;[\s\S]*?border-bottom:1px solid var\(--border\);/);
  assert.match(ui, /\.ws-tab\{[^}]*font:11\.5px var\(--ui\);/s);
  assert.match(ui, /\.ws-tab\.active\{ border-bottom-color:var\(--text\); \}/);
  assert.match(ui, /\.cmd-bar\{[\s\S]*?height:26px; min-height:26px;[\s\S]*?background:transparent;[\s\S]*?margin-bottom:2px;/);
  assert.match(ui, /\.cmd-bar \.cmd-btn span\{ display:inline; \}/);
  assert.match(ui, /\.cmd-bar \.cmd-btn\{\s*flex:0 0 auto; min-width:23px; width:auto;/);
  assert.match(ui, /\.cmd-bar \.cmd-btn\.primary\{[\s\S]*?height:22px;[\s\S]*?border-radius:8px; background:#2b2b2b;/);
  assert.match(ui, /data-rail="side-chat" title="Side chat"/);
  assert.match(ui, /else if\(action==="side-chat"\)\{ setSideChatOpen/);
  for (const action of ["File", "Test", "Web", "Note", "Commit"]) {
    assert.match(ui, new RegExp(`aria-label="${action}"`));
  }
});

test("dark mode keeps autofill and the footer mask on approved theme surfaces", () => {
  assert.match(ui, /:root\[data-theme="dark"\]\{ --approved-canvas:#181818; --approved-card:#1c1c1c; \}/);
  assert.match(ui, /\.cmd-bar \.cmd-input:-webkit-autofill,[\s\S]*?box-shadow:0 0 0 1000px var\(--approved-canvas\) inset !important;/);
  assert.match(ui, /\.cmd-bar \.cmd-input::selection\{[\s\S]*?background:color-mix\(in srgb,var\(--text\) 20%,var\(--approved-canvas\)\);/);
  assert.match(ui, /body::after,body\.shell::after\{[\s\S]*?background:var\(--approved-canvas\);/);
});

test("dark mode separates canvas panels cards and borders without changing layout", () => {
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--bg:#181818; --sidebar:#1d1d1d;[\s\S]*?--border:#2a2a2a;/);
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--card:#202020;/);
  assert.match(ui, /\.msg-ai \.body,\.msg-ai\.cloud \.body\{[\s\S]*?--msg-fill:transparent;[\s\S]*?background:transparent; border:0;/);
});

test("command bar never restores saved Google OAuth credentials", () => {
  assert.match(ui, /id="cmdInput"[^>]*name="boolean-command-bar"[^>]*autocomplete="new-password"[^>]*data-1p-ignore="true"[^>]*data-lpignore="true"/);
  assert.match(ui, /function commandBarContainsCredential\(value\)[\s\S]*?apps\\\.googleusercontent\\\.com/);
  assert.match(ui, /window\.addEventListener\("pageshow",sanitizeCommandBarValue\);[\s\S]*?setInterval\(sanitizeCommandBarValue,500\);/);
});

test("heuristic next-edit cards stay disabled", () => {
  assert.match(ui, /\.next-edit-bar\{ display:none!important; \}/);
  assert.match(ui, /function showNextEditSuggestion\(suggestion\) \{\s*return;/);
});

test("approved side panes reflow beside chat and hide progressively as the window narrows", () => {
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel,\s*body\.zone-3 #ctxZone\{[\s\S]*?position:relative;/);
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel\{[\s\S]*?flex:0 0 var\(--nw,clamp\(240px,26vw,320px\)\);/);
  assert.doesNotMatch(ui, /<section id="browser">/);
  assert.match(ui, /@media\(max-width:640px\)\{[\s\S]*?body:not\(\.collapsed\) aside\{[\s\S]*?flex-basis:0;[\s\S]*?opacity:0; pointer-events:none;/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?body\.zone-3 #ctxZone,body\.zone-3 #ctxdrag\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{ display:none; width:0; min-width:0; flex-basis:0; \}/);
  assert.match(ui, /@media\(max-width:560px\)\{[\s\S]*?body\.notes-on:not\(\.shell\) #notesPanel,/);
});

test("workspace navigation and commands compact before they overflow", () => {
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.workspace-tabs\{ gap:clamp\(6px,1\.3vw,14px\); padding-inline:6px; \}/);
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.ws-tab\{ padding-inline:clamp\(5px,1vw,9px\); gap:5px; font-size:13px; \}/);
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.cmd-bar \.cmd-btn:not\(\.primary\) span\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:900px\)\{[\s\S]*?\.ws-tab\{ padding-inline:5px; font-size:12px; \}/);
  assert.match(ui, /@media\(max-width:900px\)\{[\s\S]*?\.cmd-bar \.cmd-input\{ min-width:80px; font-size:11px; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?body\.composer-simple \.composer-tools \.anchor:has\(#modelbtn\)\{ margin-left:4px; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?\.composer-tools \.modelbtn\{ max-width:68px; padding-inline:2px; \}/);
  assert.match(ui, /\.msg-ai \.body code\{ white-space:normal; overflow-wrap:anywhere; word-break:break-word; \}/);
  assert.match(shell, /MinimumSize = new Size\(Math\.Min\(900, Math\.Max\(600,/);
  assert.match(shell, /Math\.Min\(540, Math\.Max\(480, wa\.Height - 16\)\)/);
  assert.match(shell, /double scale = Math\.Max\(1d, DeviceDpi \/ 96d\);/);
  assert.match(shell, /Math\.Min\(\(int\)Math\.Round\(900 \* scale\), availableWidth\)/);
  assert.match(shell, /Math\.Min\(\(int\)Math\.Round\(540 \* scale\), availableHeight\)/);
  assert.match(shell, /protected override void OnHandleCreated\(EventArgs e\)[\s\S]*?ApplyDpiMinimumSize\(\);/);
  assert.match(shell, /protected override void OnDpiChanged\(DpiChangedEventArgs e\)[\s\S]*?ApplyDpiMinimumSize\(\);/);
  assert.doesNotMatch(shell, /MinimumSize = new Size\(Math\.Min\(1180,/);
  assert.match(ui, /body\.chat-xs #sideRail,[\s\S]*?display:none; width:0; min-width:0; flex-basis:0; opacity:0; pointer-events:none;/);
  assert.match(ui, /body\.chat-xs\.rail-menu-open #sideRail,[\s\S]*?display:flex!important; position:fixed;/);
  assert.doesNotMatch(ui, /body\.shell\.notes-on #notesPanel\{ display:none!important; \}/);
  assert.match(ui, /const chatW=effectiveChatWidth\(mainW\);/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-compact",chatW<720\);/);
  assert.match(ui, /body\.chat-compact \.ws-tab\{ padding-inline:4px; gap:4px; font-size:11px; \}/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-input\{ min-width:64px; font-size:10px;/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-btn:not\(\.primary\) span\{ display:none; \}/);
});

test("side chat stays compact and the duplicate browser edge launcher is removed", () => {
  assert.match(ui, /\.side-chat-launch\{[\s\S]*?left:20px; right:auto; top:calc\(100% - var\(--composer-h,106px\) \+ 14px\); width:23px; height:23px;[\s\S]*?border-radius:8px;/);
  // The floating reopen pill belonged to the removed HTML browser.
  assert.doesNotMatch(ui, /browserPill/);
  assert.match(shell, /void ShowBrowserPill\(\)\s*\{[\s\S]*?_browserPill\.Visible = false;/);
  assert.match(ui, /body\.composer-simple \.promptline #interruptEdit\{ position:absolute; right:42px; top:auto; bottom:8px; z-index:3;/);
  assert.match(ui, /body:not\(\.composer-simple\) \.promptline #interruptEdit\{[\s\S]*?right:15px; bottom:52px;[\s\S]*?width:28px; height:28px;/);
});

test("Notepad docks beside Explore instead of hiding behind it", () => {
  assert.match(
    ui,
    /body\.notes-on:is\(\.education-open,\.markets-open,\.recipes-open,\.sales-open\) #notesPanel\{[\s\S]*?position:fixed; top:78px; right:8px; bottom:var\(--approved-bottom-gap\);[\s\S]*?border-radius:6px;/
  );
  assert.match(
    ui,
    /body\.notes-on:is\(\.education-open,\.markets-open,\.recipes-open,\.sales-open\) #ndrag\{[\s\S]*?right:calc\(var\(--nw,clamp\(240px,26vw,320px\)\) \+ 4px\);/
  );
  assert.match(
    ui,
    /body\.notes-on:is\(\.education-open,\.markets-open,\.recipes-open,\.sales-open\) \.workspace-float\.maximized\{[\s\S]*?right:calc\(var\(--nw,clamp\(240px,26vw,320px\)\) \+ 17px\)!important;/
  );
  assert.match(
    ui,
    /const notesDocked=!narrow&&document\.body\.classList\.contains\("notes-on"\)&&EXPLORE_WORKSPACES\.includes\(activeWsTab\)/
  );
  assert.match(ui, /function syncExploreNotepadDock\(\)\{[\s\S]*?restoreWorkspaceFloatWidth\(\);/);
  assert.match(
    ui,
    /if\(handleId==="ndrag"&&typeof syncExploreNotepadDock==="function"\) syncExploreNotepadDock\(\);/
  );
  assert.match(
    ui,
    /document\.body\.classList\.toggle\("notes-on",!!on\);\s*if\(workspaceDockReady&&typeof syncExploreNotepadDock==="function"\) syncExploreNotepadDock\(\);/
  );
});

test("a new Sales run clears stale completion metadata", () => {
  assert.match(
    ui,
    /if\(resultsMeta\)resultsMeta\.textContent=salesWorkflow\.running\s*\?\s*"Researching now"\s*:\s*salesWorkflow\.completedAt/
  );
  assert.match(ui, /savePlan\.disabled=salesWorkflow\.running\|\|!salesWorkflow\.result/);
  assert.match(ui, /if\(removePlan\)removePlan\.disabled=salesWorkflow\.running/);
  assert.match(
    ui,
    /salesWorkflow=\{running:true,stage:0,states:\[\],partialSections:\[\],detail:"Starting a new Sales chat\.\.\.",result:"",blocked:false,startedAt:Date\.now\(\),completedAt:0,planId:"",\.\.\.workflowMeta\}/
  );
});

test("Settings keeps Projects and Chats available as a visible floating pane", () => {
  assert.match(ui, /body\.settings-open:not\(\.sidebar-popover-open\) aside\{[\s\S]*?display:none!important;[\s\S]*?width:0!important;[\s\S]*?flex-basis:0!important;[\s\S]*?pointer-events:none!important;/);
  assert.match(ui, /id="settingsProjectsChats"[^>]*aria-label="Open projects and chats"[^>]*>Projects &amp; chats<\/button>/);
  assert.match(ui, /\$\("settingsProjectsChats"\)\?\.addEventListener\("click",event=>\{\s*event\.stopPropagation\(\);\s*\$\("panelToggle"\)\?\.click\(\);\s*\}\)/);
  assert.match(ui, /\.settings-head #settingsProjectsChats\{[^}]*width:auto;[^}]*border:1px solid var\(--border\);/);
  assert.match(ui, /function syncSidePanelWidth\(\)\{[\s\S]*?scheduleResponsiveClasses\(\);/);
  assert.match(ui, /if\(document\.body\.classList\.contains\("settings-open"\)\)\{\s*sidebarHoverPreview=false;\s*document\.body\.classList\.add\("collapsed"\);\s*document\.body\.classList\.toggle\("sidebar-popover-open"\);\s*syncPanelButtons\(\);\s*return;/);
  assert.match(ui, /if\(!sidebarPopupMode&&!document\.body\.classList\.contains\("settings-open"\)\) document\.body\.classList\.remove\("sidebar-popover-open"\);/);
  assert.match(ui, /function prepareWorkspaceForSettings\(sec\)\{\s*document\.body\.classList\.remove\("sidebar-popover-open"\);\s*sidebarHoverPreview=false;/);
  assert.doesNotMatch(ui, /function prepareWorkspaceForSettings\(sec\)\{[\s\S]*?sidebarManualState=true;[\s\S]*?const settingsWs=/);
});

test("Dark mode automatically uses the Obsidian notepad paper", () => {
  assert.match(ui, /const resolvedDark=\(ui\.theme==="dark"\)\|\|\(ui\.theme!=="light" && matchMedia\("\(prefers-color-scheme:dark\)"\)\.matches\);/);
  assert.match(ui, /const noteTheme=resolvedDark\?"obsidian":\(ui\.notepadTheme==="warm"\?"obsidian":ui\.notepadTheme\);/);
  assert.match(ui, /body\[data-note-paper="obsidian"\] #notesPanel\{[\s\S]*?--note-panel:#0d0f0f; --note-paper:#101212;/);
});

test("the native app opens as a large centered workspace", () => {
  assert.match(shell, /Width = Math\.Min\(wa\.Width - 32, Math\.Max\(1100, \(int\)Math\.Round\(wa\.Width \* 0\.90\)\)\);/);
  assert.match(shell, /Height = Math\.Min\(wa\.Height - 32, Math\.Max\(760, \(int\)Math\.Round\(wa\.Height \* 0\.90\)\)\);/);
  assert.match(shell, /Left = wa\.Left \+ \(wa\.Width - Width\) \/ 2;/);
  assert.match(shell, /Top\s+= wa\.Top \+ \(wa\.Height - Height\) \/ 2;/);
  assert.doesNotMatch(shell, /wa\.Width \* 0\.42/);
});

test("native window and workspace panes restore their last closed layout", () => {
  assert.match(shell, /"saz3", "window-layout\.json"/);
  assert.match(shell, /bool _windowLayoutRestored;/);
  assert.match(shell, /protected override void OnHandleCreated\(EventArgs e\)[\s\S]*?ApplyDpiMinimumSize\(\);[\s\S]*?if \(_windowLayoutRestored\) return;[\s\S]*?_windowLayoutRestored = true;[\s\S]*?RestoreWindowLayout\(\);/);
  assert.match(shell, /Top\s+= wa\.Top \+ \(wa\.Height - Height\) \/ 2;\s*Opacity = 0;/);
  assert.match(shell, /FormClosing \+= \(_, __\) => SaveWindowLayout\(\);/);
  assert.match(shell, /WindowState == FormWindowState\.Normal \? Bounds : RestoreBounds/);
  assert.match(shell, /Maximized = WindowState == FormWindowState\.Maximized/);
  assert.match(shell, /BrowserOpen = _browserOpen/);
  assert.match(shell, /bool savedFillsWorkArea =\s*saved\.Width >= work\.Width - 24 &&\s*saved\.Height >= work\.Height - 24;/);
  assert.match(shell, /savedFillsWorkArea\s*\? Math\.Clamp\(\(int\)Math\.Round\(work\.Width \* 0\.90\), minWidth, work\.Width\)/);
  assert.match(shell, /savedFillsWorkArea\s*\? Math\.Clamp\(\(int\)Math\.Round\(work\.Height \* 0\.90\), minHeight, work\.Height\)/);
  assert.match(shell, /work\.Left \+ \(work\.Width - width\) \/ 2/);
  assert.match(shell, /work\.Top \+ \(work\.Height - height\) \/ 2/);
  assert.match(shell, /if \(_restoreBrowserOpen\)\s*BeginInvoke\(new Action\(\(\) => ToggleBrowser\(true\)\)\);/);
  assert.match(shell, /bool _wasMinimized;\s*int _lastUsableBrowserWidth;/);
  assert.match(shell, /if \(WindowState == FormWindowState\.Minimized\)\s*\{\s*_wasMinimized = true;\s*return;/);
  assert.match(shell, /if \(_wasMinimized\)[\s\S]*?RestoreBrowserSplitAfterMinimize/);
  assert.match(shell, /void RememberBrowserSplit\(\)/);
  assert.match(shell, /void RestoreBrowserSplitAfterMinimize\(\)/);
  assert.match(shell, /_split\.ResumeLayout\(true\);\s*\}\s*RememberBrowserSplit\(\);\s*if \(ensureTab/);
  assert.match(ui, /const APP_FRAME_KEY="booleanAppFrame";/);
  assert.match(ui, /sidebarOpen:!document\.body\.classList\.contains\("collapsed"\)/);
  assert.match(ui, /notesOpen:document\.body\.classList\.contains\("notes-on"\)/);
  assert.match(ui, /workspace:activeWsTab\|\|"chat"/);
  assert.match(ui, /sidebarManualState=savedAppFrame\?savedAppFrame\.sidebarOpen===false:false;/);
  assert.match(ui, /openNotes\(!!savedAppFrame\.notesOpen,\{remember:false,focus:false\}\);/);
  assert.match(ui, /window\.addEventListener\("pagehide",\(\)=>\{ saveAppFrameState\(\); navigator\.sendBeacon\("\/api\/bye"\); \}\);/);
});

test("new users start with the rounded composer and API key entry has a real text cursor", () => {
  assert.match(config, /composerStyle:\s*"pill",\s*\/\/ pill \| simple/);
  assert.match(ui, /#modelmenu \.api-key-form input\{[^}]*width:100%;[^}]*min-height:32px; height:32px;[^}]*color:var\(--text\); caret-color:var\(--text\);[^}]*cursor:text; pointer-events:auto;/s);
  assert.match(ui, /-webkit-text-security:disc;/);
  assert.match(ui, /<input type="text" inputmode="text" name="boollm-api-key-/);
  assert.match(ui, /\.menu \.api-key-form input:focus\{ border-color:var\(--green\); box-shadow:/);
  assert.match(ui, /\.api-key-form\{[^}]*width:100%; min-width:0;[^}]*scroll-margin-block:8px;/s);
  assert.match(ui, /\.api-key-form\{[^}]*grid-template-columns:minmax\(0,1fr\) 28px 46px auto;/s);
  assert.match(ui, /\.api-key-icon\{[^}]*width:28px; height:30px;/s);
  assert.match(ui, /input\.onfocus=\(\)=>requestAnimationFrame\(\(\)=>form\.scrollIntoView\(\{block:"nearest"\}\)\)/);
  assert.match(ui, /<path d="M6 8h4M6 10\.5h4"\/>/);
  assert.match(ui, /<option value="google">Google AI \(Gemini\)<\/option>/);
  assert.match(ui, /google:"Gemini"/);
});

test("compact composer dropdowns escape the footer tool-row clip", () => {
  assert.match(ui, /\.composer-tools:has\(\.menu\.open\)\{ overflow:visible; \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools\{ height:32px; gap:5px; overflow:hidden; \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools:has\(\.menu\.open\)\{ overflow:visible; \}/);
  assert.match(ui, /\.composer-tools \.anchor:has\(\.menu\.open\)\{ z-index:31; \}/);
});

test("narrow composer keeps model teamwork and send controls from overlapping", () => {
  assert.match(ui, /model-label-compact/);
  assert.match(ui, /body\.chat-xxs \.teambtn \.team-label/);
  assert.match(ui, /body\.chat-micro #micbtn\{ display:none; \}/);
  assert.match(ui, /#teamAnchor\{ order:21;/);
});

test("native browser split uses the approved gray header without a separate bottom frame", () => {
  assert.match(shell, /const int BrowserTopInset = 38;/);
  assert.match(shell, /readonly RoundedPanel _browserPane = new\(\) \{ Dock = DockStyle\.Fill, Radius = 0 \};/);
  assert.match(shell, /readonly WebView2 _chromeView = new\(\) \{ Dock = DockStyle\.Top, Height = 116 \};/);
  assert.match(shell, /const int ChromeHeight = 116;/);
  assert.match(shell, /_chromeView\.CoreWebView2\.Navigate\(\$"http:\/\/127\.0\.0\.1:\{_port\}\/browser-chrome"\)/);
  assert.match(shell, /_chromeView\.Bounds = new Rectangle\(r\.Left, r\.Top, r\.Width, h\)/);
  assert.match(shell, /Palette\(Color CanvasBg, Color PaneBg, Color BarBg/);
  assert.match(shell, /public static Palette Light => new\(\s*Color\.FromArgb\(245, 245, 243\), Color\.FromArgb\(251, 251, 250\), Color\.FromArgb\(245, 245, 243\)/);
  assert.doesNotMatch(shell, /Palette (?:SoftGlass|GraphiteMist)/);
  assert.match(shell, /Padding = Padding\.Empty;/);
  assert.match(shell, /BackColor = p\.CanvasBg;/);
  assert.match(shell, /_split\.Panel1\.BackColor = p\.CanvasBg;/);
  assert.match(shell, /_split\.Panel2\.BackColor = p\.CanvasBg;/);
  assert.match(shell, /ApplyDwmChromeColor\(p\.CanvasBg\);/);
  assert.match(ui, /--approved-canvas:#f2f2f0;/);
  assert.match(ui, /body\.shell\{ --approved-bottom-gap:0px; padding-bottom:0!important; \}/);
  assert.match(ui, /body\.shell::after\{ display:none; \}/);
  assert.match(ui, /:root\[data-color-theme="classic"\] #notesPanel,[\s\S]*?:root\[data-color-theme="classic"\] #ctxZone\{/);
  assert.match(shell, /void ShowBrowserPill\(\)\s*\{[\s\S]*?_browserPill\.Visible = false;/);
  assert.doesNotMatch(ui, /browserPill/);
  assert.match(ui, /body\.collapsed:not\(\.sidebar-popover-open\) aside\{\s*display:none; min-width:0; margin:0; padding:0; border:0; background:transparent;/);
});

test("native browser close hides the browser panel without closing Boollm", () => {
  assert.ok(server.includes('<button class="ico close" id="browserClose" title="Close browser panel" aria-label="Close browser panel">&#xE8BB;</button>'));
  assert.ok(server.includes('$("browserClose").onclick = function(){ act("hideBrowser"); };'));
  assert.doesNotMatch(server, /class="ico close" data-w="close"/);
  assert.match(shell, /case "hideBrowser": ToggleBrowser\(false\); break;/);
  assert.match(shell, /case "close": Close\(\); break;/);
  assert.match(ui, /\$\("winClose"\)\.onclick=\(\)=>winCmd\("close"\)/);
});

test("browser dark mode is persistent and reaches both browser implementations", () => {
  assert.match(server, /id="darkPage" title="Dark mode for websites" aria-pressed="false"/);
  // Website dark mode is owned by the native pane; the UI only stores the preference.
  assert.match(ui, /const browserDark=resolvedDark\|\|!!ui\.browserDarkMode/);
  assert.match(ui, /shellBrowserDarkMode"\)\{ setUi\(\{browserDarkMode:!!d\.enabled\}\); \}/);
  assert.match(ui, /cmd:"theme",dark:resolvedDark,surface:selectedColorTheme\(ui\),browserDark/);
  assert.match(ui, /d\.type==="shellBrowserDarkMode"[\s\S]*?setUi\(\{browserDarkMode:!!d\.enabled\}\)/);
  assert.match(server, /id="darkPage" title="Dark mode for websites" aria-pressed="false"/);
  assert.match(server, /act\("darkPage"\)/);
  assert.match(shell, /darkPage = _browserDarkMode/);
  assert.match(shell, /AddScriptToExecuteOnDocumentCreatedAsync\(BrowserDarkModeScript\)/);
  assert.match(shell, /RemoveScriptToExecuteOnDocumentCreated\(t\.DarkModeScriptId\)/);
  assert.match(shell, /case "darkPage":[\s\S]*?SetBrowserDarkModeAsync\(!_browserDarkMode, notifyChat: true\)/);
  assert.match(shell, /new \{ type = "shellBrowserDarkMode", enabled \}/);
  // Website dark mode is injected by the shell into the native pane (BrowserDarkModeScript above); the /browse proxy that used to do it for the HTML pane is gone.
});

test("transcript token counts are shown at a tenth, with exact counts in the tooltip", () => {
  assert.match(ui, /const TOKEN_DISPLAY_SCALE=10;/);
  assert.match(ui, /const displayTokens=\(n\)=>\{ const raw=Number\(n\)\|\|0; return raw>0\?Math\.max\(1,Math\.round\(raw\/TOKEN_DISPLAY_SCALE\)\):0; \};/);
  assert.match(ui, /shortNum\(displayTokens\(total\)\)\+" tokens · "\+shortNum\(displayTokens\(output\|\|0\)\)/);
  assert.match(ui, /return displayTokens\(n\)\.toLocaleString\(\)\+" tokens"/);
  assert.match(ui, /title="Estimated from message text — about '\+raw\.toLocaleString\(\)\+' tokens"/);
  assert.match(ui, /esc\(shortNum\(displayTokens\(tokens\)\)\)\+" tok"/);
  assert.match(ui, /foot\.textContent="tokens: "\+shortNum\(displayTokens\(total\)\)/);
  // The raw figure still reaches the user through the hover title.
  assert.match(ui, /const exact=\(total\|\|0\)\.toLocaleString\(\)\+" tokens"/);
  // Budgets, the context bar, and Settings usage totals stay literal.
  assert.match(ui, /\$\("ctxLenLabel"\)\.textContent=fmtCtx\(CTX_STEPS\[idx\]\)\+" tokens"/);
});

test("Explore docks the native browser into its Web tab when browser home is enabled", () => {
  assert.match(config, /browserExploreHome: false,/);
  assert.match(ui, /id="browserExploreHome"/);
  assert.match(ui, /setUi\(\{browserExploreHome:e\.target\.checked\}\)/);
  assert.match(ui, /function exploreHomeEnabled\(\)\{ return state\.ui\?\.browserExploreHome===true&&adminFeatureAccessAllowed\(\); \}/);
  assert.match(ui, /\$\("browserToggle"\)\.onclick=\(\)=>toggleBrowserSurface\(\)/);
  // The preference lives in openBrowser itself, so every entry point that summons
  // the pane without a page — button, keyboard shortcut, workspace tab, rail —
  // lands on Explore. Guarding only the button left those paths opening the web.
  assert.match(ui, /openExploreWorkspace\("web"\); return;/);
  assert.match(ui, /if\(activeWsTab==="web"\)\{setWorkspaceTab\("chat"\);return;\}/);
  // Callers that already have somewhere to go must still reach the real browser.
  assert.match(ui, /id="webWorkspaceTab"[^>]*data-workspace-page="web"[^>]*aria-controls="webPanel"/);
  assert.match(ui, /id="webPanel" aria-label="Web browser"/);
  assert.match(ui, /body\.web-open \.workspace-float,[^\n]*\{ display:flex; \}/);
  assert.match(ui, /body\.web-open \.web-panel\{ display:block; \}/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"dock",rect:/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"undock"\}/);
  assert.match(shell, /void DockBrowserInExplore\(JsonElement root\)/);
  assert.match(shell, /void RestoreBrowserPaneToSplit\(\)[\s\S]*?_split\.Panel2\.Controls\.Add\(_browserPane\);\s*_browserPane\.Visible = true;/);
  assert.match(shell, /case "dock": DockBrowserInExplore\(root\); break;/);
  assert.match(shell, /case "undock": UndockExploreBrowser\(\); break;/);
  // The Explore window keeps a way back to the real web browser.
  assert.match(shell, /bool BrowserPaneIsOpen\(\) => _browserEmbedded \|\|/);
  assert.match(ui, /\.workspace-float-actions button\[hidden\]\{ display:none; \}/);
  // Desktop: the start page offers the three surfaces and the shell relays the click.
  assert.match(server, /const browserStartPage = \(servers, \{ explore = false, bookmarks = \[\] \} = \{\}\) =>/);
  assert.match(server, /explore: config\.ui\?\.browserExploreHome === true/);
  assert.match(server, /type:"exploreSurface",surface:b\.dataset\.surface/);
  assert.match(shell, /if \(!source\.StartsWith\(\$"http:\/\/127\.0\.0\.1:\{_port\}\/", StringComparison\.OrdinalIgnoreCase\)\) return;/);
  assert.match(shell, /surface != "markets" && surface != "education" && surface != "sales"/);
  assert.match(shell, /PostToChat\(new \{ type = "openExplore", surface \}\)/);
  assert.match(ui, /d\.type==="openExplore"\)\{ openBrowser\(false\); openExploreWorkspace\(d\.surface\); \}/);
});

test("browser bookmarks are stored in Settings and mirrored into the native chrome", () => {
  assert.match(config, /browserBookmarks: \[\],/);
  assert.match(server, /id="star" title="Bookmark this page" aria-pressed="false"/);
  assert.match(server, /\$\("star"\)\.onclick   = function\(\)\{ act\("bookmark"\); \};/);
  assert.match(server, /act\("bookmarkOpen",\{url:b\.url\}\)/);
  assert.match(server, /act\("bookmarkRemove",\{url:b\.url\}\)/);
  // Saving and deleting belong to the chat UI, which owns the stored list.
  assert.match(shell, /case "bookmark":[\s\S]*?type = "browserBookmarkToggle"/);
  assert.match(shell, /case "bookmarkOpen":[\s\S]*?AddTab\(bmOpenUrl, activate: true, navigate: true\)/);
  assert.match(shell, /case "bookmarkRemove":[\s\S]*?type = "browserBookmarkRemove", url = bmDelUrl/);
  assert.match(shell, /bookmarked = !string\.IsNullOrEmpty\(t\?\.Url\) && _bookmarks\.Any\(b => b\.url == t!\.Url\)/);
  assert.match(shell, /case "bookmarks":[\s\S]*?PushChromeState\(\);/);
  assert.match(ui, /d\.type==="browserBookmarkToggle"\)\{ toggleBookmark\(d\.url,d\.title\); \}/);
  assert.match(ui, /d\.type==="browserBookmarkRemove"\)\{ removeBookmark\(d\.url\); \}/);
  assert.match(ui, /cmd:"bookmarks",items:list\.map/);
  // Only a changed list crosses the bridge, and clearing browsing data drops it.
  assert.match(ui, /if\(signature===lastBookmarkSignature\) return;/);
  assert.match(ui, /setUi\(\{browserHistory:\[\],browserBookmarks:\[\]\}\)/);
  // The new-tab page lists saved pages and refuses non-web schemes.
  assert.match(server, /\/\^https\?:\\\/\\\/\/i\.test\(b\.url\)/);
});

test("compact pane button opens projects and chats as a floating sidebar", () => {
  assert.match(ui, /body\.sidebar-popover-open aside,[\s\S]*?body\.collapsed\.sidebar-popover-open aside\{[\s\S]*?position:fixed; z-index:135;/);
  assert.match(ui, /body\.collapsed\.sidebar-popover-open \.sidebar-brand\{ display:flex; \}/);
  assert.match(ui, /body\.collapsed\.sidebar-popover-open \.threadlist\{ display:flex; \}/);
  assert.match(ui, /const sidebarPopupMode=w<=640;/);
  assert.match(ui, /if\(document\.body\.classList\.contains\("sidebar-popup-mode"\)\)\{[\s\S]*?document\.body\.classList\.toggle\("sidebar-popover-open"\);/);
  assert.doesNotMatch(ui, /body\.sidebar-popup-mode\.chat-xxs\.chat-xs \.topbar #(?:newchat|copyall)/);
  assert.match(ui, /\.side-chat-launch\{\s*display:none;[\s\S]*?width:23px; height:23px;/);
  assert.match(ui, /body\.browser-on \.side-chat-launch,body\.notes-on \.side-chat-launch\{ display:grid; \}/);
});

test("hidden compact rail is available from a floating hamburger menu", () => {
  assert.match(ui, /id="railMenuToggle" title="Open navigation menu" aria-label="Open navigation menu" aria-expanded="false"/);
  assert.match(ui, /#railMenuToggle\{ display:grid; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?#railMenuToggle\{ display:grid; \}/);
  assert.match(ui, /body\.rail-menu-open #sideRail,[\s\S]*?body\.collapsed\.rail-menu-open #sideRail\{[\s\S]*?display:flex!important; position:fixed; z-index:130; left:8px; top:42px;[\s\S]*?width:148px;/);
  assert.match(ui, /body\.rail-menu-open #sideRail,\s*body:not\(\.collapsed\)\.rail-menu-open #sideRail,\s*body\.collapsed\.rail-menu-open #sideRail\{/);
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("pointerenter",[\s\S]*?openNavigationMenu\(\{preview:true\}\)/);
  assert.match(ui, /\$\("panelToggle"\)\?\.addEventListener\("pointerenter",[\s\S]*?sidebarHoverPreview=true;[\s\S]*?classList\.add\("sidebar-popover-open"\)/);
  assert.match(ui, /accountRailButton\?\.addEventListener\("pointerenter",[\s\S]*?accountHoverPreview=true;[\s\S]*?\$\("accountMenu"\)\?\.classList\.add\("open"\)/);
  assert.match(ui, /setTimeout\(\(\)=>\{[\s\S]*?railHoverPreview[\s\S]*?\},220\)/);
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("click"/);
  assert.match(ui, /body\.rail-manual-hidden:not\(\.rail-menu-open\) #sideRail\{[\s\S]*?display:none !important;/);
  assert.match(ui, /function compactNavigationVisible\(\)\{[\s\S]*?style\?\.pointerEvents!=="none"&&style\?\.position!=="fixed";/);
  assert.match(ui, /if\(document\.body\.classList\.contains\("rail-menu-open"\)\|\|compactNavigationVisible\(\)\)\{\s*document\.body\.classList\.add\("rail-manual-hidden"\);\s*closeNavigationMenu\(\);\s*\}else openNavigationMenu\(\);/);
  assert.match(ui, /body:not\(\.collapsed\)\.rail-menu-open #sideRail\{ left:calc\(var\(--approved-sidebar-w\) \+ 8px\); \}/);
  assert.match(ui, /body\.rail-menu-open\.rail-menu-docked #sideRail,[\s\S]*?position:relative;[\s\S]*?flex:0 0 148px;/);
  assert.match(ui, /body\.rail-menu-open #sideRail \.rail-label\{ display:block; font-size:10px; \}/);
  assert.match(ui, /classList\.remove\("rail-expanded","rail-menu-open","rail-menu-docked"\)/);
});

test("back to chat lives beside Local and Cloud while conversation actions remain in the command bar", () => {
  assert.match(ui, /<div class="netseg" id="netmode">[\s\S]*?<\/div>\s*<button class="icon-btn" id="chatHome" title="Back to chat" aria-label="Back to chat"/);
  assert.match(ui, /\$\("chatHome"\)\.onclick=returnToCurrentChat/);
  assert.match(ui, /function returnToCurrentChat\(\)\{[\s\S]*?closeConversationPanels\(\);[\s\S]*?markWorkspaceTab\("chat"\);[\s\S]*?saveAppFrameState\(\);/);
  assert.doesNotMatch(ui, /\$\("chatHome"\)\.onclick=newChat/);
  assert.match(ui, /\$\("chatUtilityNew"\)\?\.addEventListener\("click",\(\)=>newChat\(\)\)/);
  assert.match(ui, /<div class="cmd-bar" id="cmdBar">[\s\S]*id="copyall" title="Copy whole conversation"[\s\S]*id="cmdFile" title="Open and read a file"/);
  assert.match(ui, /function wholeConversationText\(\)/);
  assert.match(ui, /node\.classList\.contains\("model-error"\).*?"Error: "/s);
  assert.match(ui, /node\.classList\.contains\("toolcard"\)/);
  assert.match(ui, /Array\.from\(col\.children\)\.forEach/);
  assert.doesNotMatch(ui, /<div class="cmd-bar" id="cmdBar">[\s\S]*?id="chatHome"/);
  assert.doesNotMatch(ui, /data-rail="new-chat"/);
  assert.doesNotMatch(ui, /data-rail="copy-chat"/);
  assert.doesNotMatch(ui, /<button class="icon-btn" id="copyall"/);
  assert.doesNotMatch(ui, /body\.chat-micro #newchat|body\.chat-micro #copyall/);
});

test("clicking a wide-window sidebar preview docks it beside the app rail", () => {
  assert.match(ui, /if\(sidebarHoverPreview&&document\.body\.classList\.contains\("sidebar-popover-open"\)\)\{[\s\S]*?if\(!document\.body\.classList\.contains\("sidebar-popup-mode"\)\)\{[\s\S]*?document\.body\.classList\.remove\("collapsed"\);[\s\S]*?sidebarManualState=false;[\s\S]*?saveAppFrameState\(\);[\s\S]*?return;/);
});

test("the rail is grouped, context is wired, and the bottom gap is opaque", () => {
  assert.match(ui, /data-rail="browser"[\s\S]*data-rail="context" title="Context panel"[\s\S]*data-rail="notes"/);
  assert.match(ui, /data-rail="notes"[\s\S]*class="rail-separator"[\s\S]*data-rail="git"[\s\S]*data-rail="recipes"[\s\S]*data-rail="automations"/);
  assert.match(ui, /#sideRail \.rail-separator\{ width:22px; height:1px;/);
  assert.match(ui, /else if\(action==="context"\)\{ \$\("ctxToggle"\)\?\.click\(\); \}/);
  assert.match(ui, /\|\|\(rail==="context"&&document\.body\.classList\.contains\("zone-3"\)\)/);
  assert.match(ui, /\.topbar #ctxToggle\{ display:none; \}/);
  assert.match(ui, /body::after,body\.shell::after\{[\s\S]*?height:var\(--approved-bottom-gap\); background:var\(--approved-canvas\); pointer-events:none;/);
});

test("narrow chat contains its header messages and composer without clipping", () => {
  assert.match(ui, /function effectiveChatWidth\(fallback\)\{[\s\S]*?--workspace-chat-width[\s\S]*?getBoundingClientRect\(\)\.width;/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-xxs",chatW<560\);/);
  assert.match(ui, /body\.chat-xxs \.topbar\{ padding:0 6px; justify-content:flex-start; \}/);
  assert.match(ui, /body\.chat-xxs \.winctl\{ margin-left:auto; \}/);
  assert.match(ui, /#appBack\{ display:grid; \}[\s\S]*?#appBack:disabled\{ opacity:\.42; cursor:default; \}/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-micro",chatW<360\);/);
  assert.match(ui, /body\.chat-micro #appForward,[\s\S]*?body\.chat-micro #ctxToggle\{ display:none; \}/);
  assert.doesNotMatch(ui, /body\.browser-on\.chat-micro \.topbar #(?:newchat|copyall)/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?main,#chat,\.col\{ min-width:0; max-width:100%; overflow-x:hidden; box-sizing:border-box; \}/);
  assert.match(ui, /\.msg-user,\.msg-ai,body\.win-lg \.msg-user,body\.win-lg \.msg-ai\{[\s\S]*?max-width:min\(88%,calc\(100% - 12px\)\);/);
  assert.match(ui, /\.composer-wrap,body\.composer-simple \.composer-wrap,[\s\S]*?\.composer-tools\{ min-width:0; max-width:100%; box-sizing:border-box; \}/);
  assert.match(ui, /body\.chat-xxs:not\(\.composer-simple\) \.composer-tools #modetxt,[\s\S]*?\.modebtn \.chev\{ display:none; \}/);
  assert.match(ui, /body\.chat-micro:not\(\.composer-simple\) \.composer-tools \.modelbtn \.chev\{ display:none; \}/);
});

test("workspace card shows the selected API model's real readiness", () => {
  assert.match(ui, /id="sidebarAccountLabel">Ready<\/span>/);
  assert.match(ui, /id="sidebarAccountDot"/);
  assert.match(ui, /function updateReadyStatus\(label,shortLabel\)\{\s*const ready=providerReadyForRun\(state\.provider\|\|"local"\);/);
  assert.match(ui, /\$\("sidebarAccountDot"\)\.className="dot"\+\(ready\?"":" down"\);/);
});

test("workspace card, create actions, search, and account match the approved grouped sidebar", () => {
  assert.match(ui, /\.sidehead\{ min-height:55px;[\s\S]*?border:0;[\s\S]*?background:transparent; \}/);
  assert.doesNotMatch(ui, /\.sidebar-brand::before/);
  assert.equal((ui.match(/<svg class="sidebar-brand-mark" viewBox="0 0 40 40"/g)||[]).length,1);
  assert.doesNotMatch(ui, /<div class="sidehead">/);
  assert.match(ui, /\.sidebar-brand-mark circle\{ fill:currentColor; \}/);
  assert.match(ui, /<svg class="sidebar-brand-mark"[\s\S]*?<circle cx="20" cy="20" r="3\.8"\/>[\s\S]*?<\/svg>/);
  assert.doesNotMatch(ui, /id="sidebarNewProject"|id="sidebarNewChat"/);
  assert.match(ui, /<span>Recents<\/span><button type=\"button\" class=\"section-action chat-add\" title=\"Create\" aria-label=\"Create chat or project\">\+<\/button><span class=\"gcaret\">/);
  assert.match(ui, /\.thread-new-chat\{[^}]*background:transparent; color:var\(--dim\)/);
  assert.match(ui, /chatCreateMenu\.innerHTML=[\s\S]*?data-create="chat"[\s\S]*?New chat[\s\S]*?data-create="project"[\s\S]*?New project/);
  assert.match(ui, /\.chat-create-menu button \+ button\{ border-left:1px solid var\(--border\);/);
  assert.match(ui, /<div class="thread-search-wrap">\s*<div class="thread-search-field">\s*<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"\/><path d="m16 16 4 4"\/><\/svg>\s*<input id="threadSearch"[^>]*placeholder="Search projects and chats"/);
  assert.match(ui, /<span class="thread-search-key" aria-hidden="true">Ctrl K<\/span>/);
  assert.match(ui, /#sidebar \.thread-search-wrap\{ height:38px;[^}]*padding-top:7px;[^}]*width:calc\(100% - 20px\); \}/);
  assert.doesNotMatch(ui, /#sidebar \.thread-search-wrap\{[^}]*border-top/);
  assert.match(ui, /\.thread-search-field > svg\{[\s\S]*?left:9px;[\s\S]*?stroke:var\(--dim\);/);
  assert.match(ui, /display:block; width:100%; height:30px; margin:0; padding:0 9px 0 27px;/);
  assert.match(ui, /id="sidebarAccount"[\s\S]*?id="sidebarAccountAvatar"[\s\S]*?id="sidebarAccountName"[\s\S]*?id="sidebarAccountLabel"/);
  assert.match(ui, /id="sidebarAccountSettings"[^>]*title="Settings"[^>]*aria-label="Open settings"/);
  assert.doesNotMatch(ui, /id="sidebarAbout"|\$\("sidebarAbout"\)\.onclick/);
  assert.match(ui, /\$\("sidebarAccountSettings"\)\.onclick=\(event\)=>\{ event\.stopPropagation\(\); closeAccountMenu\(\); openSettings\(null\); \}/);
  assert.doesNotMatch(ui, /sidebar-account-chevron/);
  assert.doesNotMatch(ui, /<div class="sidebar-system-row">[\s\S]*?data-sidebar-theme=/);
  assert.match(ui, /\$\("sidebarAccount"\)\.onclick=toggleAccountMenu/);
  assert.match(ui, /body:not\(\.collapsed\) #sideRail \.rail-user,\s*body\.collapsed\.sidebar-popover-open #sideRail \.rail-user\{ display:none!important; \}/);
  assert.doesNotMatch(ui, /data-account-composer|id="composerStyleSeg"|Chat input style/);
  assert.match(ui, /document\.body\.classList\.remove\("composer-simple"\)/);
});

test("sidebar shortcut icon row is removed from the visible layout", () => {
  assert.match(ui, /id="sidebarShortcuts"[^>]*hidden/);
  assert.match(ui, /#sidebarShortcuts\[hidden\]\{ display:none!important; \}/);
  assert.doesNotMatch(ui, /id="footStatus"/);
  assert.match(ui, /class="sidebar-account-status"[\s\S]*id="sidebarAccountDot"[\s\S]*id="sidebarAccountLabel">Ready/);
  assert.match(ui, /if\(\$\("sidebarAccountLabel"\)\)\{ \$\("sidebarAccountLabel"\)\.textContent=label;/);
  assert.match(ui,/\.personal-chat-head\{ margin-top:2px; padding-top:4px; \}/);
  assert.match(server,/company\\s\+website[\s\S]*?prospect plan/);
  assert.match(server,/function uniqueThreadTitle\(title, t, allThreads\)/);
  assert.match(server,/autoTitleThread\(t, content, threads\.values\(\)\)/);
});

test("account Settings and the compact provider picker match the approved utility panels", () => {
  const account=ui.slice(ui.indexOf('id="accountMenu"'),ui.indexOf("<main>"));
  assert.match(account,/data-account-action="settings"[\s\S]*?Settings/);
  assert.match(ui,/else if\(action==="settings"\) openSettings\(null\)/);
  const modelMenu=ui.slice(ui.indexOf('id="modelmenu"'),ui.indexOf('id="micbtn"'));
  assert.doesNotMatch(modelMenu,/AI providers/);
  assert.match(ui,/\.menu#modelmenu\{[\s\S]*?padding:32px 6px 6px;/);
  assert.match(ui,/\.api-section-head\{ padding:1px 7px 3px; color:var\(--label\); font-size:10px; font-weight:400;/);
  assert.match(ui,/\.api-provider-select\{ width:calc\(100% - 20px\); min-height:27px; height:27px; margin:2px 10px 5px;/);
  assert.doesNotMatch(ui,/Where do I get a key\?/);
  assert.match(ui,/\.menu#modelmenu\{[^}]*padding:32px 6px 6px;/s);
  assert.match(ui,/\.menu \.model-head\{ min-height:20px;[^}]*font-size:10px; font-weight:400;/s);
});

test("major app surfaces share the compact Projects and Chats corner radius", () => {
  assert.match(ui, /--surface-radius:6px;/);
  assert.match(ui, /body:not\(\.shell\) aside,[\s\S]*?\.sidebar-account-card,[\s\S]*?\.account-popover,/);
  assert.match(ui, /Pills,[\s\S]*?round avatars,[\s\S]*?message bubbles,[\s\S]*?compact controls keep their own shape/);
  assert.match(ui, /@media\(max-width:760px\)\{\s*\.workspace-float\{ border-radius:var\(--surface-radius\); \}/);
});

test("About email and connection rows use recognizable service marks", () => {
  assert.match(ui, /<img class="about-mark" src="\/icon-256\.png"/);
  assert.match(ui, /class="email-provider-icon gmail"[\s\S]*?fill="#4285f4"[\s\S]*?fill="#ea4335"/);
  assert.match(ui, /class="email-provider-icon outlook"[\s\S]*?fill="#1473e6"/);
  assert.match(ui, /function connectorBrandMark\(row\)/);
  assert.match(ui, /openai\|chatgpt/);
  assert.match(ui, /google\|gemini\|gmail/);
  assert.match(ui, /microsoft\|outlook\|azure/);
  assert.match(ui, /github/);
  assert.match(ui, /cloudflare/);
  assert.match(ui, /slack/);
  assert.match(ui, /const mark=connectorBrandMark\(row\)/);
});

test("connector overview gives status and actions independent non-clipping columns", () => {
  assert.match(ui, /\.connector-table-head,\.connector-row\{ display:grid; grid-template-columns:minmax\(150px,1\.7fr\) minmax\(100px,\.55fr\) minmax\(104px,\.55fr\) auto;/);
  assert.match(ui, /<span>Status<\/span><span aria-hidden="true"><\/span>/);
  assert.match(ui, /class="connector-status"><span class="connector-state/);
  assert.match(ui, /class="connector-actions"><button class="connector-action"/);
  assert.match(ui, /\.connector-state\{ color:var\(--dim\); white-space:nowrap; \}/);
});

test("approved layout keeps gray breathing room below every footer", () => {
  assert.match(ui, /--approved-bottom-gap:20px;/);
  assert.match(ui, /--approved-card:#f8f8f6;/);
  assert.match(ui, /\.col\{ width:100%; max-width:none; gap:8px; background:var\(--approved-canvas\); \}/);
  assert.match(ui, /body,body\.shell\{[\s\S]*?padding:calc\(var\(--approved-topbar-h\) \+ var\(--approved-gap\)\) var\(--approved-gap\) var\(--approved-bottom-gap\) 4px;/);
});

test("projects chats and browser use one shared pane background", () => {
  assert.match(ui, /--approved-card:#f8f8f6;/);
  assert.match(ui, /aside,body\.shell aside\{[\s\S]*?background:var\(--approved-card\);/);
  assert.match(ui, /#chat\{[\s\S]*?background:var\(--approved-canvas\);/);
  assert.match(server, /background:#fafaf9;color:#1a1a1a/);
  assert.match(server, /@media\(prefers-color-scheme:dark\)\{body\{background:#1c1c1c;color:#e8e8e8\}\}/);
  assert.doesNotMatch(shell, /Palette\.(?:SoftGlass|GraphiteMist|Clex)|"(?:soft-gloss|graphite-mist|clex)" =>/);
  assert.match(shell, /_themeSurface = "classic";[\s\S]*?return Palette\.Light;/);
});

test("Classic is Boollm's only surface foundation", () => {
  assert.doesNotMatch(ui, /id="colorThemeSeg"|id="brandThemeMenu"|id="brandThemeButton"|data-account-surface/);
  assert.doesNotMatch(ui, /soft-gloss|paper-minimal|graphite-mist|>Clex</);
  assert.match(ui, /function selectedColorTheme\(\)\{ return "classic"; \}/);
  assert.match(config, /colorTheme:\s*"classic"/);
  assert.match(config, /if \(cfg\.ui\.colorTheme !== "classic"\)[\s\S]*?cfg\.ui\.colorTheme = "classic"/);
  assert.match(ui, /root\.dataset\.visualTheme=resolvedDark\?"dark":"light";[\s\S]*?root\.dataset\.colorTheme=selectedColorTheme\(ui\);/);
  assert.match(ui, /\["theme","appZoom","colorTheme","composerStyle"/);
  assert.match(ui, /:root\[data-visual-theme="light"\]\[data-color-theme="classic"\][\s\S]*?--approved-canvas:#f5f5f3; --approved-card:#f7f7f5;/);
  assert.match(ui, /:root\[data-visual-theme="dark"\]\[data-color-theme="classic"\][\s\S]*?--approved-canvas:#181818; --approved-card:#1c1c1c;/);
  assert.match(ui, /:root\[data-color-theme="classic"\] aside,[\s\S]*?data-color-theme="classic"\] body\.shell aside,/);
  assert.match(ui, /:root\[data-color-theme="classic"\] aside,[\s\S]*?data-color-theme="classic"\] body\.shell aside\{[\s\S]*?background:var\(--approved-canvas\)!important;/);
  assert.match(ui, /id="ndrag" title="Drag to resize notepad"/);
  assert.match(ui, /id="ctxdrag" title="Drag to resize context"/);
  assert.match(ui, /function installPaneResizer\(\{handleId,panelId,cssVar,saveKey,minWidth=240\}\)[\s\S]*?setUi\(\{\[saveKey\]:Math\.round\(panel\.getBoundingClientRect\(\)\.width\)\}\)[\s\S]*?handle\.addEventListener\("pointerdown"[\s\S]*?document\.addEventListener\("pointermove",onMove\)[\s\S]*?document\.addEventListener\("pointerup",finish\)/);
  assert.match(ui, /installPaneResizer\(\{handleId:"ndrag",panelId:"notesPanel",cssVar:"--nw",saveKey:"notepadW",minWidth:220\}\)/);
  assert.match(ui, /installPaneResizer\(\{handleId:"ctxdrag",panelId:"ctxZone",cssVar:"--cw",saveKey:"contextW",minWidth:240\}\)/);
  assert.doesNotMatch(ui, /handleId:"bdrag"/);
  assert.match(ui, /document\.body\.style\.setProperty\("--nw",ui\.notepadW\+"px"\)/);
  assert.match(ui, /document\.body\.style\.setProperty\("--cw",ui\.contextW\+"px"\)/);
  assert.match(config, /notepadW:\s*320/);
  assert.match(config, /contextW:\s*300/);
  assert.doesNotMatch(ui, /body\.browser-on:not\(\.shell\) #browser/);
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel\{ width:var\(--nw,280px\); min-width:250px; flex-basis:var\(--nw,280px\); \}/);
  assert.match(ui, /#notesPanel\{ width:var\(--nw,clamp\(260px,32vw,360px\)\); flex:0 0 var\(--nw,clamp\(260px,32vw,360px\)\);/);
  assert.match(ui, /const chatXs=document\.body\.classList\.contains\("chat-xs"\);\s*document\.body\.classList\.toggle\("chat-xs",chatXs\?chatW<470:chatW<430\);/);
  assert.match(ui, /body\.pane-resizing #notesPanel,[\s\S]*?body\.pane-resizing main,body\.pane-resizing aside\{ transition:none!important; \}/);
  // The browser pane's width is the shell splitter's job now (see _browserManualWidth).
  assert.match(shell, /int preferredBrowserW = _browserManualWidth > 0/);
});

test("surface styles reach the native footer and the account identity owns Profile", () => {
  assert.match(ui, /id="accountProfileLink" data-account-action="profile"[^>]*>[\s\S]*?id="accountMenuName"[\s\S]*?id="accountMenuEmail"[\s\S]*?<\/button>/);
  assert.doesNotMatch(ui, /class="account-menu-row" data-account-action="profile"/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"theme",dark:resolvedDark,surface:selectedColorTheme\(ui\),browserDark\}\)/);
  assert.doesNotMatch(shell, /Palette (?:SoftGlass|GraphiteMist|Clex)|connectedClex|_connectedClex/);
  assert.match(shell, /Padding = Padding\.Empty;[\s\S]*?_split\.SplitterWidth = 5;[\s\S]*?_browserPane\.Radius = 0;[\s\S]*?_browserPane\.BorderColor = Color\.Transparent;/);
  // The splitter is dragged by a real grip control that takes mouse capture. The old
  // IMessageFilter hit-test never saw moves over either WebView, so the divider stopped
  // tracking the cursor the moment the drag left the 5px strip.
  assert.doesNotMatch(shell, /IMessageFilter|PreFilterMessage/);
  assert.match(shell, /readonly Panel _splitGrip = new\(\) \{ TabStop = false, Visible = false, Cursor = Cursors\.VSplit \};/);
  assert.match(shell, /_splitGrip\.MouseDown \+= \(_, e\) =>[\s\S]*?_gripDragging = true;\s*_splitGrip\.Capture = true;/);
  assert.match(shell, /_splitGrip\.MouseMove \+= \(_, __\) =>\s*\{\s*if \(_gripDragging\) DragSplitTo\(_split\.PointToClient\(Cursor\.Position\)\.X\);/);
  assert.match(shell, /string surface = "classic";/);
  assert.match(shell, /_themeSurface = "classic";[\s\S]*?pal = Palette\.Light;/);
});

test("approved sidebar follows window width until the user toggles it", () => {
  assert.match(ui, /--approved-sidebar-w:286px;/);
  assert.match(ui, /const estimatedOpenMainW=currentMainW-\(document\.body\.classList\.contains\("collapsed"\)\?sidebarW:0\);/);
  assert.match(ui, /const shouldCollapseApprovedSidebar=w<=640\|\|auxiliaryNeedsRoom;/);
  assert.match(ui, /document\.body\.classList\.toggle\("collapsed",auxiliaryNeedsRoom\|\|recipesNeedRoom\|\|educationNeedsRoom\s*\?true/);
  assert.match(ui, /if\(auxiliaryNeedsRoom\) document\.body\.classList\.remove\("sidebar-popover-open"\);/);
});

test("projects and chats respect manual close even when ample width returns", () => {
  assert.doesNotMatch(ui, /sidebarWasAutoDockable/);
  assert.doesNotMatch(ui, /sidebarManualState=null;\s*document\.body\.classList\.remove\("sidebar-popover-open"\)/);
  assert.match(ui, /sidebarManualState=document\.body\.classList\.contains\("collapsed"\);/);
  assert.match(ui, /body\.notes-on\.browser-on\.chat-micro #notesToggle,[\s\S]*?body\.notes-on\.browser-on\.chat-micro #ctxToggle\{ display:grid!important; \}/);
  assert.match(ui, /\.topbar \.netseg\{ width:92px; min-width:92px; max-width:92px; height:24px;[\s\S]*?border:1px solid var\(--border\); border-radius:9px; background:var\(--bubble\); flex:0 0 92px;/);
  assert.match(ui, /\.topbar \.netseg button\{ width:auto; min-width:0; min-height:18px; height:18px;[\s\S]*?border-radius:7px;[\s\S]*?font:600 7px\/1\.1 var\(--ui\);/);
  assert.match(ui, /\.topbar \.netseg button\[data-net="online"\]\.on\{ background:var\(--bg\); color:var\(--online\); box-shadow:0 1px 5px rgba\(0,0,0,.10\); \}/);
});

test("compact navigation rail returns at half the old width requirement", () => {
  assert.match(ui, /@media\(min-width:681px\) and \(max-width:760px\)\{[\s\S]*?#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{[\s\S]*?display:flex; flex-basis:30px; width:30px; min-width:30px;/);
  assert.doesNotMatch(ui, /@media\(min-width:681px\) and \(max-width:760px\)\{[\s\S]*?#railMenuToggle\{ display:none; \}/);
  assert.doesNotMatch(ui, /if\(w>380\)\{\s*document\.body\.classList\.remove\("rail-menu-open"\);/);
});

test("model picker includes the local cloud toggle and stays synced", () => {
  assert.match(ui, /\.menu#modelmenu\{ position:fixed; bottom:auto; right:auto; width:218px;/);
  assert.match(ui, /\.menu#modelmenu\.api-wizard-open\{ width:min\(285px,calc\(100vw - 16px\)\); max-height:min\(504px,calc\(100vh - 16px\)\);[^}]*scrollbar-gutter:auto;/);
  assert.match(ui, /<button class="api-key-save" type="button" title="Connect API key" aria-label="Connect API key">&#10003;<\/button>/);
  assert.match(ui, /#modelmenu\.api-wizard-open \.api-provider-detail\.connecting \.api-key-save\{[^}]*width:27px;[^}]*height:25px;/);
  assert.match(ui, /@media\(max-width:350px\)\{[\s\S]*?#modelmenu\.api-wizard-open \.api-provider-detail\.connecting \.api-key-save\{ grid-column:1\/-1; width:100%; \}/);
  assert.match(ui, /#modelmenu\.api-wizard-open \.model-engine-seg\{ height:21px; \}/);
  assert.match(ui, /#modelmenu\.api-wizard-open \.api-provider-detail\.connecting \.api-key-form input\{ min-height:25px; height:25px;/);
  assert.match(ui, /\$\("modelmenu"\)\?\.classList\.add\("api-wizard-open"\);/);
  assert.match(ui, /const preferredLeft=wizard\?workspaceRect\.left\+\(workspaceRect\.width-width\)\/2:buttonRect\.left;/);
  assert.match(ui, /function positionModelMenu\(\)\{[\s\S]*?const minLeft=workspaceRect\.left\+margin;[\s\S]*?const maxLeft=Math\.max\(minLeft,workspaceRect\.right-width-margin\);[\s\S]*?menu\.style\.left=/);
  assert.match(ui, /function openModelSelector\(\)\{[\s\S]*?\$\("modelmenu"\)\?\.classList\.add\("open"\);[\s\S]*?renderModelList\(""\);\s*positionModelMenu\(\);\s*requestAnimationFrame\(positionModelMenu\);/);
  assert.match(ui, /if\(paidReady\)\{\s*openModelSelector\(\);/);
  assert.match(ui, /id="modelmenu"[\s\S]*id="modelsearch" type="hidden" value=""[\s\S]*id="modelNetMode"[\s\S]*data-net="local"[\s\S]*data-net="online"[\s\S]*id="modellist"/);
  assert.match(ui, /#modelmenu \.model-netseg\{ position:absolute; top:8px; right:8px; z-index:1; \}/);
  assert.match(ui, /\.model-netseg\{[^}]*width:92px;[^}]*grid-template-columns:1fr 1fr;/s);
  assert.match(ui, /#modelmenu>input\{ display:none; \}/);
  assert.match(ui, /function placeModelNetSeg\(\)\{/);
  assert.match(ui, /if\(menu&&seg&&list&&seg\.parentElement!==menu\) menu\.insertBefore\(seg,list\);/);
  assert.match(ui, /const pickerNet=modelPickerNet\|\|\(state\.provider==="local"\?"local":"online"\);/);
  assert.match(ui, /if\(pickerNet==="online"\)\{/);
  assert.match(ui, /const activeModelName=\(\)=>\{[\s\S]*?provider==="local"\?displayName\(state\.model\):providerModelName\(provider\)/);
  assert.match(ui, /function setComposerModelDisplay\(modelName\)\{/);
  assert.match(ui, /target\.innerHTML=`<span class="model-label-text">\$\{esc\(full\)\}<\/span><span class="model-label-compact">\$\{esc\(compact\|\|full\)\}<\/span>`;/);
  assert.match(ui, /target\.setAttribute\("aria-label",modelName\|\|"Select a model"\)/);
  assert.match(ui, /\$\("providersel"\)\.onchange=async\(e\)=>\{[\s\S]*?const provider=e\.target\.value;[\s\S]*?JSON\.stringify\(\{provider\}\)/);
  assert.match(ui, /modelPickerNet="online";[\s\S]*?const firstMissing=\$\("modellist"\)\?\.querySelector\("\.api-provider\.missing"\);[\s\S]*?Boollm will stay on Local until it is saved\./);
  assert.match(ui, /if\(net==="local"\)\{[\s\S]*?modelPickerNet="local";[\s\S]*?state\.codingEngine="boolean";[\s\S]*?JSON\.stringify\(\{provider:"local",codingEngine:"boolean"\}\)/);
  assert.match(ui, /modelPickerNet="online";\s*state\.codingEngine="auto";[\s\S]*?JSON\.stringify\(\{provider:prov,codingEngine:"auto"\}\)/);
  assert.match(ui, /await fetch\("\/api\/config",\{method:"POST",body:JSON\.stringify\(\{codingEngine:"auto"\}\)\}\);[\s\S]*?\$\("modelmenu"\)\.classList\.add\("open"\)/);
  assert.doesNotMatch(ui, /else if\(providerReadyForRun\("local"\)\) prov="local"/);
  assert.match(ui, /document\.querySelectorAll\("#netmode button,#modelNetMode button"\)\.forEach\(b=>b\.classList\.toggle\("on"/);
  assert.match(ui, /document\.querySelectorAll\("#netmode button,#modelNetMode button"\)\.forEach\(b=>b\.onclick=\(\)=>selectNet\(b\.dataset\.net\)\)/);
});

test("installed local models show measured performance on this PC", () => {
  assert.match(ui, /const LOCAL_MODEL_PERF_KEY="boollmLocalModelPerformanceV1";/);
  assert.match(ui, /Not tested on this PC/);
  assert.match(ui, /tok\/s · responds /);
  assert.match(ui, /recordLocalModelPerformance\(run\)/);
  assert.match(ui, /run\.firstTokenAt=performance\.now\(\)/);
  assert.match(ui, /run\.lastUsage=ev/);
  assert.match(ui, /installed\?"Installed":"Download"/);
  assert.match(ui, /#modellist\.local-model-view \.item\.model-rec \.model-performance\{ position:absolute; left:34px; right:4px; bottom:2px;/);
  assert.match(ui, /await benchmarkInstalledModel\(file\)/);
});

test("cloud provider setup stays compact and reveals all models after connection", () => {
  assert.doesNotMatch(ui, /class="model-picker-title"><b>AI providers<\/b>/);
  assert.match(ui, /\.menu#modelmenu\{[^}]*width:218px;[^}]*max-height:min\(380px,calc\(100vh - 72px\)\)/s);
  assert.doesNotMatch(ui, /class="model-search-toggle"|id="modelSearchToggle"/);
  assert.match(ui, /<input id="modelsearch" type="hidden" value="">/);
  assert.match(ui, /connectedHead\.textContent="Connected"/);
  assert.match(ui, /apiProviderHealth\[prov\]==="ready"/);
  assert.match(ui, /if\(missing\.length\)\{\s*const next=missing\.find\(\(\[prov\]\)=>prov==="openai"\)\|\|missing\[0\];\s*openApiProvider=next\[0\];\s*renderFocusedApiProvider\(next\[0\],next\[1\],false\);/);
  assert.doesNotMatch(ui, /showApiProviderCatalog|api-add-provider/);
  assert.doesNotMatch(ui, /missing\.length&&\(connected\.length\|\|!savedProviders\.length\)/);
  assert.match(ui, /function renderFocusedApiProvider\(prov,label,hasKey\)/);
  assert.match(ui, /className="api-connected-summary"/);
  assert.match(ui, /const selected=state\.provider===id;/);
  assert.match(ui, /row\.setAttribute\("aria-current","true"\)/);
  assert.match(ui, /\(selected\?"Selected":"Use"\)/);
  assert.doesNotMatch(ui, /providerMark\(id,name\)\+'<span class="conn-dot"/);
  assert.match(ui, /className="api-provider-select"/);
  assert.match(ui, /\.api-connected-summary \.model-line\{[^}]*display:grid; grid-template-columns:minmax\(0,1\.35fr\) minmax\(42px,\.65fr\);/s);
  assert.match(ui, /#modelmenu \.model-picker-title\{[^}]*height:30px; min-height:30px;/s);
  assert.match(ui, /\.menu#modelmenu\{[^}]*border-radius:6px;[^}]*background-clip:padding-box; scrollbar-gutter:stable;/s);
  assert.match(ui, /\.api-provider-select\{[^}]*min-height:27px; height:27px;/s);
  assert.match(ui, /\.api-provider-detail\.connecting \.api-key-form\{[^}]*grid-template-columns:minmax\(0,1fr\) 24px;/s);
  assert.match(ui, /#modelmenu \.api-provider-detail\.connecting \.api-key-form input\{[^}]*min-height:26px; height:26px;/s);
  assert.match(ui, /\.api-provider-detail\.connecting \.api-key-save\{[^}]*min-height:24px; height:24px;/s);
  assert.match(ui, /role="button" tabindex="0" aria-expanded="false"/);
  assert.match(ui, /toggleApiProvider\(id,name,row,true,true\)/);
  assert.match(ui, /tempToast\("Switched to "\+displayName\(model\)\+"\."\);\s*await refresh\(\);\s*inlineOpenApiProvider="";\s*openApiProvider="";\s*renderModelList\(""\);/);
  assert.match(ui, /\.api-provider-detail\.inline-models\{[^}]*border-top:1px/s);
  assert.match(ui, /list\.classList\.toggle\("local-model-view",pickerNet!=="online"\)/);
  assert.match(ui, /#modellist\.local-model-view \.item\.model-rec\{[^}]*min-height:40px/s);
  assert.match(ui, /function localModelCompanyMark\(value\)/);
  assert.match(ui, /const head=appendLibraryHead\(list,"Installed"\);[\s\S]*?appendLibraryHead\(list,"Recommended local"\)/);
  assert.match(ui, /#modellist\.local-model-view \.model-actions\{[^}]*width:94px;[^}]*grid-template-columns:50px 20px 20px;/s);
  assert.match(ui, /#modellist\.local-model-view \.model-dl\{[^}]*width:50px;[^}]*min-width:50px;/s);
  assert.match(ui, /\.local-company-mark\{[^}]*width:14px;[^}]*height:14px;/s);
  assert.match(ui, /\.api-connected-summary \.api-mark,\.api-connected-summary \.api-badge\{ width:14px; height:14px;/);
  assert.match(ui, /id==="zaiCoding"\?'<em class="api-plan-badge" title="Subscription plan API">Plan<\/em>'/);
  assert.match(ui, /\.api-plan-badge\{[^}]*font:700 5\.8px\/1 var\(--ui\)/s);
  assert.match(ui, /\.api-provider-option \.api-mark\{ flex:0 0 auto; width:14px; height:14px;/);
  assert.match(ui, /\.api-provider-option \.api-badge\{ flex:0 0 auto; width:14px; height:14px;/);
  assert.match(ui, /\.api-provider-select \.api-mark\{ width:13px; height:13px;/);
  assert.match(ui, /qwen:\{fill:true,svg:'<svg[^']*qwenMarkGradient/);
  assert.match(ui, /const actionMarkup=installed\?esc\(action\):'<span>Download<\/span><small>'\+esc\(rec\.size\)/);
  assert.match(ui, /class="model-dl'\+\(installed\?"":" download"\)/);
  assert.match(ui, /className="local-model-ask"/);
  assert.match(ui, /Ask chat to find another open model/);
  assert.match(ui, /askAI\(request\)/);
  assert.match(ui, /className="api-provider-options"/);
  assert.doesNotMatch(ui, /Browse all providers/);
  assert.match(ui, /const heightLimit=wizard\?Math\.min\(504,window\.innerHeight-margin\*2\):380;/);
  assert.match(ui, /Math\.min\(heightLimit,buttonRect\.top-margin\)/);
  assert.match(ui, /function closeRowMenus\(\{restoreFocus=false\}=\{\}\)/);
  assert.match(ui, /more\.setAttribute\("aria-haspopup","menu"\)/);
  assert.match(ui, /if\(!e\.target\.closest\("#modelmenu \.api-row-menu,#modelmenu \.api-row-more"\)\) closeRowMenus\(\)/);
  assert.match(ui, /e\.key==="Escape"&&document\.querySelector\("#modelmenu \.api-row-menu"\)[\s\S]*?closeRowMenus\(\{restoreFocus:true\}\)/);
  assert.match(ui, /modelsHead\.textContent="Available models"/);
  assert.match(ui, /await verifyApiProviderModels\(prov\);[\s\S]*?if\(!verifiedModels\.length\)[\s\S]*?showInlineApiModels\(form,prov,label,verifiedModels\)/);
  assert.match(ui, /\.api-model-list\{ max-height:260px; overflow:auto; \}/);
});

test("AI model switches have full mouse and touch targets and persist their state", () => {
  assert.match(ui, /<label class="switch" for="cloudFallbackEnabled"[\s\S]*id="cloudFallbackEnabled" role="switch"[\s\S]*aria-checked="false"/);
  assert.match(ui, /<label class="model-routing-toggle" for="autoRouteModels"[\s\S]*id="autoRouteModels" role="switch"[\s\S]*aria-checked="false"/);
  assert.match(ui, /\.switch input\{[^}]*inset:0;[^}]*width:100%;[^}]*height:100%;[^}]*cursor:pointer;/s);
  assert.match(ui, /\.model-routing-toggle input\{[^}]*inset:0;[^}]*width:100%;[^}]*height:100%;[^}]*cursor:pointer;/s);
  assert.match(ui, /\.switch\{[^}]*touch-action:manipulation;/s);
  assert.match(ui, /\.model-routing-toggle\{[^}]*touch-action:manipulation;/s);
  assert.match(ui, /\.model-routing-toggle input:checked \+ \.slider\{ background:var\(--ready\); \}/);
  assert.match(ui, /#settingsPanel \.model-routing-toggle input:checked \+ \.slider\{ background:var\(--ready\); \}/);
  assert.match(ui, /toggle\.setAttribute\("aria-checked",String\(toggle\.checked\)\)/);
  assert.match(ui, /Automatic model routing is on\./);
  assert.match(ui, /Backup cloud model is on\./);
  assert.match(ui, /modelsWrap\.querySelectorAll\("\.api-model-row"\)\.forEach\(candidate=>\{candidate\.classList\.toggle\("selected",candidate===row\);candidate\.querySelector\("small"\)\.textContent=candidate===row\?"Selected":"Use";\}\)/);
  assert.match(ui, /state\.provider=prov;state\.model=model;state\.providerModels=\{\.\.\.\(state\.providerModels\|\|\{\}\),\[prov\]:model\}/);
  assert.match(ui, /setComposerModelDisplay\(displayName\(model\)\);updateFooterModelStatus\(\)/);
  assert.match(ui, /tempToast\("Switched to "\+displayName\(model\)\+"\."\)/);
});

test("composer hides compare and moves approval beside the model picker", () => {
  assert.match(ui, /#compareAnchor\{ display:none !important; \}/);
  assert.match(ui, /body\.online-mode #compareAnchor\{ display:none !important; \}/);
  assert.match(ui, /\.composer-tools \.spacer\{ order:10; \}/);
  assert.match(ui, /\.composer-tools \.anchor:has\(#modebtn\)\{ order:20; \}/);
  assert.match(ui, /#compareAnchor\{ order:21; \}/);
  assert.match(ui, /\.composer-tools \.anchor:has\(#modelbtn\)\{ order:22; margin-left:10px; \}/);
  assert.match(ui, /body\.composer-simple \.composer-tools \.anchor:has\(#modelbtn\)\{ margin-left:12px; \}/);
});

test("simple composer keeps only compact action icons above the input", () => {
  assert.match(ui, /<div class="composer-top-strip">\s*<div class="composer-chat-actions" id="composerChatActions"><\/div>\s*<\/div>/);
  assert.doesNotMatch(ui, /recent-chats-label/);
  assert.doesNotMatch(ui, /id="recentChats"/);
  assert.doesNotMatch(ui, /recent-chat-tab/);
  assert.doesNotMatch(ui, /renderRecentChats/);
  assert.match(ui, /body\.composer-simple \.composer-top-strip\{[^}]*display:flex;/s);
  assert.match(ui, /body\.composer-simple \.composer-top-strip\{[^}]*pointer-events:auto;/s);
  assert.match(ui, /body\.composer-simple \.composer\{[^}]*min-height:96px;[^}]*padding:8px var\(--content-x\) 16px;/s);
  assert.match(ui, /body\.composer-simple \.promptline\{[^}]*min-height:56px;/s);
  assert.match(ui, /body\.composer-simple \.composer textarea\{[^}]*min-height:38px; max-height:58px;/s);
  assert.match(ui, /body\.composer-simple \.composer-base\{[^}]*margin:-14px 0 var\(--composer-bottom\);/s);
  assert.match(ui, /body\.composer-simple \.composer-chat-actions\{[^}]*font:12\.5px\/1\.2 var\(--ui\);/s);
  assert.match(ui, /body\.composer-simple \.composer-chat-actions\{[^}]*pointer-events:auto;/s);
  assert.match(ui, /body\.composer-simple \.composer-meta-action\{[^}]*width:36px; height:34px;[^}]*touch-action:manipulation;[^}]*pointer-events:auto;/s);
  assert.match(ui, /body\.composer-simple \.composer-meta-action\{\s*width:28px; height:28px; border-radius:6px; color:var\(--dim\); pointer-events:auto;/);
  assert.match(ui, /body\.composer-simple \.composer-meta-action\.action-done::after\{[^}]*content:attr\(data-feedback\)/s);
  assert.match(ui, /body\.composer-simple \.composer-chat-actions\{[^}]*min-width:max-content;[^}]*overflow:visible;/s);
  for (const action of ["copy", "paste", "share", "again"]) {
    assert.match(ui, new RegExp(`data-chat-act="${action}"`));
  }
  assert.match(ui, /\$\("composerChatActions"\)\.addEventListener\("pointerdown",handleComposerMetaPointerDown\)/);
  assert.match(ui, /\$\("composerChatActions"\)\.addEventListener\("click"/);
  assert.match(ui, /btn\.onpointerdown=handleComposerMetaPointerDown/);
  assert.match(ui, /btn\.onclick=handleComposerMetaActionEvent/);
  assert.match(ui, /markActionDone\(btn,"Copied"\)/);
  assert.match(ui, /markActionDone\(btn,"Pasted"\)/);
  assert.match(ui, /markActionDone\(btn,"Shared"\)/);
  assert.match(ui, /markActionDone\(btn,"Retrying"\)/);
  assert.match(ui, /async function pasteClipboardToComposer\(\)\{\s*try\{\s*const clip=await readClipboardText\(\);/);
  assert.match(ui, /fetch\("\/api\/clipboard\/read",\{method:"POST",headers:\{"x-saz":"1"\},body:"\{\}"\}\)/);
  assert.match(ui, /\.paste-ico\{[^}]*stroke:currentColor;[^}]*stroke-width:1\.7;/s);
  assert.match(ui, /id="gmailClientPaste"[\s\S]*<svg class="paste-ico" viewBox="0 0 16 16"/);
  assert.match(ui, /id="outlookClientPaste"[\s\S]*<svg class="paste-ico" viewBox="0 0 16 16"/);
  assert.match(ui, /\.msg-foot \.actbtn\{[^}]*width:17px; height:17px;[^}]*touch-action:manipulation;/s);
  assert.match(ui, /\.msg-foot \.actbtn svg\{[^}]*width:10px; height:10px;/s);
  assert.match(ui, /const uPasteIcon='<svg/);
  assert.match(ui, /aria-label="Paste into composer">'\+uPasteIcon\+'/);
});

test("compact access and model controls open visible dropdowns", () => {
  assert.match(ui, /\.composer-wrap:has\(\.menu\.open\),body\.composer-simple \.composer-wrap:has\(\.menu\.open\)\{ overflow:visible; z-index:30; \}/);
  assert.match(ui, /body\.composer-simple \.composer-tools \.modebtn,\s*body\.composer-simple \.composer-tools \.modelbtn\{[\s\S]*?height:18px; min-height:18px;[\s\S]*?border-radius:0;[\s\S]*?background:transparent; box-shadow:none; font:9px\/1 var\(--ui\);/);
  assert.match(ui, /body\.composer-simple \.composer-tools \.modelbtn\{ max-width:74px; \}/);
  assert.match(ui, /body\.composer-simple\.online-mode \.composer-tools \.modelbtn\{\s*border-radius:0; background:transparent; box-shadow:none;/);
  assert.match(ui, /\$\("modelbtn"\)\.onclick=\(e\)=>\{ e\.stopPropagation\(\);[\s\S]*openModelSelector\(\); \};/);
  assert.match(ui, /\$\("modebtn"\)\.onclick=\(e\)=>\{ e\.stopPropagation\(\);[\s\S]*\$\("modemenu"\)\.classList\.toggle\("open"\); \};/);
});

test("composer access menu persists read, write, full-access, and signed-in trading modes", () => {
  assert.match(ui, /data-mode="read_only"[\s\S]*?<b>Read only<\/b><small>Inspect and analyze; no edits or deploys\.<\/small>/);
  assert.match(ui, /data-mode="ask"[\s\S]*?<b>Read &amp; write<\/b><small>Ask before changes and commands\.<\/small>/);
  assert.match(ui, /data-mode="full_access"[\s\S]*?<b>Full access<\/b><small>Auto-approve workspace actions\.<\/small>/);
  assert.match(ui, /data-mode="trading_confirm"[\s\S]*?<b>Trading access<\/b><small>Full access plus signed-in trading\. Confirm every live order\.<\/small>/);
  assert.match(ui, /accessMode:"ask", autoApprove:false/);
  assert.match(ui, /function currentAccessMode\(\)\{[\s\S]*?\["read_only","ask","full_access"\]\.includes\(saved\)\?saved:\(state\.autoApprove\?"full_access":"ask"\);/);
  assert.match(ui, /let accessModeSaveQueue=Promise\.resolve\(\);/);
  assert.match(ui, /function saveAccessMode\(mode\)\{[\s\S]*?const response=await fetch\("\/api\/config",\{method:"POST",body:JSON\.stringify\(body\)\}\);[\s\S]*?if\(!response\.ok\) throw new Error/);
  assert.match(ui, /state\.accessMode=\["read_only","ask","full_access"\]\.includes\(data\.accessMode\)\?data\.accessMode:requested;/);
  assert.match(ui, /await accessModeSaveQueue;[\s\S]*?body\.accessMode=currentAccessMode\(\);/);
  assert.match(ui, /if\(mode==="trading_confirm"\)\{ await setTradingMode\(true\); return; \}/);
  assert.match(ui, /await setTradingMode\(false\);[\s\S]*?await saveAccessMode/);
  assert.match(ui, /Trading stocks, ETFs, options, futures, crypto, and other assets is risky/);
  assert.match(ui, /This mode includes Full access/);
  assert.match(ui, /await saveAccessMode\("full_access"\)/);
  assert.match(ui, /Sign in to Boollm before enabling trading access/);
  assert.match(ui, /\.approval\.trade-approval\{ display:grid; grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(ui, /tradeApproval\?'Confirm live trade order'/);
  assert.match(ui, /tradeApproval\?'Confirm'/);
  assert.match(ui, /if\(access\)access\.textContent=accessModeLabel\(tradingModeEnabled\(\)\?"trading_confirm":currentAccessMode\(\)\);/);
});

test("approval and continuation cards remain visible above the composer", () => {
  assert.match(ui, /\.col::after\{[^}]*height:calc\(var\(--composer-h,106px\) \+ var\(--chat-tail-gap,12px\)\)/s);
  assert.match(ui, /function revealChatAction\(node\)\{/);
  assert.match(ui, /requestAnimationFrame\(\(\)=>\{\s*reveal\(\);\s*requestAnimationFrame\(reveal\);/s);
  assert.match(ui, /const card=insertAbove\(makeApprovalCard\(ev\)\);\s*revealChatAction\(card\);/s);
  assert.match(ui, /col\.appendChild\(bar\);\s*revealChatAction\(bar\);/s);
  assert.doesNotMatch(ui, /col\.scrollTop\s*=\s*col\.scrollHeight/);
  assert.match(ui, /body\.composer-simple \.next-edit-bar\{ margin-bottom:4px; \}/);
});

test("local browser paste has a guarded backend clipboard fallback", () => {
  assert.match(server, /function readSystemClipboardText\(\)/);
  assert.match(server, /spawnSync\("powershell\.exe", \["-NoProfile", "-Command", "Get-Clipboard -Raw"\]/);
  assert.match(server, /p === "\/api\/clipboard\/read"/);
  assert.match(server, /json\(\{ ok: true, text: readSystemClipboardText\(\) \}\)/);
  assert.match(ui, /fetch\("\/api\/clipboard\/read",\{method:"POST",headers:\{"x-saz":"1"\},body:"\{\}"\}\)/);
});

test("browser chrome adapts before the pane is too narrow", () => {
  assert.match(ui, /@container \(max-width:560px\)\{/);
  // Toolbar density now belongs to the shell chrome bar.
  assert.match(server, /.row.r-nav{|.ico{/);
  assert.match(ui, /@container \(max-width:420px\)\{/);
  assert.match(server, /\.addr\{|\.row\.r-nav\{/);
  assert.match(server, /\.ico\{/);
});

test("side chat popup scales smaller with the main window", () => {
  assert.match(ui, /\.side-chat-launch\{ position:fixed;[^}]*left:4px; right:auto; top:calc\(100% - var\(--composer-h,106px\) \+ 14px\);[^}]*width:23px; height:23px;[^}]*cursor:pointer; touch-action:manipulation;/s);
  assert.doesNotMatch(ui, /body:not\(\.collapsed\) \.side-chat-launch/);
  assert.match(ui, /\.side-chat-panel\{[^}]*top:86px; left:14px; right:auto;[^}]*width:clamp\(228px,23vw,276px\);[^}]*height:clamp\(260px,44dvh,370px\);/s);
  assert.match(ui, /body\.browser-on \.side-chat-panel\{ width:clamp\(216px,21vw,258px\); height:clamp\(250px,40dvh,344px\); \}/);
  assert.match(ui, /@media\(max-width:720px\)\{ \.side-chat-panel\{ width:min\(276px,calc\(100vw - 22px\)\); height:min\(344px,calc\(100dvh - 92px\)\); left:11px; right:auto; \} \}/);
  assert.match(ui, /function sideChatLeftEdge\(\)\{/);
  assert.match(ui, /const launcher=\$\("sideChatToggle"\);[\s\S]*return Math\.max\(8,Math\.round\(\(rect\?\.right\|\|0\)\+8\)\);/);
  assert.match(ui, /id="sideChatResize" title="Drag to resize side chat"/);
  assert.match(ui, /boolean_side_chat_size/);
  assert.match(ui, /localStorage\.getItem\("boolean_side_chat_home"\)==="left"/);
  assert.match(ui, /sideChatResizing=\{x:event\.clientX,y:event\.clientY,width:rect\.width,height:rect\.height\}/);
  assert.match(ui, /function applySideChatLauncherPosition\(\)\{/);
  assert.match(ui, /const actionRowTop=Number\.isFinite\(composerTop\)\?composerTop\+14:window\.innerHeight-92;/);
  assert.match(ui, /const chatRect=document\.querySelector\("main"\)\?\.getBoundingClientRect\(\);/);
  assert.match(ui, /const left=Math\.max\(0,Math\.min\(window\.innerWidth-launcherWidth,Math\.round\(chatLeft-launcherWidth\/2\)\)\);/);
  assert.match(ui, /launcher\.style\.left=left\+"px";\s*launcher\.style\.right="auto";/);
  assert.match(ui, /localStorage\.removeItem\("boolean_side_chat_launcher_action_top"/);
  assert.doesNotMatch(ui, /"sideChatToggle"\)\.addEventListener\("pointermove"/);
  assert.match(ui, /const latest=sideChatThreads\(\)\[0\];[\s\S]*sideChatThreadId=latest\.id;/);
  assert.match(ui, /peek=1&tail=250/);
  assert.match(ui, /const left=\(saved&&Number\.isFinite\(saved\.left\)\)\?saved\.left:sideChatLeftEdge\(\);[\s\S]*const pos=clampSideChatPosition\(left,top\);/);
  assert.match(ui, /function scheduleSideChatDrag\(left,top\)\{[\s\S]*const pos=clampSideChatPosition\(left,top\);[\s\S]*sideChatDragging\.left=pos\.left;/);
  assert.match(ui, /\.side-chat-history\{[^}]*max-height:84px;/);
  assert.doesNotMatch(ui, /class="new-side-chat/);
  assert.doesNotMatch(ui, /data-new="1"/);
  assert.match(ui, /id="sideChatNew" title="New side chat" aria-label="New side chat">/);
  assert.match(ui, /else if\(event\.type==="answer"\) raw=event\.text\|\|raw;\s*else if\(event\.type==="done"\) streamDone=true;/);
  assert.match(ui, /if\(streamDone\) break;/);
  assert.doesNotMatch(ui, /reader\.cancel\(\)\.catch/);
  assert.match(ui, /if\(sideChatThreadId\) await loadSideChat\(\)\.catch\(\(\)=>\{\}\); renderSideChatHistory\(\); updateSideChatModelBadge\(\);/);
});

test("native shell places the window inside the monitor work area", () => {
  assert.match(shell, /case "max": MaximizeWindow\(\)/);
  assert.match(shell, /case "snapleft": SnapWindow\(false\)/);
  assert.match(shell, /case "snapright": SnapWindow\(true\)/);
  assert.match(shell, /Screen\.FromHandle\(Handle\)\.WorkingArea/);
  assert.match(shell, /right \? work\.Right - width : work\.Left/);
  assert.match(ui, /\$\("winMax"\)\.onclick=\(e\)=>\{\s*e\.stopPropagation\(\);\s*closeWindowLayoutMenu\(\);\s*winCmd\("maxtoggle"\);\s*\};/);
  assert.match(ui, /\$\("winMax"\)\.addEventListener\("pointerenter",\(e\)=>\{/);
  assert.match(ui, /windowLayoutHoverTimer=setTimeout\(openWindowLayoutMenu,450\)/);
  assert.match(ui, /winCmd\("maxtoggle"\);/);
  assert.match(shell, /type = "shellWindowState",\s*maximized = WindowState == FormWindowState\.Maximized/);
  assert.match(shell, /PushChromeState\(\); \/\/ keep the chrome's maximize\/restore glyph in sync\s*PushWindowState\(\);/);
  assert.match(ui, /const setNativeWindowState=\(maximized\)=>\{/);
  assert.match(ui, /const label=maximized\?"Restore window":"Window layout";/);
  assert.match(ui, /d\.type==="shellWindowState"\)\{[\s\S]*?setNativeWindowState\(!!d\.maximized\);[\s\S]*?restoreWorkspaceFloatWidth\(\);/);
});

test("borderless native shell exposes resize hit zones on every edge and corner", () => {
  assert.match(shell, /WS_THICKFRAME = 0x40000/);
  assert.match(shell, /const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084, HTCLIENT = 1;/);
  assert.match(shell, /m\.Msg == WM_NCHITTEST && WindowState != FormWindowState\.Maximized/);
  assert.match(shell, /int grip = Math\.Max\(8, \(int\)Math\.Round\(8 \* DeviceDpi \/ 96d\)\);/);
  assert.match(shell, /m\.Result = \(IntPtr\)hit/);
  const hitBody = shell.slice(shell.indexOf("int ResizeHitTest"), shell.indexOf("protected override void WndProc"));
  for (const code of ["HTLEFT","HTRIGHT","HTTOP","HTBOTTOM","HTTOPLEFT","HTTOPRIGHT","HTBOTTOMLEFT","HTBOTTOMRIGHT"]) {
    assert.match(hitBody, new RegExp(`return ${code};`));
  }
  for (const corner of ["HTTOPLEFT","HTTOPRIGHT","HTBOTTOMLEFT","HTBOTTOMRIGHT"]) {
    assert.ok(hitBody.indexOf(`return ${corner};`) < hitBody.indexOf("return HTLEFT;"));
  }
});

test("native shell completes the Windows 11 border without adding a Windows 10 top line", () => {
  assert.match(shell, /readonly Panel _topOutline = new\(\) \{ Dock = DockStyle\.Top, Height = 1, TabStop = false, Visible = false \};/);
  assert.match(shell, /Controls\.Add\(_topOutline\);\s*_topOutline\.BringToFront\(\);/);
  assert.match(shell, /bool show = OperatingSystem\.IsWindowsVersionAtLeast\(10, 0, 22000\);\s*_topOutline\.Visible = show;\s*if \(!show\) return;/);
  assert.match(shell, /_topOutline\.BackColor = _pal\.BtnBorder;/);
  assert.doesNotMatch(shell, /DwmGetColorizationColor/);
});

test("native shell does not leave a differently colored footer below the WebView", () => {
  assert.match(shell, /Let the themed content reach the bottom edge/);
  assert.match(shell, /The WebView owns the complete bottom surface in both themes/);
  assert.doesNotMatch(shell, /Padding = new Padding\(0, 0, 0, 12\)/);
});

test("side chat user bubbles keep readable foreground contrast in dark mode", () => {
  assert.match(ui, /\.side-chat-msg\.user\{[^}]*color:var\(--accent-text\);[^}]*background:var\(--accent\);/s);
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--accent:#ececec; --accent-text:#181818;/);
});

test("round composer uses the compact floating card layout without changing line mode", () => {
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-wrap\{[^}]*min-height:124px;[^}]*border-radius:24px;[^}]*box-shadow:0 3px 12px/s);
  assert.match(ui, /body:not\(\.composer-simple\) main::after\{\s*bottom:0; height:152px;[\s\S]*?var\(--approved-canvas\) 92%,transparent\) 24px/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer textarea\{[^}]*min-height:48px;[^}]*font:15px\/1\.45 var\(--ui\)/s);
  assert.match(ui, /id="composerPrompt">Ask anything\.\.\.<\/span><textarea id="input" rows="1" placeholder="Ask anything\.\.\."/);
  assert.match(ui, /id="micbtn" type="button" title="Voice input"/);
  assert.match(ui, /window\.SpeechRecognition\|\|window\.webkitSpeechRecognition/);
  assert.match(ui, /\?\{read_only:"Read",ask:"Write",full_access:"Full",trading_confirm:"Trade"\}\s*:\{read_only:"Read only",ask:"Read & write",full_access:"Full access",trading_confirm:"Trading access"\}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools #plusbtn\{ order:0; \}/);
  assert.doesNotMatch(ui, /id="snipbtn"/);
  assert.match(ui, /id="attSnip"><span>Snip screen<\/span>/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools \.anchor:has\(#modebtn\)\{ order:2; \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.col::after\{ background:var\(--approved-canvas\); \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.promptline #send\{[^}]*width:36px; height:36px;[^}]*border-radius:50%;[^}]*background:#202124/s);
  assert.match(ui, /body\.composer-simple \.composer-wrap\{/);
});

test("touching top navigation once opens it without hover toggling it closed", () => {
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("pointerenter",\(event\)=>\{\s*if\(event\.pointerType&&event\.pointerType!=="mouse"\) return;/);
  assert.match(ui, /\$\("panelToggle"\)\?\.addEventListener\("pointerenter",\(event\)=>\{\s*if\(event\.pointerType&&event\.pointerType!=="mouse"\) return;/);
  assert.match(ui, /accountRailButton\?\.addEventListener\("pointerenter",\(event\)=>\{\s*if\(event\.pointerType&&event\.pointerType!=="mouse"\) return;/);
});

test("composer sends with Enter and inserts a line with Shift Enter", () => {
  assert.match(ui, /let key=typeof event\.key==="string"\?event\.key:"";\s*if\(!key\)return parts\.join\("\+"\);/);
  assert.match(ui, /\{ id:"send_message", label:"Send message", keys:"Enter" \}/);
  assert.match(ui, /\{ id:"newline", label:"New line", keys:"Shift\+Enter" \}/);
  assert.match(ui, /if\(e\.isComposing\) return;/);
  assert.match(ui, /if\(shortcutActionFor\(e\)==="send_message"\)\{ e\.preventDefault\(\); sendMessage\(\); \}/);
});

test("native browser overflow menu reserves space above the page WebView", () => {
  assert.match(shell, /const int ChromeMenuHeight = 548;/);
  assert.match(shell, /bool _chromeMenuOpen;/);
  assert.match(shell, /int desiredHeight = _chromeMenuOpen[\s\S]*?ChromeMenuHeight/);
  assert.match(shell, /_content\.Bounds = new Rectangle\([\s\S]*?r\.Top \+ normalHeight/);
  assert.match(shell, /_chromeView\.BringToFront\(\);/);
  assert.match(shell, /_chromeView\.DefaultBackgroundColor = Color\.Transparent/);
  assert.match(shell, /case "menuLayout":[\s\S]*?LayoutBrowserPane\(\);/);
  assert.match(shell, /_chromeView\.Leave \+= \(_, __\) => CloseChromeMenu\(\);/);
  assert.match(server, /max-height:calc\(100vh - 86px\);overflow-y:auto/);
  assert.match(server, /html,body\{margin:0;height:100%;overflow:hidden;background:transparent\}/);
  assert.match(server, /\.bar\{display:flex;flex-direction:column;height:116px;background:var\(--bg\)\}/);
  assert.match(server, /r\.style\.colorScheme = dark \? "dark" : "light"/);
  assert.match(server, /act\("menuLayout",\{open:v\}\)/);
  assert.match(server, /e\.key==="Escape"&&open/);
  assert.match(server, /e\.data\.type==="dismissMenu"/);
});

test("native browser opens at its final split width without an intermediate jump", () => {
  assert.match(shell, /bool _fittingBrowserSplit;/);
  assert.match(shell, /if \(_fittingBrowserSplit \|\| _split\.Width <= 0\) return;/);
  assert.match(shell, /_fittingBrowserSplit = true;[\s\S]*?finally\s*\{\s*_fittingBrowserSplit = false;/);
  assert.match(shell, /_split\.SuspendLayout\(\);[\s\S]*?_split\.Panel2Collapsed = false;[\s\S]*?FitBrowserSplit\(\);[\s\S]*?_split\.ResumeLayout\(true\);/);
  assert.doesNotMatch(shell, /BeginInvoke\(new Action\(FitBrowserSplit\)\); \/\/ fit after the layout settles/);
});

test("approved chat styling expands AI responses on the surface and keeps user messages bubbled", () => {
  assert.match(ui, /--app-fs:14px!important; --chat-fs:12px!important;/);
  assert.match(ui, /main,body\.shell main\{[\s\S]*?background:var\(--approved-canvas\); border:0; border-radius:0; box-shadow:none;/);
  assert.match(ui, /\/\* Seamless chat: header, transcript, and composer share one quiet surface\. \*\/\s*#chat\{[\s\S]*?border:0;[\s\S]*?border-radius:0; background:var\(--approved-canvas\); box-shadow:none;/);
  assert.match(ui, /\.col\{ width:100%; max-width:none; gap:8px; background:var\(--approved-canvas\); \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-wrap\{[\s\S]*?background:var\(--approved-card\); box-shadow:0 3px 12px/);
  assert.match(ui, /\.workspace-tabs\{[\s\S]*?border-bottom:1px solid var\(--border\); background:transparent;/);
  assert.match(ui, /\.msg-user,body\.win-lg \.msg-user\{ max-width:min\(78%,720px\); \}/);
  assert.match(ui, /\.msg-ai,body\.win-lg \.msg-ai\{\s*align-self:stretch; width:100%; max-width:100%;/);
  assert.match(ui, /\.msg-ai \.body,\.msg-ai\.cloud \.body\{[\s\S]*?--msg-fill:transparent; width:100%; max-width:none; padding:0 2px 4px;[\s\S]*?background:transparent; border:0; border-radius:0;/);
  assert.match(ui, /\.msg-user \.body\{[\s\S]*?--msg-fill:#0a84d8; color:#fff;[\s\S]*?border-radius:12px 12px 4px 12px;/);
  assert.match(ui, /\.stream-caret\{[\s\S]*?animation:streamCaret \.8s steps\(1,end\) infinite;/);
});

test("local replies are borderless while local and cloud sends use distinct bubbles", () => {
  assert.match(ui, /\.msg-ai:not\(\.cloud\) \.body\{ --msg-fill:transparent; border:0; box-shadow:none; \}/);
  assert.match(ui, /\.msg-ai:not\(\.cloud\) \.body:after\{ display:none; \}/);
  assert.match(ui, /\.msg-user\.local \.body\{ --msg-fill:var\(--local-user-bubble\); color:var\(--local-user-text\); \}/);
  assert.match(ui, /\.msg-user\.cloud \.body\{ --msg-fill:var\(--cloud-user-bubble\); color:var\(--cloud-user-text\); \}/);
  assert.match(ui, /--cloud-user-bubble:#2f7fd3; --cloud-user-text:#ffffff;/);
  assert.match(ui, /function addUser\([^)]*provider=state\.provider\|\|"local"[\s\S]*?d\.className="msg-user "\+\(cloud\?"cloud":"local"\)/);
  assert.match(ui, /const provider=e\.provider\|\|\(nextAi\?\.provider\|\|"local"\);/);
});

test("narrow chat renders compact scrollable markdown tables", () => {
  assert.match(ui, /body\.chat-compact\{ --chat-fs:10\.75px!important; --col-gap:4px; \}/);
  assert.match(ui, /\.md-table-wrap\{[^}]*overflow-x:auto;[^}]*border:1px solid var\(--border\);/s);
  assert.match(ui, /const tableDivider=\(line\)=>tableCells\(line\)\.length>1&&tableCells\(line\)\.every\(cell=>\/\^:\?-\{3,\}:\?\$\/\.test\(cell\)\);/);
  assert.match(ui, /html\+='<div class="md-table-wrap"><table class="md-table"><thead><tr>'/);
});

test("message metadata and actions appear on mouse hover and selected touch messages", () => {
  assert.match(ui, /\.msg-foot\{[^}]*min-height:18px;[^}]*max-height:24px;[^}]*opacity:0; visibility:hidden; pointer-events:none;/s);
  assert.match(ui, /\.msg-user\.message-controls-open \.msg-foot,\.msg-ai\.message-controls-open \.msg-foot,[^{]*\{[^}]*visibility:visible; pointer-events:auto;/s);
  assert.match(ui, /@media \(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\.msg-user:hover \.msg-foot,\.msg-ai:hover \.msg-foot\{[^}]*visibility:visible; pointer-events:auto;/);
  assert.match(ui, /\.uact\{ width:17px; height:17px;/);
  assert.match(ui, /\.msg-foot \.actbtn\{[^}]*width:17px; height:17px;/);
  assert.match(ui, /\.msg-copy\{[^}]*width:17px; height:17px;/);
  assert.match(ui, /d\.tabIndex=0; d\.setAttribute\("aria-expanded","false"\);/);
  assert.match(ui, /function toggleMessageControls\(msg,force\)\{[\s\S]*?col\.querySelectorAll\("\.msg-user\.message-controls-open,\.msg-ai\.message-controls-open"\)[\s\S]*?msg\.classList\.toggle\("message-controls-open",open\);/);
  assert.match(ui, /if\(message&&!e\.target\.closest\("a,button,input,textarea,select,summary"\)\)\{\s*toggleMessageControls\(message\);/);
  assert.match(ui, /col\.addEventListener\("keydown",\(e\)=>\{[\s\S]*?toggleMessageControls\(e\.target\);/);
});

test("AI responses offer neutral local helpful and correction feedback", () => {
  assert.match(ui, /data-act="feedback-up"[^>]*title="Helpful"/);
  assert.match(ui, /data-act="feedback-down"[^>]*title="Not helpful or incorrect"/);
  assert.match(ui, /\.msg-foot \.response-feedback\{ color:var\(--dim\); opacity:\.72; \}/);
  assert.match(ui, /fetch\("\/api\/preferences\/feedback"/);
  assert.match(ui, /This feedback stays on this PC\./);
  assert.doesNotMatch(ui, /\.response-feedback[^}]*#[0-9a-f]{3,8}/i);
});

test("local chats hide token counts and reserve the message action row", () => {
  assert.match(ui, /body:not\(\.online-mode\) \.msg-foot \.usage-inline\{ display:none; \}/);
  assert.match(ui, /\.msg-foot\{[^}]*min-height:18px;[^}]*max-height:24px;[^}]*margin-top:1px;[^}]*transition:opacity \.12s;/);
  assert.doesNotMatch(ui, /\.msg-user:hover \.msg-foot,[^{]+\{[^}]*min-height:/);
});

test("cloud API setup pastes keys and reports verified connection progress", () => {
  assert.match(ui, /class="api-key-icon paste"[^>]*title="Paste API key"[^>]*aria-label="Paste API key"/);
  assert.doesNotMatch(ui, /class="api-key-icon copy"[^>]*title="Copy key"/);
  assert.doesNotMatch(ui, /class="api-key-icon eye"[^>]*title="Show key"/);
  assert.match(ui, /fetch\("\/api\/provider-test",\{method:"POST",body:JSON\.stringify\(\{provider:prov,key\}\)\}\)/);
  assert.match(ui, /setApiConnectionState\(form,"connecting","Connecting securely\.\.\."\)/);
  assert.match(ui, /setApiConnectionState\(form,"model-connecting","API key saved\. Loading models\.\.\."\)/);
  assert.match(ui, /await verifyApiProviderModels\(prov\)/);
  assert.match(ui, /setApiConnectionState\(form,"error","API key saved, but models could not load"\)/);
  assert.match(ui, /\.api-step\.connecting i::after\{[^}]*position:absolute; left:50%; top:50%;[^}]*animation:apiConnectSpin \.9s linear infinite;/s);
  assert.match(ui, /@keyframes apiConnectSpin\{[\s\S]*?translate\(-50%,-50%\) rotate\(0deg\)[\s\S]*?translate\(-50%,-50%\) rotate\(360deg\)/);
  assert.match(ui, /\.api-connect-status\.success::before\{[^}]*width:11px; height:11px;/s);
  assert.match(ui, /\.api-focus-security::before\{[^}]*width:10px; height:10px;/s);
  assert.match(ui, /function showInlineApiModels\(form,prov,label,models\)/);
  assert.match(ui, /setApiConnectionState\(row,"model-connecting","Connecting "\+displayName\(model\)\+"\.\.\."\)/);
  assert.match(ui, /await waitForApiWizard\(Math\.max\(0,900-\(Date\.now\(\)-selectionStarted\)\)\)/);
  assert.match(ui, /setApiConnectionState\(row,"complete",label\+" connected"\)/);
  assert.match(ui, /done\.textContent=displayName\(model\)\+" is ready"/);
  assert.match(ui, /await waitForApiWizard\(950\);[\s\S]*?openApiProvider="";[\s\S]*?renderModelList\(""\)/);
  assert.match(ui, /\.api-inline-model-list \.api-model-row\{[^}]*width:100%;[^}]*border:0;[^}]*background:transparent;[^}]*text-align:left;/s);
  assert.match(ui, /if\(\$\("modelmenu"\)\?\.classList\.contains\("open"\)&&!apiWizardInline\) renderModelList\(""\)/);
  assert.match(ui, /if\(!hasKey\)\{\s*apiWizardInline=true;/);
  assert.doesNotMatch(ui, /await new Promise\(resolve=>setTimeout\(resolve,550\)\);\s*renderModelList/);
});

test("Markets closes the projects pane once on entry and signed-out accounts explain optional login", () => {
  assert.match(ui, /const enteringMarkets=ws==="markets"&&ws!==activeWsTab;/);
  assert.match(ui, /if\(enteringMarkets&&!document\.body\.classList\.contains\("collapsed"\)\)\{[\s\S]*?classList\.add\("collapsed"\)[\s\S]*?sidebarManualState=true;[\s\S]*?syncPanelButtons\(\);/);
  assert.doesNotMatch(ui, /body\.markets-open[^}]*#sidebar[^}]*display:none/);
  assert.match(ui, /id="accountAuthNote">Optional — Boollm works without an account\. Your data stays local on this PC\.<\/div>/);
  assert.match(ui, /id="accountAuthText">Sign in or sign up<\/span>/);
  assert.match(ui, /if\(auth\) auth\.textContent=cloud\.signedIn\?"Log out":"Sign in or sign up";/);
  assert.match(ui, /if\(authNote\) authNote\.hidden=!!cloud\.signedIn;/);
});

test("Education closes Projects and Chats when the workspace opens", () => {
  assert.match(ui, /const enteringEducation=ws==="education"&&ws!==activeWsTab;/);
  assert.match(ui, /if\(enteringEducation&&!document\.body\.classList\.contains\("collapsed"\)\)\{[\s\S]*?educationSidebarAutoClosed=true;[\s\S]*?classList\.add\("collapsed"\)[\s\S]*?classList\.remove\("sidebar-popover-open"\)[\s\S]*?syncPanelButtons\(\);/);
  assert.match(ui, /sidebarOpen:educationSidebarAutoClosed\?true:!document\.body\.classList\.contains\("collapsed"\)/);
  assert.match(ui, /else if \(ws === "education"\) \{[\s\S]*?educationSidebarAutoClosed=false;scheduleResponsiveClasses\(\); \}/);
});

test("Markets dark mode uses the shared Boollm canvas and card blacks", () => {
  assert.match(ui, /body\.markets-open \.markets-shell\{\s*--market-bg:var\(--approved-canvas\);\s*--market-card:var\(--approved-card\);\s*--market-card-2:var\(--card\);/);
  assert.match(ui, /body\.markets-open \.workspace-tabs,[\s\S]*?body\.markets-open \.market-bottom-tape\{\s*background:var\(--approved-canvas\);/);
  assert.match(ui, /body\.markets-open \.market-watch,[\s\S]*?body\.markets-open \.market-ai-summary\{\s*background:var\(--approved-card\);/);
});

test("Education offers saved practice exams with both feedback modes and topic results", () => {
  assert.match(ui, /id="educationWorkspaceTab"[^>]*data-workspace-page="education"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(ui, /const educationExams=\{/);
  for (const exam of ["SHSAT","TACHS","HSPT","ISEE","SSAT","Regents","SAT","ACT","IQ reasoning practice"]) {
    assert.match(ui, new RegExp(exam));
  }
  assert.match(ui, /<option value="each">After each question<\/option><option value="end">After the full test<\/option>/);
  assert.match(ui, /id="educationGrade"/);
  assert.match(ui, /sat:\[11,12\]/);
  assert.match(ui, /const EDUCATION_SAVE_KEY="boollmEducationPracticeV1"/);
  assert.match(ui, /function educationShowResults\(\)/);
  assert.match(ui, /Questions in Boollm are newly generated practice items, not copied secure test questions/);
  assert.match(ui, /body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{ display:block!important; \}/);
});

test("Education uses the compact four-step exam workbench", () => {
  assert.match(ui,/id="educationSteps" aria-label="Practice steps"/);
  for(const [step,label] of [["choose","Choose exam"],["options","Set options"],["practice","Practice"],["results","Results"]]){
    assert.match(ui,new RegExp(`data-education-step="${step}"[\\s\\S]*?>${label}<`));
  }
  assert.match(ui,/class="education-exam-list" id="educationExamList" role="listbox"/);
  assert.match(ui,/class="education-selected-exam" id="educationSelectedExam"/);
  assert.equal((ui.match(/id="educationExam"/g)||[]).length,1);
  assert.match(ui,/\.education-workbench\{[^}]*grid-template-columns:126px minmax\(0,1fr\);/s);
  assert.match(ui,/#educationSetup\.education-setup-flat\{[^}]*grid-template-columns:minmax\(220px,\.85fr\) minmax\(300px,1\.15fr\);[^}]*border:0;/s);
  assert.match(ui,/\.education-exam-column,\.education-detail-column\{[^}]*overflow-y:auto;/s);
  assert.match(ui,/function educationRenderExamList\(\)[\s\S]*?Array\.from\(select\.options\)[\s\S]*?data-education-exam/);
  assert.match(ui,/select\.value=button\.dataset\.educationExam;[\s\S]*?educationSyncReleasedOptions\(\);[\s\S]*?educationSetStep\("options"\);[\s\S]*?educationRenderSetup\(\)/);
  assert.match(ui,/function educationShowSession\(\)\{[\s\S]*?educationSetStep\("practice"\)/);
  assert.match(ui,/function educationShowResults\(\)\{[\s\S]*?educationSetStep\("results"\)/);
});

test("Explore uses the top icon instead of a text workspace link", () => {
  const navStart=ui.indexOf('<div class="workspace-tabs" id="workspaceTabs">');
  const navEnd=ui.indexOf("</div>",navStart);
  const nav=ui.slice(navStart,navEnd);
  assert.ok(navStart>=0&&navEnd>navStart,"main workspace navigation should exist");
  assert.doesNotMatch(nav,/id="exploreWorkspaceTab"|data-ws="explore"/);
  assert.match(ui,/id="exploreToggle"[^>]*aria-label="Toggle Explore"/);
  assert.doesNotMatch(nav,/data-ws="education"|data-ws="markets"|data-ws="recipes"/);
  assert.doesNotMatch(nav,/id="educationWorkspaceTab"|id="marketsWorkspaceTab"|id="recipesWorkspaceTab"/);
});

test("Explore pages share internal tabs in one flat workspace header", () => {
  for (const id of ["workspaceFloatBar","workspaceFloatTabs","workspaceFloatTheme","workspaceFloatExpand","workspaceFloatClose"]) {
    assert.equal((ui.match(new RegExp(`id="${id}"`,"g"))||[]).length,1,`${id} should exist once in the shared workspace chrome`);
  }
  const headerStart=ui.indexOf('id="workspaceFloatBar"');
  const headerEnd=ui.indexOf("</header>",headerStart);
  const contentStart=ui.indexOf('class="workspace-float-content"',headerEnd);
  const header=ui.slice(headerStart,headerEnd);
  assert.ok(headerStart>=0&&headerEnd>headerStart&&contentStart>headerEnd,"shared chrome should precede the flat page content");
  let previous=-1;
  for (const id of ["workspaceFloatTabs","workspaceFloatTheme","workspaceFloatExpand","workspaceFloatClose"]) {
    const next=header.indexOf(`id="${id}"`);
    assert.ok(next>previous,`${id} should keep the approved shared-header order`);
    previous=next;
  }
  const tabsStart=header.indexOf('id="workspaceFloatTabs"');
  const tabsEnd=header.indexOf("</nav>",tabsStart);
  const tabs=header.slice(tabsStart,tabsEnd);
  let tabPrevious=-1;
  for(const page of ["web","markets","education","recipes","sales","library"]){
    const next=tabs.indexOf(`data-workspace-page="${page}"`);
    assert.ok(next>tabPrevious,`${page} should remain in the approved internal-tab order`);
    tabPrevious=next;
  }
  assert.equal((tabs.match(/data-workspace-page="/g)||[]).length,7,"the Explore pane should expose exactly seven page tabs");
  const initializeWorkspace=ui.slice(ui.indexOf("function initializeWorkspaceFloat"),ui.indexOf("initializeWorkspaceFloat();"));
  assert.match(initializeWorkspace,/\$\("workspaceFloatTabs"\)\?\.addEventListener\("click",event=>\{/);
  assert.match(initializeWorkspace,/const tab=event\.target\.closest\("\[data-workspace-page\]"\)/);
  assert.match(initializeWorkspace,/const page=tab\.dataset\.workspacePage/);
  assert.match(initializeWorkspace,/setWorkspaceTab\((?:page|tab\.dataset\.workspacePage)\)/,"the internal tabs should activate their existing workspace pages");
  const showWorkspace=ui.slice(ui.indexOf("function showWorkspaceFloat"),ui.indexOf("function beginWorkspaceLayoutSwitch"));
  assert.match(showWorkspace,/\$\("workspaceFloatTabs"\)\?\.querySelectorAll\("\[data-workspace-page\]"\)/);
  assert.match(showWorkspace,/tab\.classList\.toggle\("active",active\)/);
  assert.match(showWorkspace,/tab\.setAttribute\("aria-selected",String\(active\)\)/);
  assert.match(ui,/\.workspace-float\{[^}]*border-radius:18px;/s);
  assert.match(ui,/\.workspace-float-bar\{[^}]*flex:0 0 26px;[^}]*min-height:26px;[^}]*border-bottom:0;[^}]*background:var\(--approved-card,var\(--card\)\);/s);
  assert.match(ui,/\.workspace-float-page-tab\{[^}]*height:20px;[^}]*font:600 9px\/1\.2 var\(--ui\);/s);
  assert.match(ui,/\.workspace-float-page-tab\.active\{[^}]*border-color:transparent; background:var\(--hover\); color:var\(--text\);[^}]*box-shadow:none;/s);
  assert.match(ui,/id="workspaceFloatTheme"[^>]*>&#x263E;<\/button>/);
  assert.match(ui,/\.workspace-float-actions button\{[^}]*width:26px; height:26px;[^}]*font:15px\/1 "Segoe UI Symbol"/s);
  assert.match(ui,/\.workspace-float-content\{[^}]*padding:0;[^}]*overflow:hidden;[^}]*background:var\(--approved-card,var\(--card\)\);/s);
  assert.match(ui,/\.workspace-float \.education-panel,\.workspace-float \.markets-panel,\.workspace-float \.recipes-panel\{[^}]*margin:0;[^}]*padding:0!important;[^}]*border:0!important;[^}]*border-radius:0!important;[^}]*box-shadow:none!important;/s);
  assert.match(ui,/\.workspace-float \.education-shell,\.workspace-float \.recipes-shell\{[^}]*width:100%; height:100%;[^}]*margin:0; border:0; border-radius:0;[^}]*box-shadow:none;/s);
  assert.match(ui,/\.workspace-float \.markets-shell\.market-flat\{[^}]*margin:0;[^}]*border:0; border-radius:0;[^}]*box-shadow:none;/s);
  assert.match(ui,/#educationSetup\.education-setup-flat\{[^}]*border:0!important;[^}]*border-radius:0!important;[^}]*background:transparent!important;[^}]*box-shadow:none!important;/s);
  assert.match(ui,/\.recipes-shell\{[^}]*width:100%; height:100%;[^}]*margin:0;[^}]*gap:0;[^}]*overflow:hidden;/s);
  assert.match(ui,/\.recipes-category-rail,\.recipes-main,\.recipes-detail\{[^}]*background:transparent;/s);
  assert.match(ui,/\.recipe-card\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(showWorkspace,/frame\.dataset\.workspace=ws/);
});

test("Education, Markets, and Recipes open in a shared floating resizable workspace while Browser stays unchanged", () => {
  assert.match(ui, /class="workspace-float" id="workspaceFloat" role="dialog"/);
  const floatContentIndex=ui.indexOf('class="workspace-float-content"');
  const recipesPanelIndex=ui.indexOf('id="recipesPanel"');
  const resizeHandleIndex=ui.indexOf('data-workspace-resize="w"');
  assert.ok(floatContentIndex>=0&&recipesPanelIndex>floatContentIndex&&recipesPanelIndex<resizeHandleIndex);
  assert.match(ui, /id="workspaceFloatBar"/);
  assert.match(ui, /id="workspaceFloatTheme"[^>]*aria-label="Switch workspace to dark mode"/);
  assert.match(ui, /id="workspaceFloatExpand"[^>]*aria-label="Expand workspace"/);
  assert.match(ui, /id="workspaceFloatClose"[^>]*aria-label="Close workspace"/);
  assert.match(ui, /const WORKSPACE_THEME_KEY="booleanWorkspaceThemeV1"/);
  assert.match(ui, /function applyWorkspaceTheme\(theme,\{save=false\}=\{\}\)/);
  assert.match(ui, /theme\.onclick=\(\)=>\{[\s\S]*?applyWorkspaceTheme\(frame\.dataset\.workspaceTheme==="dark"\?"light":"dark",\{save:true\}\)/);
  assert.match(ui, /data-workspace-resize="w"/);
  for (const edge of ["n","e","s","ne","se","sw","nw"]) assert.doesNotMatch(ui, new RegExp(`data-workspace-resize="${edge}"`));
  assert.match(ui, /body\.education-open \.workspace-float,body\.markets-open \.workspace-float,body\.recipes-open \.workspace-float,body\.library-open \.workspace-float,body\.studio-open \.workspace-float\{ display:flex; \}/);
  assert.match(ui, /\.workspace-float \.education-panel,\.workspace-float \.markets-panel,\.workspace-float \.recipes-panel\{[^}]*width:100%; height:100%; min-height:0; margin:0;[^}]*box-sizing:border-box;/s);
  assert.match(ui, /body\.recipes-open \.workspace-float \.recipes-panel\{ display:flex; \}/);
  assert.match(ui, /\.workspace-float\.maximized\{ inset:78px 8px var\(--approved-bottom-gap\) 44px!important;/);
  assert.match(ui, /const WORKSPACE_FLOAT_KEY="booleanWorkspaceDockWidthV4"/);
  assert.match(ui, /function constrainWorkspaceFloatWidth\(/);
  assert.match(ui, /top:78px; right:8px; bottom:var\(--approved-bottom-gap\)/);
  assert.match(ui, /function setWorkspaceFloatMaximized\(/);
  assert.match(ui, /function showWorkspaceFloat\(ws\)/);
  assert.match(ui, /if\(frame\.classList\.contains\("maximized"\)\)syncWorkspaceChatReservation\(\);\s*else restoreWorkspaceFloatWidth\(\);/);
  assert.match(ui, /window\.addEventListener\("resize",\(\)=>\{[\s\S]*?!EXPLORE_WORKSPACES\.includes\(activeWsTab\)\)return;/);
  assert.match(ui, /<span class="workspace-window-beta"[^>]*>Beta<\/span>/);
  assert.doesNotMatch(ui, /class="workspace-float-page-tab"[^>]*>[\s\S]*?<span class="workspace-beta">Beta<\/span><\/button>/);
  assert.doesNotMatch(ui, /class="sidebar-nav-beta">Beta<\/span>/);
  assert.match(ui, /id="salesQuery"[^>]*inputmode="url"/);
  assert.match(ui, /id="salesDraft"/);
  assert.match(ui, /data-sales-mode="website"[\s\S]*data-sales-mode="describe"[\s\S]*data-sales-mode="upload"/);
  assert.match(ui, /data-sales-signal="Hiring"[\s\S]*data-sales-signal="Recently funded"[\s\S]*data-sales-signal="Tech change"/);
  assert.match(ui, /Company \| Verification \| Fit score \| Why it fits \| Active buying signal \| Evidence URL \| Checked/);
  assert.match(ui, /id="salesProgress"[^>]*aria-live="polite"/);
  assert.match(ui, /data-sales-step="0"[\s\S]*data-sales-step="4"/);
  assert.match(ui, /id="salesResultsBody"/);
  assert.match(ui, /id="salesSavePlan"[^>]*>Save plan<\/button>/);
  assert.match(ui, /id="salesRemovePlan"[^>]*>Remove<\/button>/);
  assert.match(ui, /id="salesPlanList"/);
  for(const action of ["open","redo","rename","delete"])assert.match(ui,new RegExp(`data-sales-${action}`));
  assert.match(ui, /data-sales-pdf/);
  assert.match(ui, /Open plan PDF/);
  assert.match(ui, /form\.method="POST";form\.action="\/api\/sales\/plan-pdf";form\.target="_blank"/);
  assert.match(ui, /document\.body\.appendChild\(form\);form\.submit\(\);form\.remove\(\)/);
  assert.match(ui, /data-sales-copy/);
  assert.match(ui, /writeClipboardText\(String\(plan\.result\|\|""\)\.trim\(\)\)/);
  for(const label of ["Open plan","Open plan PDF","Copy plan","Redo plan","Rename plan","Delete plan"])assert.match(ui,new RegExp(`aria-label="${label}"`));
  assert.match(ui, /class="sales-plan-icon"/);
  assert.match(ui, /const SALES_PLANS_KEY="booleanSalesPlansV1"/);
  assert.match(ui, /function salesResultStates\(answer\)/);
  assert.match(ui, /const sections=salesResultSections\(text\)/);
  assert.match(ui, /understand\?"done":text\?"blocked":""/);
  assert.match(ui, /function salesResultSections\(answer\)/);
  assert.match(ui, /\(\?:SALES_\)\?STAGE/);
  assert.match(ui, /function salesResearchEvidence\(section\)/);
  assert.match(ui, /prospectRows\.every\(row=>\/\\bverified\\b\/i\.test\(row\)/);
  assert.match(ui, /urls\.length>=prospectRows\.length&&checked&&!limited/);
  assert.match(ui, /const hasOutreach=hasResearch&&salesSubstantive\(sections\[3\]\)/);
  assert.match(ui, /const hasApproval=hasOutreach&&salesSubstantive\(sections\[4\]\)/);
  assert.match(ui, /Template only — verified prospect required/);
  assert.match(ui, /Approval blocked — verify at least one prospect/);
  assert.match(ui, /Reserve at least 6 calls for prospect verification/);
  assert.match(ui, /function renderSalesOutreach\(text\)/);
  assert.match(ui, /Touch\\s\*\\d\+/);
  assert.match(ui, /data-sales-email-copy/);
  assert.match(ui, /data-sales-email-share/);
  assert.match(ui, /data-sales-email-draft/);
  assert.match(ui, /data-sales-recipient/);
  assert.match(ui, /fetch\("\/api\/email\/draft"/);
  for(const mode of ["single","multiple","csv"])assert.match(ui,new RegExp(`data-sales-recipient-mode="${mode}"`));
  assert.match(ui, /function salesCsvRows\(text\)/);
  assert.match(ui, /function salesValidRecipients\(rows\)/);
  assert.match(ui, /data-sales-attachment-file/);
  assert.match(ui, /data-sales-inline-image/);
  assert.match(ui, /fetch\("\/api\/email\/batch-drafts"/);
  assert.match(ui, /shareChatText\(text\)/);
  assert.match(ui, /class="sales-email-fields"/);
  assert.match(ui, /data-sales-placeholder/);
  assert.match(ui, /salesResultsBody"\)\?\.addEventListener\("input"/);
  assert.match(ui, /const hasOutreach=hasResearch&&salesSubstantive\(sections\[3\]\)/);
  assert.match(ui, /Research limited/);
  assert.match(ui, /function renderSalesClearSummary\(text,index\)/);
  assert.match(ui, /sales-clear-list/);
  assert.match(ui, /Make stages 1 and 2 direct and easy to scan/);
  assert.match(ui, /function renderSalesResearchSummary\(text\)/);
  assert.match(ui, /View full research details/);
  assert.match(ui, /no more than 5 short bullets/);
  assert.match(ui, /function salesNonSelling\(text\)/);
  assert.match(ui, /Sales readiness: Not currently selling/);
  for(const action of ["partner","similar","new"])assert.match(ui,new RegExp(`data-sales-alt="${action}"`));
  assert.match(ui, /function renderSalesPlanBody\(\)/);
  assert.match(ui, /sales-plan-section/);
  assert.match(ui, /sales-email-card/);
  assert.match(ui, /hasOutreach\?"done":text\?"blocked":""/);
  assert.match(ui, /Plan incomplete — the company was not understood/);
  assert.match(ui, /data-sales-retry-current/);
  assert.match(ui, /hasApproval\?"done":text\?"blocked":""/);
  assert.match(ui, /saveCurrentSalesPlan\(\{automatic:true\}\)/);
  assert.match(ui, /function clearCurrentSalesPlan\(\)/);
  assert.match(ui, /Open a folder or create a project first/i);
  assert.match(ui, /if\(opts\.salesWorkflow\)body\.salesWorkflow=true/);
  assert.match(server, /forceNoArtifact: body\.salesWorkflow === true/);
  assert.match(server, /salesWorkflow: body\.salesWorkflow === true/);
  assert.match(server, /salesWorkflow: options\.salesWorkflow === true/);
  assert.match(agent, /forceChat \|\| ctx\.forceNoArtifact === true \? false : requiresArtifactAction\(messages\)/);
  assert.match(agent, /const SALES_RESEARCH_TOTAL_LIMIT = 8/);
  assert.match(agent, /const SALES_RESEARCH_FAILURE_LIMIT = 2/);
  assert.match(agent, /const SALES_PRIMARY_EVIDENCE_CONTRADICTION/);
  assert.match(agent, /const SALES_PLAN_SECTION/);
  assert.match(agent, /ctx\.salesWorkflow === true && SALES_RESEARCH_TOOL_NAMES\.has\(name\)/);
  assert.match(agent, /Do not call another research or browser tool/);
  assert.match(agent, /EVIDENCE CONSISTENCY CHECK FAILED/);
  assert.match(agent, /salesPlanSections\.size < 5/);
  assert.match(agent, /correcting the plan against verified website evidence/);
  assert.match(ui, /at most 12 research or browser tool calls and finish within 5 minutes/);
  assert.match(ui, /if\(\(mode==="chat"\|\|mode==="compare"\)&&!opts\.salesWorkflow&&!opts\.workflowRun\)/);
  assert.match(ui, /const salesBackground=run\.request\?\.salesWorkflow===true/);
  assert.match(ui, /const workspaceBackground=salesBackground\|\|workflowBackground/);
  assert.match(ui, /if\(showing&&!workspaceBackground\) scheduleStreamPaint\(\)/);
  assert.match(ui, /if\(showing&&!workspaceBackground\)\{\s*insertToolAbove\(ev\.entry\)/);
  assert.match(ui, /function salesWorkflowEvent\(ev\)/);
  assert.match(ui, /function salesLiveCheckpoint\(note\)/);
  assert.match(ui, /function salesPrimaryEvidenceCheckpoint\(entry\)/);
  assert.match(ui, /SALES_STAGE_\(\[1-5\]\)/);
  assert.match(ui, /salesLiveCheckpoint\(ev\.stepArgs\?\.note/);
  assert.match(ui, /const statusLabels=\["Understanding the offer","Defining the target","Researching companies","Drafting outreach","Preparing approval"\]/);
  assert.match(ui, /if\(viewingRun\(\)\)ensureStatusEl\(\)/);
  assert.match(server, /options\.salesWorkflow === true \|\| options\.workflowRun === true\) \? \{ stepArgs: step\.args \|\| \{\} \}/);
  assert.match(ui, /async function newChat\(options=\{\}\)\{\s*const preserveWorkspace=options\?\.preserveWorkspace===true;[\s\S]*?if\(!preserveWorkspace\)closeConversationPanels\(\);[\s\S]*?return threadId;/);
  assert.match(ui, /\$\("salesDraft"\)\?\.addEventListener\("click",async\(\)=>\{[\s\S]*?await newChat\(\{preserveWorkspace:true\}\);[\s\S]*?if\(activeWsTab!=="sales"\)markWorkspaceTab\("sales"\);/);
  assert.match(ui, /startRun\(threadId,\{mode:"chat",[\s\S]*?salesWorkflow:true\}\)/);
  assert.match(ui, /if\(!workspaceBackground\)aiNavigate\(ev\.url\)/);
  assert.match(ui, /results\.classList\.toggle\("visible",salesWorkflow\.running\|\|!!salesWorkflow\.result\)/);
  assert.doesNotMatch(ui, /Prospect plan loaded into Chat/);
  assert.match(ui, /\.sales-panel\{[^}]*height:100%;[^}]*overflow-x:hidden; overflow-y:auto;[^}]*scrollbar-gutter:stable;/s);
  assert.match(ui, /\.sales-shell\{[^}]*width:min\(1180px,100%\);[^}]*margin:0 auto;[^}]*padding:24px 28px 36px;[^}]*flex:0 0 auto;/s);
  assert.match(ui, /applyWorkspaceFloatWidth\(saved\|\|innerWidth\)/);
  assert.match(ui, /right:narrow\?4:\(notesDocked\?Math\.round\(noteWidth\)\+17:8\),bottom:4/);
  assert.match(ui, /\.workspace-float\{[^}]*min-width:0; min-height:0;/s);
  assert.match(ui, /if\(innerWidth<=760\)return Math\.max\(0,innerWidth-bounds\.left-bounds\.right\)/);
  assert.match(ui, /const mainLeft=document\.querySelector\("main"\)\?\.getBoundingClientRect\(\)\.left\|\|bounds\.left;/);
  assert.match(ui, /const minChatWidth=Math\.min\(380,Math\.max\(220,Math\.round\(available\*\.32\)\)\);/);
  assert.match(ui, /const maxWidth=Math\.max\(0,available-chatGap-minChatWidth\);/);
  assert.match(ui, /const minWidth=Math\.min\(60,maxWidth\);/);
  assert.match(ui, /frame\.classList\.toggle\("compact-strip",nextWidth<150\)/);
  assert.match(ui, /\.workspace-float\.compact-strip:not\(\.maximized\) \.workspace-float-bar\{ justify-content:flex-end; padding-left:22px; \}/);
  assert.match(ui, /\.workspace-float\.compact-strip:not\(\.maximized\) \.workspace-float-tabs,[\s\S]*?#workspaceFloatExpand\{ display:none; \}/);
  assert.match(ui, /\.workspace-float\.compact-strip:not\(\.maximized\) \.workspace-float-actions\{ flex:0 0 auto; \}/);
  assert.match(ui, /\.workspace-float\.compact-strip:not\(\.maximized\) \.workspace-float-content\{ visibility:hidden; pointer-events:none; \}/);
  assert.match(ui, /\.workspace-resize-handle\.w\{[\s\S]*?left:0;[\s\S]*?width:22px;[\s\S]*?cursor:ew-resize;/);
  assert.match(ui, /const mainLeft=document\.querySelector\("main"\)\?\.getBoundingClientRect\(\)\.left\|\|0;/);
  assert.match(ui, /function syncWorkspaceChatReservation\(\)/);
  assert.match(ui, /const chatWidth=Math\.max\(0,Math\.round\(rect\.left-mainLeft-12\)\);/);
  assert.match(ui, /style\.setProperty\("--workspace-chat-width",next\)/);
  assert.match(ui, /classList\.toggle\("workspace-chat-covered",covered\)/);
  assert.match(ui, /if\(frame\.classList\.contains\("maximized"\)\)\{syncWorkspaceChatReservation\(\);return;\}/);
  assert.match(ui, /if\(innerWidth<500\|\|innerHeight<300\)\{workspaceLayoutSuspended=true;return;\}/);
  assert.match(ui, /if\(workspaceLayoutSuspended\)\{[\s\S]*?restoreWorkspaceFloatWidth\(\);[\s\S]*?scheduleResponsiveClasses\(\);/);
  assert.match(ui, /new ResizeObserver\(\(\)=>\{[\s\S]*?!EXPLORE_WORKSPACES\.includes\(activeWsTab\)[\s\S]*?else syncWorkspaceChatReservation\(\);/);
  assert.match(ui, /document\.addEventListener\("visibilitychange",\(\)=>\{[\s\S]*?restoreWorkspaceFloatWidth\(\);[\s\S]*?scheduleResponsiveClasses\(\);/);
  assert.match(ui, /function scheduleResponsiveClasses\(\)\{[\s\S]*?cancelAnimationFrame\(responsiveClassesFrame\);[\s\S]*?responsiveClassesFrame=requestAnimationFrame/);
  assert.match(ui, /new ResizeObserver\(scheduleResponsiveClasses\)\.observe\(document\.querySelector\("main"\)\)/);
  assert.match(ui, /function beginWorkspaceLayoutSwitch\(\)/);
  assert.match(ui, /body\.workspace-layout-switching aside,[\s\S]*?transition:none!important;/);
  assert.match(ui, /\.workspace-resize-handle\.w\{[\s\S]*?width:22px;[\s\S]*?cursor:ew-resize;/);
  assert.match(ui, /\.workspace-resize-handle\.w::after\{[\s\S]*?height:54px;[\s\S]*?opacity:\.45;/);
  assert.match(ui, /workspaceFloatGesture=\{startX:event\.clientX,width:rect\.width,pointerId:event\.pointerId,handle\}/);
  assert.match(ui, /queueWorkspaceFloatWidth\(drag\.width-\(event\.clientX-drag\.startX\)\)/);
  assert.doesNotMatch(ui, /handle\.onpointermove=/);
  assert.match(ui, /handle\.onpointercancel=finishResize/);
  assert.match(ui, /box-shadow:0 8px 28px rgba\(0,0,0,\.12\)/);
  assert.match(ui, /border-right:1px solid color-mix\(in srgb,var\(--border\) 72%,transparent\)/);
  assert.match(ui, /body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{[\s\S]*?width:var\(--workspace-chat-width,360px\)/);
  assert.match(ui, /body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{[^}]*overflow-x:hidden; overflow-y:auto; overscroll-behavior-y:contain;/s);
  assert.doesNotMatch(ui, /body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{[^}]*overflow:hidden;/s);
  assert.match(ui, /body\.workspace-chat-covered #chat,[\s\S]*?body\.workspace-chat-covered \.composer-wrap,[\s\S]*?visibility:hidden!important; pointer-events:none!important;/);
  assert.match(ui, /body\.education-open \.composer-wrap,body\.markets-open \.composer-wrap,[\s\S]*?body\.recipes-open \.composer-wrap,[\s\S]*?width:var\(--workspace-chat-width,360px\)/);
  assert.match(ui, /body\.education-open main::after,body\.markets-open main::after,body\.recipes-open main::after\{[\s\S]*?display:block!important; left:0; right:auto; width:var\(--workspace-chat-width,360px\);/);
  assert.doesNotMatch(ui, /body\.education-open main::after\{ display:none!important; \}/);
  assert.match(ui, /\.workspace-float\[data-workspace-theme="light"\]\{[\s\S]*?--approved-canvas:#f5f5f3; --approved-card:#fbfbfa;/);
  assert.match(ui, /\.workspace-float \.education-panel,\.workspace-float \.markets-panel,\.workspace-float \.recipes-panel\{[\s\S]*?background:var\(--approved-card,var\(--card\)\);/);
  assert.match(ui, /\.workspace-float \.recipes-shell,[\s\S]*?\.workspace-float \.recipe-actions\{ background:var\(--approved-card,var\(--card\)\); \}/);
  assert.match(ui, /id="workspaceFloatTheme"[^>]*>&#x263E;<\/button>/);
  assert.doesNotMatch(ui, /id="workspaceFloatMinimize"/);
  assert.match(ui, /\.workspace-float-actions button\{[^}]*width:26px; height:26px;[^}]*font:15px\/1 "Segoe UI Symbol"/s);
  assert.doesNotMatch(ui, /body\.recipes-open #chat,body\.recipes-open \.composer-wrap\{ display:none !important; \}/);
  assert.doesNotMatch(ui, /body\.composer-simple\.recipes-open \.composer-wrap\{ display:none !important; \}/);
  assert.match(ui, /close\.onclick=\(\)=>setWorkspaceTab\("chat"\)/);
  assert.match(ui, /else\{\s*document\.body\.classList\.remove\("workspace-chat-covered"\);\s*document\.body\.style\.removeProperty\("--workspace-chat-width"\);\s*scheduleResponsiveClasses\(\);/);
  assert.match(ui, /workspaceFloatGesture=\{startX:event\.clientX,width:rect\.width,pointerId:event\.pointerId,handle\}/);
  assert.doesNotMatch(ui, /workspaceFloatGesture=\{kind:"move"/);
  assert.match(ui, /if\(EXPLORE_WORKSPACES\.includes\(activeWsTab\)\)showWorkspaceFloat\(activeWsTab\)/);
  assert.match(ui, /id="workspaceFloatTabs"[^>]*role="tablist"[^>]*aria-label="Explore pages"/);
  assert.match(ui, /data-workspace-page="markets"[\s\S]*data-workspace-page="education"[\s\S]*data-workspace-page="recipes"[\s\S]*data-workspace-page="sales"/);
  assert.match(ui, /document\.body\.classList\.toggle\("recipes-open", activeWsTab === "recipes"\)/);
  const workspaceSetter=ui.slice(ui.indexOf("function setWorkspaceTab"),ui.indexOf('document.querySelectorAll(".ws-tab")'));
  assert.doesNotMatch(workspaceSetter, /requestAnimationFrame\(\(\)=>markWorkspaceTab\("chat"\)\)/);
  assert.match(ui,/function openExploreWorkspace\(page\)\{\s*if\(!adminFeatureAccessAllowed\(\)\)\{[\s\S]*?if\(!requested&&EXPLORE_WORKSPACES\.includes\(activeWsTab\)\)\{\s*setWorkspaceTab\("chat"\);\s*return;/);
  // A named Explore page (browser start screen, semantic action) must open that
  // page instead of toggling the window shut when it is already active.
  assert.match(ui,/const requested=EXPLORE_WORKSPACES\.includes\(page\)&&\(page!=="web"\|\|exploreHomeEnabled\(\)\)\?page:"";/);
  assert.match(ui,/setWorkspaceTab\(target,\{force:!!requested\}\);/);
  assert.match(ui,/\.icon-btn\[hidden\],#modemenu \.item\[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(ui, /body\.browser-on \.workspace-float/);
});

test("every Grade 7 practice supports a 250-question session", () => {
  assert.match(ui, /educationQuestionCounts=examId=>educationExamGrades\[examId\]\?\.includes\(7\)\?\[5,10,15,20,25,50,100,150,200,250\]/);
  for (const exam of ["grade7","iseeMiddle","ssatMiddle","hspt","iq"]) {
    assert.match(ui, new RegExp(`${exam}:\\{name:[^\\n]+up to 250 Boollm original questions per session`));
  }
  assert.match(ui, /teas:\{name:"ATI TEAS"/);
  assert.match(ui, /hesiA2:\{name:"HESI A2"/);
  assert.match(ui, /hspt:\[7,8\]/);
  assert.match(ui, /teas:\[12\],hesiA2:\[12\]/);
  assert.match(ui, /safeCount=allowed\.includes\(Number\(count\)\)\?Number\(count\):10/);
  assert.match(ui, /answers:Array\(safeCount\)\.fill\(null\)/);
});

test("Education stays compact, unfaded, and always has an exit", () => {
  assert.doesNotMatch(ui, /body\.education-open main::after\{ display:none!important; \}/);
  assert.match(ui, /body\.education-open main::after,body\.markets-open main::after,body\.recipes-open main::after\{[\s\S]*?display:block!important;/);
  assert.match(ui, /\.education-field\[hidden\]\{ display:none!important; \}/);
  assert.match(ui, /#educationExitTop\{ display:inline-flex; flex:0 0 auto; \}/);
  assert.match(ui, /function educationExitFromTop\(\)/);
  assert.match(ui, /\$\("educationExitTop"\)\.onclick=educationExitFromTop/);
  assert.match(ui, /body\.education-testing \.education-shell\{ height:100%; min-height:0; display:flex; flex-direction:column; \}/);
  assert.match(ui, /\.education-official\{ height:100%; min-height:0;/);
  assert.match(ui, /\.education-question-map\{ flex:1; min-height:48px; overflow:auto; display:grid; grid-template-columns:repeat\(7,1fr\)/);
});

test("project timelines stay hidden regardless of project binding", () => {
  assert.match(ui, /function shouldShowProjectPlan\(snapshot\) \{\s*return false;\s*\}/);
});

test("Explore Web keeps the chat transcript and composer visible", () => {
  assert.match(ui, /body\.web-open #chat,body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{ display:block!important; \}/);
  assert.match(ui, /body\.web-open \.composer-wrap,body\.education-open \.composer-wrap,body\.markets-open \.composer-wrap,body\.recipes-open \.composer-wrap\{ display:flex!important; \}/);
  assert.match(ui, /body\.web-open #chat,body\.education-open #chat,body\.markets-open #chat,body\.recipes-open #chat\{[\s\S]*?width:var\(--workspace-chat-width,360px\)/);
  assert.match(ui, /body\.web-open\.composer-simple \.composer-wrap/);
});

test("Projects and Chats uses the flat Codex-style navigation and list hierarchy", () => {
  assert.match(ui, /id="sidebarPrimary" aria-label="Primary navigation"/);
  for(const label of ["New chat","GitHub","Workflows","Scheduled","Agents"])
    assert.match(ui,new RegExp(`<span>${label}<\\/span>`));
  assert.match(ui, /--approved-sidebar-w:286px;/);
  assert.match(ui, /#sidebar \.thread-search-wrap,#sidebar \.pinned-list[^\n]*display:none!important;/);
  assert.match(ui, /#sidebar \.project-group-body\{ margin-left:0; padding:0 0 4px 25px; border-left:0; \}/);
  assert.match(ui, /#sidebar \.project-group-body \.thread::before\{ display:none; \}/);
  assert.match(ui, /#sidebar \.thread\.active,#sidebar \.project-group-body \.thread\.active\{[^}]*box-shadow:none;/);
  assert.match(ui, /document\.querySelectorAll\("#sidebarNavigation,#sidebarPrimary"\)/);
  assert.match(ui, /if\(action==="new-chat"\)\{ newChat\(\); return; \}/);
  assert.match(ui, /else if\(action==="plugins"\)\{ openSettings\("connectors"\); \}/);
});

test("pinned projects and chats use the compact grouped sidebar", () => {
  assert.match(ui,/projectHead\.className="grouphead project-section-head"/);
  assert.match(ui,/class="section-action project-add"[^>]*aria-label="New project">\+<\/button>/);
  assert.match(ui,/#sidebar \.grouphead \.section-action\{ order:initial; margin-left:0; color:var\(--text\); \}/);
  assert.match(ui,/projectHead\.querySelector\("\.project-add"\)\.onclick=.*createProject\(\)/);
  assert.match(ui,/\.project-section-head\{[^}]*border-top:1px solid var\(--border\);/);
  assert.match(ui,/class="thread-new-chat" id="threadNewChat" aria-label="Start a new chat"[\s\S]*?<rect x="3" y="3" width="18" height="18" rx="3"\/><path d="M12 8v8M8 12h8"\/>/);
  assert.match(ui,/async function newChat\(options=\{\}\)\{[\s\S]*?body:JSON\.stringify\(\{forceNew:true\}\)/);
  assert.match(ui,/\$\("threadNewChat"\)\.onclick=\(event\)=>\{[\s\S]*?newChat\(\)\.catch\(\(\)=>tempToast\("Could not start a fresh chat\."\)\)/);
  assert.match(ui, /\.project-accordion\{ border-top:1px solid var\(--border\); \}/);
  assert.match(ui, /\.project-group-head\{ display:flex; align-items:center; gap:7px;/);
  assert.match(ui, /\.project-group-body\{ position:relative; margin-left:11px;[\s\S]*?border-left:1px solid var\(--border\); \}/);
  assert.match(ui, /\.project-group-body \.thread::before\{[\s\S]*?border-bottom:1px solid var\(--border\);/);
  assert.match(ui, /head\.setAttribute\("aria-expanded",String\(open\)\)/);
  assert.match(ui, /<span class="project-identity">'[\s\S]*?<span class="project-folder">'[\s\S]*?<span class="project-title">'[\s\S]*?<span class="project-caret">'/);
  assert.match(ui, /open\?OPEN_FOLDER_SVG:FOLDER_SVG/);
  assert.doesNotMatch(ui, /<span class="project-tag">project<\/span>/);
  assert.doesNotMatch(ui, /<span class="project-when">/);
  assert.doesNotMatch(ui, /<span class="project-status" aria-label=/);
  assert.match(ui, /makeThreadRow\(t,\{projectChat:true,label:"Project chat"\}\)/);
  assert.match(ui,/const pinned=ts\.filter\(t=>t\.pinned\)/);
  assert.match(ui,/pinnedHead\.innerHTML='<span>Pinned<\/span>/);
  assert.match(ui,/makeThreadRow\(t,\{pinnedSection:true\}\)/);
  assert.match(ui,/chatHead\.innerHTML='<span>Recents<\/span>/);
  assert.match(ui,/threadGroups\.Chats=!chatsOpen/);
  assert.match(ui,/class=\"project-edit\" title=\"New chat in project\"/);
  assert.match(ui,/aria-label=\"New chat in '\+esc\(t\.title\)\+'\">\+<\/button>/);
  assert.match(ui,/async function newProjectChat\(project\)/);
  assert.match(ui,/JSON\.stringify\(\{projectId:project\.id,forceNew:true\}\)/);
  assert.match(ui,/parentProjectId===t\.id/);
  assert.match(ui,/Pin important chats for quick access\./);
  assert.match(ui,/const shown=personalChatsExpanded\?chats:chats\.slice\(0,THREAD_GROUP_LIMIT\)/);
  assert.match(ui,/more\.textContent=personalChatsExpanded\?"Show less":"Show more"/);
  assert.match(ui,/more\.setAttribute\("aria-label",personalChatsExpanded\?"Show only recent personal chats":"Show all "\+chats\.length\+" personal chats"\)/);
  assert.match(ui,/className="personal-chat-more"/);
  assert.match(ui, /const projectGroups=JSON\.parse\(localStorage\.getItem\("boollmProjectGroups"\)\|\|"{}"\)/);
  assert.doesNotMatch(ui, /createRow\.append\(createProjectButton,openFolderButton\)/);
});

test("wide Chat shows a Codex-inspired Boollm workspace rail", () => {
  assert.match(ui, /id="chatUtilityPanel" aria-label="Chat workspace details"/);
  assert.match(ui, /id="notesToggle"[\s\S]*?id="exploreToggle"[^>]*aria-label="Toggle Explore"[\s\S]*?id="browserToggle"/);
  assert.match(ui, /\$\("exploreToggle"\)\.onclick=\(\)=>openExploreWorkspace\(\)/);
  assert.match(ui,/\.chat-utility-panel\{[\s\S]*?position:absolute;[\s\S]*?right:12px; width:250px; max-height:calc\(100% - 126px\);/);
  assert.match(ui,/body\.chat-utility-room\.workspace-chat \.chat-utility-panel\{ display:flex; flex-direction:column; \}/);
  assert.match(ui,/body\.chat-utility-room\.workspace-chat #chat\{ padding-right:calc\(var\(--content-x\) \+ 272px\); \}/);
  assert.match(ui,/document\.body\.classList\.contains\("workspace-chat"\)&&!utilityBlocked&&mainW>=900/);
  assert.match(ui,/function syncChatUtilityContent\(\)/);
  for(const section of ["Environment","Background processes","Browser","Sources"]){
    assert.match(ui,new RegExp(`<span>${section}<\\/span>`));
  }
  for(const id of ["chatUtilityChanges","chatUtilityMode","chatUtilityBranch","chatUtilityCommit","chatUtilityCompare","chatUtilityProcesses","chatUtilityBrowser","chatUtilitySources","chatUtilitySettings"]){
    assert.match(ui,new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(ui,/id="chatUtilityProject"/);
  assert.match(ui,/\.chat-utility-settings\{[\s\S]*?margin-top:auto/);
  assert.match(ui,/\$\("chatUtilitySettings"\)\?\.addEventListener\("click",\(\)=>openSettings\(null\)\)/);
  assert.match(ui,/\$\("chatUtilityCommit"\)\?\.addEventListener\("click",\(\)=>\$\("cmdCommit"\)\?\.click\(\)\)/);
  assert.match(ui,/github\.repo\.url\+"\/compare"/);
});

test("closing Browser or Notepad restores the wide Chat workspace rail", () => {
  assert.match(ui,/function returnToChatAfterAuxiliaryClose\(ws\)\{[\s\S]*?markWorkspaceTab\("chat"\)/);
  assert.match(ui,/document\.body\.classList\.toggle\("notes-on",!!on\);[\s\S]*?if\(!on\)returnToChatAfterAuxiliaryClose\("notes"\)/);
  assert.match(ui,/if\(!on\) returnToChatAfterAuxiliaryClose\("browser"\)/);
  assert.match(ui,/d\.type==="shellBrowser"[\s\S]*?if\(!d\.open\)returnToChatAfterAuxiliaryClose\("browser"\)/);
  assert.match(ui, /returnToChatAfterAuxiliaryClose\("browser"\);\s*syncPanelButtons\(\);/);
});

test("native browser keeps a usable split width and auto-fits narrow pages", () => {
  assert.match(shell, /const int chatMin = 520;/);
  assert.match(shell, /const int browserMin = 340;/);
  assert.match(shell, /readonly SplitContainer _split = new\(\) \{ Orientation = Orientation\.Vertical, SplitterWidth = 5 \};/);
  assert.doesNotMatch(shell, /TabIcon\("\\u2014", "Minimize"/);
  assert.doesNotMatch(shell, /TabIcon\("\\u25A1", "Maximize"/);
  assert.doesNotMatch(shell, /case "growContext":\s*GrowForBrowser\(\);/);
  assert.doesNotMatch(shell, /HideBrowserPill\(\);\s*GrowForBrowser\(\);/);
  // A dragged width survives window resizes; without this the pane snapped back to the
  // automatic split every time the window changed size.
  assert.match(shell, /int preferredBrowserW = _browserManualWidth > 0\s*\? _browserManualWidth\s*: WindowState == FormWindowState\.Maximized\s*\? \(int\)Math\.Round\(available \* 0\.40\)\s*: available \/ 2;/);
  assert.match(shell, /int browserW = Math\.Clamp\(preferredBrowserW, browserMin/);
  assert.match(shell, /_browserManualWidth = _split\.Panel2\.Width;/);
  assert.match(shell, /ApplyBorderlessDwm\(\);\s*if \(WindowState != FormWindowState\.Minimized && !_wasMinimized &&\s*_browserOpen && !_full\) BeginInvoke\(new Action\(FitBrowserSplit\)\);/);
  assert.match(shell, /int border = ColorTranslator\.ToWin32\(_pal\.BtnBorder\);\s*DwmSetWindowAttribute\(Handle, 34 \/\*DWMWA_BORDER_COLOR\*\/, ref border, 4\);/);
  assert.doesNotMatch(shell, /DWMWA_COLOR_NONE/);
  assert.match(shell, /readonly WebView2 _chromeView = new\(\) \{ Dock = DockStyle\.Top, Height = 116 \};/);
  assert.match(shell, /const int ChromeHeight = 116;/);
  assert.match(shell, /const int ChromeMenuHeight = 548;/);
  assert.match(shell, /_chromeView\.Bounds = new Rectangle\(r\.Left, r\.Top, r\.Width, h\)/);
  assert.match(shell, /ChromeTaskSpecs\(string\? url\)/);
  assert.match(shell, /PushChromeState\(\)/);
  assert.match(shell, /t\.View\.NavigationCompleted \+= \(_, __\) => \{ AutoFitActiveBrowserIfNarrow\(\); PushChromeState\(\); ReportBrowserUrl\(t\); \};/);
  assert.match(shell, /async void AutoFitActiveBrowserIfNarrow\(\)/);
  assert.match(shell, /if \(t\.View\.ClientSize\.Width >= 560\) return;/);
  assert.match(shell, /await AutoFitZoom\(allowZoomIn: false\);/);
});

test("successful run_project opens the local preview in the built-in browser", () => {
  assert.match(ui, /function runProjectPreviewUrl\(entry\)/);
  assert.match(ui, /entry\.name!=="run_project"/);
  assert.match(ui, /if\(run\) run\.previewUrl=url/);
  assert.match(ui, /run\.previewUrl&&\["write_file","edit_file","apply_patch"\]/);
  assert.match(ui, /\\bis running at\\b/);
  assert.match(ui, /https\?:\\\/\\\/\(\?:localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)/);
  assert.match(ui, /function openRunProjectPreview\(entry\)/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"navigate",url\}\)/);
  assert.match(ui, /browserNavigate\(url\);/);
  assert.match(ui, /openRunProjectPreview\(entry\);/);
  assert.match(shell, /case "navigate":/);
  assert.match(shell, /AddTab\(u, activate: true, navigate: true\);/);
});

test("Boollm brand reports live work activity without provider-specific status text", () => {
  assert.match(ui, /function setBoollmActivity\(text,\{temporary=0,ready=true\}=\{\}\)/);
  for (const label of ["Ready", "Working", "Reading page", "Browsing", "Saving to notes", "Summarizing"]) {
    assert.ok(ui.includes(`"${label}"`), `missing Boollm activity label: ${label}`);
  }
  assert.match(ui, /if\(!run\) setBoollmActivity\(text,\{ready\}\)/);
  assert.match(ui, /setBoollmActivity\("Working"\);\s*if\(opts\.provider\)/);
  assert.match(ui, /setBoollmActivity\(inferBoollmActivity\(ev\.text\)\)/);
  assert.match(ui, /setBoollmActivity\(ev\.command\?\.action==="write"\?"Saving to notes":"Working"\)/);
  assert.match(ui, /function showReading\(\)\{ setBoollmActivity\("Reading page",\{temporary:2600\}\)/);
  assert.match(ui, /setBoollmActivity\(\/summar\|email_summary\/\.test\(task\)\?"Summarizing":"Browsing"\)/);
  assert.match(ui, /\.brand-about\.ready\{ color:var\(--dim\); background:transparent; \}/);
  assert.doesNotMatch(ui, /const text=ready\?shortLabel\+" ready":"Not ready"/);
});

test("cloud providers are connected only after their model list loads", () => {
  assert.match(ui, /const apiProviderHealth=\{\};/);
  assert.match(ui, /syncApiProviderHealthFromState\(\)/);
  assert.match(ui, /ready\[prov\]===true&&apiProviderHealth\[prov\]!=="error"/);
  assert.match(ui, /async function verifyApiProviderModels\(prov\)/);
  assert.match(ui, /for\(let attempt=0;attempt<2;attempt\+\+\)/);
  assert.match(ui, /if\(!res\.ok\|\|!models\.length\) throw new Error/);
  assert.match(ui, /apiProviderHealth\[prov\]="ready"/);
  assert.match(ui, /apiProviderHealth\[prov\]="error"/);
  assert.match(ui, /const connected=visibleApi\.filter\(\(\[prov\]\)=>hasApiKey\(prov\)&&apiProviderHealth\[prov\]==="ready"\)/);
  assert.match(ui, /const attention=visibleApi\.filter\(\(\[prov\]\)=>hasApiKey\(prov\)&&apiProviderHealth\[prov\]==="error"\)/);
  assert.match(ui, /if\(missing\.length\)/);
  assert.match(ui, /attentionHead\.textContent="Needs attention"/);
  assert.match(ui, /health==="error"\?"Could not load models"/);
  assert.match(ui, /health==="error"\?"Reconnect"/);
  assert.match(ui, /API key saved, but models could not load\. Check the key or reconnect\./);
});

test("Explore visibly shares current Education Markets and Recipes context with Chat", () => {
  assert.match(ui, /id="workspaceContextChip"[^>]*aria-pressed="true"/);
  assert.match(ui, /\.workspace-context-chip\.visible\{ display:flex; \}/);
  assert.match(ui, /function renderActiveWorkspaceContext\(\)/);
  assert.match(ui, /function buildActiveWorkspaceChatContext\(\)/);
  assert.match(ui, /const workspaceContext=buildActiveWorkspaceChatContext\(\);/);
  assert.match(ui, /<active_explore_context workspace="education">/);
  assert.match(ui, /Question: \$\{educationRun\.index\+1\} of \$\{educationRun\.count\}/);
  assert.match(ui, /The question has not been checked\. Default to a useful hint and reasoning steps/);
  assert.match(ui, /<active_explore_context workspace="markets">/);
  assert.match(ui, /Source: \$\{s\.source\|\|"Unavailable"\}\$\{s\.delayed\?" \(delayed\/indicative\)":""\}/);
  assert.match(ui, /<active_explore_context workspace="recipes">/);
  assert.match(ui, /workspaceContextSharing=!workspaceContextSharing/);
});

test("each new practice attempt randomizes questions while resumes preserve the saved run", () => {
  assert.match(ui, /function educationAttemptSeed\(\)\{/);
  assert.match(ui, /globalThis\.crypto\?\.getRandomValues\?\.\(values\)/);
  assert.match(ui, /const seed=educationAttemptSeed\(\),random=educationRng\(seed\);/);
  assert.match(ui, /const questions=Array\.from\([\s\S]*?educationShuffle\(questions,random\);/);
  assert.match(ui, /educationShuffle\(unique,random\);[\s\S]*?answer:unique\.indexOf\(String\(answer\)\)/);
  assert.match(ui, /available=educationShuffle\(pools\.flat\(\),random\)/);
  assert.match(ui, /educationOfficialRun=\{mode:"mixed",subject,seed,items/);
  assert.match(ui, /if\(resume\)educationOfficialRun=resume;/);
  assert.match(ui, /educationRun=educationSaved\(\);if\(educationRun\?\.questions\?\.length\)educationShowSession\(\);/);
});

test("scheduled task completion notifications are announced once per new run", () => {
  assert.match(ui, /<div class="sechead">Task &amp; Automations/);
  assert.match(ui, /id="automationViewTabs"[\s\S]*data-automation-view="board"[\s\S]*data-automation-view="schedule"[\s\S]*data-automation-view="runs"/);
  assert.match(ui, /id="automationScheduled"[\s\S]*id="automationRunning"[\s\S]*id="automationReview"/);
  assert.match(ui, /Notifications: once per run/);
  assert.match(ui, /function setAutomationView\(view\)/);
  assert.match(ui, /const running=items\.filter\(item=>automationBusyIds\.has\(item\.id\)\)/);
  assert.match(ui, /loadAutomations\(\{notify:false\}\)\.catch\(\(\)=>\{\}\);/);
  assert.match(ui, /setInterval\(\(\)=>\{ if\(document\.visibilityState==="visible"\)\{ loadAutomations\(\{notify:true\}\)/);
  assert.match(ui, /if\(notify&&latest\.id!==lastAutomationRunId\)\{\s*lastAutomationRunId=latest\.id;\s*localStorage\.setItem\("booleanLastAutomationRun",latest\.id\);/);
  assert.doesNotMatch(ui, /tempToast\(\(ok\?"Scheduled task complete:/);
});

test("Studio records live website tours with optional advanced promo editing", () => {
  assert.match(ui, /<h3>Live website demo<\/h3>/);
  assert.match(ui, /AI records the tour/);
  assert.match(ui, /I record the tour/);
  assert.match(ui, /<summary>Advanced editing<\/summary>/);
  assert.match(shell, /Page\.startScreencast/);
  assert.match(ui, /id="videoAdTemplate">[\s\S]*Product Film[\s\S]*Fast Social[\s\S]*Demo Walkthrough/);
  assert.match(ui, /id="videoAdTextMode">[\s\S]*Minimal · 2–6 words[\s\S]*Visual only[\s\S]*Small captions/);
  assert.match(ui, /id="videoAdRegenerateScene"[^>]*>Regenerate scene<\/button>/);
  assert.match(ui, /function shortPromoLine\(/);
  assert.match(ui, /function regenerateVideoAdScene\(/);
  assert.match(ui, /scene\.shot=modes\[/);
  assert.match(ui, /style!=="social"/);
  assert.match(ui, /scene\.shot==="cursor"\|\|style==="walkthrough"/);
});

test("blocked agent runs remain visibly paused without an automatic recovery loop", () => {
  assert.match(agent, /const MAX_LOOP_RECOVERIES = 0/);
  assert.match(agent, /maxTurns: Math\.max\(3/);
  assert.match(server, /turnStatus === "completed" \? "answer" : "paused"/);
  assert.match(ui, /event\.type==="paused"/);
  assert.match(ui, /if\(ev\.type==="paused"\)\{run\.outcome="paused"/);
});

test("Tasks shortcut opens the redesigned Task and Automations workspace", () => {
  assert.match(ui, /else if\(action==="tasks"\)\{ setWorkspaceTab\("automations",\{force:true\}\); \}/);
  assert.match(ui, /else if \(ws === "automations"\) \{ openSettings\("scheduled"\); \}/);
  assert.match(ui, /<div class="sechead">Task &amp; Automations/);
  assert.doesNotMatch(ui, /else if\(action==="tasks"\)\{ toggleBgAgent\(\); \}/);
});
