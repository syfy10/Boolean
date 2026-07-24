import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../shell/Program.cs", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("maximize control offers left, maximize, and right window layouts", () => {
  const options = [...ui.matchAll(/data-window-place="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, ["snapleft", "max", "snapright"]);
  assert.match(ui, /id="windowLayoutMenu" role="menu"/);
  assert.match(ui, /document\.body\.appendChild\(windowLayoutMenu\)/);
  assert.match(ui, /windowLayoutMenu\.classList\.toggle\("open"\)/);
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
  assert.match(ui, /#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{[\s\S]*?display:flex;[\s\S]*?flex:0 0 46px;[\s\S]*?opacity:1; pointer-events:auto;/);
  assert.match(ui, /<div class="rail-brand sidebar-brand" aria-hidden="true">[\s\S]*<div class="brand-name">Boolean<\/div>[\s\S]*id="railBrandReady"[\s\S]*id="railBrandDot"[\s\S]*id="railBrandStatus"[\s\S]*class="brand-about"/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-brand\{ display:flex; \}/);
  assert.match(ui, /\.rail-brand\{[^}]*min-height:52px;[^}]*padding:7px 8px;/s);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-main\{ padding:4px 7px; \}/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-footer\{ flex-direction:row; align-items:stretch; gap:0; border-top:1px solid var\(--border\); padding:0; \}/);
  assert.match(ui, /if\(\$\("railBrandDot"\)\) \$\("railBrandDot"\)\.className="dot"\+\(ready\?"":" down"\);/);
  assert.match(ui, /if\(\$\("railBrandStatus"\)\) \$\("railBrandStatus"\)\.textContent=text;/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-label\{ display:block; \}/);
  assert.match(ui, /id="panelToggle"[\s\S]*id="appBack"[\s\S]*id="netmode"/);
  assert.match(ui, /id="appBack" title="Go back"[\s\S]*id="appForward" title="Go forward"[\s\S]*id="netmode"/);
  assert.match(ui, /id="panelToggle" title="Show projects and chats" aria-label="Show projects and chats"/);
  assert.doesNotMatch(ui, /body\.collapsed \.topbar #panelToggle/);
  assert.match(ui, /data-rail="projects" title="Open project folder" aria-label="Open project folder"[\s\S]*<span class="rail-label">Open folder<\/span>/);
  assert.match(ui, /data-rail="git" title="Git" aria-label="Git"[\s\S]*<span class="rail-label">Git<\/span>/);
  assert.match(ui, /<div class="rail-stack rail-main">/);
  assert.match(ui, /<div class="rail-stack rail-footer">[\s\S]*data-rail="settings"[\s\S]*class="rail-user"/);
  assert.match(ui, /class="rail-user-initial">B<\/span><span class="rail-user-name">Boolean<\/span>/);
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
  assert.match(ui, /document\.body\.classList\.toggle\("collapsed",sidebarManualState===null\?shouldCollapseApprovedSidebar:sidebarManualState\);/);
  assert.match(ui, /\$\("panelToggle"\)\.title=sidebarClosed\?"Show projects and chats":"Hide projects and chats";/);
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

test("compact rail uses the matching notepad icon and Boolean search", () => {
  assert.match(ui, /data-rail="notes" title="Notepad" aria-label="Notepad"/);
  assert.match(ui, /data-rail="notes"[\s\S]*viewBox="0 0 64 64"[\s\S]*class="notepad-paper"/);
  assert.match(ui, /\.rail-btn\[data-rail="notes"\] \.notepad-paper/);
  assert.match(ui, /data-rail="search" title="Search Boolean" aria-label="Search Boolean"/);
  assert.match(ui, /placeholder="Search Boolean\.\.\. chats, projects, commands\.\.\."/);
  assert.match(ui, /function cmdRecentThreads\(query\)/);
  assert.match(ui, /id: "chat:" \+ t\.id/);
  assert.ok(ui.indexOf('id="cmdPalette"') < ui.indexOf("<script>"), "search palette must exist before handlers bind");
  assert.match(ui, /if\(action==="search"\)\{ if\(typeof openCmdPalette==="function"\) openCmdPalette\(\);/);
});

test("open project folder uses the standard Windows folder picker", () => {
  assert.match(shell, /using var dialog = new FolderBrowserDialog/);
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
  assert.match(ui, /\.recipe-card\{[^}]*min-height:64px;/s);
  assert.match(
    ui,
    /\.recipe-actions\{[^}]*position:sticky;[^}]*bottom:0;/s
  );
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.recipes-panel\{ overflow-y:auto; \}[\s\S]*?\.recipes-shell\{ height:auto; min-height:100%; grid-template-columns:1fr; overflow:visible; \}/s);
});

test("completed plan checklists keep raw agent output hidden until requested", () => {
  assert.match(ui, /function markCurrentPlanOutput\(\)/);
  assert.match(ui, /markCurrentPlanOutput\(\);\s*col\.classList\.add\("plan-output-hidden"\)/);
  assert.match(ui, /const hasOutput=live\|\|Boolean\(col\.querySelector\("\.live-plan-output"\)\)/);
  assert.match(ui, /hasOutput\?'<button class="plan-checklist-action"[^]*data-plan-action="raw"/);
  assert.match(ui, /if\(!planEl\?\.isConnected\) col\.classList\.remove\("plan-output-hidden"\)/);
});

test("manually hidden ClearFix output stays hidden until Code is opened again", () => {
  assert.match(ui, /let terminalAutoReveal = true;/);
  assert.match(ui, /function toggleTerminal\(force, userInitiated=false\)/);
  assert.match(ui, /if\(userInitiated\) terminalAutoReveal=open;/);
  assert.match(ui, /if\(terminalAutoReveal\) toggleTerminal\(true\);/);
  assert.match(ui, /\$\("termToggle"\)\.onclick = \(\) => toggleTerminal\(false,true\)/);
  assert.match(ui, /ws === "code"\) \{ terminalAutoReveal=true; toggleTerminal\(true\)/);
});

test("native browser and notepad reflow without resizing the app window", () => {
  assert.match(shell, /case "growContext":\s*if \(_browserOpen && !_full\) BeginInvoke\(new Action\(FitBrowserSplit\)\);/);
  assert.doesNotMatch(shell, /case "growContext":\s*GrowForBrowser\(\);/);
  assert.doesNotMatch(shell, /HideBrowserPill\(\);\s*GrowForBrowser\(\);/);
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
  assert.match(ui, /<div class="app-footer" aria-label="App footer">\s*<div class="sidefoot-nav" aria-label="Settings and account">[\s\S]*id="topSettings" title="Settings" aria-label="Settings"[\s\S]*id="cloudSignIn" title="Sign in to your Boolean account" aria-label="Account"/);
  assert.match(ui, /\.sidefoot-nav\{[^}]*display:flex;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.match(ui, /--app-footer-h:28px/);
  assert.match(ui, /if\(approvedFooter&&approvedSidebar\) approvedSidebar\.insertBefore\(approvedFooter,approvedSidefoot\|\|null\);/);
  assert.match(ui, /\.app-footer\{[\s\S]*?left:8px; right:8px; bottom:7px;[\s\S]*?border:0; background:var\(--sidebar\);/);
  assert.match(ui, /\.app-footer \.sidefoot-nav,\.app-footer-version\{ display:none; \}/);
  assert.match(ui, /id="footerVersion" aria-label="Boolean version"/);
  assert.match(ui, /\.app-footer-version\{[^}]*margin-left:auto;[^}]*font:7\.5px\/1 var\(--mono\);/s);
  assert.match(ui, /if\(\$\("footerVersion"\)\) \$\("footerVersion"\)\.textContent="Boolean "\+\(state\.displayVersion/);
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

test("duplicate sidebar footer status is hidden because readiness lives under Boolean", () => {
  assert.match(ui, /<div class="app-footer" aria-label="App footer">[\s\S]*id="cmdProjectStatus"/);
  assert.match(ui, /\.workspace-tabs \.cmd-status\{ display:none; \}/);
  assert.match(ui, /\.app-footer\{[\s\S]*?display:none !important;[\s\S]*?background:var\(--sidebar\);/);
  assert.match(ui, /\.app-footer \.cmd-chip\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(ui, /\.app-footer #cmdProjectStatus #cmdFilesChip,\.app-footer #cmdProjectStatus #cmdServerChip\{ display:inline-flex; \}/);
  assert.doesNotMatch(ui, /insertAdjacentElement\("afterend",status\)/);
  assert.doesNotMatch(ui, /function placeProjectStatusChip/);
});

test("workspace tabs and labeled command actions match the approved compact mockup", () => {
  assert.match(ui, /\.workspace-tabs\{[\s\S]*?height:40px; min-height:40px;[\s\S]*?gap:24px;[\s\S]*?border-bottom:1px solid var\(--border\);/);
  assert.match(ui, /\.ws-tab\{[^}]*font:14px var\(--ui\);/s);
  assert.match(ui, /\.ws-tab\.active\{ border-bottom-color:var\(--text\); \}/);
  assert.match(ui, /\.cmd-bar\{[\s\S]*?height:32px; min-height:32px;[\s\S]*?background:transparent;[\s\S]*?margin-bottom:3px;/);
  assert.match(ui, /\.cmd-bar \.cmd-btn span\{ display:inline; \}/);
  assert.match(ui, /\.cmd-bar \.cmd-btn\{\s*flex:0 0 auto; min-width:28px; width:auto;/);
  assert.match(ui, /\.cmd-bar \.cmd-btn\.primary\{[\s\S]*?height:26px;[\s\S]*?border-radius:9px; background:#2b2b2b;/);
  for (const action of ["File", "Test", "Web", "Note", "Commit"]) {
    assert.match(ui, new RegExp(`aria-label="${action}"`));
  }
});

test("dark mode keeps autofill and the footer mask on approved theme surfaces", () => {
  assert.match(ui, /:root\[data-theme="dark"\]\{ --approved-canvas:#181818; --approved-card:#1d1d1d; \}/);
  assert.match(ui, /\.cmd-bar \.cmd-input:-webkit-autofill,[\s\S]*?box-shadow:0 0 0 1000px var\(--approved-canvas\) inset !important;/);
  assert.match(ui, /\.cmd-bar \.cmd-input::selection\{[\s\S]*?background:color-mix\(in srgb,var\(--text\) 20%,var\(--approved-canvas\)\);/);
  assert.match(ui, /body::after,body\.shell::after\{[\s\S]*?background:var\(--approved-canvas\);/);
});

test("dark mode separates canvas panels cards and borders without changing layout", () => {
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--bg:#181818; --sidebar:#1d1d1d;[\s\S]*?--border:#2a2a2a;/);
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--card:#202020;/);
  assert.match(ui, /:root\[data-theme="dark"\] \.msg-ai \.body,[\s\S]*?--msg-fill:var\(--card\);/);
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
  assert.match(ui, /body\.notes-on:not\(\.shell\) #notesPanel\{[\s\S]*?flex:0 0 clamp\(240px,26vw,320px\);/);
  assert.match(ui, /body\.browser-on:not\(\.shell\) #browser\{[\s\S]*?flex:0 0 clamp\(260px,30vw,400px\);/);
  assert.match(ui, /@media\(max-width:640px\)\{[\s\S]*?body:not\(\.collapsed\) aside\{[\s\S]*?flex-basis:0;[\s\S]*?opacity:0; pointer-events:none;/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?body\.zone-3 #ctxZone\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?#sideRail,body\.collapsed #sideRail,body\.collapsed\.rail-expanded #sideRail\{ display:none; width:0; min-width:0; flex-basis:0; \}/);
  assert.match(ui, /@media\(max-width:560px\)\{[\s\S]*?body\.notes-on:not\(\.shell\) #notesPanel,[\s\S]*?body\.browser-on:not\(\.shell\) #browser,[\s\S]*?body:not\(\.shell\) #bdrag\{ display:none!important; \}/);
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
  assert.match(shell, /MinimumSize = new Size\(Math\.Min\(560,/);
  assert.match(ui, /document\.body\.classList\.toggle\("chat-compact",mainW<720\);/);
  assert.match(ui, /body\.chat-compact \.ws-tab\{ padding-inline:4px; gap:4px; font-size:11px; \}/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-input\{ min-width:64px; font-size:11px;/);
  assert.match(ui, /body\.chat-compact \.cmd-bar \.cmd-btn:not\(\.primary\) span\{ display:none; \}/);
});

test("chat and browser launchers form one right-edge vertical stack", () => {
  assert.match(ui, /\.side-chat-launch\{[\s\S]*?right:20px; top:calc\(100% - var\(--composer-h,106px\) \+ 14px\); width:23px; height:23px;[\s\S]*?border-radius:8px;/);
  assert.match(ui, /#browserPill\{[\s\S]*?right:0; top:calc\(50% \+ 24px\);[\s\S]*?height:38px;[\s\S]*?border-radius:12px 0 0 12px;/);
});

test("compact composer dropdowns escape the footer tool-row clip", () => {
  assert.match(ui, /\.composer-tools:has\(\.menu\.open\)\{ overflow:visible; \}/);
  assert.match(ui, /\.composer-tools \.anchor:has\(\.menu\.open\)\{ z-index:31; \}/);
});

test("native browser split uses the approved gray header and bottom frame", () => {
  assert.match(shell, /const int BrowserTopInset = 38;/);
  assert.match(shell, /_split\.Panel2\.Padding = new Padding\(0, BrowserTopInset, 0, 0\);/);
  assert.match(shell, /Palette\(Color CanvasBg, Color PaneBg, Color BarBg/);
  assert.match(shell, /Color\.FromArgb\(243, 243, 243\), Color\.White, Color\.FromArgb\(243, 243, 243\)/);
  assert.match(shell, /Padding = new Padding\(0, 0, 0, 14\);/);
  assert.match(shell, /BackColor = p\.CanvasBg;/);
  assert.match(shell, /ApplyDwmChromeColor\(p\.CanvasBg\);/);
});

test("hidden compact rail is available from a floating hamburger menu", () => {
  assert.match(ui, /id="railMenuToggle" title="Open navigation menu" aria-label="Open navigation menu" aria-expanded="false"/);
  assert.match(ui, /#railMenuToggle\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?#railMenuToggle\{ display:grid; \}/);
  assert.match(ui, /body\.rail-menu-open #sideRail,[\s\S]*?body\.collapsed\.rail-menu-open #sideRail\{[\s\S]*?display:flex !important; position:fixed; z-index:130; left:8px; top:42px;/);
  assert.match(ui, /\$\("railMenuToggle"\)\?\.addEventListener\("click"/);
  assert.match(ui, /document\.body\.classList\.remove\("rail-expanded","rail-menu-open"\);/);
});

test("new chat and copy conversation live in either the rail or top chrome, never both", () => {
  assert.match(ui, /data-rail="new-chat" title="New chat"/);
  assert.match(ui, /data-rail="copy-chat" title="Copy whole conversation"/);
  assert.match(ui, /\.topbar #newchat,\.topbar #copyall,\.topbar #ctxToggle\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:760px\)\{[\s\S]*?\.topbar #newchat,\.topbar #copyall,\.topbar #ctxToggle\{ display:grid; \}/);
  assert.match(ui, /body\.rail-menu-open \.topbar #newchat,body\.rail-menu-open \.topbar #copyall,body\.rail-menu-open \.topbar #ctxToggle\{ display:none; \}/);
  assert.match(ui, /if\(action==="new-chat"\)\{ newChat\(\); return; \}/);
  assert.match(ui, /if\(action==="copy-chat"\)\{ \$\("copyall"\)\?\.click\(\); return; \}/);
});

test("the rail is grouped, context is wired, and the bottom gap is opaque", () => {
  assert.match(ui, /data-rail="browser"[\s\S]*data-rail="context" title="Context panel"[\s\S]*data-rail="notes"/);
  assert.match(ui, /data-rail="notes"[\s\S]*class="rail-separator"[\s\S]*data-rail="git"[\s\S]*data-rail="recipes"[\s\S]*data-rail="automations"/);
  assert.match(ui, /#sideRail \.rail-separator\{ width:22px; height:1px;/);
  assert.match(ui, /else if\(action==="context"\)\{ \$\("ctxToggle"\)\?\.click\(\); \}/);
  assert.match(ui, /\|\|\(rail==="context"&&document\.body\.classList\.contains\("zone-3"\)\)/);
  assert.match(ui, /\.topbar #newchat,\.topbar #copyall,\.topbar #ctxToggle\{ display:none; \}/);
  assert.match(ui, /body::after,body\.shell::after\{[\s\S]*?height:var\(--approved-bottom-gap\); background:var\(--approved-canvas\); pointer-events:none;/);
});

test("narrow chat contains its header messages and composer without clipping", () => {
  assert.match(ui, /document\.body\.classList\.toggle\("chat-xxs",mainW<560\);/);
  assert.match(ui, /body\.chat-xxs \.topbar\{ padding:0 6px; justify-content:flex-start; \}/);
  assert.match(ui, /body\.chat-xxs \.winctl\{ margin-left:auto; \}/);
  assert.match(ui, /body\.chat-xxs #appForward,[\s\S]*?body\.chat-xxs #ctxToggle\{ display:none; \}/);
  assert.match(ui, /@media\(max-width:700px\)\{[\s\S]*?main,#chat,\.col\{ min-width:0; max-width:100%; overflow-x:hidden; box-sizing:border-box; \}/);
  assert.match(ui, /\.msg-user,\.msg-ai,body\.win-lg \.msg-user,body\.win-lg \.msg-ai\{[\s\S]*?max-width:min\(88%,calc\(100% - 12px\)\);/);
  assert.match(ui, /\.composer-wrap,body\.composer-simple \.composer-wrap,[\s\S]*?\.composer-tools\{ min-width:0; max-width:100%; box-sizing:border-box; \}/);
});

test("workspace card shows the selected API model's real readiness", () => {
  assert.match(ui, /id="brandAbout" role="button" tabindex="0" aria-label="AI readiness"/);
  assert.match(ui, /<path d="m8 12 2\.5 2\.5L16 9"\/>/);
  assert.match(ui, /\.sidehead #footStatus \.dot,\.sidehead #footStatus #statustext\{ display:inline-flex; \}/);
  assert.doesNotMatch(ui, /\.sidehead #footStatus::after\{ content:"Local AI workspace"; \}/);
  assert.match(ui, /function updateReadyStatus\(label,shortLabel\)\{\s*const ready=providerReadyForRun\(state\.provider\|\|"local"\);/);
  assert.match(ui, /\$\("brandAbout"\)\.classList\.toggle\("ready",ready\);/);
});

test("workspace card is borderless and chat search has a leading icon", () => {
  assert.match(ui, /\.sidehead\{ min-height:64px;[\s\S]*?border:0; border-radius:var\(--radius-lg\); \}/);
  assert.match(ui, /<div class="thread-search-wrap">\s*<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"\/><path d="m16 16 4 4"\/><\/svg>\s*<input id="threadSearch"/);
  assert.match(ui, /\.thread-search-wrap svg\{[\s\S]*?left:10px;[\s\S]*?stroke:var\(--dim\);/);
  assert.match(ui, /#threadSearch\{[\s\S]*?padding:0 12px 0 30px;/);
});

test("approved layout keeps gray breathing room below every footer", () => {
  assert.match(ui, /--approved-bottom-gap:20px;/);
  assert.match(ui, /--approved-card:var\(--sidebar\);/);
  assert.match(ui, /\.col\{ width:100%; max-width:none; gap:12px; background:var\(--approved-card\); \}/);
  assert.match(ui, /body,body\.shell\{[\s\S]*?padding:calc\(var\(--approved-topbar-h\) \+ var\(--approved-gap\)\) var\(--approved-gap\) var\(--approved-bottom-gap\) 4px;/);
});

test("approved sidebar follows window width until the user toggles it", () => {
  assert.match(ui, /const shouldCollapseApprovedSidebar=w<=640;\s*document\.body\.classList\.toggle\("collapsed",sidebarManualState===null\?shouldCollapseApprovedSidebar:sidebarManualState\);/);
});

test("model picker includes the local cloud toggle and stays synced", () => {
  assert.match(ui, /id="modelmenu"[\s\S]*id="modelsearch"[\s\S]*id="modelNetMode"[\s\S]*data-net="local"[\s\S]*data-net="online"[\s\S]*id="modellist"/);
  assert.match(ui, /#modelmenu \.model-netseg\{ position:absolute; top:10px; right:10px; z-index:1; \}/);
  assert.match(ui, /\.model-netseg\{[^}]*width:109px;[^}]*grid-template-columns:1fr 1fr;/s);
  assert.match(ui, /#modelmenu input\{[^}]*padding:7px 124px 9px 9px;/s);
  assert.match(ui, /function placeModelNetSeg\(\)\{/);
  assert.match(ui, /if\(menu&&seg&&list&&seg\.parentElement!==menu\) menu\.insertBefore\(seg,list\);/);
  assert.match(ui, /document\.querySelectorAll\("#netmode button,#modelNetMode button"\)\.forEach\(b=>b\.classList\.toggle\("on"/);
  assert.match(ui, /document\.querySelectorAll\("#netmode button,#modelNetMode button"\)\.forEach\(b=>b\.onclick=\(\)=>selectNet\(b\.dataset\.net\)\)/);
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
  assert.match(ui, /\.paste-ico\{[^}]*stroke:currentColor;[^}]*stroke-width:1\.8;/s);
  assert.match(ui, /id="gmailClientPaste"[\s\S]*<svg class="paste-ico" viewBox="0 0 16 16"/);
  assert.match(ui, /id="outlookClientPaste"[\s\S]*<svg class="paste-ico" viewBox="0 0 16 16"/);
  assert.match(ui, /\.msg-foot \.actbtn\{[^}]*width:24px; height:24px;[^}]*touch-action:manipulation;/s);
  assert.match(ui, /\.msg-foot \.actbtn svg\{[^}]*width:14px; height:14px;/s);
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
  assert.match(ui, /\.side-chat-launch\{ position:fixed;[^}]*left:auto; right:4px; top:calc\(100% - var\(--composer-h,106px\) \+ 14px\);[^}]*width:23px; height:23px;[^}]*cursor:ns-resize; touch-action:none;/s);
  assert.doesNotMatch(ui, /body:not\(\.collapsed\) \.side-chat-launch/);
  assert.match(ui, /\.side-chat-panel\{[^}]*top:86px; left:auto; right:14px;[^}]*width:clamp\(228px,23vw,276px\);[^}]*height:clamp\(260px,44dvh,370px\);/s);
  assert.match(ui, /body\.browser-on \.side-chat-panel\{ width:clamp\(216px,21vw,258px\); height:clamp\(250px,40dvh,344px\); \}/);
  assert.match(ui, /@media\(max-width:720px\)\{ \.side-chat-panel\{ width:min\(276px,calc\(100vw - 22px\)\); height:min\(344px,calc\(100dvh - 92px\)\); left:auto; right:11px; \} \}/);
  assert.match(ui, /function sideChatLeftEdge\(\)\{/);
  assert.match(ui, /const launcher=\$\("sideChatToggle"\);[\s\S]*return Math\.max\(8,Math\.round\(\(rect\?\.left\|\|window\.innerWidth\)-width-8\)\);/);
  assert.match(ui, /function applySideChatLauncherPosition\(\)\{/);
  assert.match(ui, /localStorage\.setItem\("boolean_side_chat_launcher_action_top"/);
  assert.match(ui, /"sideChatToggle"\)\.addEventListener\("pointermove"/);
  assert.match(ui, /const latest=sideChatThreads\(\)\[0\];[\s\S]*sideChatThreadId=latest\.id;/);
  assert.match(ui, /peek=1&tail=250/);
  assert.match(ui, /const pos=clampSideChatPosition\(sideChatLeftEdge\(\),top\);/);
  assert.match(ui, /const pos=clampSideChatPosition\(sideChatLeftEdge\(\),top\);[\s\S]*sideChatDragging\.left=pos\.left;/);
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
  assert.match(ui, /\$\("winMax"\)\.ondblclick=\(e\)=>\{/);
  assert.match(ui, /winCmd\("maxtoggle"\);/);
});

test("side chat user bubbles keep readable foreground contrast in dark mode", () => {
  assert.match(ui, /\.side-chat-msg\.user\{[^}]*color:var\(--accent-text\);[^}]*background:var\(--accent\);/s);
  assert.match(ui, /:root\[data-theme="dark"\]\{[\s\S]*?--accent:#ececec; --accent-text:#181818;/);
});

test("native browser keeps a usable split width and auto-fits narrow pages", () => {
  assert.match(shell, /const int chatMin = 300;/);
  assert.match(shell, /const int browserMin = 340;/);
  assert.match(shell, /readonly SplitContainer _split = new\(\) \{ Orientation = Orientation\.Vertical, SplitterWidth = 1 \};/);
  assert.doesNotMatch(shell, /TabIcon\("\\u2014", "Minimize"/);
  assert.doesNotMatch(shell, /TabIcon\("\\u25A1", "Maximize"/);
  assert.doesNotMatch(shell, /case "growContext":\s*GrowForBrowser\(\);/);
  assert.doesNotMatch(shell, /HideBrowserPill\(\);\s*GrowForBrowser\(\);/);
  assert.match(shell, /int browserW = Math\.Clamp\(available \/ 2, browserMin/);
  assert.match(shell, /readonly Panel _browserChrome = new\(\) \{ Dock = DockStyle\.Top, Height = 82 \};/);
  assert.match(shell, /readonly Panel _toolbar = new\(\) \{ Dock = DockStyle\.Top, Height = 28 \};/);
  assert.match(shell, /readonly FlowLayoutPanel _taskBar = new\(\) \{ Dock = DockStyle\.Top, Height = 24,[^}]*AutoScroll = false/);
  assert.match(shell, /Panel _tabBar = new\(\) \{ Dock = DockStyle\.Top, Height = 30 \};/);
  assert.match(shell, /_browserChrome\.Controls\.Add\(_taskBar\);[\s\S]*_browserChrome\.Controls\.Add\(_toolbar\);[\s\S]*_browserChrome\.Controls\.Add\(_tabBar\);[\s\S]*_browserPane\.Controls\.Add\(_browserChrome\);/);
  assert.match(shell, /_tabStrip\.ClientSize\.Width - rightWidth - _addTabBtn\.Width - 18/);
  assert.match(shell, /t\.View\.NavigationCompleted \+= \(_, __\) => AutoFitActiveBrowserIfNarrow\(\);/);
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
