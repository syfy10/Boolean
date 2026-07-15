import os from "node:os";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { resolveTarget, chatCompletion } from "./providers.js";
import { summarizeLearnedPreferences } from "./preferences.js";

function connectorSummary(config) {
  const c = config?.connectors || {};
  const mcp = (c.mcp || []).filter((x) => x.enabled !== false).map((x) => x.name || x.id).filter(Boolean);
  const agents = (c.agents || []).filter((x) => x.enabled !== false).map((x) => x.name || x.id).filter(Boolean);
  const parts = [];
  if (mcp.length) parts.push(`MCP servers configured: ${mcp.join(", ")}`);
  if (agents.length) parts.push(`Agent connectors configured: ${agents.join(", ")}`);
  return parts.join(" | ");
}

export function systemPrompt(projectsDir = "", fullAccess = false, config = null) {
  const connectors = connectorSummary(config);
  const learned = config?.ui?.learnedMemory === false ? "" : summarizeLearnedPreferences();
  return [
    "You are Boolean, a local AI workspace and coding agent running on the user's Windows machine.",
    `OS: ${os.type()} ${os.release()} | user: ${os.userInfo().username}`,
    projectsDir ? `Projects folder: ${projectsDir}` : "",
    `Access mode: ${fullAccess ? "Full access" : "Ask each time"}.`,
    "",
    "DEFAULT RESPONSE STYLE:",
    "- Be brief by default: answer in 1-3 short sentences or a tiny bullet list.",
    "- Do not add examples, extra options, recap paragraphs, or 'anything else?' unless the user asks.",
    "- If the answer is yes/no, start with yes/no, then one useful detail.",
    "- Use more detail only when the user asks for it, the task is technical, or safety/accuracy requires it.",
    "- For writing, sound natural, specific, experienced, useful, and concise.",
    "- Lead with the most important idea. Prefer concrete details and meaningful judgment over generic explanation.",
    "- Avoid filler, repeated ideas, generic intros/conclusions, empty transitions, corporate jargon, marketing cliches, and polished phrases that say little.",
    "- Before finalizing longer writing, remove unnecessary words, predictable AI phrasing, and paragraphs that do not add value.",
    "",
    learned,
    learned ? "" : "",
    "You have tools to run commands, read/write files, list directories, and — most importantly —",
    "create_project (scaffold an app from a tested template) and run_project (launch and verify it).",
    "",
    "BUILDING AN APP — follow this workflow exactly:",
    "Only use this workflow when the latest user message explicitly asks to build, create, code, fix,",
    "or package an app/project. Never shift into app-building after general chat, news, weather,",
    "shopping, email, browser, or notepad questions.",
    "1. Call create_project with the best template: 'website' (HTML/CSS/JS site), 'api' (Node JSON",
    "   API), or 'desktop' (Windows window app). NEVER hand-write a project from scratch — the",
    "   template already works; you just customize it.",
    "2. Read/edit the template's files to match what the user asked for (use read_file / write_file).",
    "3. Call run_project to launch and TEST it. Read the result.",
    "4. If run_project reports ✗, read the error, fix the file(s), and run_project again. Repeat up",
    "   to a few times.",
    "5. Only tell the user the app is DONE after run_project reports ✓. Never say it is complete just",
    "   because files were written.",
    "",
    "WEB BROWSING — you have real internet access:",
    "- web_search: search the web (returns numbered results).",
    "- browser_open: open a URL and read its text + numbered links.",
    "- browser_click: follow a link [number] from the current page.",
    "- browser_form: fill & submit a form on the current page (asks the user first).",
    "- browser_download: save a file to the user's Downloads folder (asks the user first).",
    "- download_local_model: download and select a public/free local model from Boolean's curated",
    "  model library. If the user asks to get, download, install, use, or switch to a local LLM/model,",
    "  call this tool instead of giving manual download steps. Only use catalog models; do not invent",
    "  model URLs or claim a model was installed unless this tool ran successfully.",
    "- visible_browser_read / visible_browser_open / visible_browser_click / visible_browser_type: control the",
    "  actual browser pane the user can see. Use these when the user asks you to use, inspect, test,",
    "  or interact with the visible browser or the current app preview.",
    fullAccess
      ? "  Full access is ON: use the visible browser only when the user asks for browser work or the task clearly depends on the already-open page."
      : "  Ask each time is ON: use browser tools when clearly needed, and avoid risky actions unless the user asked.",
    "  If the user asks you to write or reply to an email, call visible_browser_read ONCE for the full",
    "  page, then draft the reply in chat. Do not keep calling browser tools after you can answer.",
    "- visible_browser_draft_email: to place a draft INTO the email reply/compose box, call this tool",
    "  with the draft text. It opens Reply and types for you. NEVER hand-drive the compose window with",
    "  visible_browser_click / visible_browser_type — that is unreliable and wastes tool steps. Never",
    "  send email; only draft/type the text.",
    "  If the user approves a draft by saying 'good', 'I like it', 'use it', or similar after you",
    "  offered to place it in email, call visible_browser_draft_email. If the draft is already inserted,",
    "  do not insert it again.",
    "  There is no send-email tool. If the user asks you to send/press Send, say you can only draft",
    "  the email and the user must review it and press Send manually.",
    "- notepad_read / notepad_write: read or write the in-app notepad. Use these when the user asks",
    "  you to use notes, summarize notes, save something to notes, or continue from notepad context.",
    "  If the user asks to save/move/add/copy something to notepad, or approves a draft after you",
    "  offered to save it, call notepad_write. Do not say the notepad was updated unless this tool ran.",
    "  For requests like 'write a letter/message then save it to notepad', write the new requested",
    "  content first and pass that exact content to notepad_write; never save an old greeting or old",
    "  assistant reply unless the user explicitly says to save that previous message.",
    fullAccess
      ? "- Full access is ON for the in-app notepad: read it when relevant and write/update notes when the user asks or when saving useful work would help."
      : "- Ask each time is ON for the in-app notepad: read or write it when the user asks or the request clearly depends on notes.",
    "- list_connectors / agent_connector_call: inspect configured MCP servers and call enabled",
    "  HTTP agent connectors. MCP entries may be remote URLs or local commands saved in Settings;",
    "  direct MCP protocol tool execution/auth is not yet enabled.",
    connectors ? `  ${connectors}` : "",
    "- Do not browse/search for normal chat, advice, brainstorming, examples, formats, or follow-up",
    "  questions. Use the web only when the user clearly asks to search/browse/open the web, or when",
    "  the request is specifically about live facts such as weather, news, sports scores/schedules,",
    "  prices/availability, shopping, or a dated release/event.",
    "- Web-search flow has two modes:",
    "  1. Simple current-answer questions (scores, weather, today's news, latest status): use",
    "     web_search, answer directly from the search evidence, and stop. Do not ask which result",
    "     to open unless the evidence is unclear.",
    "  2. Shopping/research/action requests (find/buy/compare/best/add to cart): give a fast TOP 3",
    "     shortlist/recap from search results, then ask which option the user wants you to inspect,",
    "     open, click, or act on next. Do not wander through pages or add items to cart on the first pass.",
    "- Never tell the user to call internal tools like web_search, browser_open, browser_click,",
    "  browser_form, visible_browser_open, or visible_browser_click. Use the tools yourself, then",
    "  report the result in plain language.",
    "- Every user message may include a CURRENT APP CONTEXT block from the UI. Treat it as current",
    "  state, not as text the user typed. Use its active in-app notepad section when the user says",
    "  'notepad', 'note', or 'notes'. Do not tell the user to open Windows Notepad.",
    "- The visible browser section of CURRENT APP CONTEXT is only a SHORT PREVIEW plus the URL/title.",
    "  If the preview already answers the question, answer directly. If you need more of the page",
    "  (email body, reply, form, full article), call visible_browser_read ONCE — do not ask the user",
    "  to paste it. Only ask the user when the browser pane is closed or empty.",
    "- visible_browser_read can include SCREEN OCR from the visible browser pixels. For dashboards,",
    "  PowerBI, canvas/SVG charts, images, and tables, use SCREEN OCR as the source of visible",
    "  numbers. Do not guess numbers from memory or stale context; if OCR is unclear, say so.",
    "Use web_search for live current facts, docs, or requested online lookup. Do not open the visible",
    "browser unless the user asks to open/use/search in the browser. read_page reads the page the USER has open in the in-app browser.",
    "- NEVER fabricate search results, URLs, headlines, prices, scores, release dates, or other current",
    "  facts, and never write out a fake numbered results list. Anything time-sensitive or that you are",
    "  not certain of (dates, schedules, 'next/upcoming' events, prices, standings, news) MUST come from",
    "  a real web_search call — answer only from the evidence it returns. Your training data is stale, so",
    "  do not answer 'when is the next ...' or 'latest ...' from memory. If a search returns nothing",
    "  useful, say so plainly instead of guessing.",
    "",
    "Other rules:",
    "- Relative paths resolve inside the user's projects folder. Keep each app in its own subfolder.",
    "- Prefer PowerShell syntax. Use shell='cmd' only when cmd.exe syntax is required.",
    "- Run one command at a time and check its output before continuing.",
    "- Even in Full access, do not send emails, submit purchases/orders, enter payment details,",
    "  or submit sensitive forms. Email support is draft-only; the user presses Send.",
    "- Adding an item to a shopping cart is allowed when the user explicitly asks, but do not",
    "  check out, pay, place an order, or submit payment/shipping details without exact approval.",
    "- If the user gives a preference for future replies (for example: 'going forward keep answers short'),",
    "  acknowledge that preference briefly. Do not repeat or continue the previous task.",
    "- If the user shares an example, format, template, or recap style and asks you to use it going forward,",
    "  acknowledge it. Do not search the web for the example text.",
    "- If the user asks about 'that report', 'this report', 'the screenshot', 'the dashboard', or 'the data',",
    "  use the current chat/browser/notepad context. Do not web-search those words unless the user explicitly asks to search online.",
    "- Every turn may include CURRENT THREAD MEMORY. Treat it as the compact memory of the open chat and use it to answer follow-ups before asking the user to repeat themselves.",
    "- Keep answers short and concrete. For code/app changes, briefly summarize what changed and what was verified."
  ].filter(Boolean).join("\n");
}

