import path from "node:path";

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
  "list_dir", "read_file", "find_files", "search_files", "find_symbol",
  "git_status", "git_diff", "read_page", "visible_browser_read"
]);

const BACKGROUND_RESEARCH_TOOLS = new Set(["web_search", "research_web"]);
const VISIBLE_BROWSER_TOOLS = new Set([
  "screenshot_page", "read_page", "inspect_page_layout", "visible_browser_read",
  "visible_browser_open", "visible_browser_click", "visible_browser_type",
  "visible_browser_draft_email", "browser_open",
  "browser_click", "browser_form", "browser_download"
]);

const BROWSER_TOOLS = VISIBLE_BROWSER_TOOLS;
const DEPLOY_COMMAND = /\b(?:wrangler(?:\.cmd)?\s+deploy|npm\s+run\s+deploy|git\s+push|gh\s+release|publish(?:\s|$)|deploy(?:\s|$))/i;
const DEPLOY_VERSION = /\b(?:version|deployment|deployed|worker|pages|release|tag)\b.{0,80}\b([0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}|v?\d+\.\d+\.\d+|https?:\/\/\S+)/i;
const LIVE_VERIFIED = /\b(?:HTTP\/\d(?:\.\d)?\s+)?(?:200|2\d\d)\b|\b(?:ok|healthy|success|verified|live|deployed)\b/i;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|cfut_[A-Za-z0-9_-]+|gh[opusr]_[A-Za-z0-9_-]+|GOCSPX-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/gi;
const CONSTRAINT_LINE = /\b(?:do not|don't|never|only|must|without|unless|keep|use this|no deploy|no browser|sandbox)\b/i;
const MAX_MEMORY_CHARS = 3200;

const ACTION_REQUEST = /(?:^|\b(?:please|can you|could you|would you|i want you to|i need you to)\s+)(?:open|send|download|install|connect|schedule|change|set|create|build|make|edit|fix|update|delete|remove|move|rename|run|test|deploy|publish|commit|push|draft|reply)\b/i;
const DEBUG_REQUEST = /\b(?:bug|broken|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing|ure)?|fix|repair|regression|not working|doesn['’]?t work|stuck|cut(?:s|ting)? off|overlap(?:s|ping)?|wrong|issue)\b/i;

const CHECK_COMMAND = /\b(?:test|tests|build|lint|check|compile|typecheck|verify|validate|smoke)\b|\bnode\s+--check\b|\bdotnet\s+(?:test|build)\b/i;
const INSPECTION_COMMAND = /\b(?:get-content|select-string|findstr|rg\b|grep\b|regex|matches|indexof|dir\b|ls\b|type\b|cat\b)\b/i;
const COMMAND_MUTATES_FILE = /\b(?:set-content|add-content|out-file|copy-item|move-item|remove-item|new-item|del|erase|rm|rmdir|mkdir)\b|(?:^|[^>])>{1,2}(?:[^>]|$)/i;
const FAILURE_RESULT = /^(?:error\b|blocked\b|failed\b|failure\b|timed out\b|user declined\b|could not\b|cannot\b)|\bexited\s*\(?(?:code\s*)?[1-9]\d*\)?|\b(?:request|connection|network|syntax|parse|build|test) error\b/i;
const LOOP_BLOCK_REASON = /\b(?:loop guard|tool budget reached|too many inspection|repeated the same kind of inspection)\b/i;
const PROGRESS_WARNING_INSPECTIONS = 12;
const NON_PROGRESS_INSPECTION_LIMIT = 28;

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

function inferContract(options, saved) {
  const source = `${options.taskContext || ""}\n${options.objective || saved.objective || ""}`;
  const noDeploy = /\b(?:do not|don't|never|no)\s+(?:deploy|publish|push)\b/i.test(source);
  let mode = saved.mode || "general";
  if (/\b(?:read[- ]only|do not (?:edit|change|write)|don't (?:edit|change|write))\b/i.test(source)) mode = "read_only";
  else if (/\bsandbox(?:\s+(?:only|folder))?\b/i.test(source)) mode = "sandbox_edit";
  else if (!noDeploy && /\b(?:deploy|publish|push)\b/i.test(options.objective || "")) mode = "deploy";
  else if (options.projectDir || saved.projectBound) mode = "project_edit";

  const browserPolicy = /\b(?:do not|don't|never|no)\s+(?:use|open|start)?\s*(?:the\s+)?browser\b/i.test(source)
    ? "blocked"
    : /\b(?:browser|visual|screenshot|rendered page|live site)\b/i.test(options.objective || "") ? "allowed" : "on_demand";
  const allowedRoots = [...new Set([
    ...(Array.isArray(saved.allowedRoots) ? saved.allowedRoots : []),
    ...extractExplicitRoots(source),
    options.projectDir || ""
  ].map((item) => normalizedPath(item)).filter(Boolean))].slice(0, 6);
  return { mode, browserPolicy, deployAllowed: mode === "deploy" && !noDeploy, allowedRoots };
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
  return args.path || args.file || args.cwd || "";
}

function defaultPlan(projectBound, debugRequired = false) {
  if (debugRequired) {
    return [
      { step: "Inspect the relevant code and current project state", status: "in_progress" },
      { step: "Reproduce the reported failure and record evidence", status: "pending" },
      { step: "Identify the root cause and apply a targeted fix", status: "pending" },
      { step: "Repeat the reproduction and run regression checks", status: "pending" },
      { step: "Report the verified before-and-after result", status: "pending" }
    ];
  }
  return [
    { step: projectBound ? "Inspect the current project" : "Prepare the project workspace", status: "in_progress" },
    { step: "Implement the requested result", status: "pending" },
    { step: "Run checks and inspect the result", status: "pending" },
    { step: "Report the verified outcome", status: "pending" }
  ];
}

function normalizePlan(plan, projectBound, debugRequired = false) {
  const source = Array.isArray(plan) && plan.length ? plan : defaultPlan(projectBound, debugRequired);
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

function isFailure(result) {
  return FAILURE_RESULT.test(String(result || "").trim());
}

function isVerification(name, args) {
  if (VERIFICATION_TOOLS.has(name)) return true;
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

function isLoopBlock(reason = "") {
  return LOOP_BLOCK_REASON.test(String(reason || ""));
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
  if (INSPECTION_TOOLS.has(name)) return `coarse:inspect:${name}:${cleanText(fileArgument(args) || args.query || args.url || "", 120).toLowerCase()}`;
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
    this.objective = cleanText(options.objective || saved.objective, 4000);
    this.artifactRequired = !!(options.artifactRequired || saved.artifactRequired);
    this.debugRequired = saved.debugRequired === true || (this.artifactRequired && DEBUG_REQUEST.test(this.objective));
    this.actionRequired = !!(saved.actionRequired || options.actionRequired || this.artifactRequired || ACTION_REQUEST.test(this.objective));
    this.projectBound = !!(options.projectDir || saved.projectBound);
    this.taskContext = cleanText(options.taskContext || saved.taskContext, 12000);
    this.contract = inferContract(options, saved.contract || saved);
    this.sourceOfTruth = {
      ...(saved.sourceOfTruth && typeof saved.sourceOfTruth === "object" ? saved.sourceOfTruth : {}),
      ...extractSourceOfTruth(`${options.taskContext || ""}\n${options.objective || ""}`)
    };
    this.constraints = [...new Set([
      ...(Array.isArray(saved.constraints) ? saved.constraints.map((item) => cleanText(item, 260)) : []),
      ...extractConstraints(options.taskContext || "")
    ])].filter(Boolean).slice(-10);
    this.phase = saved.phase || (this.artifactRequired ? "planning" : "executing");
    this.plan = this.artifactRequired ? normalizePlan(saved.plan, this.projectBound, this.debugRequired) : [];
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
    this.nonProgressCount = Number(saved.nonProgressCount) || 0;
    const savedLoopStop = saved.loopStopEnabled ?? saved.loopStop;
    this.loopStopEnabled = options.loopStop === undefined ? savedLoopStop === true : options.loopStop === true;
    this.deployEvidence = cleanText(saved.deployEvidence, 700);
    this.deployVerificationEvidence = cleanText(saved.deployVerificationEvidence, 700);
    this.blockedToolCount = Number(saved.blockedToolCount) || 0;
    this.blockedActionCounts = saved.blockedActionCounts && typeof saved.blockedActionCounts === "object" ? { ...saved.blockedActionCounts } : {};
    this.openProcesses = Array.isArray(saved.openProcesses)
      ? saved.openProcesses.map((item) => cleanText(item, 80)).filter(Boolean).slice(-8)
      : [];
    // Per-run token/time budget (0 = unlimited). Set from config.ui.codingAgent.budget.
    this.tokenBudget = Number(saved.tokenBudget) || 0;
    this.tokensUsed = Number(saved.tokensUsed) || 0;
    this.timeBudgetMs = Number(saved.timeBudgetMs) || 0;
    this.startedAt = Number(saved.startedAt) || Date.now();
    this.cancelRequested = !!saved.cancelRequested;
    this.updatedAt = Date.now();
  }

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
      nonProgressCount: this.nonProgressCount,
      loopStopEnabled: this.loopStopEnabled,
      deployEvidence: this.deployEvidence,
      deployVerificationEvidence: this.deployVerificationEvidence,
      blockedToolCount: this.blockedToolCount,
      blockedActionCounts: { ...this.blockedActionCounts },
      openProcesses: [...this.openProcesses],
      tokenBudget: this.tokenBudget,
      tokensUsed: this.tokensUsed,
      timeBudgetMs: this.timeBudgetMs,
      startedAt: this.startedAt,
      cancelRequested: this.cancelRequested,
      updatedAt: this.updatedAt
    };
  }

  workingMemory() {
    const next = this.plan.find((item) => item.status === "in_progress")?.step ||
      this.plan.find((item) => item.status === "pending")?.step || "Answer or report the completed result.";
    const lines = [
      "BOOLEAN WORKING MEMORY (persistent; follow this even when older chat is trimmed):",
      `Objective: ${cleanText(this.objective || "Complete the latest request.", 700)}`,
      `Mode: ${this.contract.mode}; browser: ${this.contract.browserPolicy}; deploy: ${this.contract.deployAllowed ? "allowed" : "blocked unless explicitly requested"}.`,
      this.contract.allowedRoots.length ? `Allowed workspace roots: ${this.contract.allowedRoots.join(" | ")}` : "",
      Object.keys(this.sourceOfTruth).length ? `Project source of truth: ${Object.entries(this.sourceOfTruth).map(([key, value]) => `${key}=${value}`).join(" | ")}` : "",
      this.constraints.length ? `User constraints: ${cleanText(this.constraints.join(" | "), 700)}` : "",
      this.taskContext ? `Recent user intent: ${cleanText(this.taskContext.slice(-1000), 1000)}` : "",
      this.inspectedFiles.length ? `Inspected: ${this.inspectedFiles.slice(-6).join(" | ")}` : "",
      this.changedFiles.length ? `Changed: ${this.changedFiles.slice(-6).join(" | ")}` : "",
      this.checks.length ? `Checks: ${this.checks.slice(-4).join(" | ")}` : "",
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
      lines.push("SOURCE OF TRUTH: use the recorded edit folder, build command, deploy command, live URL, and verification URL when present. Do not substitute older folders or commands from chat history.");
    }
    if (this.contract.deployAllowed) {
      lines.push("DEPLOY PROOF RULE: after deploying, capture the deploy version/id or release output, then verify the live or verification URL. Do not say deployed until both pieces of evidence are recorded.");
    }
    lines.push("WEB/BROWSER RULE: use background research_web/web_search for facts, docs, APIs, and quick checks. Open the visible built-in browser only for visual preview, OAuth/sign-in, user-facing browsing, screenshots, or page testing.");
    lines.push("BLOCKED MEANS STOP: if Boolean blocks the same tool/action twice, stop and explain the blocker plainly instead of trying equivalent actions.");
    if (this.debugRequired) {
      lines.push("DEBUG WORKFLOW (required): inspect -> reproduce -> identify root cause -> edit -> repeat the same check -> regressions.");
      lines.push("Before editing, use a real command, project preview, page inspection, or screenshot to observe the failure, then call record_debug_evidence(stage='reproduced').");
      lines.push("After inspecting the responsible code, call record_debug_evidence(stage='root_cause') with the concrete mechanism. Boolean blocks mutations until both checkpoints exist.");
      lines.push("After the fix, repeat the original reproduction, run relevant regression checks, then call record_debug_evidence(stage='verified').");
      lines.push("Never claim fixed from code inspection alone. Before-and-after tool evidence is mandatory.");
      if (this.reproductionEvidence) lines.push(`Reproduced: ${this.reproductionEvidence}`);
      if (this.rootCauseEvidence) lines.push(`Root cause: ${this.rootCauseEvidence}`);
      if (this.postFixEvidence) lines.push(`Verified: ${this.postFixEvidence}`);
    }
    if (this.artifactRequired) {
      lines.push("Completion gate: change the requested artifact, then run a relevant check after the latest change. A claim that it works is not evidence.");
    } else if (this.actionRequired) {
      lines.push("Completion gate: perform the requested action with the relevant tool and rely on its result. Instructions or a claim of success are not evidence.");
    }
    lines.push("Choose the tool whose result directly advances the objective. Do not substitute web search, browser activity, or unrelated inspection for the requested action.");
    if (this.nonProgressCount >= PROGRESS_WARNING_INSPECTIONS) {
      lines.push("Progress warning: many inspection actions have occurred without a file change or new evidence. Prefer a targeted edit or known build/test command soon; continue inspecting only if it directly narrows the fix.");
      if (!this.loopStopEnabled) lines.push("Loop guard is advisory for this task: do not pause because of repeated inspection. If more inspection is not helping, make the best targeted edit/check from current evidence and keep going.");
    }
    return lines.join("\n");
  }

  allowTool(name, args = {}) {
    if (this.contract.browserPolicy === "blocked" && BROWSER_TOOLS.has(name)) {
      return { allowed: false, reason: "The task contract blocks the visible browser. Use files, local checks, or background research only." };
    }
    const visualVerification = this.artifactRequired && (VERIFICATION_TOOLS.has(name) || name === "read_page");
    if (this.contract.browserPolicy === "on_demand" && BROWSER_TOOLS.has(name) && !visualVerification) {
      return { allowed: false, reason: "Visible browser use was not requested for this task. Use background research_web/web_search for facts or ask before opening the browser." };
    }
    if (this.contract.mode === "read_only" && (MUTATION_TOOLS.has(name) || PREPARATION_TOOLS.has(name))) {
      return { allowed: false, reason: "The task is read-only; file and project changes are blocked." };
    }
    if (this.contract.mode === "read_only" && ["run_background", "stop_process"].includes(name)) {
      return { allowed: false, reason: "The task is read-only; background process changes are blocked." };
    }
    if (this.contract.mode === "read_only" && name === "run_command" && !CHECK_COMMAND.test(String(args.command || ""))) {
      return { allowed: false, reason: "The task is read-only; only test, build, lint, and validation commands are allowed." };
    }
    if (name === "git_commit" && this.contract.mode === "read_only") {
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
    if (this.loopStopEnabled && coarseFingerprint && (this.actionCounts[coarseFingerprint] || 0) >= 3) {
      return { allowed: false, reason: "Loop guard: this task already repeated the same kind of inspection several times. Do not inspect again; use the evidence already collected and take a different progress step such as a targeted edit or known build/test command." };
    }
    if (this.loopStopEnabled && this.nonProgressCount >= NON_PROGRESS_INSPECTION_LIMIT && (INSPECTION_TOOLS.has(name) || BROWSER_TOOLS.has(name) || isInspectionCommand(name, args))) {
      return { allowed: false, reason: "Tool budget reached: many inspection steps happened without a file change or new result. Do not inspect again; continue from the saved evidence with a targeted edit, a known build/test command, or a concise blocker summary." };
    }
    const fingerprint = actionFingerprint(name, args);
    if (this.loopStopEnabled && (this.actionCounts[fingerprint] || 0) >= 2 && (INSPECTION_TOOLS.has(name) || BROWSER_TOOLS.has(name))) {
      return { allowed: false, reason: `Loop guard: '${name}' already ran twice with the same target. Use the existing evidence, summarize the cause, or choose a different check.` };
    }
    if (!this.debugRequired || !MUTATION_TOOLS.has(name)) return { allowed: true, reason: "" };
    if (!this.reproductionEvidence) {
      return { allowed: false, reason: "Debug workflow requires reproducing the reported failure and recording that evidence before editing." };
    }
    if (!this.rootCauseEvidence) {
      return { allowed: false, reason: "Debug workflow requires recording the inspected root cause before editing." };
    }
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
    return {
      count: this.blockedToolCount,
      repeated: this.blockedActionCounts[fingerprint],
      stop: this.blockedToolCount >= 2 || this.blockedActionCounts[fingerprint] >= 2,
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

    if (name === "run_background" && !isFailure(result)) {
      const started = String(result || "").match(/Started background process ['\"]([^'\"]+)['\"]/i)?.[1] || cleanText(args.name, 80);
      if (started && !this.openProcesses.includes(started)) this.openProcesses.push(started);
      this.openProcesses = this.openProcesses.slice(-8);
    } else if (name === "stop_process") {
      const stopped = cleanText(args.name, 80).toLowerCase();
      this.openProcesses = this.openProcesses.filter((item) => item.toLowerCase() !== stopped);
    }

    if (name === "update_plan" && Array.isArray(args.steps) && args.steps.length) {
      this.plan = normalizePlan(args.steps, this.projectBound, this.debugRequired);
      this.phase = "executing";
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
      if (stage === "reproduced") {
        if (this.mutationCount || this.baselineCheckCount < 1) {
          this.consecutiveFailures++;
          this.lastFailure = "record_debug_evidence: reproduce with a real check before any edit";
          this.phase = "recovering";
          return this.snapshot();
        }
        this.reproductionEvidence = summary;
        this.phase = "diagnosing";
        setPlanProgress(this.plan, 1, "done");
        if (this.plan[2]) this.plan[2].status = "in_progress";
      } else if (stage === "root_cause") {
        if (!this.reproductionEvidence || this.inspectionCount < 1 || this.mutationCount) {
          this.consecutiveFailures++;
          this.lastFailure = "record_debug_evidence: inspect the responsible code after reproducing and before editing";
          this.phase = "recovering";
          return this.snapshot();
        }
        this.rootCauseEvidence = summary;
        this.phase = "executing";
      } else if (stage === "verified") {
        if (this.mutationCount < 1 || this.lastVerification < this.lastMutation) {
          this.consecutiveFailures++;
          this.lastFailure = "record_debug_evidence: repeat the original check after the latest edit first";
          this.phase = "recovering";
          return this.snapshot();
        }
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
    if (failed) {
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
    if (name !== "update_plan" && !INSPECTION_TOOLS.has(name) && !inspectionCommand) this.successfulActionCount++;
    if (PREPARATION_TOOLS.has(name)) {
      this.preparationCount++;
      this.phase = "executing";
      setPlanProgress(this.plan, 0, "done");
      if (this.plan[1]?.status === "pending") this.plan[1].status = "in_progress";
    }
    if (INSPECTION_TOOLS.has(name) || inspectionCommand) {
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
      const changed = cleanText(fileArgument(args), 260);
      if (changed && !this.changedFiles.includes(changed)) this.changedFiles.push(changed);
      this.changedFiles = this.changedFiles.slice(-12);
      this.lastMutation = this.toolCount;
      this.phase = "executing";
      const implementationIndex = this.debugRequired ? 2 : 1;
      setPlanProgress(this.plan, implementationIndex, "done");
      if (this.plan[implementationIndex + 1]) this.plan[implementationIndex + 1].status = "in_progress";
    }

    if (verification) {
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
    return this.snapshot();
  }

  evaluateCompletion(answer) {
    if (!cleanText(answer)) return { complete: false, reason: "The model returned no final result." };
    if (this.contract.mode === "deploy" || this.deployEvidence) {
      if (!this.deployEvidence) return { complete: false, reason: "Deploy has not produced a version, release, or deployment result yet." };
      if (!this.deployVerificationEvidence) return { complete: false, reason: "The live or verification URL has not been checked after deploy yet." };
    }
    if (!this.artifactRequired) {
      if (this.actionRequired && this.successfulActionCount < 1) {
        return { complete: false, reason: "The requested action has not been performed by a successful tool yet." };
      }
      if (this.consecutiveFailures > 0) {
        return { complete: false, reason: "The latest action failed and still needs recovery." };
      }
      this.phase = "completed";
      this.updatedAt = Date.now();
      return { complete: true, reason: this.actionRequired ? "Requested action completed." : "Answer delivered." };
    }
    if (this.mutationCount < 1) {
      return { complete: false, reason: "No requested artifact change has been recorded yet." };
    }
    if (this.projectBound && this.inspectionCount < 1) {
      return { complete: false, reason: "The existing project has not been inspected yet." };
    }
    if (this.lastVerification < this.lastMutation) {
      return { complete: false, reason: "The latest change has not been checked yet." };
    }
    if (this.consecutiveFailures > 0) {
      return { complete: false, reason: "The latest tool result failed and still needs recovery." };
    }
    if (this.debugRequired && !this.reproductionEvidence) {
      return { complete: false, reason: "The reported failure has not been reproduced with recorded evidence." };
    }
    if (this.debugRequired && !this.rootCauseEvidence) {
      return { complete: false, reason: "The root cause has not been identified from inspected code and recorded." };
    }
    if (this.debugRequired && !this.postFixEvidence) {
      return { complete: false, reason: "The original reproduction has not been repeated successfully after the fix." };
    }
    this.phase = "completed";
    for (const item of this.plan) item.status = "done";
    this.updatedAt = Date.now();
    return { complete: true, reason: "Requested work changed and verified." };
  }

  continuationPrompt(reason) {
    this.phase = this.lastFailure ? "recovering" : (this.mutationCount ? "verifying" : "executing");
    this.updatedAt = Date.now();
    const loopRecovery = isLoopBlock(reason) || isLoopBlock(this.lastFailure);
    return [
      "BOOLEAN CONTROLLER: Do not stop yet.",
      reason,
      loopRecovery
        ? "Do not inspect the same files or re-check current state. Use the saved evidence, make a targeted edit if there is enough evidence, or run the known build/test command. If neither is possible, give a concise blocker summary."
        : this.lastFailure ? "Inspect the failure, choose a different corrective action, and retry safely." : "Use the available tools to finish the missing work now.",
      this.debugRequired
        ? "Follow the debug checkpoints in order. Record concrete reproduction, root-cause, and post-fix evidence with record_debug_evidence; do not skip directly to editing or completion."
        : "After the latest change, run a relevant test/build/check (and visual inspection for UI work). Return a concise result only when that evidence succeeds."
    ].join(" ");
  }
}

export function createAgentController(options) {
  return new AgentController(options);
}
