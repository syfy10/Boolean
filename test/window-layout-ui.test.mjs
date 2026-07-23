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

test("collapsed sidebar hides the compact app rail", () => {
  assert.match(ui, /<nav id="sideRail" aria-label="Compact app rail">/);
  assert.match(ui, /#sideRail\{ display:none; width:0; flex:0 0 0; overflow:hidden; opacity:0; pointer-events:none; border-right:0; \}/);
  assert.match(ui, /body\.collapsed #sideRail,\s*body\.collapsed\.rail-expanded #sideRail\{ width:0; flex-basis:0; opacity:0; pointer-events:none; padding:0; border-right:0; \}/);
  for (const action of ["search", "projects", "browser", "git", "recipes", "automations", "notes", "settings"]) {
    assert.match(ui, new RegExp(`data-rail="${action}"`));
  }
  assert.doesNotMatch(ui, /data-rail="sidechat"/);
  assert.doesNotMatch(ui, /data-rail="toggle"/);
  assert.doesNotMatch(ui, /body\.collapsed #sideRail\{ width:48px; flex-basis:48px; opacity:1; pointer-events:auto; \}/);
  assert.doesNotMatch(ui, /body\.collapsed\.rail-expanded #sideRail\{ width:210px;/);
  assert.match(ui, /<div class="rail-brand sidebar-brand" aria-hidden="true">[\s\S]*<div class="brand-name">Boolean<\/div>[\s\S]*id="railBrandReady"[\s\S]*id="railBrandDot"[\s\S]*id="railBrandStatus"[\s\S]*class="brand-about"/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-brand\{ display:flex; \}/);
  assert.match(ui, /\.rail-brand\{[^}]*min-height:52px;[^}]*padding:7px 8px;/s);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-main\{ padding:4px 7px; \}/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-footer\{ flex-direction:row; align-items:stretch; gap:0; border-top:1px solid var\(--border\); padding:0; \}/);
  assert.match(ui, /if\(\$\("railBrandDot"\)\) \$\("railBrandDot"\)\.className="dot"\+\(ready\?"":" down"\);/);
  assert.match(ui, /if\(\$\("railBrandStatus"\)\) \$\("railBrandStatus"\)\.textContent=text;/);
  assert.match(ui, /body\.collapsed\.rail-expanded \.rail-label\{ display:block; \}/);
  assert.match(ui, /id="panelToggle"[\s\S]*id="appBack"[\s\S]*id="netmode"/);
  assert.match(ui, /id="panelToggle" title="Show projects and chats" aria-label="Show projects and chats"/);
  assert.doesNotMatch(ui, /body\.collapsed \.topbar #panelToggle/);
  assert.match(ui, /data-rail="projects" title="Projects and chats" aria-label="Projects and chats"[\s\S]*<span class="rail-label">Projects<\/span>/);
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
  assert.match(ui, /document\.body\.classList\.toggle\("collapsed"\);\s*if\(!document\.body\.classList\.contains\("collapsed"\) && SHELL\) hostPost\(\{type:"window",action:"growContext"\}\);\s*scheduleResponsiveClasses\(\);\s*syncPanelButtons\(\);/);
  assert.match(ui, /if\(action==="projects"\)\{ document\.body\.classList\.remove\("collapsed"\); syncPanelButtons\(\); return; \}/);
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
});

test("recipes use one responsive workspace scroll instead of clipped nested panes", () => {
  assert.match(
    ui,
    /\.recipes-panel\{[^}]*overflow-x:hidden;[^}]*overflow-y:auto;/s
  );
  assert.match(
    ui,
    /\.recipes-shell\{[^}]*min-height:100%;[^}]*align-items:start;/s
  );
  assert.match(
    ui,
    /\.recipe-grid\{[^}]*overflow:visible;/s
  );
  assert.match(
    ui,
    /body\.recipes-compact\.recipes-open \.recipes-detail,\s*body\.browser-on\.recipes-open \.recipes-detail\{[^}]*overflow:visible;/s
  );
  assert.match(ui, /\.recipe-card\{[^}]*min-height:64px;/s);
  assert.match(
    ui,
    /\.recipe-actions\{[^}]*position:static;/s
  );
  assert.match(ui, /@media\(max-width:620px\)\{[\s\S]*?\.recipes-shell\{ grid-template-columns:1fr; \}/s);
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

test("settings and account stay inside the main footer controls", () => {
  assert.doesNotMatch(ui, /<aside id="sidebar">[\s\S]*<div class="sidefoot-nav">[\s\S]*id="topSettings"/);
  assert.doesNotMatch(ui, /composer-footer-nav/);
  assert.match(ui, /<div class="app-footer" aria-label="App footer">\s*<div class="sidefoot-nav" aria-label="Settings and account">[\s\S]*id="topSettings" title="Settings" aria-label="Settings"[\s\S]*id="cloudSignIn" title="Sign in to your Boolean account" aria-label="Account"/);
  assert.match(ui, /\.sidefoot-nav\{[^}]*display:flex;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.match(ui, /--app-footer-h:28px/);
  assert.match(ui, /\.app-footer\{[^}]*position:absolute;[^}]*bottom:0;[^}]*height:var\(--app-footer-h\);[^}]*border-top:1px solid color-mix\(in srgb,var\(--border\) 45%,transparent\);[^}]*background:color-mix\(in srgb,var\(--bg\) 96%,transparent\);/s);
  assert.match(ui, /\.app-footer \.sidefoot-nav\{ display:flex; \}/);
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

test("chat scrolls behind the transparent action strip but not the input", () => {
  assert.match(
    ui,
    /main::after\{[^}]*bottom:var\(--app-footer-h\);[^}]*height:var\(--composer-h,106px\);[^}]*background:var\(--bg\);/s
  );
  assert.match(ui, /body\.composer-simple main::after\{[^}]*height:max\(0px,calc\(var\(--composer-h,106px\) - 36px\)\);/s);
  assert.match(ui, /body\.composer-simple \.composer-top-strip\{[^}]*min-height:34px;[^}]*pointer-events:auto;/s);
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

test("project status stays in the compact footer without a gray pill", () => {
  assert.match(ui, /<div class="app-footer" aria-label="App footer">[\s\S]*id="cmdProjectStatus"/);
  assert.match(ui, /\.workspace-tabs \.cmd-status\{ display:none; \}/);
  assert.match(ui, /\.app-footer \.cmd-chip\{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/s);
  assert.match(ui, /\.app-footer #cmdProjectStatus #cmdFilesChip,\s*\.app-footer #cmdProjectStatus #cmdServerChip\{ display:none; \}/s);
  assert.doesNotMatch(ui, /insertAdjacentElement\("afterend",status\)/);
  assert.doesNotMatch(ui, /function placeProjectStatusChip/);
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
  assert.match(ui, /\.side-chat-launch\{ position:fixed;[^}]*left:auto; right:4px; top:50%;[^}]*width:38px; height:38px;[^}]*cursor:ns-resize; touch-action:none;/s);
  assert.doesNotMatch(ui, /body:not\(\.collapsed\) \.side-chat-launch/);
  assert.match(ui, /\.side-chat-panel\{[^}]*top:86px; left:auto; right:14px;[^}]*width:clamp\(228px,23vw,276px\);[^}]*height:clamp\(260px,44dvh,370px\);/s);
  assert.match(ui, /body\.browser-on \.side-chat-panel\{ width:clamp\(216px,21vw,258px\); height:clamp\(250px,40dvh,344px\); \}/);
  assert.match(ui, /@media\(max-width:720px\)\{ \.side-chat-panel\{ width:min\(276px,calc\(100vw - 22px\)\); height:min\(344px,calc\(100dvh - 92px\)\); left:auto; right:11px; \} \}/);
  assert.match(ui, /function sideChatLeftEdge\(\)\{/);
  assert.match(ui, /function applySideChatLauncherPosition\(\)\{/);
  assert.match(ui, /localStorage\.setItem\("boolean_side_chat_launcher_top"/);
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

test("native browser keeps a usable split width and auto-fits narrow pages", () => {
  assert.match(shell, /const int chatMin = 260;/);
  assert.match(shell, /const int browserMin = 480;/);
  assert.match(shell, /const int preferredBrowserW = 560;/);
  assert.match(shell, /int browserW = Math\.Clamp\(\(int\)\(available \* 0\.46\), browserMin/);
  assert.match(shell, /readonly Panel _browserChrome = new\(\) \{ Dock = DockStyle\.Top, Height = 112 \};/);
  assert.match(shell, /readonly FlowLayoutPanel _taskBar = new\(\) \{ Dock = DockStyle\.Top, Height = 34,[^}]*AutoScroll = false/);
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
