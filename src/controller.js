import path from "node:path";
import {
  appendTaskRunEvent,
  compactTaskRun,
  createTaskRun,
  publicTaskRun,
  syncTaskRunFromController,
  taskRunToolEvent,
  updateTaskRunVisual
} from "./task-runs.js";

const MUTATION_TOOLS = new Set([
  "write_file", "edit_file", "undo_last_edit", "git_restore",
  "apply_subagent_result", "create_artifact", "generate_image"
]);

const PREPARATION_TOOLS = new Set(["create_project"]);

const SELF_VERIFYING_TOOLS = new Set(["create_artifact", "generate_image"]);
const VERIFICATION_TOOLS = new Set([
  "run_project", "run_guarded", "review_repository", "screenshot_page",
  "inspect_page_layout"
]);

const INSPECTION_TOOLS = new Set([
  "list_dir", "read_file", "find_files", "search_files", "repository_map", "find_symbol",
  "git_status", "git_diff", "read_page", "visible_browser_read",
  "list_connectors", "mcp_list_tools"
]);

// MCP is a transport, not an action category. Discovery and account/data reads
// must count as inspection so the global loop guard can stop repeated connector
// rediscovery. Only clearly mutating inner tools count as progress actions.
const MCP_MUTATION_TOOL = /(?:^|_)(?:add|approve|archive|buy|cancel|close|create|delete|disable|edit|enable|execute|exercise|move|open|place|publish|remove|rename|reply|restore|sell|send|set|submit|trade|transfer|trash|update|upload|write)(?:_|$)/i;

const BACKGROUND_RESEARCH_TOOLS = new Set(["web_search", "research_web"]);
const VISIBLE_BROWSER_TOOLS = new Set([
  "screenshot_page", "read_page", "inspect_page_layout", "visible_browser_read",
  "visible_browser_open", "visible_browser_click", "visible_browser_type",
  "visible_browser_draft_email", "browser_open",
  "browser_click", "browser_form", "browser_download"
]);

