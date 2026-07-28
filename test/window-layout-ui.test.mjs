import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../shell/Program.cs", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const browse = fs.readFileSync(new URL("../src/browse.js", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");

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
  assert.match(ui, /class="rail-user-initial">B<\/span><span class="rail-user-name">Boollm<\/span>/);
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

test("open project folder uses the standard Windows folder picker", () => {
  assert.match(shell, /using var dialog = new FolderBrowserDialog/);
  assert.match(shell, /AutoUpgradeEnabled = true/);
  assert.match(shell, /UseDescriptionForTitle = true/);
  assert.match(shell, /ShowNewFolderButton = true/);
  assert.match(shell, /dialog\.SelectedPath = initialPath/);
  assert.doesNotMatch(shell, /FileName = "Select this folder"/);
});

test("recipes keep both columns bounded with independently scrollable content and visible actions", () => {
  assert.match(
    ui,
    /\.recipes-panel\{[^}]*overflow:hidden;/s
  );
  assert.match(
    ui,
    /\.recipes-shell\{[^}]*height:100%;[^}]*min-height:0;[^}]*align-items:stretch;[^}]*overflow:hidden;/s
  );
  assert.match(
    ui,
    /\.recipe-grid\{[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s
  );
  assert.match(
    ui,
    /\.recipes-detail\{[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s
  );
  assert.match(ui, /\.recipe-card\{[^}]*min-height:52px;/s);
  assert.match(ui, /\.recipe-card small\{[^}]*text-overflow:ellipsis; white-space:nowrap;/s);
  assert.match(
    ui,
    /\.recipe-actions\{[^}]*position:sticky;[^}]*bottom:0;/s
  );
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.recipes-panel\{ overflow-y:auto; \}[\s\S]*?\.recipes-shell\{ height:auto; min-height:100%; grid-template-columns:1fr; overflow:visible; \}/s);
});