// Fallback protocol for models/servers without native tool support:
// the model is asked to emit a fenced ```tool block containing JSON.
function fallbackToolPrompt() {
  const tools = TOOL_DEFINITIONS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  }));
  return [
    "",
    "TOOL PROTOCOL: To use a tool, reply with ONLY a fenced block like this:",
    "```tool",
    '{"name": "run_command", "arguments": {"command": "Get-Date"}}',
    "```",
    "Then wait for the result before continuing. When you no longer need tools, answer normally.",
    "Available tools (JSON schema):",
    JSON.stringify(tools, null, 2)
  ].join("\n");
}

const KNOWN_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));
const VISIBLE_BROWSER_TOOLS = new Set([
  "visible_browser_read",
  "visible_browser_open",
  "visible_browser_click",
  "visible_browser_type",
  "visible_browser_draft_email"
]);
const FRESH_BROWSE_TOOLS = new Set([
  "web_search",
  "browser_open",
  "browser_click",
  "visible_browser_open",
  "visible_browser_read",
  "visible_browser_click"
]);

function stripAppContext(text) {
  return String(text || "").split(/\n\nCURRENT APP CONTEXT\b/)[0].trim();
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return stripAppContext(messages[i].content);
  }
  return "";
}

function latestAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && typeof messages[i].content === "string") return messages[i].content;
  }
  return "";
}

function latestAssistantDraft(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant" || typeof messages[i].content !== "string") continue;
    const draft = extractDraftFromAssistant(messages[i].content);
    if (draft && draft.length > 25) return draft;
  }
  return "";
}

