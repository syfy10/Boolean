import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("Email Recipes include connected-mail and cleanup workflows", () => {
  const html = read("../src/ui.html");
  for (const id of [
    "email-briefing",
    "email-current",
    "email-needs-reply",
    "email-draft",
    "email-tasks",
    "email-important",
    "email-attachments",
    "email-clean-sender",
    "email-cleanup"
  ]) {
    assert.match(html, new RegExp(`id:\\"${id}\\"`));
  }
  assert.match(html, /Maximum to scan/);
  assert.match(html, /name="emailCleanupScope" value="inbox" checked/);
  assert.match(html, /name="emailCleanupScope" value="all"/);
  assert.match(html, /Inbox only/);
  assert.match(html, /Includes archived mail/);
  assert.match(html, /scope: "\+selectedEmailCleanupScope\(\)/);
  assert.match(html, /value="5000"/);
  assert.match(html, /Nothing moves during the scan/);
  assert.match(html, /required approval card for the reviewed batch/);
  assert.match(html, /saved cleanup plan and connected account belong to the same mailbox/);
  assert.match(html, /browserMatchesAccount/);
  assert.match(html, /Ignore the browser page for this connected-account cleanup/);
  assert.match(html, /do not describe the connected account as matching the visible browser account/);
  assert.match(html, /Pass this exact value as account_id to every email tool call/);
  assert.match(html, /email\.accounts/);
  assert.match(html, /data-email-account-id/);
  assert.match(html, /Add account/);
});

test("built-in browser switches to email actions for Gmail and Outlook", () => {
  const html = read("../src/ui.html");
  const shell = read("../shell/Program.cs");
  for (const action of ["email_summary", "email_reply", "email_tasks", "email_save", "email_clean", "email_more"]) {
    assert.match(html, new RegExp(action));
  }
  assert.match(html, /mail\.google\.com/);
  assert.match(html, /outlook\.office365\.com/);
  assert.match(shell, /mail\.google\.com/);
  assert.match(shell, /outlook\.office365\.com/);
  assert.match(shell, /ChromeTaskSpecs\(string\? url\) => IsEmailPage\(url\)/);
  assert.match(shell, /PushChromeState\(\)/);
});

test("email cleanup exposes preview, reversible Trash, and Undo only", () => {
  const tools = read("../src/tools.js");
  const email = read("../src/email.js");
  assert.match(tools, /name: "email_cleanup_preview"/);
  assert.match(tools, /name: "email_cleanup_trash"/);
  assert.match(tools, /name: "email_cleanup_undo"/);
  assert.doesNotMatch(tools, /name: "email_cleanup_(?:delete|purge)"/);
  assert.doesNotMatch(email, /users\/messages\/batchDelete/);
});

test("email connection UI supports one-click managed setup and manual fallback", () => {
  const html = read("../src/ui.html");
  const server = read("../src/server.js");
  assert.match(html, /Connect once with Google or Microsoft/);
  assert.match(html, /Advanced OAuth setup/);
  assert.match(html, /gmailManualConnect/);
  assert.match(html, /outlookManualConnect/);
  assert.match(html, /gmailClientSecret/);
  assert.match(html, /paired client secret/);
  assert.match(html, /clientSecret/);
  assert.match(html, /\/api\/email\/test/);
  assert.match(html, /data-connect-email/);
  assert.match(server, /mode === "manual"/);
  assert.match(server, /emailOAuthRedirectUri/);
  assert.match(server, /emailOAuthCallbackRequest/);
});

test("connection failures remain visible and offer reconnect actions", () => {
  const html = read("../src/ui.html");
  const server = read("../src/server.js");
  assert.match(html, /connectorConnectionNotice/);
  assert.match(html, /needs-attention/);
  assert.match(html, /Reconnect required/);
  assert.match(html, /Try again/);
  assert.match(html, /connectorNotice\(.*"error"/s);
  assert.match(server, /lastTestStatus:\s*"error"/);
  assert.match(server, /needsReconnect:\s*true/);
  assert.match(server, /lastTestStatus:\s*"ok"/);
  assert.match(server, /needsReconnect:\s*false/);
});

test("email recipes keep the selected AI and start in a fresh chat", () => {
  const html = read("../src/ui.html");
  assert.doesNotMatch(html, /id="emailLocalOnly"/);
  assert.doesNotMatch(html, /Use local AI for email content/);
  assert.match(html, /currentAiLabel\(\)/);
  assert.match(html, /await startWorkflowTask\(recipe,prompt,ai\)/);
  assert.match(html, /await newChat\(\{preserveWorkspace:true\}\)/);
  assert.match(html, /loadWorkflowDraft\(recipe,prompt\)/);
});

test("open-email recipes can use the signed-in visible browser session", () => {
  const html = read("../src/ui.html");
  assert.match(html, /function browserEmailActionSupported/);
  assert.match(html, /\["summary","reply","tasks"\]/);
  assert.match(html, /Signed-in browser session/);
  assert.match(html, /Use signed-in email open in Boolean browser/);
  assert.match(html, /function updateEmailBrowserStatus/);
  assert.match(html, /Gmail or Outlook in Boolean's browser/);
  assert.match(html, /First call visible_browser_read/);
  assert.match(html, /use visible_browser_draft_email/);
  assert.match(html, /if\(!accounts\.length&&!browserEmailActionSupported\(recipe\)\)/);
  assert.match(html, /if\(!account&&!browserOnly\)/);
  assert.match(html, /if\(!\$\("emailUseBrowser"\)\?\.checked\)/);
  assert.match(html, /Open Gmail or Outlook in Boolean's browser and open the email first/);
});

test("automatic AI recovery avoids paid API key providers", () => {
  const html = read("../src/ui.html");
  assert.match(html, /const DIRECT_API_PROVIDERS=new Set\(\["glm","openai","google","claude","xai","deepseek","qwen","baidu","bytedance","kimi","customApi"\]\)/);
  assert.match(html, /function directProviderRequiresExplicitPick\(provider\)/);
  assert.match(html, /providerReadyForRun\(current\)&&!directProviderRequiresExplicitPick\(current\)/);
  assert.match(html, /const safeOrder=\["zaiCoding","local"\]/);
  assert.match(html, /Pick .* from the AI menu to use that API key/);
  assert.match(html, /Boolean will not switch to it automatically/);
  assert.match(html, /markExplicitProviderChoice\(prov\);[\s\S]*JSON\.stringify\(\{provider:prov,model\}\)/);
  assert.match(html, /if\(!prov&&\(providerReadyForRun\("zaiCoding"\)\|\|keys\.zaiCoding\)\) prov="zaiCoding"/);
  assert.doesNotMatch(html, /const cloudOrder=\["zaiCoding","glm","openai","claude","customApi"\]/);
});

test("email cleanup follow-up offers a clear Move to Trash action", () => {
  const html = read("../src/ui.html");
  assert.match(html, /function cleanupSuggestionFromText\(text\)/);
  assert.match(html, /function cleanupApprovalDetails\(text\)/);
  assert.match(html, /function showCleanupApprovalCard\(details\)/);
  assert.match(html, /Move next batch to Trash/);
  assert.match(html, /move next batch to trash/);
  assert.match(html, /Keep email unchanged/);
  assert.match(html, /required approval step/);
  assert.match(html, /Nothing is permanently deleted/);
  assert.match(html, /completed batch can be undone/);
  assert.match(html, /After the preview, Boolean shows a required approval card/);
  assert.match(html, /cleanupApprovalDetails\(text\)[\s\S]*showCleanupApprovalCard\(cleanupApproval\)/);
  assert.match(html, /emailCleanup\?'Move to Trash':'Allow'/);
});

test("workspace switches hard-close Settings before showing Recipes", () => {
  const html = read("../src/ui.html");
  assert.match(html, /panel\.classList\.remove\("open","settings-detail","settings-filtering"\)/);
  assert.match(html, /document\.body\.classList\.remove\("settings-open"\)/);
  assert.match(html, /if \(!\["git","automations"\]\.includes\(ws\)\) closeSettingsPanel\(\)/);
});

test("opening Settings closes Recipes instead of stacking panels", () => {
  const html = read("../src/ui.html");
  assert.match(html, /function prepareWorkspaceForSettings\(sec\)/);
  assert.match(html, /closeWorkspaceTab\(activeWsTab\)/);
  assert.match(html, /markWorkspaceTab\(settingsWs\|\|"chat"\)/);
  assert.match(html, /if\(opening\) prepareWorkspaceForSettings\(null\)/);
  assert.match(html, /function openSettings\(sec,\{remember=true\}=\{\}\)\{\s*prepareWorkspaceForSettings\(sec\)/);
});

test("Recipes explain effects, prerequisites, and action safety before starting", () => {
  const html = read("../src/ui.html");
  assert.match(html, /function genericRecipeClarity\(recipe\)/);
  assert.match(html, /May edit the current project and run focused verification/);
  assert.match(html, /Read-only planning or verification/);
  assert.match(html, /Prepares an automation and asks for any missing schedule details/);
  assert.match(html, /Attach the screenshot in chat after loading this Recipe/);
  assert.match(html, /Open the page you want Boolean to use/);
  assert.match(html, /Confirm destructive or external actions/);
  assert.match(html, /Normal in-project edits and verification are allowed/);
  assert.match(html, /Review in chat/);
  assert.doesNotMatch(html, /<button type="button" id="recipeFill">Fill chat<\/button>/);
});

test("Start Building reports the actual selected AI instead of fake ready models", () => {
  const html = read("../src/ui.html");
  assert.match(html, /const selectedAi=currentAiLabel\(\)/);
  assert.match(html, /Current selection/);
  assert.doesNotMatch(html, /GLM 5\.2 Local - Coding OK/);
  assert.doesNotMatch(html, /Qwen Local - General OK/);
  assert.doesNotMatch(html, /GPT Cloud OK/);
  assert.doesNotMatch(html, /Claude Cloud OK/);
});