const BROWSER_TOOLS = VISIBLE_BROWSER_TOOLS;
const DEPLOY_COMMAND = /\b(?:wrangler(?:\.cmd)?\s+deploy|npm\s+run\s+deploy|git\s+push|gh\s+release|publish(?:\s|$)|deploy(?:\s|$))/i;
const DEPLOY_REQUEST = /\b(?:deploy|publish|push|release)\b/i;
const NO_DEPLOY_REQUEST = /\b(?:do not|don't|never|no)\s+(?:deploy|publish|push|release)\b/i;
// Whole-task write restrictions are different from scoped safety constraints.
// "Do not edit files" makes the task read only; "do not modify the database
// schema" must remain a constraint while unrelated requested edits proceed.
const READ_ONLY_REQUEST = /\b(?:do not|don't|never)\s+(?:edit|change|write|modify)\s*(?:[.!?;,]|$)|\b(?:do not|don't|never)\s+(?:(?:edit|change|write|modify)\s+(?:anything|any\s+(?:files?|code)|files?|code|source(?:\s+files?)?|project(?:\s+files?)?|workspace|the\s+(?:files?|code|project|workspace)|this\s+(?:project|workspace))|(?:make|apply)\s+(?:any\s+)?changes?)\b|\bread[- ]only\s+(?:review|inspection|analysis|audit|task|request)\b|\b(?:review|inspect|analy[sz]e|audit)\b[^.!?\n]{0,80}\bwithout\s+(?:editing|changing|writing|modifying)\b/i;
const DEPLOY_VERSION = /\b(?:version|deployment|deployed|worker|pages|release|tag)\b.{0,80}\b([0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|v?\d+\.\d+\.\d+|https?:\/\/\S+)/i;
const LIVE_VERIFIED = /\b(?:HTTP\/\d(?:\.\d)?\s+)?(?:200|2\d\d)\b|\b(?:ok|healthy|success|verified|live|deployed)\b/i;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|cfut_[A-Za-z0-9_-]+|gh[opusr]_[A-Za-z0-9_-]+|GOCSPX-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/gi;
const CONSTRAINT_LINE = /\b(?:do not|don't|never|only|must|without|unless|keep|use this|no deploy|no browser|sandbox)\b/i;
const MAX_MEMORY_CHARS = 4800;

const ACTION_REQUEST = /(?:^|\b(?:please|can you|could you|would you|i want you to|i need you to|let['’]?s)\s+)(?:open|send|download|install|connect|schedule|change|set|create|build|make|edit|fix|update|delete|remove|move|rename|run|test|deploy|publish|commit|push|draft|reply|use|put|place|replace|switch|apply|restore|wire)\b/i;
const FEATURE_REQUEST = /\b(?:implement|add a |create|build new|make new|write a |code|develop|design|new feature|support for|enable)\b/i;
const DEBUG_REQUEST = /\b(?:bug|broken|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing|ure)?|fix|repair|regression|not working|doesn['’]?t work|stuck|cut(?:s|ting)? off|overlap(?:s|ping)?|wrong|issue)\b/i;

const CHECK_COMMAND = /\b(?:test|tests|build|lint|check|compile|typecheck|verify|validate|smoke)\b|\bnode\s+--check\b|\bdotnet\s+(?:test|build)\b|^\s*(?:node|npm|npx|git|gh|wrangler(?:\.cmd)?|dotnet|python|py)\s+(?:--version|-v|version)\s*$/i;
const INSPECTION_COMMAND = /\b(?:get-content|select-string|findstr|rg\b|grep\b|regex|matches|indexof|dir\b|ls\b|type\b|cat\b)\b/i;
const COMMAND_MUTATES_FILE = /\b(?:set-content|add-content|out-file|copy-item|move-item|remove-item|new-item|del|erase|rm|rmdir|mkdir)\b|(?:^|[^>])>{1,2}(?:[^>]|$)/i;
const FAILURE_RESULT = /^(?:error\b|blocked\b|failed\b|failure\b|timed out\b|user declined\b|could not\b|cannot\b)|\bexited(?:\s+immediately)?\s*\(?(?:code\s*)?[1-9]\d*\)?|\b(?:request|connection|network|syntax|parse|build|test) error\b/i;
const LOOP_BLOCK_REASON = /\b(?:loop guard|tool budget reached|too many inspection|repeated the same kind of inspection)\b/i;
const PROGRESS_WARNING_INSPECTIONS = 12;
const NON_PROGRESS_INSPECTION_LIMIT = 28;
// Advisory-only threshold: when the same file has been edited this many times
// with no passing/failing check in between, workingMemory nudges the model to
// verify before editing it again. It never blocks — legitimate edit→test→fix
// iteration resets the counter the moment a check runs.
const EDIT_CHURN_WARNING = 4;
// Strict mode stops loops early. These larger emergency limits are always
// enforced so optional preferences can never permit hundreds of wasted calls.
const EMERGENCY_NON_PROGRESS_INSPECTION_LIMIT = 48;
const EMERGENCY_COARSE_REPEAT_LIMIT = 6;
const EMERGENCY_EXACT_REPEAT_LIMIT = 4;

function cleanText(value, max = 240) {
  return String(value || "").replace(SECRET_PATTERN, "[redacted]").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizedPath(value) {
  if (!value) return "";
  try { return path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase(); } catch { return ""; }
}

function isWithin(root, target) {
  const base = normalizedPath(root);
  const candidate = normalizedPath(target);
  return !!base && !!candidate && (candidate === base || candidate.startsWith(base + path.sep.toLowerCase()));
}

function extractConstraints(text) {
  return String(text || "")
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => cleanText(line, 260))
    .filter((line) => line && CONSTRAINT_LINE.test(line))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(-10);
}

function isTaskWriteRestriction(text) {
  const value = String(text || "").trim();
  return READ_ONLY_REQUEST.test(value)
    || /^(?:this\s+(?:task|session|request|work)\s+(?:is\s+)?)?read[- ]only[.!]?$/i.test(value)
    || /\b(?:task|session|request|review|inspection|analysis|audit|preview|work|mode)\b[^.!?\n]{0,60}\bread[- ]only\b/i.test(value)
    || /\b(?:file|project) changes (?:are\s+)?(?:currently\s+)?blocked\b/i.test(value)
    || /\b(?:cannot|can not|can't)\s+(?:write|edit|modify|change)\b/i.test(value);
}

function currentPermissionAuthority(options, saved) {
  const objective = options.objective || saved.objective || "";
  const source = `${options.taskContext || ""}\n${objective}`;
  const latestUserText = String(options.currentUserText || "").trim();
  const hasPersisted = !!(options.persisted && typeof options.persisted === "object");
  // Initial tasks may express their boundary across objective + taskContext.
  // Restored tasks only gain new authority from values supplied for this turn.
  const authoritySource = latestUserText || (hasPersisted
    ? `${options.taskContext || ""}\n${options.objective || ""}`
    : source);
  const accessMode = ["read_only", "ask", "full_access"].includes(String(options.effectiveAccessMode || "").toLowerCase())
    ? String(options.effectiveAccessMode).toLowerCase()
    : (saved.accessMode || "ask");
  const noDeploy = NO_DEPLOY_REQUEST.test(authoritySource);
  const deployRequestedNow = DEPLOY_REQUEST.test(authoritySource) && !noDeploy;
  const actionRequestedNow = options.currentActionRequired === true
    || ACTION_REQUEST.test(authoritySource)
    || FEATURE_REQUEST.test(authoritySource)
    || DEBUG_REQUEST.test(authoritySource);
  const accessChangedToWrite = saved.accessMode === "read_only" && accessMode !== "read_only";
  const taskReadOnly = isTaskWriteRestriction(authoritySource)
    || (!latestUserText && /\bread[- ]only\b/i.test(authoritySource));
  const freshWriteAuthority = deployRequestedNow || actionRequestedNow || accessChangedToWrite;
  return {
    source,
    latestUserText,
    accessMode,
    noDeploy,
    deployRequestedNow,
    actionRequestedNow,
    taskReadOnly,
    freshWriteAuthority,
    supersedesWriteRestrictions: accessMode !== "read_only" && !taskReadOnly && freshWriteAuthority,
    supersedesDeployRestrictions: accessMode !== "read_only" && deployRequestedNow && !noDeploy
  };
}

function permissionRestrictionSuperseded(text, authority) {
  return (authority.supersedesWriteRestrictions && isTaskWriteRestriction(text))
    || (authority.supersedesDeployRestrictions && NO_DEPLOY_REQUEST.test(String(text || "")));
}

function withoutSupersededPermissionContext(text, authority) {
  if (!authority.supersedesWriteRestrictions && !authority.supersedesDeployRestrictions) return String(text || "");
  return String(text || "")
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line && !permissionRestrictionSuperseded(line, authority))
    .join(" ");
}

const WRITE_PERMISSION_FAILURE = /\b(?:task|session)\s+(?:is\s+)?read[- ]only\b|\b(?:file and project|file|project|connector|background process) changes (?:are\s+)?(?:currently\s+)?blocked\b|\bonly test, build, lint, and validation commands are allowed\b|\bcommits are blocked\b/i;
const DEPLOY_PERMISSION_FAILURE = /\bdeploy, publish, and push commands require an explicit deploy request\b/i;

function supersededPermissionFailure(saved, authority) {
  const events = Array.isArray(saved.taskRun?.events) ? saved.taskRun.events : [];
  const lastPermissionEvent = [...events].reverse().find((event) => event?.type === "permission.blocked");
  const detail = saved.lastFailure || lastPermissionEvent?.detail || "";
  return (authority.supersedesWriteRestrictions && WRITE_PERMISSION_FAILURE.test(detail))
    || (authority.supersedesDeployRestrictions && DEPLOY_PERMISSION_FAILURE.test(detail));
}

function extractExplicitRoots(text) {
  const lines = String(text || "").split(/\r?\n/);
  const roots = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:only work|work only|use this|inside this|sandbox folder|folder only)\b/i.test(lines[i])) continue;
    for (const candidate of lines.slice(i, i + 4)) {
      const match = candidate.match(/([A-Za-z]:\\[^\r\n`"']+)/);
      if (!match) continue;
      const value = match[1].trim().replace(/[.,;:]+$/, "");
      const root = normalizedPath(value);
      if (root) roots.push(root);
    }
  }
  return [...new Set(roots)].slice(0, 6);
}

function extractSourceOfTruth(text) {
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  const truth = {};
  const direct = [
    ["editFolder", /\b(?:edit|project|working)\s+folder\s*:\s*(.+)$/i],
    ["buildCommand", /\bbuild\s*(?:command)?\s*:\s*(.+)$/i],
    ["deployCommand", /\bdeploy\s*(?:command)?\s*:\s*(.+)$/i],
    ["liveUrl", /\blive\s*(?:site|url)?\s*:\s*(https?:\/\/\S+)/i],
    ["verificationUrl", /\bverification\s*(?:url|site)?\s*:\s*(https?:\/\/\S+)/i]
  ];
  for (const line of lines) {
    for (const [key, pattern] of direct) {
      const match = line.match(pattern);
      if (match && !truth[key]) truth[key] = cleanText(match[1].replace(/[.,;]+$/, ""), 600);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim();
    const next = cleanText(lines[i + 1] || "", 600);
    if (!next) continue;
    if (/^build\s*:?\s*$/i.test(label) && !truth.buildCommand) truth.buildCommand = next;
    if (/^deploy\s*:?\s*$/i.test(label) && !truth.deployCommand) truth.deployCommand = next;
    if (/^live\s+(?:site|url)\s*:?\s*$/i.test(label) && !truth.liveUrl && /^https?:\/\//i.test(next)) truth.liveUrl = next;
    if (/^verification\s+(?:site|url)\s*:?\s*$/i.test(label) && !truth.verificationUrl && /^https?:\/\//i.test(next)) truth.verificationUrl = next;
  }
  return truth;
}

function extractWindowsPaths(command) {
  const text = String(command || "");
  const paths = [];
  const quoted = /(["'])([A-Za-z]:\\.*?)\1/g;
  for (const match of text.matchAll(quoted)) paths.push(match[2]);
  const unquoted = /(?:^|[\s=])([A-Za-z]:\\[^\s;|&"']+)/g;
  for (const match of text.matchAll(unquoted)) paths.push(match[1]);
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
}

function isTrustedExternalToolchainPath(value) {
  const candidate = normalizedPath(value);
  if (!candidate) return false;
  const segments = candidate.replace(/\//g, "\\");
  return segments.includes("\\.nuget\\packages\\")
    || segments.includes("\\.dotnet\\")
    || segments.includes("\\program files\\dotnet\\")
    || segments.includes("\\program files (x86)\\windows kits\\")
    || segments.includes("\\program files\\microsoft visual studio\\");
}

function commandMayReferenceExternalToolchain(command, candidate) {
  if (!isTrustedExternalToolchainPath(candidate)) return false;
  const text = String(command || "");
  if (COMMAND_MUTATES_FILE.test(text) && !CHECK_COMMAND.test(text)) return false;
  if (CHECK_COMMAND.test(text)) return true;
  return /\.(?:exe|dll|targets|props|tasks)$/i.test(String(candidate || ""));
}

function inferContract(options, saved, authority = currentPermissionAuthority(options, saved)) {
  const {
    source, latestUserText, accessMode, noDeploy, deployRequestedNow,
    actionRequestedNow, freshWriteAuthority, taskReadOnly
  } = authority;
  const savedWriteBlocked = saved.writeAllowed === false || saved.mode === "read_only";
  const writeAllowed = accessMode !== "read_only"
    && !taskReadOnly
    && !(savedWriteBlocked && !freshWriteAuthority);
  const keepSavedDeploy = saved.deployAllowed === true && !noDeploy && !actionRequestedNow;
  const deployAllowed = accessMode !== "read_only" && (deployRequestedNow || keepSavedDeploy);

  let mode = "general";
  if (accessMode === "read_only") mode = "read_only";
  else if (deployAllowed) mode = "deploy";
  else if (!writeAllowed) mode = "read_only";
  else if (!latestUserText && !options.objective && !options.taskContext && !options.projectDir && saved.mode) mode = saved.mode;
  else if (/\bsandbox(?:\s+(?:only|folder))?\b/i.test(source)) mode = "sandbox_edit";
  else if (options.projectDir || saved.projectBound) mode = "project_edit";

  const browserPolicy = /\b(?:do not|don't|never|no)\s+(?:use|open|start)?\s*(?:the\s+)?browser\b/i.test(source)
    ? "blocked"
    : /\b(?:browser|visual|screenshot|rendered page|live site|website|web app|localhost|gmail|outlook|mailbox|inbox|oauth|email cleanup)\b/i.test(options.objective || "") ? "allowed" : "on_demand";
  const allowedRoots = [...new Set([
    options.projectDir || "",
    ...extractExplicitRoots(source),
    ...(Array.isArray(saved.allowedRoots) ? saved.allowedRoots : [])
  ].map((item) => normalizedPath(item)).filter(Boolean))].slice(0, 6);
  return { mode, accessMode, writeAllowed, browserPolicy, deployAllowed, allowedRoots };
}

function actionFingerprint(name, args = {}) {
  const safe = {};
  for (const key of Object.keys(args).sort()) {
    if (/key|secret|token|password|authorization/i.test(key)) safe[key] = "[redacted]";
    else safe[key] = cleanText(typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key], 500);
  }
  return `${name}:${JSON.stringify(safe)}`;
}

function fileArgument(args = {}) {
  const firstChange = Array.isArray(args.changes)
    ? args.changes.find((change) => change?.path || change?.file || change?.absolutePath)
    : null;
  return args.path || args.file || firstChange?.absolutePath || firstChange?.path || firstChange?.file || args.cwd || "";
}

function fileArguments(args = {}) {
  const values = [args.path, args.file];
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) values.push(change?.absolutePath || change?.path || change?.file || "");
  }
  return [...new Set(values.map((value) => cleanText(value, 260)).filter(Boolean))];
}

function defaultPlan(projectBound, debugRequired = false, objective = "") {
  const task = String(objective || "").toLowerCase();
  if (debugRequired) {
    return [
      { step: "Inspect the relevant code and current project state", status: "in_progress" },
      { step: "Reproduce the reported failure and record evidence", status: "pending" },
      { step: "Identify the root cause and apply a targeted fix", status: "pending" },
      { step: "Repeat the reproduction and run regression checks", status: "pending" },
      { step: "Report the verified before-and-after result", status: "pending" }
    ];
  }
  if (/\b(?:email|gmail|outlook|mailbox|inbox)\b/.test(task)) {
    if (/\b(?:clean|cleanup|trash|spam|old mail|old email)\b/.test(task)) {
      return [
        { step: "Verify the connected mailbox", status: "in_progress" },
        { step: "Open the mailbox in Boolean browser", status: "pending" },
        { step: "Apply protection rules", status: "pending" },
        { step: "Scan and group cleanup candidates", status: "pending" },
        { step: "Review the read-only cleanup plan", status: "pending" },
        { step: "Request confirmation before moving mail", status: "pending" },
        { step: "Report results and Undo details", status: "pending" }
      ];
    }
    return [
      { step: "Verify the connected mailbox", status: "in_progress" },
      { step: "Open the relevant email in Boolean browser", status: "pending" },
      { step: "Read the requested conversation or messages", status: "pending" },
      { step: "Prepare the requested email result", status: "pending" },
      { step: "Report the verified outcome", status: "pending" }
    ];
  }
  if (/\b(?:website|web app|landing page|dashboard|game|application|frontend|html|css)\b/.test(task)) {
    return [
      { step: projectBound ? "Inspect the current project" : "Prepare the project workspace", status: "in_progress" },
      { step: "Create the implementation plan", status: "pending" },
      { step: "Build the requested experience", status: "pending" },
      { step: "Run the project locally", status: "pending" },
      { step: "Open the result in Boolean browser", status: "pending" },
      { step: "Run checks and inspect the result", status: "pending" },
      { step: "Report the verified outcome", status: "pending" }
    ];
  }
  if (/\b(?:deploy|publish|release|installer|package)\b/.test(task)) {
    return [
      { step: "Inspect the project and release state", status: "in_progress" },
      { step: "Run required checks", status: "pending" },
      { step: "Build the release artifacts", status: "pending" },
      { step: "Deploy to the requested targets", status: "pending" },
      { step: "Verify the deployed result", status: "pending" },
      { step: "Report links, versions, and checksums", status: "pending" }
    ];
  }
  if (/\b(?:browser|web page|page|site|research|search the web|look up)\b/.test(task)) {
    return [
      { step: "Confirm the requested page or research target", status: "in_progress" },
      { step: "Open the target in Boolean browser", status: "pending" },
      { step: "Inspect the relevant content", status: "pending" },
      { step: "Complete the requested browser task", status: "pending" },
      { step: "Report the verified result", status: "pending" }
    ];
  }
  return [
    { step: projectBound ? "Inspect the current project" : "Prepare the project workspace", status: "in_progress" },
    { step: "Implement the requested result", status: "pending" },
    { step: "Run checks and inspect the result", status: "pending" },
    { step: "Report the verified outcome", status: "pending" }
  ];
}

function normalizePlan(plan, projectBound, debugRequired = false, objective = "") {
  const source = Array.isArray(plan) && plan.length ? plan : defaultPlan(projectBound, debugRequired, objective);
  return source.slice(0, 20).map((item) => ({
    step: cleanText(item?.step, 180) || "Task step",
    status: ["pending", "in_progress", "done"].includes(item?.status) ? item.status : "pending"
  }));
}

function setPlanProgress(plan, index, status) {
  if (!plan[index]) return;
  plan[index].status = status;
  if (status === "in_progress") {
    for (let i = 0; i < index; i++) if (plan[i].status !== "done") plan[i].status = "done";
  }
}

function advanceMatchingPlanStep(plan, matcher, { activateNext = true } = {}) {
  const index = plan.findIndex((item) => matcher.test(String(item?.step || "")));
  if (index < 0) return false;
  setPlanProgress(plan, index, "done");
  if (activateNext && plan[index + 1]?.status === "pending") plan[index + 1].status = "in_progress";
  return true;
}

function advanceTaskPlanForTool(plan, name) {
  if (!Array.isArray(plan) || !plan.length) return;
  if (name === "visible_browser_open") {
    advanceMatchingPlanStep(plan, /\bopen\b.*\b(?:browser|mailbox|email|target|result)\b/i);
    return;
  }
  if (name === "email_cleanup_preview") {
    for (const matcher of [
      /\bverify\b.*\bmailbox\b/i,
      /\bopen\b.*\bmailbox\b/i,
      /\bprotection rules\b/i,
      /\bscan\b.*\bcandidates\b/i,
      /\breview\b.*\bcleanup plan\b/i
    ]) advanceMatchingPlanStep(plan, matcher, { activateNext: false });
    const confirmation = plan.findIndex((item) => /\bconfirmation\b/i.test(String(item?.step || "")));
    if (confirmation >= 0) setPlanProgress(plan, confirmation, "in_progress");
    return;
  }
  if (name === "email_cleanup_trash" || name === "email_cleanup_undo") {
    const report = plan.findIndex((item) => /\breport\b/i.test(String(item?.step || "")));
    if (report >= 0) setPlanProgress(plan, report, "in_progress");
    return;
  }
  if (/^email_/.test(name)) {
    advanceMatchingPlanStep(plan, /\bverify\b.*\bmailbox\b/i, { activateNext: false });
    advanceMatchingPlanStep(plan, /\bopen\b.*\b(?:mailbox|email)\b/i, { activateNext: false });
    if (!advanceMatchingPlanStep(plan, /\b(?:read|scan)\b/i)) {
      advanceMatchingPlanStep(plan, /\bprepare\b/i);
    }
    return;
  }
  if (name === "run_project") {
    advanceMatchingPlanStep(plan, /\brun\b.*\b(?:project|locally)\b/i);
    return;
  }
  if (name === "read_page" || name === "screenshot_page" || name === "inspect_page_layout") {
    advanceMatchingPlanStep(plan, /\b(?:inspect|checks)\b/i);
  }
}

function isFailure(result) {
  return FAILURE_RESULT.test(String(result || "").trim());
}

function isVerification(name, args) {
  if (VERIFICATION_TOOLS.has(name) || name === "read_page" || name === "visible_browser_read") return true;
  return name === "run_command" && CHECK_COMMAND.test(String(args?.command || ""));
}

function isDeployCommand(name, args) {
  return name === "run_command" && DEPLOY_COMMAND.test(String(args?.command || ""));
}

function isInspectionCommand(name, args = {}) {
  if (name !== "run_command") return false;
  const command = String(args.command || "");
  if (!command || CHECK_COMMAND.test(command) || DEPLOY_COMMAND.test(command)) return false;
  return INSPECTION_COMMAND.test(command);
}

export function isInspectionTool(name, args = {}) {
  if (INSPECTION_TOOLS.has(name)) return true;
  if (name !== "mcp_call_tool") return false;
  const innerTool = String(args.tool || args.name || "").trim();
  return !innerTool || !MCP_MUTATION_TOOL.test(innerTool);
}

function isLoopBlock(reason = "") {
  return LOOP_BLOCK_REASON.test(String(reason || ""));
}

function isOptionalVisualVerificationFailure(name, result = "") {
  if (!["inspect_page_layout", "screenshot_page", "visible_browser_read"].includes(name)) return false;
  return /(?:visible browser error|timed out|unsupported image|text-only|json value could not be converted|capture failed|could not inspect)/i.test(String(result || ""));
}

function commandSubject(command = "") {
  const paths = extractWindowsPaths(command)
    .map((item) => path.basename(item).toLowerCase())
    .filter(Boolean)
    .sort();
  if (paths.length) return paths.slice(0, 4).join(",");
  const files = [...String(command || "").matchAll(/\b[A-Za-z0-9_.-]+\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|json|md|ps1|cs|py|toml|ya?ml)\b/gi)]
    .map((match) => match[0].toLowerCase())
    .sort();
  if (files.length) return files.slice(0, 4).join(",");
  return cleanText(command, 80).toLowerCase();
}

function coarseActionFingerprint(name, args = {}) {
  if (isInspectionCommand(name, args)) return `coarse:run_inspect:${commandSubject(args.command)}`;
  if (name === "list_connectors") return "coarse:connector_discovery:list";
  if (name === "mcp_list_tools") {
    return `coarse:connector_discovery:${cleanText(args.connector || "default", 80).toLowerCase()}`;
  }
  if (name === "mcp_call_tool" && isInspectionTool(name, args)) {
    const connector = cleanText(args.connector || "default", 80).toLowerCase();
    const tool = cleanText(args.tool || "unknown", 100).toLowerCase();
    return `coarse:connector_read:${connector}:${tool}`;
  }
  if (isInspectionTool(name, args)) return `coarse:inspect:${name}:${cleanText(fileArgument(args) || args.query || args.url || "", 120).toLowerCase()}`;
  if (BROWSER_TOOLS.has(name)) return `coarse:browser:${name}:${cleanText(args.url || args.selector || args.text || "", 120).toLowerCase()}`;
  return "";
}

function isDeployVerification(name, args, result, sourceOfTruth = {}) {
  if (isFailure(result)) return false;
  const targetUrl = sourceOfTruth.verificationUrl || sourceOfTruth.liveUrl || "";
  const argText = `${args?.url || ""} ${args?.command || ""} ${args?.query || ""}`;
  const resultText = String(result || "");
  if (targetUrl && (argText.includes(targetUrl) || resultText.includes(targetUrl))) return true;
  if ((name === "read_page" || name === "visible_browser_read" || name === "research_web" || name === "web_search") && /^https?:\/\//i.test(argText)) return true;
  if (name === "run_command" && /\b(?:curl|Invoke-WebRequest|iwr|wget)\b/i.test(String(args?.command || "")) && LIVE_VERIFIED.test(resultText)) return true;
  return false;
}

export class AgentController {
  constructor(options = {}) {
    const saved = options.persisted && typeof options.persisted === "object" ? options.persisted : {};
    const answerOnly = options.answerOnly === true;
    const currentActionRequired = !answerOnly && (options.actionRequired === true || options.artifactRequired === true);
    const permissionAuthority = currentPermissionAuthority({ ...options, currentActionRequired }, saved.contract || saved);
    this.objective = cleanText(options.objective || saved.objective, 4000);
    this.artifactRequired = answerOnly ? false : !!(options.artifactRequired || saved.artifactRequired);
    this.debugRequired = answerOnly ? false : saved.debugRequired === true || (this.artifactRequired && DEBUG_REQUEST.test(this.objective) && !FEATURE_REQUEST.test(this.objective));
    this.actionRequired = answerOnly ? false : !!(saved.actionRequired || options.actionRequired || this.artifactRequired || ACTION_REQUEST.test(this.objective));
    this.projectBound = !!(options.projectDir || saved.projectBound);
    this.taskContext = cleanText(withoutSupersededPermissionContext(options.taskContext || saved.taskContext, permissionAuthority), 12000);
    this.contract = inferContract({ ...options, currentActionRequired }, saved.contract || saved, permissionAuthority);
    this.sourceOfTruth = {
      ...(saved.sourceOfTruth && typeof saved.sourceOfTruth === "object" ? saved.sourceOfTruth : {}),
      ...extractSourceOfTruth(`${options.taskContext || ""}\n${options.objective || ""}`)
    };
    this.constraints = [...new Set([
      ...(Array.isArray(saved.constraints) ? saved.constraints.map((item) => cleanText(item, 260)) : []),
      ...extractConstraints(this.taskContext)
    ])].filter((item) => item && !permissionRestrictionSuperseded(item, permissionAuthority)).slice(-10);
    this.phase = saved.phase || (this.artifactRequired ? "planning" : "executing");
    this.plan = (this.artifactRequired || this.actionRequired)
      ? normalizePlan(saved.plan, this.projectBound, this.debugRequired, this.objective)
      : [];
    this.toolCount = Number(saved.toolCount) || 0;
    this.preparationCount = Number(saved.preparationCount) || 0;
    this.inspectionCount = Number(saved.inspectionCount) || 0;
    this.mutationCount = Number(saved.mutationCount) || 0;
    this.successfulActionCount = Number(saved.successfulActionCount) || 0;
    this.lastMutation = Number(saved.lastMutation) || 0;
    this.lastVerification = Number(saved.lastVerification) || 0;
    this.consecutiveFailures = Number(saved.consecutiveFailures) || 0;
    this.lastFailure = cleanText(saved.lastFailure, 500);
    this.verificationEvidence = Array.isArray(saved.verificationEvidence)
      ? saved.verificationEvidence.map((item) => cleanText(item, 220)).filter(Boolean).slice(-6)
      : [];
    this.baselineCheckCount = Number(saved.baselineCheckCount) || 0;
    this.reproductionEvidence = cleanText(saved.reproductionEvidence, 600);
    this.rootCauseEvidence = cleanText(saved.rootCauseEvidence, 600);
    this.postFixEvidence = cleanText(saved.postFixEvidence, 600);
    this.inspectedFiles = Array.isArray(saved.inspectedFiles) ? saved.inspectedFiles.map((item) => cleanText(item, 260)).filter(Boolean).slice(-12) : [];
    this.changedFiles = Array.isArray(saved.changedFiles) ? saved.changedFiles.map((item) => cleanText(item, 260)).filter(Boolean).slice(-12) : [];
    this.checks = Array.isArray(saved.checks) ? saved.checks.map((item) => cleanText(item, 260)).filter(Boolean).slice(-8) : [];
    this.recentActions = Array.isArray(saved.recentActions) ? saved.recentActions.map((item) => cleanText(item, 260)).filter(Boolean).slice(-10) : [];
    this.actionCounts = saved.actionCounts && typeof saved.actionCounts === "object" ? { ...saved.actionCounts } : {};
    // Per-file edit churn: counts edits to a file with no intervening check.
    // Unlike actionCounts it is NOT wiped on each mutation, so repeated re-edits
    // of the same file accumulate and surface an advisory in workingMemory.
    this.editChurn = saved.editChurn && typeof saved.editChurn === "object" ? { ...saved.editChurn } : {};
    this.nonProgressCount = Number(saved.nonProgressCount) || 0;
    const savedLoopStop = saved.loopStopEnabled ?? saved.loopStop;
    this.loopStopEnabled = options.loopStop === undefined ? savedLoopStop === true : options.loopStop === true;
    this.deployEvidence = cleanText(saved.deployEvidence, 700);
    this.deployVerificationEvidence = cleanText(saved.deployVerificationEvidence, 700);
    this.blockedToolCount = Number(saved.blockedToolCount) || 0;
    this.blockedActionCounts = saved.blockedActionCounts && typeof saved.blockedActionCounts === "object" ? { ...saved.blockedActionCounts } : {};
    if (supersededPermissionFailure(saved, permissionAuthority)) {
      this.phase = "executing";
      this.consecutiveFailures = 0;
      this.lastFailure = "";
      this.blockedToolCount = 0;
      this.blockedActionCounts = {};
    }
    this.openProcesses = Array.isArray(saved.openProcesses)
      ? saved.openProcesses.map((item) => cleanText(item, 80)).filter(Boolean).slice(-8)
      : [];
    this.openProcessCommands = saved.openProcessCommands && typeof saved.openProcessCommands === "object"
      ? Object.fromEntries(Object.entries(saved.openProcessCommands).slice(-8).map(([name, command]) => [cleanText(name, 80), cleanText(command, 500)]).filter(([name]) => name))
      : {};
    // Per-run token/time budget (0 = unlimited). Set from config.ui.codingAgent.budget.
    // Runtime options are authoritative. Older saved controllers contain 0
    // from the former unlimited default; using only that saved value made the
    // visible Normal (150k) budget a no-op.
    this.tokenBudget = Math.max(0, Number(options.tokenBudget ?? saved.tokenBudget) || 0);
    this.tokensUsed = Number(saved.tokensUsed) || 0;
    this.timeBudgetMs = Math.max(0, Number(options.timeBudgetMs ?? saved.timeBudgetMs) || 0);
    this.startedAt = Number(saved.startedAt) || Date.now();
    this.cancelRequested = !!saved.cancelRequested;
    // Active-controller mode (autopilot): re-enables auto-continue, verification
    // nudge, and recovery prompts. Off by default so the neutral relay is unchanged.
    this.autopilot = options.autopilot === true;
    // Model-curated findings: the model records durable notes via the `remember`
    // tool; they surface in workingMemory even after older chat is trimmed.
    this.notes = Array.isArray(saved.notes) ? saved.notes.map((n) => cleanText(n, 300)).filter(Boolean).slice(-12) : [];
    this.verificationNudged = saved.verificationNudged === true;
    this.visualVerificationNudged = saved.visualVerificationNudged === true;
    this.teamWorkers = saved.teamWorkers && typeof saved.teamWorkers === "object"
      ? Object.fromEntries(Object.entries(saved.teamWorkers).slice(0, 8).map(([role, worker]) => [cleanText(role, 80), {
          role: cleanText(worker?.role || role, 80), provider: cleanText(worker?.provider, 60), model: cleanText(worker?.model, 120),
          state: ["queued", "working", "stalled", "retrying", "draining", "done", "failed", "cancelled"].includes(worker?.state) ? worker.state : "failed",
          attempt: Math.max(1, Number(worker?.attempt) || 1), detail: cleanText(worker?.detail, 500),
          objective: cleanText(worker?.objective, 500), workspace: cleanText(worker?.workspace, 500),
          maxTurns: Math.max(0, Number(worker?.maxTurns) || 0), startedAt: Number(worker?.startedAt) || 0,
          lastProgressAt: Number(worker?.lastProgressAt) || 0, deadlineAt: Number(worker?.deadlineAt) || 0,
          finishedAt: Number(worker?.finishedAt) || 0, updatedAt: Number(worker?.updatedAt) || Date.now()
        }]))
      : {};
    this.updatedAt = Date.now();
    this.taskRun = createTaskRun({
      objective: this.objective,
      startedAt: this.startedAt,
      persisted: saved.taskRun
    });
    if (!this.taskRun.events.length) {
      appendTaskRunEvent(this.taskRun, {
        type: "run.started", status: "active", title: "Task started", detail: this.objective
      });
    }
    syncTaskRunFromController(this.taskRun, this);

    // Per-thread rolling digest: tracks answers given, corrections received,
    // and active topics so workingMemory can surface them even when chat is trimmed.
    this.conversationDigest = {
      recentAnswers: Array.isArray(saved.conversationDigest?.recentAnswers) ? saved.conversationDigest.recentAnswers : [],
      activeTopic: saved.conversationDigest?.activeTopic || "",
      userCorrections: Array.isArray(saved.conversationDigest?.userCorrections) ? saved.conversationDigest.userCorrections : [],
      recentDecisions: Array.isArray(saved.conversationDigest?.recentDecisions) ? saved.conversationDigest.recentDecisions : []
    };  }

  snapshot() {
    return {
      version: 2,
      objective: this.objective,
      taskContext: this.taskContext,
      contract: { ...this.contract, allowedRoots: [...this.contract.allowedRoots] },
      sourceOfTruth: { ...this.sourceOfTruth },
      constraints: [...this.constraints],
      artifactRequired: this.artifactRequired,
      debugRequired: this.debugRequired,
      actionRequired: this.actionRequired,
      projectBound: this.projectBound,
      showPlan: this.artifactRequired,
      phase: this.phase,
      plan: this.plan.map((item) => ({ ...item })),
      toolCount: this.toolCount,
      preparationCount: this.preparationCount,
      inspectionCount: this.inspectionCount,
      mutationCount: this.mutationCount,
      successfulActionCount: this.successfulActionCount,
      lastMutation: this.lastMutation,
      lastVerification: this.lastVerification,
      consecutiveFailures: this.consecutiveFailures,
      lastFailure: this.lastFailure,
      verificationEvidence: [...this.verificationEvidence],
      baselineCheckCount: this.baselineCheckCount,
      reproductionEvidence: this.reproductionEvidence,
      rootCauseEvidence: this.rootCauseEvidence,
      postFixEvidence: this.postFixEvidence,
      inspectedFiles: [...this.inspectedFiles],
      changedFiles: [...this.changedFiles],
      checks: [...this.checks],
      recentActions: [...this.recentActions],
      actionCounts: { ...this.actionCounts },
      editChurn: { ...this.editChurn },
      nonProgressCount: this.nonProgressCount,
      loopStopEnabled: this.loopStopEnabled,
      deployEvidence: this.deployEvidence,
      deployVerificationEvidence: this.deployVerificationEvidence,
      blockedToolCount: this.blockedToolCount,
      blockedActionCounts: { ...this.blockedActionCounts },
      openProcesses: [...this.openProcesses],
      openProcessCommands: { ...this.openProcessCommands },
      tokenBudget: this.tokenBudget,
      tokensUsed: this.tokensUsed,
      timeBudgetMs: this.timeBudgetMs,
      startedAt: this.startedAt,
      cancelRequested: this.cancelRequested,
      updatedAt: this.updatedAt,
      conversationDigest: this.conversationDigest,
      notes: [...this.notes],
      verificationNudged: this.verificationNudged,
      visualVerificationNudged: this.visualVerificationNudged,
      teamWorkers: Object.fromEntries(Object.entries(this.teamWorkers).map(([role, worker]) => [role, { ...worker }])),
      taskRun: publicTaskRun(this.taskRun),
      compaction: compactTaskRun(this.taskRun, this)
    };
  }

  /** Record a durable finding curated by the model (via the `remember` tool). */
  addNote(text) {
    const note = cleanText(text, 300);
    if (note) {
      this.notes.push(note);
      this.notes = this.notes.slice(-12);
      this.updatedAt = Date.now();
    }
    return this.snapshot();
  }

  /** Persist specialist lifecycle without counting it as lead tool work. */
  noteTeamWorker(worker = {}, detail = "") {
    const role = cleanText(worker.role || "Specialist", 80);
    const state = ["queued", "working", "stalled", "retrying", "draining", "done", "failed", "cancelled"].includes(worker.state) ? worker.state : "working";
    const prior = this.teamWorkers[role] || {};
    const now = Date.now();
    const entry = {
      ...prior,
      role,
      provider: cleanText(worker.provider, 60),
      model: cleanText(worker.model, 120),
      state,
      attempt: Math.max(1, Number(worker.attempt) || 1),
      detail: cleanText(detail, 500),
      objective: cleanText(worker.objective || prior.objective, 500),
      workspace: cleanText(worker.workspace || prior.workspace, 500),
      maxTurns: Math.max(0, Number(worker.maxTurns ?? prior.maxTurns) || 0),
      startedAt: Number(worker.startedAt || prior.startedAt) || (state === "working" || state === "retrying" ? now : 0),
      lastProgressAt: Number(worker.lastProgressAt) || (state === "working" || state === "retrying" ? now : Number(prior.lastProgressAt) || 0),
      deadlineAt: Number(worker.deadlineAt || prior.deadlineAt) || 0,
      finishedAt: ["done", "failed", "cancelled"].includes(state) ? now : 0,
      updatedAt: now
    };
    this.teamWorkers[role] = entry;
    this.updatedAt = entry.updatedAt;
    appendTaskRunEvent(this.taskRun, {
      type: `team.worker.${state}`,
      status: ["failed", "cancelled"].includes(state) ? "failed" : state === "done" ? "done" : "active",
      title: `${role} ${state === "retrying" ? "retrying" : state}`,
      detail: entry.detail || `${entry.model || entry.provider || "Model"} ${state}`,
      details: { role, provider: entry.provider, model: entry.model, attempt: entry.attempt }
    }, { dedupe: false });
    return this.snapshot();
  }

  /**
   * Update the per-thread digest from the latest assistant + user messages.
   * Called after each turn so workingMemory() always has fresh context.
   */
  updateDigest(assistantText, userText) {
    // Track answers given (compact, last 8)
    if (typeof assistantText === "string" && assistantText.length > 60) {
      const entry = cleanText(assistantText, 300);
      this.conversationDigest.recentAnswers.push(entry);
      this.conversationDigest.recentAnswers = this.conversationDigest.recentAnswers.slice(-8);
    }
    // Detect corrections from user
    if (typeof userText === "string") {
      const isCorrection = /\b(not what i asked|thats not|that'?s not|you misunderstood|no\b.*(?:i said|i meant|i wanted)|correction|actually\b)/i.test(userText);
      if (isCorrection) {
        this.conversationDigest.userCorrections.push(cleanText(userText, 200));
        this.conversationDigest.userCorrections = this.conversationDigest.userCorrections.slice(-4);
      }
      // Track active topic (last non-trivial user message)
      if (!/^(ok|okay|yes|no|thanks|thank you|ready|continue|go ahead|keep going|sure|right|cool|nice|great|good|perfect)[.!? ]*$/i.test(userText.trim())) {
        this.conversationDigest.activeTopic = cleanText(userText, 200);
      }
      // Extract and store user decisions/preferences
      const decisionMatch = userText.match(/(?:i want|i'd like|use |choose |go with|let's (?:use|go|make)|prefer|switch to|change (?:it|this|to)|make (?:it|sure)|don't (?:use|do))(?: to)?\b(.{1,150})/i);
      if (decisionMatch) {
        this.conversationDigest.recentDecisions.push(cleanText(decisionMatch[0], 200));
        this.conversationDigest.recentDecisions = this.conversationDigest.recentDecisions.slice(-6);
      }
    }
    this.updatedAt = Date.now();
  }
  workingMemory() {
    const next = this.plan.find((item) => item.status === "in_progress")?.step ||
      this.plan.find((item) => item.status === "pending")?.step || "Answer or report the completed result.";
    const lines = [
      "BOOLEAN WORKING MEMORY (persistent; follow this even when older chat is trimmed):",
      `Objective: ${cleanText(this.objective || "Complete the latest request.", 700)}`,
      `Mode: ${this.contract.mode}; access: ${this.contract.accessMode}; file changes: ${this.contract.writeAllowed ? "allowed" : "blocked"}; browser: ${this.contract.browserPolicy}; deploy: ${this.contract.deployAllowed ? "allowed" : "blocked unless explicitly requested"}.`,
      this.contract.allowedRoots.length ? `Allowed workspace roots: ${this.contract.allowedRoots.join(" | ")}` : "",
      Object.keys(this.sourceOfTruth).length ? `Project source of truth: ${Object.entries(this.sourceOfTruth).map(([key, value]) => `${key}=${value}`).join(" | ")}` : "",
      this.constraints.length ? `User constraints: ${cleanText(this.constraints.join(" | "), 700)}` : "",
      this.taskContext ? `Recent user intent: ${cleanText(this.taskContext.slice(-1000), 1000)}` : "",
      /\b(?:these|those|all (?:of )?(?:this|that|them)|the remaining|this things|those fixes)\b/i.test(this.objective)
        ? "Scope fidelity: the request refers to an earlier checklist or recommendation. Treat every referenced item as acceptance criteria; do not silently implement only one item. If the referenced scope cannot be identified, ask before editing."
        : "",
      this.inspectedFiles.length ? `Inspected: ${this.inspectedFiles.slice(-6).join(" | ")}` : "",
      this.changedFiles.length ? `Changed: ${this.changedFiles.slice(-6).join(" | ")}` : "",
      this.conversationDigest.activeTopic ? `Active topic: ${this.conversationDigest.activeTopic}` : "",
      this.conversationDigest.userCorrections.length ? `User corrections: ${this.conversationDigest.userCorrections.slice(-2).join(" | ")}` : "",
      this.conversationDigest.recentAnswers.length ? `Recent answers: ${this.conversationDigest.recentAnswers.slice(-3).map(a => a.slice(0, 150)).join(" | ")}` : "",
      this.conversationDigest.recentDecisions?.length ? `User decisions: ${this.conversationDigest.recentDecisions.slice(-3).join(" | ")}` : "",
      this.checks.length ? `Checks: ${this.checks.slice(-4).join(" | ")}` : "",
      this.notes.length ? `Findings recorded: ${this.notes.slice(-6).join(" | ")}` : "",
      this.openProcesses.length ? `Open temporary processes: ${this.openProcesses.join(" | ")}` : "",
      this.lastFailure ? `Unresolved failure: ${this.lastFailure}` : "",
      `Next step: ${next}`
    ].filter(Boolean);
    const nextLine = lines.pop();
    const body = lines.join("\n").slice(0, Math.max(0, MAX_MEMORY_CHARS - nextLine.length - 1));
    return `${body}\n${nextLine}`;
  }

  handoffReport() {
    const next = this.plan.find((item) => item.status !== "done")?.step || "No remaining planned step.";
    return [
      `Goal: ${cleanText(this.objective || "Complete the latest request.", 700)}`,
      `Mode: ${this.contract.mode}`,
      Object.keys(this.sourceOfTruth).length ? `Source of truth: ${Object.entries(this.sourceOfTruth).map(([key, value]) => `${key}=${value}`).join(" | ")}` : "Source of truth: none recorded",
      `Files changed: ${this.changedFiles.length ? this.changedFiles.join(" | ") : "none recorded"}`,
      `Checks: ${this.checks.length ? this.checks.join(" | ") : "none recorded"}`,
      `Deploy proof: ${this.deployEvidence || "none recorded"}`,
      `Live verification: ${this.deployVerificationEvidence || "none recorded"}`,
      `Open processes: ${this.openProcesses.length ? this.openProcesses.join(" | ") : "none"}`,
      `Last failure: ${this.lastFailure || "none"}`,
      `Next step: ${next}`
    ].join("\n");
  }

  prompt() {
    const lines = [
      this.workingMemory(),
      "BOOLEAN TASK CONTROLLER:",
      `Phase: ${this.phase}.`
    ];
    if (this.plan.length) {
      lines.push("Plan:");
      for (const item of this.plan) lines.push(`- [${item.status === "done" ? "x" : item.status === "in_progress" ? ">" : " "}] ${item.step}`);
    }
    if (this.lastFailure) {
      lines.push(`Last failure: ${this.lastFailure}`);
      if (isLoopBlock(this.lastFailure)) {
        lines.push("LOOP RECOVERY: do not start by inspecting the same files, running another search, or checking current state again. Use the evidence already collected. The next progress step must be a targeted edit, a known build/test/check command, or a plain blocker summary.");
      } else {
        lines.push("Diagnose the evidence and change strategy. Do not repeat the same failing action unchanged.");
      }
    }
    if (Object.keys(this.sourceOfTruth).length) {
      const truth = Object.entries(this.sourceOfTruth).map(([k, v]) => `${k}: ${v}`).join(" | ");
      lines.push(`Recorded for this task: ${truth}`);
    }
    if (this.debugRequired) {
      if (this.reproductionEvidence) lines.push(`Reproduced: ${this.reproductionEvidence}`);
      if (this.rootCauseEvidence) lines.push(`Root cause: ${this.rootCauseEvidence}`);
      if (this.postFixEvidence) lines.push(`Verified: ${this.postFixEvidence}`);
    }
    if (this.nonProgressCount >= PROGRESS_WARNING_INSPECTIONS) {
      lines.push("Note: several inspections have run without a change or new evidence yet.");
    }
    const churned = Object.entries(this.editChurn)
      .filter(([, count]) => count >= EDIT_CHURN_WARNING)
      .sort((a, b) => b[1] - a[1]);
    if (churned.length) {
      const [file, count] = churned[0];
      lines.push(`Note: ${path.basename(file)} has been edited ${count} times with no build/test/check in between. Run the project's check to verify the current state before editing it again, or move on to the next step.`);
    }
    return lines.join("\n");
  }

  allowTool(name, args = {}) {
    // The model decides when the visible browser is useful; it is not gated here.
    if (!this.contract.writeAllowed && (MUTATION_TOOLS.has(name) || PREPARATION_TOOLS.has(name))) {
      return { allowed: false, reason: "The task is read-only; file and project changes are blocked." };
    }
    if (!this.contract.writeAllowed && name === "mcp_call_tool" && !isInspectionTool(name, args)) {
      return { allowed: false, reason: "The task is read-only; connector changes are blocked." };
    }
    if (!this.contract.writeAllowed && ["run_background", "stop_process"].includes(name)) {
      return { allowed: false, reason: "The task is read-only; background process changes are blocked." };
    }
    if (!this.contract.writeAllowed && name === "run_command"
        && !CHECK_COMMAND.test(String(args.command || ""))
        && !(this.contract.deployAllowed && DEPLOY_COMMAND.test(String(args.command || "")))) {
      return { allowed: false, reason: "The task is read-only; only test, build, lint, and validation commands are allowed." };
    }
    if (name === "git_commit" && !this.contract.writeAllowed) {
      return { allowed: false, reason: "The task is read-only; commits are blocked." };
    }
    if (name === "run_command" && DEPLOY_COMMAND.test(String(args.command || "")) && !this.contract.deployAllowed) {
      return { allowed: false, reason: "Deploy, publish, and push commands require an explicit deploy request for this task." };
    }
    if (name === "run_command" && this.sourceOfTruth.deployCommand && DEPLOY_COMMAND.test(String(args.command || ""))) {
      const wanted = cleanText(this.sourceOfTruth.deployCommand, 500).toLowerCase();
      const actual = cleanText(args.command, 500).toLowerCase();
      if (!actual.includes(wanted)) {
        return { allowed: false, reason: `Use the project source-of-truth deploy command: ${this.sourceOfTruth.deployCommand}` };
      }
    }
    const requestedPath = fileArgument(args);
    if (requestedPath && path.isAbsolute(String(requestedPath)) && this.contract.allowedRoots.length &&
        !this.contract.allowedRoots.some((root) => isWithin(root, requestedPath))) {
      return { allowed: false, reason: `Path is outside the task's allowed workspace: ${cleanText(requestedPath, 260)}` };
    }
    if (name === "run_command" && this.contract.allowedRoots.length) {
      const absolutePaths = extractWindowsPaths(args.command);
      const outside = absolutePaths.find((candidate) =>
        !this.contract.allowedRoots.some((root) => isWithin(root, candidate.trim()))
        && !commandMayReferenceExternalToolchain(args.command, candidate)
      );
      if (outside) return { allowed: false, reason: `Command references a path outside the allowed workspace: ${cleanText(outside, 260)}` };
    }
    const coarseFingerprint = coarseActionFingerprint(name, args);
    // record_debug_evidence always allowed — it is the debug workflow own mechanism
    if (name === "record_debug_evidence") return { allowed: true, reason: "" };
    // Large source files often need several different bounded line reads. Keep
    // broad searches strict, but allow enough distinct ranges to understand one
    // large file before requiring an edit or check.
    const coarseRepeatLimit = name === "read_file"
      ? (this.loopStopEnabled ? 6 : Math.max(6, EMERGENCY_COARSE_REPEAT_LIMIT))
      : (this.loopStopEnabled ? 3 : EMERGENCY_COARSE_REPEAT_LIMIT);
    if (coarseFingerprint && (this.actionCounts[coarseFingerprint] || 0) >= coarseRepeatLimit) {
      return { allowed: false, synthesize: true, reason: "Loop guard reached. Do not inspect again; enough evidence has already been collected. Synthesize the requested answer now." };
    }
    const nonProgressLimit = this.loopStopEnabled
      ? NON_PROGRESS_INSPECTION_LIMIT
      : EMERGENCY_NON_PROGRESS_INSPECTION_LIMIT;
    if (this.nonProgressCount >= nonProgressLimit && (isInspectionTool(name, args) || BROWSER_TOOLS.has(name) || isInspectionCommand(name, args))) {
      return { allowed: false, synthesize: true, reason: "Tool budget reached. Do not inspect again; enough evidence has already been collected. Synthesize the requested answer now." };
    }
    const fingerprint = actionFingerprint(name, args);
    const exactRepeatLimit = this.loopStopEnabled ? 2 : EMERGENCY_EXACT_REPEAT_LIMIT;
    if ((this.actionCounts[fingerprint] || 0) >= exactRepeatLimit && (isInspectionTool(name, args) || BROWSER_TOOLS.has(name))) {
      return { allowed: false, synthesize: true, reason: `Loop guard: '${name}' already ran with this target. Use the existing result and answer now.` };
    }
    // Debug evidence is tracked and surfaced, but no longer blocks edits — the
    // model decides when it understands a bug well enough to change code.
    return { allowed: true, reason: "" };
  }

  noteBlockedTool(name, args = {}, reason = "") {
    this.blockedToolCount++;
    this.updatedAt = Date.now();
    const fingerprint = actionFingerprint(name, args);
    this.blockedActionCounts[fingerprint] = (this.blockedActionCounts[fingerprint] || 0) + 1;
    this.consecutiveFailures++;
    this.lastFailure = `${name} blocked: ${cleanText(reason, 420)}`;
    this.phase = isLoopBlock(reason) ? "recovering" : "blocked";
    appendTaskRunEvent(this.taskRun, {
      type: "permission.blocked", status: "failed", title: `${name.replaceAll("_", " ")} blocked`, detail: reason
    });
    return {
      count: this.blockedToolCount,
      repeated: this.blockedActionCounts[fingerprint],
      stop: this.blockedToolCount >= 3 || this.blockedActionCounts[fingerprint] >= 3,
      snapshot: this.snapshot()
    };
  }

  noteTool(name, args = {}, result = "") {
    this.toolCount++;
    this.updatedAt = Date.now();
    const fingerprint = actionFingerprint(name, args);
    const coarseFingerprint = coarseActionFingerprint(name, args);
    this.actionCounts[fingerprint] = (this.actionCounts[fingerprint] || 0) + 1;
    if (coarseFingerprint) this.actionCounts[coarseFingerprint] = (this.actionCounts[coarseFingerprint] || 0) + 1;
    this.recentActions.push(`${name}: ${cleanText(fileArgument(args) || args.command || result, 220)}`);
    this.recentActions = this.recentActions.slice(-10);
    taskRunToolEvent(this.taskRun, name, args, result, isFailure(result));

    if (name === "run_background" && !isFailure(result)) {
      const started = String(result || "").match(/Started background process ['\"]([^'\"]+)['\"]/i)?.[1] || cleanText(args.name, 80);
      if (started && /\brunning\b/i.test(String(result || "")) && !this.openProcesses.includes(started)) this.openProcesses.push(started);
      if (started && /\brunning\b/i.test(String(result || ""))) this.openProcessCommands[started] = cleanText(args.command, 500);
      this.openProcesses = this.openProcesses.slice(-8);
    } else if (name === "stop_process") {
      const stopped = cleanText(args.name, 80).toLowerCase();
      this.openProcesses = this.openProcesses.filter((item) => item.toLowerCase() !== stopped);
      for (const processName of Object.keys(this.openProcessCommands)) {
        if (processName.toLowerCase() === stopped) delete this.openProcessCommands[processName];
      }
    }

    if (name === "update_plan" && Array.isArray(args.steps) && args.steps.length) {
      this.plan = normalizePlan(args.steps, this.projectBound, this.debugRequired, this.objective);
      this.phase = "executing";
      syncTaskRunFromController(this.taskRun, this);
      return this.snapshot();
    }

    if (name === "record_debug_evidence") {
      const stage = String(args.stage || "");
      const summary = cleanText(args.summary, 600);
      if (!this.debugRequired) return this.snapshot();
      if (!summary) {
        this.consecutiveFailures++;
        this.lastFailure = "record_debug_evidence: a concrete evidence summary is required";
        this.phase = "recovering";
        return this.snapshot();
      }
      // Record whatever the model reports. The stage order is no longer policed —
      // the model decides how it wants to work through a bug.
      if (stage === "reproduced") {
        this.reproductionEvidence = summary;
        this.phase = "diagnosing";
        setPlanProgress(this.plan, 1, "done");
        if (this.plan[2]) this.plan[2].status = "in_progress";
      } else if (stage === "root_cause") {
        this.rootCauseEvidence = summary;
        this.phase = "executing";
      } else if (stage === "verified") {
        this.postFixEvidence = summary;
        this.phase = "verifying";
        setPlanProgress(this.plan, 3, "done");
        if (this.plan[4]) this.plan[4].status = "in_progress";
      }
      this.consecutiveFailures = 0;
      this.lastFailure = "";
      return this.snapshot();
    }

    const failed = isFailure(result);
    const verification = isVerification(name, args) || SELF_VERIFYING_TOOLS.has(name);
    const previewUrl = name === "run_project" && !failed
      ? String(result || "").match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'<>]*/i)?.[0] || ""
      : "";
    if (MUTATION_TOOLS.has(name) && !failed && this.taskRun.visual?.enabled) {
      updateTaskRunVisual(this.taskRun, { state: "building", verifiedAt: 0 });
    }
    if (name === "run_project") {
      if (failed && this.taskRun.visual?.enabled) updateTaskRunVisual(this.taskRun, { state: "failed", detail: result });
      else if (previewUrl) {
        updateTaskRunVisual(this.taskRun, {
          state: "previewing", previewUrl, cycle: (this.taskRun.visual?.cycle || 0) + 1, verifiedAt: 0, forceEvent: true
        });
      }
    }
    if (["visible_browser_open", "browser_open"].includes(name) && this.artifactRequired && !failed) {
      const openedUrl = String(args?.url || result || "").match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'<>]*/i)?.[0] || "";
      if (openedUrl) updateTaskRunVisual(this.taskRun, {
        state: "previewing", previewUrl: openedUrl,
        cycle: (this.taskRun.visual?.cycle || 0) + 1, verifiedAt: 0, forceEvent: true
      });
    }
    if (["screenshot_page", "inspect_page_layout"].includes(name) && (this.taskRun.visual?.enabled || this.artifactRequired)) {
      updateTaskRunVisual(this.taskRun, failed
        ? { state: "failed", detail: result }
        : { state: "verified", verifiedAt: Date.now(), forceEvent: true });
    }
    const deployCommand = isDeployCommand(name, args);
    if (deployCommand && !failed) {
      const version = String(result || "").match(DEPLOY_VERSION)?.[1] || "";
      this.deployEvidence = cleanText(version ? `${version} — ${result}` : result, 700);
      this.phase = "verifying";
      setPlanProgress(this.plan, this.plan.length > 2 ? 1 : 0, "done");
      if (this.plan[2]?.status === "pending") this.plan[2].status = "in_progress";
    }
    if (this.deployEvidence && isDeployVerification(name, args, result, this.sourceOfTruth)) {
      this.deployVerificationEvidence = `${name}: ${cleanText(result, 650)}`;
      this.phase = "verifying";
    }
    if (this.debugRequired && this.mutationCount === 0 && verification) {
      this.baselineCheckCount++;
    }
    if (isOptionalVisualVerificationFailure(name, result) && this.mutationCount > 0 && this.lastVerification >= this.lastMutation) {
      const warning = `${name}: optional visual verification failed after a successful post-change check; do not keep retrying this helper. ${cleanText(result, 160)}`;
      this.checks.push(warning);
      this.verificationEvidence.push(warning);
      this.checks = this.checks.slice(-8);
      this.verificationEvidence = this.verificationEvidence.slice(-6);
      this.consecutiveFailures = 0;
      this.lastFailure = "";
      this.phase = "verifying";
      return this.snapshot();
    }
    if (failed) {
      // A check ran (even a failing one) — it is fresh evidence, so re-editing a
      // file after it is legitimate iteration, not churn. Clear the churn counter.
      if (verification) this.editChurn = {};
      if (this.debugRequired && this.mutationCount === 0 && verification) {
        this.lastFailure = "";
        this.consecutiveFailures = 0;
        this.phase = "reproducing";
        return this.snapshot();
      }
      this.consecutiveFailures++;
      this.lastFailure = `${name}: ${cleanText(result, 420)}`;
      this.phase = "recovering";
      return this.snapshot();
    }

    this.consecutiveFailures = 0;
    this.lastFailure = "";
    const inspectionCommand = isInspectionCommand(name, args);
    const inspectionTool = isInspectionTool(name, args);
    if (name !== "update_plan" && !inspectionTool && !inspectionCommand) this.successfulActionCount++;
    if (PREPARATION_TOOLS.has(name)) {
      this.preparationCount++;
      this.phase = "executing";
      setPlanProgress(this.plan, 0, "done");
      if (this.plan[1]?.status === "pending") this.plan[1].status = "in_progress";
    }
    if (inspectionTool || inspectionCommand) {
      this.inspectionCount++;
      this.nonProgressCount++;
      const inspected = cleanText(fileArgument(args) || commandSubject(args.command), 260);
      if (inspected && !this.inspectedFiles.includes(inspected)) this.inspectedFiles.push(inspected);
      this.inspectedFiles = this.inspectedFiles.slice(-12);
      setPlanProgress(this.plan, 0, "done");
      if (this.plan[1]?.status === "pending") this.plan[1].status = "in_progress";
    }

    if (MUTATION_TOOLS.has(name)) {
      this.mutationCount++;
      this.nonProgressCount = 0;
      this.actionCounts = {};
      const changedPaths = fileArguments(args);
      const changed = changedPaths[0] || "";
      for (const changedPath of changedPaths) {
        if (!this.changedFiles.includes(changedPath)) this.changedFiles.push(changedPath);
      }
      this.changedFiles = this.changedFiles.slice(-12);
      if (changed) {
        this.editChurn[changed] = (this.editChurn[changed] || 0) + 1;
        const churnKeys = Object.keys(this.editChurn);
        if (churnKeys.length > 12) delete this.editChurn[churnKeys[0]];
      }
      this.lastMutation = this.toolCount;
      this.phase = "executing";
      const implementationIndex = this.debugRequired ? 2 : 1;
      setPlanProgress(this.plan, implementationIndex, "done");
      if (this.plan[implementationIndex + 1]) this.plan[implementationIndex + 1].status = "in_progress";
    }

    if (verification) {
      this.editChurn = {};
      this.lastVerification = this.toolCount;
      const evidence = `${name}: ${cleanText(result, 180)}`;
      if (evidence) this.verificationEvidence.push(evidence);
      if (evidence) this.checks.push(evidence);
      this.checks = this.checks.slice(-8);
      this.verificationEvidence = this.verificationEvidence.slice(-6);
      if (this.debugRequired && this.mutationCount === 0) {
        this.phase = "reproducing";
      } else {
        this.phase = "verifying";
        const verificationIndex = this.debugRequired ? 3 : 2;
        setPlanProgress(this.plan, verificationIndex, "done");
        if (this.plan[verificationIndex + 1]) this.plan[verificationIndex + 1].status = "in_progress";
      }
    }
    advanceTaskPlanForTool(this.plan, name);
    syncTaskRunFromController(this.taskRun, this);
    return this.snapshot();
  }

  /** Called each turn by the agent loop to accumulate token usage. */
  addUsage(usage) {
    if (!usage) return;
    const tokens = (usage.input || 0) + (usage.output || 0);
    if (tokens > 0) this.tokensUsed += tokens;
  }

  /** Returns {budgeted, reason} when a per-run token or time limit is exceeded. */
  checkBudget() {
    if (this.cancelRequested) return { budgeted: true, reason: "The task was cancelled by the user." };
    if (this.tokenBudget > 0 && this.tokensUsed >= this.tokenBudget) {
      return { budgeted: true, reason: `Token budget of ${this.tokenBudget} has been reached for this task.` };
    }
    if (this.timeBudgetMs > 0 && (Date.now() - this.startedAt) >= this.timeBudgetMs) {
      return { budgeted: true, reason: `Time budget of ${Math.round(this.timeBudgetMs / 1000)}s has been reached for this task.` };
    }
    return { budgeted: false };
  }

  /** User-requested cancellation. Returns a snapshot. */
  cancel() {
    this.cancelRequested = true;
    this.updatedAt = Date.now();
    appendTaskRunEvent(this.taskRun, { type: "run.paused", status: "waiting", title: "Task paused", detail: "Paused by the user." });
    return this.snapshot();
  }

  // The model decides when a task is finished. Boolean no longer refuses a final
  // answer for missing evidence — the only hard requirement is that an answer exists.
  // A still-running background process is the one soft nudge worth keeping, because
  // leaving one behind makes a finished task look stuck.
  evaluateCompletion(answer) {
    if (!cleanText(answer)) return { complete: false, reason: "The model returned no final result." };
    if (["blocked", "recovering"].includes(this.phase) && this.lastFailure) {
      this.updatedAt = Date.now();
      syncTaskRunFromController(this.taskRun, this);
      return { complete: false, reason: `The task is paused after a blocked action: ${cleanText(this.lastFailure, 300)}` };
    }
    if (this.openProcesses.length) {
      const visualVerified = this.taskRun.visual?.state === "verified";
      const blockingProcesses = this.openProcesses.filter((name) => {
        const command = this.openProcessCommands[name] || "";
        const looksLikePreview = /(?:preview|server|serve|dev|watch)/i.test(`${name} ${command}`);
        return !(visualVerified && looksLikePreview);
      });
      if (blockingProcesses.length) {
        return { complete: false, reason: `Temporary process still running: ${blockingProcesses.join(", ")}. Stop it with stop_process before finishing so the task does not look stuck.` };
      }
    }
    if (this.projectBound && this.artifactRequired && this.mutationCount === 0) {
      this.phase = "executing";
      this.updatedAt = Date.now();
      return {
        complete: false,
        reason: "This project task has not changed any project file. Use the available project tools to implement the requested work instead of only describing a timeline or tutorial."
      };
    }
    // Verification nudge (autopilot only): a build/fix task that changed files but
    // ran no build/test/check should confirm before finishing — once, so it can
    // never loop. Neutral relay keeps its current "accept the answer" behavior.
    if (this.projectBound && this.artifactRequired && this.mutationCount > 0
        && this.lastVerification < this.lastMutation && !this.postFixEvidence) {
      this.verificationNudged = true;
      this.phase = "verifying";
      this.updatedAt = Date.now();
      return { complete: false, reason: "Files changed, but no successful build/test/check has verified the current edits. Run the project's relevant check after the last change. If verification is unavailable or fails, report the exact blocker instead of claiming completion." };
    }
    if (this.autopilot && !this.visualVerificationNudged && this.taskRun.visual?.enabled
        && this.taskRun.visual.previewUrl && this.taskRun.visual.state !== "verified") {
      this.visualVerificationNudged = true;
      this.phase = "verifying";
      this.updatedAt = Date.now();
      updateTaskRunVisual(this.taskRun, { state: "inspecting" });
      return { complete: false, reason: "The local preview is open but the latest screen has not been visually checked. Capture or inspect the rendered page once, fix any visible issue, and then finish with the verified outcome." };
    }
    this.phase = "completed";
    for (const item of this.plan) item.status = "done";
    this.updatedAt = Date.now();
    syncTaskRunFromController(this.taskRun, this);
    appendTaskRunEvent(this.taskRun, { type: "run.completed", status: "done", title: "Task completed", detail: "The requested work is ready." });
    return { complete: true, reason: "Done." };
  }

  continuationPrompt(reason) {
    const loopBlock = isLoopBlock(reason);
    const r = cleanText(reason, 500);
    const next = this.plan.find((item) => item.status && item.status !== "done")?.step;
    const tail = next ? ` Planned next step: ${next}.` : "";
    const roots = (this.contract.allowedRoots || []).slice(0, 3).map((root) => cleanText(root, 260)).filter(Boolean);
    const files = this.inspectedFiles.slice(-4).map((file) => cleanText(file, 260)).filter(Boolean);
    const location = `${roots.length ? ` Stay inside the exact allowed workspace: ${roots.join(" | ")}.` : ""}${files.length ? ` Reuse these already inspected targets without locating them again: ${files.join(" | ")}.` : ""}`;
    if (loopBlock) {
      return `${r} Re-read WORKING MEMORY above.${location} Do not repeat the blocked action — use the evidence already gathered and take a different concrete step: a targeted edit, a known build/test/check command, or a plain blocker summary.${tail}`;
    }
    if (r) return `${r} Re-read WORKING MEMORY above and continue in this same run toward the objective.${tail}`;
    return `Re-read WORKING MEMORY above and continue in this same run toward the objective.${tail}`;
  }
}

export function createAgentController(options) {
  return new AgentController(options);
}