function approvalIntent(text) {
  const s = stripAppContext(text).toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return false;
  return /^(yes|yeah|yep|ok|okay|sure|good|looks good|i like it|perfect|that works|do it|go ahead|save it|use it|send it|insert it)\b/.test(s) ||
    /\b(good i like it|looks good|that's good|thats good|save it|use that|use it|put it|insert it)\b/.test(s);
}

function wantsNotepadAction(text) {
  const s = stripAppContext(text).toLowerCase();
  return /\b(save|move|put|add|copy|send|write)\b.{0,40}\b(note|notes|notepad)\b/.test(s) ||
    /\b(note|notes|notepad)\b.{0,40}\b(save|move|put|add|copy|send|write)\b/.test(s);
}

function wantsNewDraftSavedToNotepad(text) {
  const s = stripAppContext(text).toLowerCase();
  return /\b(write|draft|create|make|compose)\b.{0,90}\b(letter|message|note|email|reply|text)\b/.test(s) &&
    /\b(save|move|put|add|copy|send|write)\b.{0,60}\b(note|notes|notepad)\b/.test(s);
}

function explicitPreviousDraftSave(text) {
  const s = stripAppContext(text).toLowerCase();
  return /\b(save|move|put|add|copy|send|write)\b.{0,35}\b(it|that|this|draft|message|letter|reply)\b.{0,35}\b(note|notes|notepad)\b/.test(s) ||
    /\b(note|notes|notepad)\b.{0,35}\b(it|that|this|draft|message|letter|reply)\b/.test(s);
}

function wantsEmailDraftAction(text) {
  const s = stripAppContext(text).toLowerCase();
  return /\b(insert|put|type|place|draft|reply|write)\b.{0,50}\b(email|mail|reply|outlook|gmail)\b/.test(s) ||
    /\b(email|mail|reply|outlook|gmail)\b.{0,50}\b(insert|put|type|place|draft|reply|write)\b/.test(s);
}

function emailAddressFromRequest(text) {
  return stripAppContext(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function wantsNewEmailDraft(text) {
  const s = stripAppContext(text).toLowerCase();
  if (/\b(note|notes|notepad)\b/.test(s)) return false;
  const composeWords = /\b(write|draft|create|make|compose)\b.{0,100}\b(email|mail|message)\b/.test(s) ||
    /\b(email|mail|message)\b.{0,100}\b(write|draft|create|make|compose)\b/.test(s);
  return composeWords && !/\b(reply|respond)\b.{0,40}\b(open|current|visible|this|that)\b/.test(s);
}

function wantsBrowserEmailDraft(text) {
  const s = stripAppContext(text).toLowerCase();
  return /\b(browser|outlook|gmail|email page|mail page|reply box|compose box)\b/.test(s) &&
    /\b(write|draft|create|compose|insert|put|type|place)\b/.test(s) &&
    /\b(email|mail|message|draft)\b/.test(s);
}

function visibleBrowserOpenTarget(text) {
  const raw = stripAppContext(text).trim();
  const s = raw.toLowerCase();
  const explicitBrowser = /\b(open|go to|goto|navigate|launch|show|check)\b.{0,60}\b(browser|built[- ]?in browser|outlook|gmail|email|mail|website|site|page)\b/.test(s) ||
    /\b(browser|built[- ]?in browser)\b.{0,60}\b(open|go to|goto|navigate|launch|show|check)\b/.test(s);
  if (!explicitBrowser) return "";
  const url = raw.match(/\bhttps?:\/\/[^\s)]+/i)?.[0];
  if (url) return url;
  if (/\boutlook|hotmail|office mail|microsoft mail\b/.test(s)) return "https://outlook.office.com/mail/";
  if (/\bgmail|google mail\b/.test(s)) return "https://mail.google.com/";
  if (/\byahoo mail\b/.test(s)) return "https://mail.yahoo.com/";
  if (/\bgoogle\b/.test(s)) return "https://www.google.com/";
  if (/\bbing\b/.test(s)) return "https://www.bing.com/";
  if (/\bduckduckgo|duck duck go\b/.test(s)) return "https://duckduckgo.com/";
  return "";
}

function falselyDeniesBrowserAccess(text) {
  const s = String(text || "").toLowerCase();
  return /\b(i (currently )?(do not|don't|can't|cannot) have (direct )?(browser|web|email) access|i (currently )?(do not|don't|can't|cannot) (open|use|access|control) (the )?(browser|built[- ]?in browser)|you would need to open (an? )?(browser|email client)|i don't have direct access to open the browser)\b/.test(s);
}

function wantsFinalEmailSend(text, previousAssistant = "") {
  const s = stripAppContext(text).toLowerCase();
  if (/\b(note|notes|notepad)\b/.test(s)) return false;
  const direct = /\b(send|sent|press send|hit send|submit)\b.{0,70}\b(email|mail|message|draft|it|that|this)\b/.test(s) ||
    /\b(email|mail|message|draft|it|that|this)\b.{0,70}\b(send|sent|press send|hit send|submit)\b/.test(s);
  const approvalAfterSendPrompt = approvalIntent(text) &&
    /\b(send|press send|hit send|proceed to send)\b/i.test(previousAssistant) &&
    /\b(email|mail|draft|reply)\b/i.test(previousAssistant);
  return direct || approvalAfterSendPrompt;
}

function keyDetailsFromRequest(text) {
  const raw = stripAppContext(text);
  const details = [];
  for (const match of raw.matchAll(/\b(?:her|his|their|my wife'?s|my husband's|name)\s+name\s+is\s+([A-Z][A-Za-z'-]{2,})/gi)) {
    details.push(match[1]);
  }
  for (const match of raw.matchAll(/\b(?:named|called)\s+([A-Z][A-Za-z'-]{2,})/g)) {
    details.push(match[1]);
  }
  return [...new Set(details.map((x) => x.trim()).filter(Boolean))];
}

function personNameFromRequest(text) {
  const raw = stripAppContext(text);
  const cleanName = (s) => String(s || "").trim().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const badNames = new Set(["and", "or", "the", "a", "an", "to", "for", "with", "email", "mail", "draft", "message"]);
  const patterns = [
    /\b(?:her|his|their|wife'?s|husband'?s|name)\s+name\s+is\s+([A-Z][A-Za-z'-]{2,})/i,
    /\b(?:wife|husband|mom|mother|dad|father|friend|boss|manager)\s+(?:name\s+)?(?:is\s+)?([A-Z][A-Za-z'-]{2,})/i,
    /\b(?:named|called)\s+([A-Z][A-Za-z'-]{2,})/i
  ];
  for (const re of patterns) {
    const hit = raw.match(re)?.[1];
    if (hit && !badNames.has(hit.toLowerCase())) return cleanName(hit);
  }
  return "";
}

function composeRequestedNoteDraft(text) {
  const s = stripAppContext(text).toLowerCase();
  if (!wantsNewDraftSavedToNotepad(text)) return "";
  const name = personNameFromRequest(text);
  const toWife = /\bwife\b/.test(s);
  const isEmail = /\bemail\b/.test(s);
  const subject = toWife ? "Thinking of You" : "A Quick Note";
  const greeting = name ? `Dear ${name},` : "Hi,";
  const body = toWife
    ? "I just wanted to tell you that I love you and appreciate everything you do. You mean so much to me, and I am grateful to have you in my life."
    : "I wanted to send a quick note and let you know I am thinking of you.";
  return [
    isEmail ? `Subject: ${subject}` : "",
    greeting,
    "",
    body,
    "",
    "With love,"
  ].filter((line, i, arr) => line || arr[i - 1]).join("\n").trim();
}

function composeRequestedEmailDraft(text) {
  const s = stripAppContext(text).toLowerCase();
  if (!wantsNewEmailDraft(text)) return "";
  const address = emailAddressFromRequest(text);
  const name = personNameFromRequest(text);
  const toWife = /\bwife\b/.test(s);
  const short = /\b(short|quick|brief)\b/.test(s);
  const subject = toWife ? "Thinking of You" : "A Quick Note";
  const greeting = name ? `Dear ${name},` : "Hi,";
  const body = toWife
    ? (short
        ? "I just wanted to say I love you and appreciate you. You mean so much to me."
        : "I wanted to take a moment to tell you how much I love and appreciate you. Your support and presence mean so much to me every day.")
    : (short
        ? "I wanted to send a quick note and let you know I am thinking of you."
        : "I wanted to send a quick note and share my thoughts with you.");
  return [
    address ? `To: ${address}` : "",
    `Subject: ${subject}`,
    "",
    greeting,
    "",
    body,
    "",
    "With love,"
  ].filter((line, i, arr) => line || arr[i - 1]).join("\n").trim();
}

function wantsEmailNote(text, previousAssistant = "") {
  const s = stripAppContext(text).toLowerCase();
  const explicitNote = /\b(email|mail|send)\b.{0,60}\b(note|notes|notepad)\b/.test(s) ||
    /\b(note|notes|notepad)\b.{0,60}\b(email|mail|send)\b/.test(s);
  const pronounAfterNote = (/\b(email|mail|send)\b.{0,60}\b(that|it|this)\b/.test(s) ||
    /\b(that|it|this)\b.{0,60}\b(email|mail|send)\b/.test(s)) &&
    previousAssistantPromisedNotepad(previousAssistant);
  return explicitNote || pronounAfterNote;
}

function notepadWriteGuard(userText, args) {
  if (!wantsNewDraftSavedToNotepad(userText)) return "";
  const text = String(args?.text || "").trim();
  if (text.length < 40) return "The notepad text is too short. Write the requested draft first, then save that draft.";
  if (/^hello!? how can i assist you/i.test(text)) {
    return "The notepad text is an old greeting, not the requested draft. Write the requested draft first, then save that draft.";
  }
  for (const detail of keyDetailsFromRequest(userText)) {
    if (!text.toLowerCase().includes(detail.toLowerCase())) {
      return `The notepad text is missing the requested detail "${detail}". Write the requested draft with that detail, then save it.`;
    }
  }
  return "";
}

function previousAssistantPromisedNotepad(text) {
  const s = String(text || "").toLowerCase();
  return /\b(save|saved|move|moved|put|add|copy|write)\b.{0,70}\b(note|notes|notepad)\b/.test(s) ||
    /\b(note|notes|notepad)\b.{0,70}\b(save|saved|move|moved|put|add|copy|write)\b/.test(s);
}

function previousAssistantPromisedEmail(text) {
  const s = String(text || "").toLowerCase();
  if (assistantAlreadyInsertedEmailDraft(s)) return false;
  if (/\b(send|press send|hit send|proceed to send)\b/.test(s)) return false;
  return /\b(insert|put|type|place|draft|reply)\b.{0,80}\b(email|mail|reply|outlook|gmail)\b/.test(s) ||
    /\b(email|mail|reply|outlook|gmail)\b.{0,80}\b(insert|put|type|place|draft|reply)\b/.test(s);
}

function assistantAlreadyInsertedEmailDraft(text) {
  const s = String(text || "").toLowerCase();
  return /\b(draft inserted|inserted into (the )?(email )?(reply|compose)|put .* into (the )?email draft|saved in (the )?email reply box|draft has been saved in (the )?email)\b/.test(s);
}

function extractDraftFromAssistant(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return "";
  const lines = raw.split("\n");
  let start = lines.findIndex((line) => /^(subject\s*:|dear\b|hi\b|hello\b|team\b)/i.test(line.trim()));
  if (start < 0) start = lines.findIndex((line) => line.trim().length > 0 && !/^(great|sure|here|i can|let's|please|do you)\b/i.test(line.trim()));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim().toLowerCase();
    if (/^(please review|once you|do you have|your notepad|you can now|how would you like|is this draft|let me know|if this looks good|if it looks good)\b/.test(l)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function falselyClaimsNotepad(text) {
  const s = String(text || "").toLowerCase();
  return /\b(i (will now )?(saved|save|moved|move|added|add|wrote|write)|your notepad has been updated|notepad has been updated|saved to (your )?(notes|notepad))\b/.test(s);
}

function falselyClaimsEmailDraft(text) {
  const s = String(text || "").toLowerCase();
  return /\b(i (have )?(inserted|typed|placed|put)|draft (has been|is) (inserted|placed|typed)|reply box has been updated|email reply has been updated)\b/.test(s) &&
    /\b(email|mail|reply|outlook|gmail|compose|draft)\b/.test(s);
}

function isExampleStyleRequest(text) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/\b(search|google|browse|web|internet|online|look up|lookup|find online)\b/.test(s)) return false;
  if (/\b(shop|shopping|buy|purchase|price|prices|deal|deals|cart|retailer|under\s+\$?\d+)\b/.test(s)) return false;
  const exampleRef = /\b(example|format|style|recap|summary|template)\b/.test(s) ||
    /\b(like|similar to|same as|match)\s+(this|that|the example|the format|the style|the recap|the summary|thei|their)\b/.test(s) ||
    /\b(looking for|want|need)\s+(something\s+)?(like|similar to)\s+(this|that|the example|the format|the style|the recap|the summary|thei|their)\b/.test(s);
  const action = /\b(use|do|make|keep|match|follow|copy|remember|going forward|from now on|looking for|want|need|can you|could you)\b/.test(s);
  return exampleRef && action;
}

function preferenceAck(text) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return "";
  const futurePref = /\b(going forward|from now on|moving forward|next time|for future|in the future|always|please keep|keep)\b/.test(s);
  if (!futurePref && !isExampleStyleRequest(text)) return "";
  if (/\b(short|shorter|brief|concise|simple|less detail|unless i ask for more|unless asked)\b/.test(s)) {
    return "Yes. Going forward, I’ll keep answers short unless you ask for more.";
  }
  if (/\b(more detail|detailed|explain more|step by step)\b/.test(s)) {
    return "Yes. Going forward, I’ll give more detail when answering.";
  }
  if (/\b(don'?t|do not|stop|avoid)\b/.test(s)) {
    return "Got it. I’ll follow that going forward.";
  }
  if (isExampleStyleRequest(text) || /\b(example|format|style|recap|summary|template|like this|can do it this|can you do this|do it like this)\b/.test(s)) {
    return "Yes. Going forward, I’ll use that format.";
  }
  return "";
}

function metaTroubleAck(userText, previousAssistant) {
  const s = stripAppContext(userText).toLowerCase().replace(/[^\w\s'?]/g, " ").replace(/\s+/g, " ").trim();
  if (conversationIntent(userText) !== "meta") return "";
  if (/\b(stuck|stock|wrong|happened|why|search|browse|open|doing)\b/.test(s)) {
    const leakedSearch = /^\s*WEB SEARCH RESULTS\b/i.test(previousAssistant || "") || /\bweb search results\b/i.test(previousAssistant || "");
    return leakedSearch
      ? "I got stuck because I searched for the live schedule but returned raw search results instead of turning them into an answer. I should summarize the search evidence or say the date was not visible, not show tool output."
      : "I got stuck in the tool flow. I should answer from the current chat/tool result first, and only search when the user clearly asks for live outside information.";
  }
  return "Yes, I am okay. I got pulled into the tool flow, but I should stay with the current chat unless you clearly ask me to search.";
}

function isFuturePreferenceOrExample(text) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (isExampleStyleRequest(text)) return true;
  return /\b(going forward|from now on|moving forward|next time|for future|in the future)\b/.test(s) &&
    /\b(example|format|style|recap|summary|template|like this|can do it this|can you do this|do it like this|keep answers?|short|brief|concise|detail)\b/.test(s);
}

function isLocalReportReference(text) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  const explicitWeb = /\b(search|google|browse|web|internet|online|look up|lookup|find online)\b/.test(s);
  if (explicitWeb) return false;
  const localRef = /\b(from|in|on|using|based on|according to)\s+(the\s+)?(that|this|current|above|previous|open|uploaded)?\s*(report|dashboard|screenshot|image|chart|table|data|email|page)\b/.test(s) ||
    /\b(that|this|current|above|previous|open|uploaded)\s+(report|dashboard|screenshot|image|chart|table|data|email|page)\b/.test(s) ||
    /\b(the|that|this)\s+report\b/.test(s);
  const asksAnalyze = /\b(top\s*\d+|bottom\s*\d+|best|worst|highest|lowest|doing best|doing worst|recap|summarize|summary|compare|opportunit|improve|performance|rank)\b/.test(s);
  return localRef && asksAnalyze;
}

function isConversationReference(text) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/\b(search|google|browse|web|internet|online|look up|lookup|find online)\b/.test(s)) return false;
  return /\b(what we'?re talking about|what we are talking about|current chat|this chat|above|previous message|earlier|that one|this one|that report|this report|the report|that data|this data|from it|from that|from this|no from)\b/.test(s);
}

function textFromMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
  return "";
}

function relevantChatFocus(messages, userText) {
  if (!isLocalReportReference(userText) && !isConversationReference(userText)) return null;
  const terms = [
    "report", "dashboard", "data", "store", "stores", "p&ms", "comp", "esp", "keap",
    "reward", "rewards", "transaction", "penetration", "performance", "opportunity",
    "recap", "summary", "top", "bottom", "best", "worst"
  ];
  const prior = messages.slice(1, -1)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, i) => {
      const text = stripAppContext(textFromMessageContent(m.content)).replace(/\s+/g, " ").trim();
      const low = text.toLowerCase();
      const score = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) + Math.max(0, i / 1000);
      return { role: m.role, text, score, i };
    })
    .filter((m) => m.text && m.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, 8)
    .sort((a, b) => a.i - b.i);
  if (!prior.length) return null;
  const snippets = [];
  let used = 0;
  for (const m of prior) {
    const clipped = m.text.length > 900 ? m.text.slice(0, 900) + " ..." : m.text;
    if (used + clipped.length > 4200) break;
    snippets.push(`${m.role === "assistant" ? "Boolean" : "User"}: ${clipped}`);
    used += clipped.length;
  }
  if (!snippets.length) return null;
  return {
    role: "user",
    content: [
      "RELEVANT CHAT CONTEXT FOR THIS FOLLOW-UP:",
      "The user is referring to the report/data/conversation already discussed. Use these prior snippets before using browser/search.",
      "If the visible browser currently shows unrelated Google/search results, ignore that page unless the user asks to search online.",
      snippets.join("\n\n")
    ].join("\n")
  };
}

function currentThreadMemory(messages) {
  const turns = (messages || [])
    .slice(1)
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m, i) => {
      const text = stripAppContext(textFromMessageContent(m.content)).replace(/\s+/g, " ").trim();
      return { role: m.role, text, i };
    })
    .filter((m) => m.text && !/^\(?stopped by user\)?$/i.test(m.text));
  if (turns.length < 4) return "";

  const highSignal = turns.filter((m) =>
    /\b(report|dashboard|data|store|stores|email|draft|notepad|note|recap|summary|format|going forward|remember|wife|name|model|browser|outlook|power\s*bi|screenshot|image|top\s*\d+|best|worst|opportunit|performance)\b/i.test(m.text)
  );
  const chosen = [...highSignal.slice(-8), ...turns.slice(-8)]
    .sort((a, b) => a.i - b.i)
    .filter((m, i, arr) => arr.findIndex((x) => x.i === m.i) === i)
    .slice(-14);
  if (!chosen.length) return "";

  const lines = ["CURRENT THREAD MEMORY (compact recap of this open chat; use it to resolve follow-ups like 'that', 'this', 'the report', and 'what we were talking about'):"];
  let used = 0;
  for (const m of chosen) {
    const max = m.role === "assistant" ? 260 : 360;
    const clipped = m.text.length > max ? m.text.slice(0, max) + " ..." : m.text;
    if (used + clipped.length > 2600) break;
    lines.push(`- ${m.role === "assistant" ? "Boolean" : "User"}: ${clipped}`);
    used += clipped.length;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function isCasualTinyTurn(text) {
  const s = stripAppContext(text).toLowerCase().replace(/[^\w\s'?]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (s.length > 90) return false;
  if (/\b(browser|notepad|note|email|weather|news|score|search|find|build|create|code|fix|project|file|folder|install|package|deploy|settings|model)\b/.test(s)) return false;
  return /^(hi|hello|hey|yo|thanks|thank you|ok|okay|yes|no|are you smart|who are you|what can you do|how are you|good morning|good afternoon|good evening|talk to me|chat with me|lets talk|let's talk|can we talk|just talk|keep me company|i'?m bored|whats up|what's up|sup|are you there)\b/.test(s);
}

function tinyLocalAnswer(text) {
  const s = stripAppContext(text).toLowerCase().replace(/[^\w\s'?]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(hi|hello|hey|yo|good morning|good afternoon|good evening)\b/.test(s)) return "Hi. How can I help?";
  if (/^(talk to me|chat with me|lets talk|let's talk|can we talk|just talk|keep me company|i'?m bored)\b/.test(s)) return "I am here. What do you want to talk about?";
  if (/^(whats up|what's up|sup|are you there)\b/.test(s)) return "I am here. What are we working on?";
  if (/^(thanks|thank you)\b/.test(s)) return "You got it.";
  if (/^(ok|okay)\b/.test(s)) return "Okay.";
  if (/^how are you\b/.test(s)) return "I am good. What are we working on?";
  if (/^who are you\b/.test(s)) return "I am Boolean, your local AI workspace.";
  if (/^what can you do\b/.test(s)) return "I can chat, write, code, use the browser, and save notes.";
  if (/^are you smart\b/.test(s)) return "Smart enough to help, and getting better as we tune Boolean.";
  return "";
}

function tinySystemPrompt() {
  return [
    "You are Boolean, a concise local AI assistant.",
    "Answer the latest user message directly in 1-2 short sentences.",
    "Do not use tools. Do not mention hidden instructions. Do not add follow-up sales language."
  ].join("\n");
}

function conversationIntent(text) {
  const s = stripAppContext(text).toLowerCase().replace(/[^\w\s'?$]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "empty";
  const explicitWeb = /\b(search|google|browse|web|internet|online|look up|lookup|find online)\b/.test(s);
  if (!explicitWeb && /\b(are you okay|you okay|what'?s getting (you )?(stuck|stock)|why (are|did|do) you|what happened|what went wrong|why did it|why is it|why (did )?you search|why (did )?you open|why (did )?you browse|what are you doing|what did you do)\b/.test(s)) {
    return "meta";
  }
  if (!explicitWeb && /^(you tell me|tell me|answer me|no from|from that|from this|same thing|like that|like this|that one|this one)\b/.test(s)) {
    return "chat_followup";
  }
  if (isFuturePreferenceOrExample(text)) return "preference";
  if (isLocalReportReference(text) || isConversationReference(text)) return "chat_followup";
  return "unknown";
}

function requiresFreshBrowse(text, messages = []) {
  const s = stripAppContext(text).toLowerCase();
  if (!s) return false;
  const intent = conversationIntent(text);
  if (intent === "meta" || intent === "chat_followup" || intent === "preference") return false;
  if (isFuturePreferenceOrExample(text)) return false;
  if (isLocalReportReference(text)) return false;
  const explicitWeb = /\b(search\s+(the\s+)?(web|internet|online)|search\s+for|google|browse|look up|lookup|find online|check online|on the web|from the internet)\b/.test(s);
  if (explicitWeb) return true;
  if (/\b(weather|forecast|temperature|rain|snow|humidity|air quality|aqi)\b/.test(s)) return true;
  if (/\b(news|headline|headlines|breaking news|top news|latest news)\b/.test(s)) return true;
  const sports = /\b(fifa|soccer|football|nba|nfl|nhl|mlb|wnba|game score|who won|winner|standings|schedule|kickoff|match|matches|fixture|fixtures|score|scores|results?)\b/.test(s);
  if (sports && /\b(today|tonight|now|live|current|latest|next|upcoming|schedule|when|score|scores|who won|winner|result|results|standings)\b/.test(s)) return true;
  if (isContextualSportsFollowup(text, messages)) return true;
  if (/\b(price|prices|sale|deal|deals|coupon|available|availability|in stock|shopping|shop|buy|purchase|retailer|cart|add to cart|site i can buy|where can i buy|under\s+\$?\d+)\b/.test(s)) return true;
  if (/\b(stock|stocks|market|ticker)\b/.test(s) && /\b(today|now|current|latest|price|prices)\b/.test(s)) return true;
  // future/schedule questions: "when is the next ... game / release / premiere ...".
  const eventNoun = /\b(game|games|match|matches|fixture|tournament|cup|final|playoff|season|episode|series|show|movie|film|fight|bout|race|grand prix|concert|tour|election|debate|update|version|patch|release|console|phone|iphone|pixel|event)\b/;
  if (/\b(next|upcoming|when'?s|release|releases?|released|launch|launches?|premiere|premieres?|come[s]?\s+out|coming\s+out|out\s+(?:yet|now)|airs?|airing|start|starts|begins?)\b/.test(s) && eventNoun.test(s)) return true;
  if (/^when\b/.test(s) && (eventNoun.test(s) || /\b(next|upcoming|out|release|launch|premiere|start|begin|air)\b/.test(s))) return true;
  return false;
}

function wantsQuickWebAnswer(text) {
  const s = stripAppContext(text).toLowerCase();
  if (!s) return false;
  if (/^when\b.*\b(next|upcoming|out|release|launch|premiere|start|begin|air|game|games|match|season|episode|event)\b/.test(s)) return true;
  if (/\b(score|scores|game|games|game score|who won|winner|result|results|standings|schedule|kickoff|match|fixture|next|upcoming)\b/.test(s)) return true;
  if (/\b(weather|forecast|temperature|rain|snow|humidity|air quality|aqi)\b/.test(s)) return true;
  if (/\b(news|headline|headlines|latest|current|today|now)\b/.test(s) &&
      !/\b(best|find me|shop|shopping|buy|purchase|cart|compare|review|under\s+\$?\d+)\b/.test(s)) return true;
  if (/^(what'?s|what is|who is|when is|where is|how many|how much)\b/.test(s) &&
      /\b(today|now|current|latest|score|price|weather|news)\b/.test(s)) return true;
  return false;
}

function freshBrowseQuery(text) {
  let q = stripAppContext(text)
    .replace(/\b(can you|could you|please|for me)\b/gi, " ")
    .replace(/\b(open|show|use)\s+(the\s+)?(built[- ]?in\s+)?browser\s+(pane|tab|window)?\b/gi, " ")
    .replace(/\b(open|show|use)\s+(the\s+)?(pane|tab|window)\b/gi, " ")
    .replace(/\bfind\s+me\b/gi, "find")
    .replace(/\badd\s+(it|one|this|that)?\s*to\s+cart\b/gi, "buy")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  if (!q) return "";
  const low = q.toLowerCase();
  if (/\btv|television\b/.test(low) && /\bunder\s+\$?\d+/.test(low)) {
    const amount = q.match(/\bunder\s+\$?(\d+)/i)?.[1] || "500";
    const brand = q.match(/\b(tcl|hisense|samsung|lg|sony|roku|vizio)\b/i)?.[1] || "";
    const size = q.match(/\b(\d{2,3})\s*(?:\"|in|inch|inches)\b/i)?.[1];
    const retailerQuery = `${brand} ${size ? size + " inch" : "65 inch 4K"} TV under ${amount}`.replace(/\s+/g, " ").trim();
    return "https://www.bestbuy.com/site/searchpage.jsp?st=" + encodeURIComponent(retailerQuery);
  }
  return "https://www.bing.com/search?q=" + encodeURIComponent(q);
}

function freshSearchText(text) {
  const raw = stripAppContext(text);
  const low = raw.toLowerCase();
  if (/\b(news|headlines|latest news|top news)\b/.test(low)) {
    if (/\b(local|near me|nearby)\b/.test(low)) return "top local news today";
    if (/\b(world|global|international)\b/.test(low)) return "top world news headlines today";
    if (/\b(us|usa|america|american|united states)\b/.test(low)) return "top United States news headlines today";
    return "top news headlines today United States";
  }
  if (/\b(weather|forecast|temperature)\b/.test(low)) {
    const loc = raw.match(/\b(?:in|for|near)\s+([a-z][a-z .'-]{2,40})/i)?.[1]?.trim();
    return loc ? `weather forecast today ${loc}` : "weather forecast today";
  }
  if (/\b(fifa|soccer|football)\b/.test(low) && /\b(next|upcoming|schedule|fixture|fixtures|when)\b/.test(low)) {
    return raw.replace(/\s+/g, " ").trim().slice(0, 180) + " schedule fixtures dates";
  }
  if (/\b(fifa|soccer|football)\b/.test(low) && /\b(score|scores|result|results|live|who won|standings|today)\b/.test(low)) {
    return "FIFA soccer scores today live results";
  }
  if (/\b(stock|stocks|market|price)\b/.test(low) && /\b(today|now|current|latest)\b/.test(low)) {
    return raw.replace(/\s+/g, " ").trim().slice(0, 180);
  }
  const url = freshBrowseQuery(raw);
  try {
    const parsed = new URL(url);
    const bestBuy = parsed.hostname.includes("bestbuy.com");
    const q = bestBuy ? parsed.searchParams.get("st") : parsed.searchParams.get("q");
    return (q || raw).replace(/\s+/g, " ").trim().slice(0, 180);
  } catch {
    return raw.replace(/\s+/g, " ").trim().slice(0, 180);
  }
}

function contextualFreshSearchText(text, messages = []) {
  const raw = stripAppContext(text);
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const prior = (messages || []).slice(-12, -1)
    .map((m) => stripAppContext(textFromMessageContent(m.content)))
    .join("\n")
    .toLowerCase();
  const priorFifa = /\b(fifa|world cup)\b/.test(prior);
  const contextualSportsFollowup = /^(fifa|football|soccer|who (won|played?)|what(?:'s| is| was)? (?:today(?:'s)? )?(?:score|result)|(?:today(?:'s)? )?(?:score|result)|who play(?:s|ed)?(?: today)?|when(?:'s| is)? (?:the )?(?:next )?(?:game|match))\??$/.test(s);
  if (priorFifa && contextualSportsFollowup && !/\b(nba|nfl|nhl|mlb|wnba)\b/.test(s)) {
    return freshSearchText(`${raw} FIFA World Cup today`);
  }
  const genericGame = /\b(when\s+is\s+)?(the\s+)?next\s+(game|match|fixture)\b/.test(s) ||
    /^when\s+is\s+next\s+(game|match|fixture)\??$/.test(s);
  if (genericGame && !/\b(fifa|soccer|football|nba|nfl|nhl|mlb|team|club)\b/.test(s)) {
    if (/\bfifa\b/.test(prior)) return freshSearchText(raw + " fifa match");
    if (/\bsoccer|football\b/.test(prior)) return freshSearchText(raw + " soccer match");
  }
  return freshSearchText(raw);
}

function isContextualSportsFollowup(text, messages = []) {
  const s = stripAppContext(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  const shortFollowup = /^(fifa|football|soccer|who (won|played?)|what(?:'s| is| was)? (?:today(?:'s)? )?(?:score|result)|(?:today(?:'s)? )?(?:score|result)|who play(?:s|ed)?(?: today)?|when(?:'s| is)? (?:the )?(?:next )?(?:game|match))\??$/.test(s);
  if (!shortFollowup) return false;
  const prior = (messages || []).slice(-12, -1)
    .map((m) => stripAppContext(textFromMessageContent(m.content)))
    .join("\n")
    .toLowerCase();
  return /\b(fifa|world cup|soccer|football|nba|nfl|nhl|mlb|wnba)\b/.test(prior);
}

function shortlistSearchInstruction(userText) {
  const shopping = /\b(price|prices|sale|deal|deals|shopping|shop|buy|purchase|retailer|cart|add to cart|where can i buy|best\b|compare|reviews?|under\s+\$?\d+)\b/i
    .test(stripAppContext(userText));
  return [
    "SYSTEM PREFLIGHT: The user's request needs current web information.",
    "Use the search result evidence to answer with a fast TOP 3 shortlist first.",
    shopping
      ? "For each option include product/item name, key spec, visible price/retailer if available, and one short reason."
      : "For each option include title/source, why it matters, and a useful link or next step if available.",
    "Then ask which option the user wants you to inspect, open, compare, or act on next.",
    "Do not click/open deeper pages, fill forms, add to cart, or keep browsing until the user chooses an option.",
    "Do not invent products, prices, links, availability, weather, news, or dates."
  ].join("\n");
}

function quickSearchInstruction(userText) {
  const isNews = /\b(news|headline|headlines|latest news|top news)\b/i.test(stripAppContext(userText));
  return [
    "SYSTEM PREFLIGHT: The user asked for a simple current answer.",
    "Use the web_search result evidence below to answer directly in plain language.",
    "Do not ask which result to open. Do not give a top-3 shortlist. Do not keep browsing unless the search evidence is clearly not enough.",
    isNews ? "For news, summarize the actual current stories/headlines with their sources. Do not list news websites as the answer." : "",
    "For sports scores, include teams, score, game status/time/date, and competition if available.",
    "For weather, include location, current conditions/temperature, and today's forecast if available.",
    "If the evidence is ambiguous, say what is unclear and give the best source link from the search results.",
    `User question: ${stripAppContext(userText)}`
  ].filter(Boolean).join("\n");
}

function browseGuardInstruction(mode) {
  return mode === "quick"
    ? [
        "SYSTEM GUARD: Do not browse deeper unless the search evidence is insufficient.",
        "Answer the user's simple current question directly from the existing web_search result evidence.",
        "Do not ask the user which result to open and do not mention internal tool names."
      ].join("\n")
    : [
        "SYSTEM GUARD: Do not browse deeper yet.",
        "Answer with a top 3 shortlist from the existing search results and ask the user which option to inspect/open next."
      ].join("\n");
}

function leaksToolPlan(text) {
  const s = String(text || "").toLowerCase();
  return /\b(you can|you should|we can|i can|use the|using the)\s+(web_search|browser_open|browser_click|browser_form|visible_browser_open|visible_browser_click|visible_browser_type|read_page)\b/.test(s) ||
    /\b(web_search|browser_open|browser_click|browser_form|visible_browser_open|visible_browser_click|visible_browser_type|read_page)\s+(function|tool)\b/.test(s);
}

function violatesQuickAnswer(userText, answer) {
  const s = String(answer || "").toLowerCase();
  if (/^\s*WEB SEARCH RESULTS\b/i.test(String(answer || ""))) return true;
  if (/\b(proceed with building|windows application|what would you like the name|functionality do you want the application)\b/.test(s)) return true;
  if (/\b(please visit one of these sources|visit one of these sources directly|for the most up-to-date and detailed news)\b/.test(s)) return true;
  if (/\b(news|headline|headlines|latest news|top news)\b/i.test(stripAppContext(userText)) &&
      /\b(abc7|cnn|fox news|google news|nbc|new york times|new york post)\b/.test(s) &&
      !/\b(source:|reported|according|says|announced|killed|election|court|market|president|congress|storm|war|deal|stocks)\b/.test(s)) {
    return true;
  }
  return false;
}

function fastWeatherLocation(text) {
  const raw = stripAppContext(text).replace(/\?+$/, "").trim();
  const loc = raw.match(/\b(?:weather|forecast|temperature)\s+(?:today\s+)?(?:in|for|near)\s+([a-z][a-z .'-]{2,50})/i)?.[1] ||
    raw.match(/\b(?:in|for|near)\s+([a-z][a-z .'-]{2,50})\b/i)?.[1];
  return (loc || "").replace(/\b(today|now|right now|please|plz)\b/gi, "").replace(/\s+/g, " ").trim();
}

async function directWeatherAnswer(userText, ctx) {
  const loc = fastWeatherLocation(userText);
  if (!loc) return "";
  try {
    ctx.onStatus?.(`getting weather for ${loc}...`);
    const url = "https://wttr.in/" + encodeURIComponent(loc) + "?format=j1";
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "user-agent": "Boolean/0.9 weather quick answer" }
    });
    if (!res.ok) return "";
    const data = await res.json();
    const cur = data.current_condition?.[0] || {};
    const today = data.weather?.[0] || {};
    const desc = cur.weatherDesc?.[0]?.value || "conditions unavailable";
    const temp = cur.temp_F ? `${cur.temp_F} F` : "";
    const feels = cur.FeelsLikeF ? `feels like ${cur.FeelsLikeF} F` : "";
    const high = today.maxtempF ? `high ${today.maxtempF} F` : "";
    const low = today.mintempF ? `low ${today.mintempF} F` : "";
    const rain = today.hourly?.map((h) => Number(h.chanceofrain || 0)).reduce((a, b) => Math.max(a, b), 0);
    const rainText = Number.isFinite(rain) && rain > 0 ? `rain chance up to ${rain}%` : "";
    return `${loc}: ${[temp, desc, feels].filter(Boolean).join(", ")}. Today: ${[high, low, rainText].filter(Boolean).join(", ")}.`;
  } catch {
    return "";
  }
}

function parseSearchItems(result) {
  const chunks = String(result || "")
    .replace(/^WEB SEARCH RESULTS[^\n]*(?:\n\([^\n]*\))?[^\n]*:\s*/i, "")
    .split(/\n(?=\[\d+\]\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.map((chunk) => {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = (lines[0] || "").replace(/^\[\d+\]\s*/, "");
    const url = lines.find((l) => /^https?:\/\//i.test(l)) || "";
    const snippet = lines.filter((l, i) => i > 0 && !/^https?:\/\//i.test(l) && !/^(Source|Published):/i.test(l)).join(" ");
    const source = (lines.find((l) => /^Source:/i.test(l)) || "").replace(/^Source:\s*/i, "");
    const pub = (lines.find((l) => /^Published:/i.test(l)) || "").replace(/^Published:\s*/i, "");
    return { title, url, snippet, source, pub };
  }).filter((x) => (x.title || x.snippet) && !/^WEB SEARCH RESULTS\b/i.test(x.title)).slice(0, 5);
}

function fastSearchFallback(userText, result) {
  const s = stripAppContext(userText).toLowerCase();
  const items = parseSearchItems(result);
  if (!items.length) return "";
  if (/\b(news|headline|headlines|latest news|top news)\b/.test(s)) {
    return "Top news:\n" + items.slice(0, 5).map((x) =>
      `- ${x.title}${x.source ? ` (${x.source})` : ""}${x.pub ? ` - ${x.pub}` : ""}`
    ).join("\n");
  }
  if (/\b(score|scores|game score|who won|winner|result|results|standings|schedule|match|fixture|next|upcoming)\b/.test(s)) {
    const first = items[0];
    return `I could not verify the exact score from the available results.${first.url ? ` Check the live scoreboard: ${first.url}` : ""}`;
  }
  if (/\b(weather|forecast|temperature|rain|snow|humidity|air quality|aqi)\b/.test(s)) {
    const first = items[0];
    return [first.title, first.snippet].filter(Boolean).join("\n");
  }
  if (/^(what'?s|what is|who is|when is|where is|how many|how much)\b/.test(s)) {
    const first = items[0];
    return [first.title, first.snippet, first.url].filter(Boolean).join("\n");
  }
  return "";
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function teamName(competitor) {
  return competitor?.team?.shortDisplayName || competitor?.team?.displayName || competitor?.team?.name || "Unknown team";
}

async function directFifaAnswer(query, ctx) {
  if (!/\b(fifa|world cup)\b/i.test(query)) return "";
  try {
    ctx.onStatus?.("checking today's FIFA matches...");
    const dateKey = localDateKey();
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateKey}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "Boolean/0.9 sports quick answer" }
    });
    if (!res.ok) return "";
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const league = data.leagues?.[0]?.name || "FIFA World Cup";
    if (!events.length) return `No ${league} match is scheduled today.`;

    const lines = events.slice(0, 5).map((event) => {
      const competition = event.competitions?.[0] || {};
      const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
      const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
      const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
      const state = event.status?.type?.state || "pre";
      const detail = event.status?.type?.shortDetail || event.status?.type?.detail || event.status?.type?.description || "";
      const homeName = teamName(home);
      const awayName = teamName(away);
      const homeScore = String(home?.score ?? "0");
      const awayScore = String(away?.score ?? "0");

      if (state === "post") {
        const winner = competitors.find((c) => c.winner === true);
        const loser = winner === home ? away : home;
        if (winner && loser) return `${teamName(winner)} beat ${teamName(loser)} ${winner.score}-${loser.score} (${detail || "final"}).`;
        return `${awayName} and ${homeName} finished ${awayScore}-${homeScore} (${detail || "final"}).`;
      }
      if (state === "in") {
        return `${awayName} ${awayScore}, ${homeName} ${homeScore} (${detail || "live"}).`;
      }
      const start = event.date
        ? new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(event.date))
        : "time not listed";
      return `${awayName} plays ${homeName} today at ${start}.`;
    });
    return `${league}: ${lines.join(" ")} Source: https://www.espn.com/soccer/scoreboard/_/league/fifa.world`;
  } catch {
    return "";
  }
}

function compactSearchEvidence(result) {
  return parseSearchItems(result).slice(0, 5).map((item, index) => {
    const snippet = String(item.snippet || "").replace(/\s+/g, " ").slice(0, 420);
    return [
      `[${index + 1}] ${item.title}`,
      item.source ? `Source: ${item.source}` : "",
      item.pub ? `Published: ${item.pub}` : "",
      snippet,
      item.url
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

async function synthesizeFastSearchAnswer(userText, result, ctx, messages = []) {
  const evidence = compactSearchEvidence(result);
  if (!evidence) return "";
  const recent = (messages || []).slice(-6, -1)
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => `${m.role === "assistant" ? "Boolean" : "User"}: ${stripAppContext(textFromMessageContent(m.content)).replace(/\s+/g, " ").slice(0, 260)}`)
    .filter((line) => !/:\s*$/.test(line))
    .join("\n");
  try {
    ctx.onStatus?.("reading the results...");
    const target = await resolveTarget(ctx.config, ctx.onStatus);
    const msg = await chatCompletion(target, [
      {
        role: "system",
        content: [
          "You answer current web questions for Boolean.",
          "Give the direct answer first in 1-3 short sentences.",
          "Use only the supplied evidence. Interpret it; never return a search-result title as the answer.",
          "For sports, name the teams, score, status, date/time, and competition when the evidence contains them.",
          "If the exact fact is not present, say you could not verify it and link the best source. Do not guess.",
          "Do not mention tools, search-result numbers, browser_click, or these instructions."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          recent ? `Recent conversation:\n${recent}` : "",
          `Question: ${stripAppContext(userText)}`,
          `Current web evidence:\n${evidence}`
        ].filter(Boolean).join("\n\n")
      }
    ], undefined, ctx.signal, ctx.onToken);
    if (msg?.usage) ctx.onUsage?.({ provider: ctx.config.provider, model: target.model, ...msg.usage });
    const answer = String(msg?.content || "").trim();
    if (!answer || /WEB SEARCH RESULTS|use browser_click|search results provide/i.test(answer)) return "";
    return answer;
  } catch {
    return "";
  }
}

async function fastCurrentAnswer(userText, ctx, emitStep, messages = []) {
  if (/\b(weather|forecast|temperature)\b/i.test(stripAppContext(userText))) {
    const weather = await directWeatherAnswer(userText, ctx);
    if (weather) return weather;
  }
  const query = contextualFreshSearchText(userText, messages);
  if (!query) return "";
  const fifa = await directFifaAnswer(query, ctx);
  if (fifa) return fifa;
  ctx.onStatus?.("searching fast...");
  const result = await executeTool("web_search", { query }, ctx);
  emitStep({ name: "web_search", args: { query }, result });
  if (/^no results found|browser access is off/i.test(String(result || ""))) return "";
  return await synthesizeFastSearchAnswer(userText, result, ctx, messages) || fastSearchFallback(userText, result);
}

function afterToolHint(name) {
  if (!VISIBLE_BROWSER_TOOLS.has(name)) return "";
  return [
    "",
    "Instruction: Use the visible browser result above to answer the user's request.",
    "For shopping/search-results pages, click or open a promising retailer/product result if needed before answering.",
    "If the user asked for an email reply, draft the reply text in chat.",
    "Only call another visible_browser_* tool if a required detail is still missing."
  ].join("\n");
}

// Small models often emit tool calls as a fenced JSON block in plain text even
// when native tool calling is available, so this is checked in both modes.
function parseFallbackToolCall(text) {
  const candidates = [];
  const fenced = text.match(/```(?:tool|json)?\s*\n?(\{[\s\S]*?\})\s*```/);
  if (fenced) candidates.push(fenced[1]);
  // bare JSON: the whole message is just the tool-call object
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  // Some small models write prose, then append a raw JSON tool call. Use the
  // final object when it contains a known tool name.
  const trailing = trimmed.match(/(\{[\s\S]*"name"\s*:\s*"(?:[^"]+)"[\s\S]*\})\s*$/);
  if (trailing) candidates.push(trailing[1]);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && KNOWN_TOOLS.has(obj.name)) {
        return { name: obj.name, arguments: obj.arguments || obj.parameters || {} };
      }
    } catch {
      /* not a tool call */
    }
  }
  return null;
}

function convertNativeToolHistoryToText(messages) {
  const ids = new Map();
  const converted = [];
  for (const m of messages || []) {
    if (m?.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) {
        if (call?.id) ids.set(call.id, call.function?.name || "tool");
      }
      if (typeof m.content === "string" && m.content.trim()) {
        converted.push({ role: "assistant", content: m.content });
      }
      continue;
    }
    if (m?.role === "tool") {
      const name = ids.get(m.tool_call_id) || "tool";
      converted.push({ role: "user", content: `TOOL RESULT for ${name}:\n${m.content || ""}` });
      continue;
    }
    converted.push(m);
  }
  messages.splice(0, messages.length, ...converted);
}

function looksLikeNoToolSupport(err) {
  const text = (err.body || "") + " " + (err.message || "");
  return /does not support tools|tools? (is|are) not supported|no tool|unknown field.{0,20}tools|messages parameter is illegal|"?code"?\s*:?\s*"?1214"?/i
    .test(text);
}

// rough token estimate for context-budget trimming. ~3.3 chars/token is
// deliberately conservative (code and shell output are token-dense) so the
// estimate errs on the side of trimming more, never overflowing the window.
function approxTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length;
  }
  return Math.ceil(chars / 3.3);
}

// clip a tool result inside the SENT copy (minimal mode) without touching history
function clipMsg(m, maxChars) {
  if (m.role === "tool" && typeof m.content === "string" && m.content.length > maxChars) {
    return { ...m, content: m.content.slice(0, maxChars) + "\n...[trimmed by Context Optimizer]" };
  }
  return m;
}

/**
 * Context Optimizer: return a COPY of the conversation trimmed to a token budget
 * so a prompt can never exceed the model's window (a hard error on the local
 * engine) AND to save tokens. Keeps the system message + a recent contiguous
 * suffix starting at a user turn (tool_call/tool pairs stay intact). The full
 * history is untouched for display; only what fits is sent.
 *
 * mode: "full" (use most of the window), "balanced" (default), "minimal"
 * (aggressive — cap context small and clip large tool outputs).
 * Returns { msgs, sentTokens, fullTokens, budget }.
 */
function fitToContext(messages, budgetTokens, mode = "balanced", focusText = "", useThreadMemory = true) {
  const focus = relevantChatFocus(messages, focusText);
  const memory = useThreadMemory ? currentThreadMemory(messages) : "";
  const baseSystem = memory && messages[0]?.role === "system"
    ? { ...messages[0], content: messages[0].content + "\n\n" + memory }
    : messages[0];
  const source = focus ? [baseSystem, focus, ...messages.slice(1)] : [baseSystem, ...messages.slice(1)];
  const fullTokens = approxTokens(source);
  if (mode === "tiny") {
    const system = { role: "system", content: tinySystemPrompt() };
    const recent = source.slice(1).filter((m) => m.role !== "tool").slice(-6).map((m) => {
      if (typeof m.content !== "string") return m;
      return { ...m, content: m.content.slice(0, 900) };
    });
    return { msgs: [system, ...recent], sentTokens: approxTokens([system, ...recent]), fullTokens, budget: 2200 };
  }
  const reserve = mode === "full" ? 1000 : 2000;
  let budget = Math.max(2048, budgetTokens - reserve);
  if (mode === "minimal") budget = Math.min(budget, 3200);

  let work = source;
  if (mode === "minimal") work = source.map((m, i) => (i === 0 ? m : clipMsg(m, 800)));

  const done = (msgs) => ({ msgs, sentTokens: approxTokens(msgs), fullTokens, budget });
  if (approxTokens(work) <= budget) return done(work);

  const system = work[0];
  let rest = work.slice(1);
  while (rest.length > 1 && approxTokens([system, ...rest]) > budget) rest.shift();
  while (rest.length && rest[0].role !== "user") rest.shift();

  if (rest.length === 0) {
    const last = work[work.length - 1];
    const clipped = typeof last.content === "string"
      ? { ...last, content: last.content.slice(0, budget * 3) + "\n...[truncated to fit context]" }
      : last;
    return done([system, clipped]);
  }
  return done([system, ...rest]);
}

// exported so the /api/estimate endpoint can preview token cost before sending
export function estimateContext(messages, budgetTokens, mode) {
  const userText = latestUserText(messages);
  const estimateMode = mode === "balanced" && isCasualTinyTurn(userText) ? "tiny" : mode;
  const r = fitToContext(messages, budgetTokens, estimateMode, userText);
  return { full: r.fullTokens, sent: r.sentTokens, saved: Math.max(0, r.fullTokens - r.sentTokens), budget: r.budget };
}

/**
 * Run one user turn through the agent loop, executing tools until the model
 * produces a final text answer.
 *
 * @param {object} ctx { config, approve, onStatus }
 * @param {Array} messages full conversation history (mutated in place)
 * @returns {Promise<string>} the model's final answer
 */
export async function runTurn(ctx, messages) {
  const { config, onStatus, onToken, onStep, onUsage, signal } = ctx;
  const userText = latestUserText(messages);
  const previousAssistant = latestAssistantText(messages);
  const approvedPrevious = approvalIntent(userText);
  const previousDraft = latestAssistantDraft(messages);
  const emitStep = (entry) => { if (onStep) onStep(entry); };
  const browserOpenTarget = visibleBrowserOpenTarget(userText);
  const metaAck = metaTroubleAck(userText, previousAssistant);
  if (metaAck) {
    messages.push({ role: "assistant", content: metaAck });
    return metaAck;
  }
  const tinyAck = tinyLocalAnswer(userText);
  if (tinyAck) {
    messages.push({ role: "assistant", content: tinyAck });
    return tinyAck;
  }
  const ack = preferenceAck(userText);
  if (ack) {
    messages.push({ role: "assistant", content: ack });
    return ack;
  }
  const finalSendRequested = wantsFinalEmailSend(userText, previousAssistant);
  const requestedNoteDraft = composeRequestedNoteDraft(userText);
  if (requestedNoteDraft) {
    onStatus?.("saving to notepad...");
    const result = await executeTool("notepad_write", { text: requestedNoteDraft, mode: "append" }, ctx);
    emitStep({ name: "notepad_write", args: { text: requestedNoteDraft, mode: "append" }, result });
    const answer = /^error|notepad control is not available/i.test(String(result || ""))
      ? `I wrote the draft, but could not save it to notepad: ${result}`
      : `Saved to notepad:\n\n${requestedNoteDraft}`;
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  const requestedEmailDraft = composeRequestedEmailDraft(userText);
  if (requestedEmailDraft) {
    if (wantsBrowserEmailDraft(userText) && config.ui?.aiBrowser !== false) {
      onStatus?.("inserting email draft...");
      const result = await executeTool("visible_browser_draft_email", { text: requestedEmailDraft }, ctx);
      emitStep({ name: "visible_browser_draft_email", args: { text: requestedEmailDraft }, result });
      const failed = /^error|visible browser.*not available|visible browser control is not available|browser pane is closed|visible browser error|user declined/i.test(String(result || ""));
      const answer = failed
        ? `I wrote the draft, but could not place it in the browser yet: ${result}\n\n${requestedEmailDraft}`
        : `Draft inserted into the email editor. I did not send it. Please review it and press Send yourself.\n\n${requestedEmailDraft}`;
      messages.push({ role: "assistant", content: answer });
      return answer;
    }
    const answer = `Here is the draft:\n\n${requestedEmailDraft}`;
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  if (wantsEmailNote(userText, previousAssistant) && config.ui?.aiBrowser !== false) {
    onStatus?.("reading notepad...");
    const noteResult = await executeTool("notepad_read", {}, ctx);
    emitStep({ name: "notepad_read", args: {}, result: noteResult });
    const noteText = String(noteResult || "").replace(/^ACTIVE NOTE:[^\n]*\n*/i, "").trim();
    if (!noteText || /\(empty\)/i.test(noteText)) {
      const answer = "Your notepad looks empty, so I do not have a note to email yet.";
      messages.push({ role: "assistant", content: answer });
      return answer;
    }
    onStatus?.("inserting email draft...");
    const result = await executeTool("visible_browser_draft_email", { text: noteText }, ctx);
    emitStep({ name: "visible_browser_draft_email", args: { text: noteText }, result });
    const failed = /^error|visible browser.*not available|visible browser control is not available|browser pane is closed|visible browser error|user declined/i.test(String(result || ""));
    const answer = failed
      ? `I found the note, but could not place it into Outlook yet: ${result}`
      : "I put the note into the email draft. I did not send it. Please review the recipient and subject, then press Send yourself.";
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  if (previousDraft && !wantsNewDraftSavedToNotepad(userText) &&
      (explicitPreviousDraftSave(userText) || (approvedPrevious && previousAssistantPromisedNotepad(previousAssistant)))) {
    onStatus?.("saving to notepad...");
    const result = await executeTool("notepad_write", { text: previousDraft, mode: "append" }, ctx);
    emitStep({ name: "notepad_write", args: { text: previousDraft, mode: "append" }, result });
    const answer = /^error|notepad control is not available/i.test(String(result || ""))
      ? `I could not save it to notepad: ${result}`
      : "Saved to notepad.";
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  if (previousDraft && (wantsEmailDraftAction(userText) || (approvedPrevious && previousAssistantPromisedEmail(previousAssistant)) || (finalSendRequested && !assistantAlreadyInsertedEmailDraft(previousAssistant)))) {
    onStatus?.("inserting email draft...");
    const result = await executeTool("visible_browser_draft_email", { text: previousDraft }, ctx);
    emitStep({ name: "visible_browser_draft_email", args: { text: previousDraft }, result });
    const answer = /^error|visible browser.*not available|visible browser control is not available|browser pane is closed|user declined/i.test(String(result || ""))
      ? `I could not insert the email draft: ${result}`
      : "Draft inserted into the email reply box. I did not send it. Please review it and press Send yourself.";
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  if (finalSendRequested) {
    const answer = assistantAlreadyInsertedEmailDraft(previousAssistant)
      ? "I can't press Send from Boolean yet. The draft step is done; please review it in the browser and press Send yourself."
      : "I can draft the email in the browser, but I can't press Send yet. Please review the draft and press Send yourself.";
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  if (browserOpenTarget && config.ui?.aiBrowser !== false) {
    onStatus?.("opening browser...");
    const result = await executeTool("visible_browser_open", { url: browserOpenTarget }, ctx);
    emitStep({ name: "visible_browser_open", args: { url: browserOpenTarget }, result });
    const failed = /^AI browser access is disabled|visible browser.*not available|visible browser error|visible browser control timed out|visible browser control was cancelled/i.test(String(result || ""));
    const answer = failed
      ? `I tried to open the built-in browser, but it failed: ${result}`
      : (/\boutlook|email|mail\b/i.test(stripAppContext(userText))
          ? "Opened Outlook in the built-in browser."
          : "Opened it in the built-in browser.");
    messages.push({ role: "assistant", content: answer });
    return answer;
  }
  const freshBrowseRequired = requiresFreshBrowse(userText, messages);
  const searchMode = freshBrowseRequired ? ((wantsQuickWebAnswer(userText) || isContextualSportsFollowup(userText, messages)) ? "quick" : "shortlist") : "none";
  const searchShortlistMode = searchMode === "shortlist";
  const searchQuickAnswerMode = searchMode === "quick";
  if (searchQuickAnswerMode) {
    const fast = await fastCurrentAnswer(userText, ctx, emitStep, messages);
    if (fast) {
      messages.push({ role: "assistant", content: fast });
      return fast;
    }
  }
  const target = await resolveTarget(config, onStatus);
  const tinyTurn = isCasualTinyTurn(userText);
  let useNativeTools = !tinyTurn;
  let freshBrowseDone = false;
  let freshBrowseGuardUsed = false;
  let toolLeakGuardUsed = false;
  let quickAnswerGuardUsed = false;
  let notepadWroteThisTurn = false;
  let emailDraftedThisTurn = false;
  const emitUsage = (msg) => {
    if (onUsage && msg?.usage) onUsage({ provider: config.provider, model: target.model, ...msg.usage });
  };
  // token budget for trimming: the local window, or a generous cap for cloud
  let ctxBudget = config.provider === "local" ? (config.local.ctx || 32768) : 128000;
  const needsPriorContext = isLocalReportReference(userText) || isConversationReference(userText);
  const configuredContextMode = config.ui?.contextMode || "balanced";
  const contextMode = needsPriorContext
    ? (configuredContextMode === "full" ? "full" : "balanced")
    : (isCasualTinyTurn(userText) ? "tiny" : configuredContextMode);
  const { onOptimize } = ctx;
  let optimizeSent = false; // report once per turn
  const looksLikeContextOverflow = (err) =>
    /exceed.{0,30}context|context size|n_ctx|maximum context length/i.test((err.body || "") + (err.message || ""));

  const stopped = () => {
    const bail = "(stopped by user)";
    messages.push({ role: "assistant", content: bail });
    return bail;
  };

  if (freshBrowseRequired) {
    const query = contextualFreshSearchText(userText, messages);
    if (query) {
      onStatus(searchQuickAnswerMode ? "searching the web for the answer..." : "searching the web for top options...");
      const result = await executeTool("web_search", { query }, ctx);
      freshBrowseDone = true;
      freshBrowseGuardUsed = true;
      emitStep({ name: "web_search", args: { query }, result });
      messages.push({
        role: "user",
        content: [
          searchQuickAnswerMode ? quickSearchInstruction(userText) : shortlistSearchInstruction(userText),
          `TOOL RESULT for web_search:\n${result}`
        ].join("\n")
      });
    }
  }

  for (let turn = 0; turn < config.maxToolTurns; turn++) {
    if (signal?.aborted) return stopped();
    let msg;
    try {
      const fit = fitToContext(messages, ctxBudget, contextMode, userText, config.ui?.referenceChatMemory !== false);
      if (!optimizeSent && onOptimize) {
        optimizeSent = true;
        onOptimize({ mode: contextMode, sent: fit.sentTokens, full: fit.fullTokens,
          saved: Math.max(0, fit.fullTokens - fit.sentTokens), budget: fit.budget });
      }
      msg = await chatCompletion(target, fit.msgs, useNativeTools ? TOOL_DEFINITIONS : undefined, signal, onToken);
      emitUsage(msg);
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) return stopped();
      // prompt still too big for the engine — trim harder and retry automatically
      if (looksLikeContextOverflow(err) && ctxBudget > 4096) {
        ctxBudget = Math.floor(ctxBudget * 0.7);
        onStatus(`conversation too long for the model — trimming older history and retrying…`);
        continue;
      }
      if (useNativeTools && looksLikeNoToolSupport(err)) {
        useNativeTools = false;
        onStatus(`model '${target.model}' lacks native tool support — using text protocol`);
        convertNativeToolHistoryToText(messages);
        if (messages[0]?.role === "system" && !messages[0].content.includes("TOOL PROTOCOL")) {
          messages[0] = {
            role: "system",
            content: messages[0].content + "\n" + fallbackToolPrompt()
          };
        }
        continue;
      }
      throw err;
    }

    // Native tool calls (OpenAI format: arguments is a JSON string)
    if (useNativeTools && msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        let args = call.function?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        if ((searchShortlistMode || searchQuickAnswerMode) && freshBrowseDone && FRESH_BROWSE_TOOLS.has(name)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id || `call_${turn}`,
            content: browseGuardInstruction(searchMode)
          });
          continue;
        }
        const noteGuard = name === "notepad_write" ? notepadWriteGuard(userText, args) : "";
        if (noteGuard) {
          messages.push({
            role: "tool",
            tool_call_id: call.id || `call_${turn}`,
            content: "SYSTEM GUARD: notepad_write was blocked. " + noteGuard
          });
          continue;
        }
        onStatus(`running ${name}…`);
        const result = await executeTool(name, args, ctx);
        if (FRESH_BROWSE_TOOLS.has(name)) freshBrowseDone = true;
        if (name === "notepad_write") notepadWroteThisTurn = true;
        if (name === "visible_browser_draft_email") emailDraftedThisTurn = true;
        const toolContent = result + afterToolHint(name);
        emitStep({ name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: call.id || `call_${turn}`,
          content: toolContent
        });
      }
      continue;
    }

    const assistantContent = msg.content || "";

    // Text-protocol tool calls (checked in both modes — small models often
    // write a JSON block instead of using native tool calls)
    const call = parseFallbackToolCall(assistantContent);
    if (call) {
      messages.push({ role: "assistant", content: assistantContent });
      if ((searchShortlistMode || searchQuickAnswerMode) && freshBrowseDone && FRESH_BROWSE_TOOLS.has(call.name)) {
        messages.push({
          role: "user",
          content: browseGuardInstruction(searchMode)
        });
        continue;
      }
      const noteGuard = call.name === "notepad_write" ? notepadWriteGuard(userText, call.arguments) : "";
      if (noteGuard) {
        messages.push({
          role: "user",
          content: "SYSTEM GUARD: notepad_write was blocked. " + noteGuard
        });
        continue;
      }
      onStatus(`running ${call.name}…`);
      const result = await executeTool(call.name, call.arguments, ctx);
      if (FRESH_BROWSE_TOOLS.has(call.name)) freshBrowseDone = true;
      if (call.name === "notepad_write") notepadWroteThisTurn = true;
      if (call.name === "visible_browser_draft_email") emailDraftedThisTurn = true;
      const toolResultContent = result + afterToolHint(call.name);
      emitStep({ name: call.name, args: call.arguments, result });
      messages.push({
        role: "user",
        content: `TOOL RESULT for ${call.name}:\n${toolResultContent}`
      });
      continue;
    }

    // Backup guardrail: if preflight did not run for any reason, force one
    // visible browser search before accepting a final fresh-info answer.
    if (freshBrowseRequired && !freshBrowseDone && !freshBrowseGuardUsed) {
      freshBrowseGuardUsed = true;
      const query = contextualFreshSearchText(userText, messages);
      onStatus(searchQuickAnswerMode ? "searching the web for the answer..." : "searching the web for top options...");
      const result = await executeTool("web_search", { query }, ctx);
      freshBrowseDone = true;
      emitStep({ name: "web_search", args: { query }, result });
      messages.push({
        role: "user",
        content: [
          searchQuickAnswerMode ? quickSearchInstruction(userText) : shortlistSearchInstruction(userText),
          `TOOL RESULT for web_search:\n${result}`
        ].join("\n")
      });
      continue;
    }

    if (leaksToolPlan(assistantContent)) {
      messages.push({
        role: "user",
        content: [
          "SYSTEM GUARD: Do not explain internal tool names or tell the user to use them.",
          toolLeakGuardUsed
            ? "Your last answer still exposed tool names. Answer in plain language only, or use a tool if action is still needed."
            : "Use the available tools yourself if the task still needs action.",
          "Then answer the user with product names, sizes, prices, and links when available."
        ].join("\n")
      });
      toolLeakGuardUsed = true;
      continue;
    }

    if (searchQuickAnswerMode && !quickAnswerGuardUsed && violatesQuickAnswer(userText, assistantContent)) {
      messages.push({
        role: "user",
        content: [
          "SYSTEM GUARD: Your last answer did not answer the user's current-info question correctly.",
          "Use only the web_search evidence already provided. Answer the user's question directly.",
          "For news, give actual current story headlines with sources, not a list of news websites.",
          "Do not ask app-building questions, do not say to visit sources, and do not mention internal tools."
        ].join("\n")
      });
      quickAnswerGuardUsed = true;
      continue;
    }

    if (!notepadWroteThisTurn && falselyClaimsNotepad(assistantContent)) {
      messages.push({
        role: "user",
        content: [
          "SYSTEM GUARD: You claimed the notepad was saved or updated, but notepad_write has not run.",
          "If the user wants this content in the in-app notepad, call notepad_write with the exact note text.",
          "Otherwise, say plainly that you have not saved it yet. Do not claim it is saved."
        ].join("\n")
      });
      continue;
    }

    if (!emailDraftedThisTurn && falselyClaimsEmailDraft(assistantContent)) {
      messages.push({
        role: "user",
        content: [
          "SYSTEM GUARD: You claimed an email draft was inserted, but visible_browser_draft_email has not run.",
          "If the user wants it placed into the email reply box, call visible_browser_draft_email with the exact draft text.",
          "Never claim an email reply box was updated unless the tool succeeded."
        ].join("\n")
      });
      continue;
    }

    if (config.ui?.aiBrowser !== false && falselyDeniesBrowserAccess(assistantContent)) {
      const target = visibleBrowserOpenTarget(userText);
      if (target) {
        onStatus?.("opening browser...");
        const result = await executeTool("visible_browser_open", { url: target }, ctx);
        emitStep({ name: "visible_browser_open", args: { url: target }, result });
        messages.push({
          role: "user",
          content: "SYSTEM GUARD: You said you do not have browser access, but the built-in browser tool was just run. Answer from this result:\n" + result
        });
        continue;
      }
      messages.push({
        role: "user",
        content: [
          "SYSTEM GUARD: Do not say you lack browser access. Boolean has built-in browser tools.",
          "If the user asks to open, read, or use the browser, call visible_browser_open or visible_browser_read.",
          "Only mention a failure after a browser tool returns an actual error."
        ].join("\n")
      });
      continue;
    }

    // Final answer
    messages.push({ role: "assistant", content: assistantContent });
    return assistantContent;
  }

  const bail =
    "(stopped: reached the maximum number of tool steps for one request — " +
    "ask me to continue if you want more)";
  messages.push({ role: "assistant", content: bail });
  return bail;
}