test("completed plan checklists keep raw agent output hidden until requested", () => {
  assert.match(ui, /function shouldShowProjectPlan\(snapshot\)/);
  assert.match(ui, /snapshot\?\.showPlan === true \|\| snapshot\?\.artifactRequired === true/);
  assert.match(ui, /!shouldShowProjectPlan\(snapshot\)/);
  assert.match(ui, /function markCurrentPlanOutput\(\)/);
  assert.match(ui, /markCurrentPlanOutput\(\);\s*col\.classList\.add\("plan-output-hidden"\)/);
  assert.match(ui, /const hasOutput=live\|\|Boolean\(col\.querySelector\("\.live-plan-output"\)\)/);
  assert.match(ui, /hasOutput\?'<button class="plan-checklist-action"[^]*data-plan-action="raw"/);
  assert.match(ui, /if\(!planEl\?\.isConnected\) col\.classList\.remove\("plan-output-hidden"\)/);
});

test("ClearFix respects manual hiding and closes after successful coding work", () => {
  assert.match(ui, /let terminalAutoReveal = true;/);
  assert.match(ui, /function toggleTerminal\(force, userInitiated=false\)/);
  assert.match(ui, /if\(userInitiated\) terminalAutoReveal=open;/);
  assert.match(ui, /if\(terminalAutoReveal\) toggleTerminal\(true\);/);
  assert.match(ui, /\$\("termToggle"\)\.onclick = \(\) => toggleTerminal\(false,true\)/);
  assert.match(ui, /ws === "code"\) \{ terminalAutoReveal=true; toggleTerminal\(true\)/);
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
  assert.match(ui, /id="bAddrClear"[^>]*title="Clear address"/);
  assert.match(ui, /\$\("bAddrClear"\)\?\.addEventListener\("click",\(\)=>\{ bAddr\.value=""/);
  assert.match(ui, /body\.chat-micro #notesToggle,body\.chat-micro #browserToggle\{ display:grid; \}/);
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

test("about page shows build metadata, release history, and working links", () => {
  assert.equal((ui.match(/id="aboutVersion"/g) || []).length, 1);
  assert.match(ui, /id="brandVersion"/);
  assert.match(ui, /id="aboutChannel"/);
  assert.match(ui, /id="aboutBranch"/);
  assert.match(ui, /id="aboutCommit"/);
  assert.match(ui, /id="aboutReleaseDate"/);
  assert.match(ui, /id="aboutChangelog"/);
  assert.match(ui, /id="aboutGitList"/);
  assert.match(ui, /async function loadAboutInfo/);
  assert.match(ui, /if\(section\.dataset\.sec==="about"\) loadAboutInfo\(\);/);
  assert.match(ui, /aboutSource:"https:\/\/github\.com\/syfy10\/Boolean"/);
  assert.match(ui, /aboutReleases:"https:\/\/github\.com\/syfy10\/Boolean\/releases"/);
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
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel,\s*body\.browser-on:not\(\.shell\) #browser,\s*body\.zone-3 #ctxZone\{[\s\S]*?position:relative;[\s\S]*?transition:width var\(--t\),flex-basis var\(--t\),opacity var\(--t\);/);
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel\{[\s\S]*?flex:0 0 var\(--nw,clamp\(240px,26vw,320px\)\);/);
  assert.match(ui, /body\.browser-on:not\(\.shell\) #browser\{[\s\S]*?flex:0 0 var\(--bw,clamp\(260px,30vw,400px\)\);/);
  assert.match(ui, /@media\(max-width:640px\)\{[\s\S]*?body:not\(\.collapsed\) aside\{[\s\S]*?flex-basis:0;[\s\S]*?opacity:0; pointer-events:none;/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?body\.zone-3 #ctxZone,body\.zone-3 #ctxdrag\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{ display:none; width:0; min-width:0; flex-basis:0; \}/);
  assert.match(ui, /@media\(max-width:560px\)\{[\s\S]*?body\.notes-on:not\(\.shell\) #notesPanel,[\s\S]*?body\.browser-on:not\(\.shell\) #browser,[\s\S]*?body:not\(\.shell\) #bdrag,[\s\S]*?#ndrag,#ctxdrag\{ display:none!important; \}/);
});

test("workspace navigation and commands compact before they overflow", () => {
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.workspace-tabs\{ gap:clamp\(6px,1\.3vw,14px\); padding-inline:6px; \}/);
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.ws-tab\{ padding-inline:clamp\(5px,1vw,9px\); gap:5px; font-size:13px; \}/);
  assert.match(ui, /@media\(max-width:1100px\)\{[\s\S]*?\.cmd-bar \.cmd-btn:not\(\.primary\) span\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:900px\)\{[\s\S]*?\.ws-tab\{ padding-inline:5px; font-size:12px; \}/);
  assert.match(ui, /@media\(max-width:900px\)\{[\s\S]*?\.cmd-bar \.cmd-input\{ min-width:80px; font-size:11px; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?body\.composer-simple \.composer-tools \.anchor:has\(#modelbtn\)\{ margin-left:4px; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?\.composer-tools \.modelbtn\{ max-width:54px; padding-inline:2px; \}/);
  assert.match(ui, /\.msg-ai \.body code\{ white-space:normal; overflow-wrap:anywhere; word-break:break-word; \}/);
  assert.match(shell, /MinimumSize = new Size\(Math\.Min\(720, Math\.Max\(600,/);
  assert.match(ui, /body\.chat-xs #sideRail,[\s\S]*?display:none; width:0; min-width:0; flex-basis:0; opacity:0; pointer-events:none;/);
  assert.match(ui, /body\.chat-xs\.rail-menu-open #sideRail,[\s\S]*?display:flex!important; position:fixed;/);
  assert.doesNotMatch(ui, /body\.shell\.notes-on #notesPanel\{ display:none!important; \}/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-compact",mainW<720\);/);
  assert.match(ui, /body\.chat-compact \.ws-tab\{ padding-inline:4px; gap:4px; font-size:11px; \}/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-input\{ min-width:64px; font-size:10px;/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-btn:not\(\.primary\) span\{ display:none; \}/);
});

test("side chat stays compact and the duplicate browser edge launcher is removed", () => {
  assert.match(ui, /\.side-chat-launch\{[\s\S]*?left:20px; right:auto; top:calc\(100% - var\(--composer-h,106px\) \+ 14px\); width:23px; height:23px;[\s\S]*?border-radius:8px;/);
  assert.match(ui, /#browserPill\{\s*display:none !important;\s*\}/);
  assert.match(shell, /void ShowBrowserPill\(\)\s*\{[\s\S]*?_browserPill\.Visible = false;/);
  assert.match(ui, /body\.composer-simple \.promptline #interruptEdit\{ position:absolute; right:42px; top:auto; bottom:8px; z-index:3;/);
  assert.match(ui, /body:not\(\.composer-simple\) \.promptline #interruptEdit\{[\s\S]*?right:15px; bottom:52px;[\s\S]*?width:28px; height:28px;/);
});

test("Settings temporarily closes Projects and Chats without changing the saved sidebar choice", () => {
  assert.match(ui, /body\.settings-open aside,[\s\S]*?body\.settings-open\.collapsed\.sidebar-popover-open aside\{[\s\S]*?display:none!important;[\s\S]*?width:0!important;[\s\S]*?flex-basis:0!important;[\s\S]*?pointer-events:none!important;/);
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
  assert.match(shell, /RestoreWindowLayout\(\);\s*Opacity = 0;/);
  assert.match(shell, /FormClosing \+= \(_, __\) => SaveWindowLayout\(\);/);
  assert.match(shell, /WindowState == FormWindowState\.Normal \? Bounds : RestoreBounds/);
  assert.match(shell, /Maximized = WindowState == FormWindowState\.Maximized/);
  assert.match(shell, /BrowserOpen = _browserOpen/);
  assert.match(shell, /if \(_restoreBrowserOpen\)\s*BeginInvoke\(new Action\(\(\) => ToggleBrowser\(true\)\)\);/);
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
  assert.match(ui, /\.composer-tools \.anchor:has\(\.menu\.open\)\{ z-index:31; \}/);
});

test("native browser split uses the approved gray header and bottom frame", () => {
  assert.match(shell, /const int BrowserTopInset = 38;/);
  assert.match(shell, /readonly RoundedPanel _browserPane = new\(\) \{ Dock = DockStyle\.Fill, Radius = 0 \};/);
  assert.match(shell, /readonly WebView2 _chromeView = new\(\) \{ Dock = DockStyle\.Top, Height = 116 \};/);
  assert.match(shell, /const int ChromeHeight = 116;/);
  assert.match(shell, /_chromeView\.CoreWebView2\.Navigate\(\$"http:\/\/127\.0\.0\.1:\{_port\}\/browser-chrome"\)/);
  assert.match(shell, /_chromeView\.Bounds = new Rectangle\(r\.Left, r\.Top, r\.Width, h\)/);
  assert.match(shell, /Palette\(Color CanvasBg, Color PaneBg, Color BarBg/);
  assert.match(shell, /public static Palette Light => new\(\s*Color\.FromArgb\(245, 245, 243\), Color\.FromArgb\(251, 251, 250\), Color\.FromArgb\(245, 245, 243\)/);
  assert.doesNotMatch(shell, /Palette (?:SoftGlass|GraphiteMist)/);
  assert.match(shell, /Padding = new Padding\(0, 0, 0, 12\);/);
  assert.match(shell, /BackColor = p\.CanvasBg;/);
  assert.match(shell, /_split\.Panel1\.BackColor = p\.CanvasBg;/);
  assert.match(shell, /_split\.Panel2\.BackColor = p\.CanvasBg;/);
  assert.match(shell, /ApplyDwmChromeColor\(p\.CanvasBg\);/);
  assert.match(ui, /--approved-canvas:#e4e4e4;/);
  assert.match(ui, /body\.shell\.workspace-chat\{ padding-bottom:0; \}/);
  assert.match(ui, /body\.shell::after\{ display:none; \}/);
  assert.match(ui, /:root\[data-color-theme="classic"\] #notesPanel,[\s\S]*?:root\[data-color-theme="classic"\] #ctxZone,[\s\S]*?:root\[data-color-theme="classic"\] #browser\{[\s\S]*?border:0!important;[\s\S]*?border-radius:0!important;[\s\S]*?outline:0!important;[\s\S]*?box-shadow:none!important;/);
  assert.match(shell, /void ShowBrowserPill\(\)\s*\{[\s\S]*?_browserPill\.Visible = false;/);
  assert.match(ui, /#browserPill\{\s*display:none !important;\s*\}/);
  assert.match(ui, /body\.collapsed:not\(\.sidebar-popover-open\) aside\{\s*display:none; min-width:0; margin:0; padding:0; border:0; background:transparent;/);
});

test("browser dark mode is persistent and reaches both browser implementations", () => {
  assert.match(ui, /id="bDarkPage" title="Dark mode for websites" aria-pressed="false"/);
  assert.match(ui, /setUi\(\{browserDarkMode:darkPageOn\}\)/);
  assert.match(ui, /const browserDark=resolvedDark\|\|!!ui\.browserDarkMode/);
  assert.match(ui, /darkPageOn=browserThemeDark\|\|!!ui\.browserDarkMode/);
  assert.match(ui, /cmd:"theme",dark:resolvedDark,surface:selectedColorTheme\(ui\),browserDark/);
  assert.match(ui, /d\.type==="shellBrowserDarkMode"[\s\S]*?setUi\(\{browserDarkMode:!!d\.enabled\}\)/);
  assert.match(server, /id="darkPage" title="Dark mode for websites" aria-pressed="false"/);
  assert.match(server, /act\("darkPage"\)/);
  assert.match(shell, /darkPage = _browserDarkMode/);
  assert.match(shell, /AddScriptToExecuteOnDocumentCreatedAsync\(BrowserDarkModeScript\)/);
  assert.match(shell, /RemoveScriptToExecuteOnDocumentCreated\(t\.DarkModeScriptId\)/);
  assert.match(shell, /case "darkPage":[\s\S]*?SetBrowserDarkModeAsync\(!_browserDarkMode, notifyChat: true\)/);
  assert.match(shell, /new \{ type = "shellBrowserDarkMode", enabled \}/);
  assert.match(browse, /img,video,canvas,svg\{opacity:1 !important;\}/);
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
  assert.match(ui, /body\.rail-menu-open #sideRail,[\s\S]*?body\.collapsed\.rail-menu-open #sideRail\{[\s\S]*?display:flex !important; position:fixed; z-index:130; left:8px; top:42px;/);
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("pointerenter",[\s\S]*?railHoverPreview=true;[\s\S]*?classList\.add\("rail-menu-open"\)/);
  assert.match(ui, /\$\("panelToggle"\)\?\.addEventListener\("pointerenter",[\s\S]*?sidebarHoverPreview=true;[\s\S]*?classList\.add\("sidebar-popover-open"\)/);
  assert.match(ui, /accountRailButton\?\.addEventListener\("pointerenter",[\s\S]*?accountHoverPreview=true;[\s\S]*?\$\("accountMenu"\)\?\.classList\.add\("open"\)/);
  assert.match(ui, /setTimeout\(\(\)=>\{[\s\S]*?railHoverPreview[\s\S]*?\},220\)/);
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("click"/);
  assert.match(ui, /body\.rail-manual-hidden:not\(\.rail-menu-open\) #sideRail\{[\s\S]*?display:none !important;/);
  assert.match(ui, /if\(docked\)\{[\s\S]*?classList\.add\("rail-manual-hidden"\);[\s\S]*?classList\.remove\("rail-menu-open"\);/);
  assert.match(ui, /classList\.contains\("rail-manual-hidden"\)[\s\S]*?window\.innerWidth>760[\s\S]*?classList\.remove\("rail-manual-hidden"\);/);
  assert.match(ui, /document\.body\.classList\.remove\("rail-expanded","rail-menu-open"\);/);
});

test("new chat and copy conversation live beside open-and-read in the command bar", () => {
  assert.match(ui, /<div class="cmd-bar" id="cmdBar">[\s\S]*id="newchat" title="New chat"[\s\S]*id="copyall" title="Copy whole conversation"[\s\S]*id="cmdFile" title="Open and read a file"/);
  assert.doesNotMatch(ui, /data-rail="new-chat"/);
  assert.doesNotMatch(ui, /data-rail="copy-chat"/);
  assert.doesNotMatch(ui, /<button class="icon-btn" id="newchat"/);
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
  assert.match(ui, /document\.body\.classList\.toggle\("chat-xxs",mainW<560\);/);
  assert.match(ui, /body\.chat-xxs \.topbar\{ padding:0 6px; justify-content:flex-start; \}/);
  assert.match(ui, /body\.chat-xxs \.winctl\{ margin-left:auto; \}/);
  assert.match(ui, /#appBack\{ display:grid; \}[\s\S]*?#appBack:disabled\{ opacity:\.42; cursor:default; \}/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-micro",mainW<360\);/);
  assert.match(ui, /body\.chat-micro #appForward,[\s\S]*?body\.chat-micro #ctxToggle\{ display:none; \}/);
  assert.doesNotMatch(ui, /body\.browser-on\.chat-micro \.topbar #(?:newchat|copyall)/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?main,#chat,\.col\{ min-width:0; max-width:100%; overflow-x:hidden; box-sizing:border-box; \}/);
  assert.match(ui, /\.msg-user,\.msg-ai,body\.win-lg \.msg-user,body\.win-lg \.msg-ai\{[\s\S]*?max-width:min\(88%,calc\(100% - 12px\)\);/);
  assert.match(ui, /\.composer-wrap,body\.composer-simple \.composer-wrap,[\s\S]*?\.composer-tools\{ min-width:0; max-width:100%; box-sizing:border-box; \}/);
});

test("workspace card shows the selected API model's real readiness", () => {
  assert.match(ui, /id="brandAbout" role="button" tabindex="0" aria-label="About Boollm and AI readiness"/);
  assert.match(ui, /<path d="M12 11v6"\/><path d="M12 7\.5h\.01"\/>/);
  assert.match(ui, /\.sidehead #footStatus \.dot,\.sidehead #footStatus #statustext\{ display:inline-flex; \}/);
  assert.doesNotMatch(ui, /\.sidehead #footStatus::after\{ content:"Local AI workspace"; \}/);
  assert.match(ui, /function updateReadyStatus\(label,shortLabel\)\{\s*const ready=providerReadyForRun\(state\.provider\|\|"local"\);/);
  assert.match(ui, /\$\("brandAbout"\)\.classList\.toggle\("ready",ready\);/);
});

test("workspace card is borderless and chat search has a leading icon", () => {
  assert.match(ui, /\.sidehead\{ min-height:48px;[\s\S]*?border:0; border-radius:var\(--radius-lg\); \}/);
  assert.doesNotMatch(ui, /\.sidebar-brand::before/);
  assert.match(ui, /<div class="thread-search-wrap">\s*<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"\/><path d="m16 16 4 4"\/><\/svg>\s*<input id="threadSearch"/);
  assert.match(ui, /\.thread-search-wrap svg\{[\s\S]*?left:9px;[\s\S]*?stroke:var\(--dim\);/);
  assert.match(ui, /display:block; width:100%; height:28px; margin:0; padding:0 9px 0 27px;/);
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
  assert.match(ui, /--approved-card:#fafaf9;/);
  assert.match(ui, /\.col\{ width:100%; max-width:none; gap:8px; background:var\(--approved-canvas\); \}/);
  assert.match(ui, /body,body\.shell\{[\s\S]*?padding:calc\(var\(--approved-topbar-h\) \+ var\(--approved-gap\)\) var\(--approved-gap\) var\(--approved-bottom-gap\) 4px;/);
});

test("projects chats and browser use one shared pane background", () => {
  assert.match(ui, /--approved-card:#fafaf9;/);
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
  assert.match(ui, /\["theme","colorTheme","composerStyle"/);
  assert.match(ui, /:root\[data-visual-theme="light"\]\[data-color-theme="classic"\][\s\S]*?--approved-canvas:#f5f5f3; --approved-card:#fbfbfa;/);
  assert.match(ui, /:root\[data-visual-theme="dark"\]\[data-color-theme="classic"\][\s\S]*?--approved-canvas:#181818; --approved-card:#1c1c1c;/);
  assert.match(ui, /:root\[data-color-theme="classic"\] aside,[\s\S]*?data-color-theme="classic"\] body\.shell aside,[\s\S]*?data-color-theme="classic"\] #browser\{[\s\S]*?border:0!important;[\s\S]*?border-radius:0!important;[\s\S]*?outline:0!important;[\s\S]*?box-shadow:none!important;/);
  assert.match(ui, /:root\[data-color-theme="classic"\] aside,[\s\S]*?data-color-theme="classic"\] body\.shell aside\{[\s\S]*?background:var\(--approved-canvas\)!important;/);
  assert.match(ui, /id="ndrag" title="Drag to resize notepad"/);
  assert.match(ui, /id="ctxdrag" title="Drag to resize context"/);
  assert.match(ui, /function installPaneResizer\(\{handleId,panelId,cssVar,saveKey,minWidth=240\}\)[\s\S]*?setUi\(\{\[saveKey\]:Math\.round\(panel\.getBoundingClientRect\(\)\.width\)\}\)[\s\S]*?handle\.addEventListener\("pointerdown"[\s\S]*?document\.addEventListener\("pointermove",onMove\)[\s\S]*?document\.addEventListener\("pointerup",finish\)/);
  assert.match(ui, /installPaneResizer\(\{handleId:"ndrag",panelId:"notesPanel",cssVar:"--nw",saveKey:"notepadW",minWidth:220\}\)/);
  assert.match(ui, /installPaneResizer\(\{handleId:"ctxdrag",panelId:"ctxZone",cssVar:"--cw",saveKey:"contextW",minWidth:240\}\)/);
  assert.match(ui, /installPaneResizer\(\{handleId:"bdrag",panelId:"browser",cssVar:"--bw",saveKey:"browserW",minWidth:260\}\)/);
  assert.match(ui, /document\.body\.style\.setProperty\("--nw",ui\.notepadW\+"px"\)/);
  assert.match(ui, /document\.body\.style\.setProperty\("--cw",ui\.contextW\+"px"\)/);
  assert.match(config, /notepadW:\s*320/);
  assert.match(config, /contextW:\s*300/);
  assert.match(ui, /body\.browser-on:not\(\.shell\) #browser\{ width:var\(--bw,320px\)!important; min-width:270px!important; flex-basis:var\(--bw,320px\); \}/);
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel\{ width:var\(--nw,280px\); min-width:250px; flex-basis:var\(--nw,280px\); \}/);
  assert.match(ui, /#notesPanel\{ width:var\(--nw,clamp\(260px,32vw,360px\)\); flex:0 0 var\(--nw,clamp\(260px,32vw,360px\)\);/);
  assert.match(ui, /const chatXs=document\.body\.classList\.contains\("chat-xs"\);\s*document\.body\.classList\.toggle\("chat-xs",chatXs\?mainW<470:mainW<430\);/);
  assert.match(ui, /body\.pane-resizing #notesPanel,[\s\S]*?body\.pane-resizing main,body\.pane-resizing aside\{ transition:none!important; \}/);
  assert.match(ui, /if\(!browserManualSize\) fitBrowserSplit\(\);/);
});

test("surface styles reach the native footer and the account identity owns Profile", () => {
  assert.match(ui, /id="accountProfileLink" data-account-action="profile"[^>]*>[\s\S]*?id="accountMenuName"[\s\S]*?id="accountMenuEmail"[\s\S]*?<\/button>/);
  assert.doesNotMatch(ui, /class="account-menu-row" data-account-action="profile"/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"theme",dark:resolvedDark,surface:selectedColorTheme\(ui\),browserDark\}\)/);
  assert.doesNotMatch(shell, /Palette (?:SoftGlass|GraphiteMist|Clex)|connectedClex|_connectedClex/);
  assert.match(shell, /Padding = new Padding\(0, 0, 0, 12\);[\s\S]*?_split\.SplitterWidth = 5;[\s\S]*?_browserPane\.Radius = 0;[\s\S]*?_browserPane\.BorderColor = Color\.Transparent;/);
  assert.match(shell, /sealed class MainForm : Form, IMessageFilter[\s\S]*?Application\.AddMessageFilter\(this\);[\s\S]*?public bool PreFilterMessage\(ref Message m\)[\s\S]*?Math\.Abs\(point\.X - _split\.SplitterDistance\) <= 5/);
  assert.match(shell, /string surface = "classic";/);
  assert.match(shell, /_themeSurface = "classic";[\s\S]*?pal = Palette\.Light;/);
});

test("approved sidebar follows window width until the user toggles it", () => {
  assert.match(ui, /--approved-sidebar-w:260px;/);
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
  assert.match(ui, /\.topbar \.netseg\{ width:96px; min-width:96px; max-width:96px; height:22px;/);
  assert.match(ui, /\.topbar \.netseg button\{ flex:1 1 50%; width:46px; min-width:0; height:18px; font-size:10px;/);
});

test("compact navigation rail returns at half the old width requirement", () => {
  assert.match(ui, /@media\(min-width:681px\) and \(max-width:760px\)\{[\s\S]*?#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{[\s\S]*?display:flex; flex-basis:30px; width:30px; min-width:30px;/);
  assert.doesNotMatch(ui, /@media\(min-width:681px\) and \(max-width:760px\)\{[\s\S]*?#railMenuToggle\{ display:none; \}/);
  assert.match(ui, /if\(w>380\)\{\s*document\.body\.classList\.remove\("rail-menu-open"\);/);
});

test("model picker includes the local cloud toggle and stays synced", () => {
  assert.match(ui, /\.menu#modelmenu\{ position:fixed; bottom:auto; right:auto; width:218px;/);
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
  assert.match(ui, /\$\("modelname"\)\.textContent=nm\?shortAiName\(state\.provider,nm\):"Model"/);
  assert.match(ui, /\$\("providersel"\)\.onchange=async\(e\)=>\{[\s\S]*?const provider=e\.target\.value;[\s\S]*?JSON\.stringify\(\{provider\}\)/);
  assert.match(ui, /modelPickerNet="online";[\s\S]*?const firstMissing=\$\("modellist"\)\?\.querySelector\("\.api-provider\.missing"\);[\s\S]*?Boollm will stay on Local until it is saved\./);
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
  assert.match(ui, /class="model-picker-title"><b>AI providers<\/b>/);
  assert.match(ui, /\.menu#modelmenu\{[^}]*width:218px;[^}]*max-height:min\(380px,calc\(100vh - 72px\)\)/s);
  assert.doesNotMatch(ui, /class="model-search-toggle"|id="modelSearchToggle"/);
  assert.match(ui, /<input id="modelsearch" type="hidden" value="">/);
  assert.match(ui, /connectedHead\.textContent="Connected"/);
  assert.match(ui, /add\.textContent=showApiProviderCatalog\?"Hide available providers":"\+ Add a cloud provider"/);
  assert.match(ui, /function renderFocusedApiProvider\(prov,label,hasKey\)/);
  assert.match(ui, /className="api-connected-summary"/);
  assert.match(ui, /const selected=state\.provider===id;/);
  assert.match(ui, /row\.setAttribute\("aria-current","true"\)/);
  assert.match(ui, /\(selected\?"Selected":"Use"\)/);
  assert.doesNotMatch(ui, /providerMark\(id,name\)\+'<span class="conn-dot"/);
  assert.match(ui, /className="api-provider-select"/);
  assert.match(ui, /\.api-connected-summary \.model-line\{[^}]*display:grid; grid-template-columns:minmax\(0,1\.35fr\) minmax\(42px,\.65fr\);/s);
  assert.match(ui, /#modelmenu \.model-picker-title\{[^}]*height:30px; min-height:30px;/s);
  assert.match(ui, /\.api-provider-select\{[^}]*min-height:32px; height:32px;/s);
  assert.match(ui, /\.api-provider-detail\.connecting \.api-key-form\{[^}]*grid-template-columns:minmax\(0,1fr\) 24px;/s);
  assert.match(ui, /#modelmenu \.api-provider-detail\.connecting \.api-key-form input\{[^}]*min-height:26px; height:26px;/s);
  assert.match(ui, /\.api-provider-detail\.connecting \.api-key-save\{[^}]*min-height:24px; height:24px;/s);
  assert.match(ui, /role="button" tabindex="0" aria-expanded="false"/);
  assert.match(ui, /toggleApiProvider\(id,name,row,true,true\)/);
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
  assert.match(ui, /\.api-provider-select \.api-mark\{ width:14px; height:14px;/);
  assert.match(ui, /qwen:\{fill:true,svg:'<svg[^']*qwenMarkGradient/);
  assert.match(ui, /const actionMarkup=installed\?esc\(action\):'<span>Download<\/span><small>'\+esc\(rec\.size\)/);
  assert.match(ui, /class="model-dl'\+\(installed\?"":" download"\)/);
  assert.match(ui, /className="local-model-ask"/);
  assert.match(ui, /Ask chat to find another open model/);
  assert.match(ui, /askAI\(request\)/);
  assert.match(ui, /className="api-provider-options"/);
  assert.doesNotMatch(ui, /Browse all providers/);
  assert.match(ui, /Math\.min\(380,buttonRect\.top-margin\)/);
  assert.match(ui, /function closeRowMenus\(\{restoreFocus=false\}=\{\}\)/);
  assert.match(ui, /more\.setAttribute\("aria-haspopup","menu"\)/);
  assert.match(ui, /if\(!e\.target\.closest\("#modelmenu \.api-row-menu,#modelmenu \.api-row-more"\)\) closeRowMenus\(\)/);
  assert.match(ui, /e\.key==="Escape"&&document\.querySelector\("#modelmenu \.api-row-menu"\)[\s\S]*?closeRowMenus\(\{restoreFocus:true\}\)/);
  assert.match(ui, /modelsHead\.textContent="Available models"/);
  assert.match(ui, /setApiConnectionState\(form,"success",label\+" connected"\);[\s\S]*?showInlineApiModels\(form,prov,label,verifiedModels\)/);
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

test("compact Auto and model controls open visible dropdowns", () => {
  assert.match(ui, /\.composer-wrap:has\(\.menu\.open\),body\.composer-simple \.composer-wrap:has\(\.menu\.open\)\{ overflow:visible; z-index:30; \}/);
  assert.match(ui, /body\.composer-simple \.composer-tools \.modebtn,\s*body\.composer-simple \.composer-tools \.modelbtn\{[\s\S]*?height:18px; min-height:18px;[\s\S]*?border-radius:0;[\s\S]*?background:transparent; box-shadow:none; font:9px\/1 var\(--ui\);/);
  assert.match(ui, /body\.composer-simple \.composer-tools \.modelbtn\{ max-width:54px; \}/);
  assert.match(ui, /body\.composer-simple\.online-mode \.composer-tools \.modelbtn\{\s*border-radius:0; background:transparent; box-shadow:none;/);
  assert.match(ui, /\$\("modelbtn"\)\.onclick=\(e\)=>\{ e\.stopPropagation\(\);[\s\S]*openModelSelector\(\); \};/);
  assert.match(ui, /\$\("modebtn"\)\.onclick=\(e\)=>\{ e\.stopPropagation\(\);[\s\S]*\$\("modemenu"\)\.classList\.toggle\("open"\); \};/);
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
  assert.match(ui, /\.browser-toolbar\{ padding:3px 5px; gap:1px; flex-wrap:nowrap; \}/);
  assert.match(ui, /@container \(max-width:420px\)\{/);
  assert.match(ui, /\.addr-wrap\{ flex:1 1 88px; min-width:88px; \}/);
  assert.match(ui, /#bReader,#bDarkPage,#bFindBtn,#bOutlineBtn,#bSplitBtn,\.page-actions,\.btool-sep\{ display:none; \}/);
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
});

test("native shell completes the border across the custom title bar", () => {
  assert.match(shell, /readonly Panel _topOutline = new\(\) \{ Dock = DockStyle\.Top, Height = 1, TabStop = false \};/);
  assert.match(shell, /Controls\.Add\(_topOutline\);\s*_topOutline\.BringToFront\(\);/);
  assert.match(shell, /_topOutline\.BackColor = p\.BtnBorder;/);
});

test("side chat user bubbles keep readable foreground contrast in dark mode", () => {
  assert.match(ui, /\.side-chat-msg\.user\{[^}]*color:var\(--accent-text\);[^}]*background:var\(--accent\);/s);
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--accent:#ececec; --accent-text:#181818;/);
});

test("round composer uses the compact floating card layout without changing line mode", () => {
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-wrap\{[^}]*min-height:124px;[^}]*border-radius:24px;[^}]*box-shadow:0 6px 20px/s);
  assert.match(ui, /body:not\(\.composer-simple\) main::after\{\s*bottom:0; height:152px;[\s\S]*?var\(--approved-canvas\) 92%,transparent\) 24px/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer textarea\{[^}]*min-height:48px;[^}]*font:15px\/1\.45 var\(--ui\)/s);
  assert.match(ui, /id="composerPrompt">Ask anything\.\.\.<\/span><textarea id="input" rows="1" placeholder="Ask anything\.\.\."/);
  assert.match(ui, /id="micbtn" type="button" title="Voice input"/);
  assert.match(ui, /window\.SpeechRecognition\|\|window\.webkitSpeechRecognition/);
  assert.match(ui, /composerIsSimple\(\)\?"Auto":"Full access"/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools #plusbtn\{ order:0; \}/);
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-tools #snipbtn\{[^}]*display:grid; order:1; color:var\(--dim\); font-weight:400;/);
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
  assert.match(ui, /body:not\(\.composer-simple\) \.composer-wrap\{[\s\S]*?background:var\(--approved-card\); box-shadow:0 6px 20px/);
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
  assert.match(ui, /setApiConnectionState\(form,"success",label\+" connected"\)/);
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
  assert.match(ui, /id="educationWorkspaceTab" data-ws="education" title="Practice exams" hidden aria-hidden="true"/);
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
  assert.match(ui, /body\.education-open #chat,body\.education-open \.composer-wrap\{ display:none!important; \}/);
});

test("project timelines appear only for chats explicitly bound to a folder", () => {
  assert.match(ui, /function shouldShowProjectPlan\(snapshot\)[\s\S]*?thread\?\.kind==="project"[\s\S]*?!!thread\?\.projectDir/);
});

test("projects and chats use the compact 1A accordion sidebar", () => {
  assert.match(ui, /\.project-accordion\{ border-top:1px solid var\(--border\); \}/);
  assert.match(ui, /\.project-group-head\{ display:flex; align-items:center; gap:7px;/);
  assert.match(ui, /head\.setAttribute\("aria-expanded",String\(open\)\)/);
  assert.match(ui, /makeThreadRow\(t,\{projectChat:true,label:"Project chat"\}\)/);
  assert.ok(ui.includes(`chatHead.innerHTML='<span>Personal chats</span><span class="gcount">'+chats.length+'</span>'`));
  assert.match(ui, /const projectGroups=JSON\.parse\(localStorage\.getItem\("boollmProjectGroups"\)\|\|"{}"\)/);
});

test("native browser keeps a usable split width and auto-fits narrow pages", () => {
  assert.match(shell, /const int chatMin = 300;/);
  assert.match(shell, /const int browserMin = 340;/);
  assert.match(shell, /readonly SplitContainer _split = new\(\) \{ Orientation = Orientation\.Vertical, SplitterWidth = 5 \};/);
  assert.doesNotMatch(shell, /TabIcon\("\\u2014", "Minimize"/);
  assert.doesNotMatch(shell, /TabIcon\("\\u25A1", "Maximize"/);
  assert.doesNotMatch(shell, /case "growContext":\s*GrowForBrowser\(\);/);
  assert.doesNotMatch(shell, /HideBrowserPill\(\);\s*GrowForBrowser\(\);/);
  assert.match(shell, /int preferredBrowserW = WindowState == FormWindowState\.Maximized\s*\? \(int\)Math\.Round\(available \* 0\.40\)\s*: available \/ 2;/);
  assert.match(shell, /int browserW = Math\.Clamp\(preferredBrowserW, browserMin/);
  assert.match(shell, /ApplyBorderlessDwm\(\);\s*if \(_browserOpen && !_full\) BeginInvoke\(new Action\(FitBrowserSplit\)\);/);
  assert.match(shell, /int border = ColorTranslator\.ToWin32\(_pal\.BtnBorder\);\s*DwmSetWindowAttribute\(Handle, 34 \/\*DWMWA_BORDER_COLOR\*\/, ref border, 4\);/);
  assert.doesNotMatch(shell, /DWMWA_COLOR_NONE/);
  assert.match(shell, /readonly WebView2 _chromeView = new\(\) \{ Dock = DockStyle\.Top, Height = 116 \};/);
  assert.match(shell, /const int ChromeHeight = 116;/);
  assert.match(shell, /const int ChromeMenuHeight = 548;/);
  assert.match(shell, /_chromeView\.Bounds = new Rectangle\(r\.Left, r\.Top, r\.Width, h\)/);
  assert.match(shell, /ChromeTaskSpecs\(string\? url\)/);
  assert.match(shell, /PushChromeState\(\)/);
  assert.match(shell, /t\.View\.NavigationCompleted \+= \(_, __\) => \{ AutoFitActiveBrowserIfNarrow\(\); PushChromeState\(\); \};/);
  assert.match(shell, /async void AutoFitActiveBrowserIfNarrow\(\)/);
  assert.match(shell, /if \(t\.View\.ClientSize\.Width >= 560\) return;/);
  assert.match(shell, /await AutoFitZoom\(allowZoomIn: false\);/);
});

test("successful run_project opens the local preview in the built-in browser", () => {
  assert.match(ui, /function runProjectPreviewUrl\(entry\)/);
  assert.match(ui, /entry\.name!=="run_project"/);
  assert.match(ui, /\\bis running at\\b/);
  assert.match(ui, /https\?:\\\/\\\/\(\?:localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)/);
  assert.match(ui, /function openRunProjectPreview\(entry\)/);
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"navigate",url\}\)/);
  assert.match(ui, /openBrowser\(true,\{remember:true\}\);\s*navigate\(url\);/);
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
