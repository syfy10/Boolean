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

const BROWSER_TOOLS = new Set([
  "screenshot_page", "read_page", "inspect_page_layout", "visible_browser_read",
  "visible_browser_open", "visible_browser_click", "visible_browser_type",
  "visible_browser_draft_email", "web_search", "research_web", "browser_open",
  "browser_click", "browser_form", "browser_download"
]);

const DEPLOY_COMMAND = /\b(?:wrangler(?:\.cmd)?\s+deploy|npm\s+run\s+deploy|git\s+push|gh\s+release|publish(?:\s|$)|deploy(?:\s|$))/i;
const SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|cfut_[A-Za-z0-9_-]+|gh[opusr]_[A-Za-z0-9_-]+|GOCSPX-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)\b/gi;
const CONSTRAINT_LINE = /\b(?:do not|don't|never|only|must|without|unless|keep|use this|no deploy|no browser|sandbox)\b/i;
const MAX_MEMORY_CHARS = 3200;

const ACTION_REQUEST = /(?:^|\b(?:please|can you|could you|would you|i want you to|i need you to)\s+)(?:open|send|download|install|connect|schedule|change|set|create|build|make|edit|fix|update|delete|remove|move|rename|run|test|deploy|publish|commit|push|draft|reply)\b/i;
const DEBUG_REQUEST = /\b(?:bug|broken|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing|ure)?|fix|repair|regression|not working|doesn['’]?t work|stuck|cut(?:s|ting)? off|overlap(?:s|ping)?|wrong|issue)\b/i;

const CHECK_COMMAND = /\b(?:test|tests|build|lint|check|compile|typecheck|verify|validate|smoke)\b|\bnode\s+--check\b|\bdotnet\s+(?:test|build)\b/i;
const FAILURE_RESULT = /^(?:error\b|failed\b|failure\b|timed out\b|user declined\b|could not\b|cannot\b)|\bexited\s*\(?(?:code\s*)?[1-9]\d*\)?|\b(?:request|connection|network|syntax|parse|build|test) error\b/i;

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

function extractWindowsPaths(command) {
  const text = String(command || "");
  const paths = [];
  const quoted = /(["'])([A-Za-z]:\\.*?)\1/g;
  for (const match of text.matchAll(quoted)) paths.push(match[2]);
  const unquoted = /(?:^|[\s=])([A-Za-z]:\\[^\s;|&"']+)/g;
  for (const match of text.matchAll(unquoted)) paths.push(match[1]);
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
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

export class AgentController {
  constructor(options = {}) {
    const saved = options.persisted && typeof options.persisted === "object" ? options.persisted : {};
    this.objective = cleanText(options.objective || saved.objective, 4000);
    this.artifactRequired = !!(options.artifactRequired || saved.artifactRequired);
    this.debugRequired = saved.debugRequired === true || (this.artifactRequired && DEBUG_REQUEST.test(this.objective));
    this.actionRequired = !!(saved.actionRequired || this.artifactRequired || ACTION_REQUEST.test(this.objective));
    this.projectBound = !!(options.projectDir || saved.projectBound);
    this.taskContext = cleanText(options.taskContext || saved.taskContext, 12000);
    this.contract = inferContract(options, saved.contract || saved);
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
    this.openProcesses = Array.isArray(saved.openProcesses)
      ? saved.openProcesses.map((item) => cleanText(item, 80)).filter(Boolean).slice(-8)
      : [];
    this.updatedAt = Date.now();
  }

  snapshot() {
    return {
      version: 2,
      objective: this.objective,
      taskContext: this.taskContext,
      contract: { ...this.contract, allowedRoots: [...this.contract.allowedRoots] },
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
      openProcesses: [...this.openProcesses],
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
      `Files changed: ${this.changedFiles.length ? this.changedFiles.join(" | ") : "none recorded"}`,
      `Checks: ${this.checks.length ? this.checks.join(" | ") : "none recorded"}`,
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
      lines.push("Diagnose the evidence and change strategy. Do not repeat the same failing action unchanged.");
    }
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
    if (this.nonProgressCount >= 6) lines.push("Progress warning: too many inspection actions have occurred without a change or new evidence. Summarize the cause now and choose one different, targeted next action.");
    return lines.join("\n");
  }

  allowTool(name, args = {}) {
    if (this.contract.browserPolicy === "blocked" && BROWSER_TOOLS.has(name)) {
      return { allowed: false, reason: "The task contract blocks browser use. Continue with files and local checks only." };
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
    const requestedPath = fileArgument(args);
    if (requestedPath && path.isAbsolute(String(requestedPath)) && this.contract.allowedRoots.length &&
        !this.contract.allowedRoots.some((root) => isWithin(root, requestedPath))) {
      return { allowed: false, reason: `Path is outside the task's allowed workspace: ${cleanText(requestedPath, 260)}` };
    }
    if (name === "run_command" && this.contract.allowedRoots.length) {
      const absolutePaths = extractWindowsPaths(args.command);
      const outside = absolutePaths.find((candidate) => !this.contract.allowedRoots.some((root) => isWithin(root, candidate.trim())));
      if (outside) return { allowed: false, reason: `Command references a path outside the allowed workspace: ${cleanText(outside, 260)}` };
    }
    const fingerprint = actionFingerprint(name, args);
    if ((this.actionCounts[fingerprint] || 0) >= 2 && (INSPECTION_TOOLS.has(name) || BROWSER_TOOLS.has(name))) {
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

  noteTool(name, args = {}, result = "") {
    this.toolCount++;
    this.updatedAt = Date.now();
    const fingerprint = actionFingerprint(name, args);
    this.actionCounts[fingerprint] = (this.actionCounts[fingerprint] || 0) + 1;
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
    if (name !== "update_plan" && !INSPECTION_TOOLS.has(name)) this.successfulActionCount++;
    if (PREPARATION_TOOLS.has(name)) {
      this.preparationCount++;
      this.phase = "executing";
      setPlanProgress(this.plan, 0, "done");
      if (this.plan[1]?.status === "pending") this.plan[1].status = "in_progress";
    }
    if (INSPECTION_TOOLS.has(name)) {
      this.inspectionCount++;
      this.nonProgressCount++;
      const inspected = cleanText(fileArgument(args), 260);
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

  evaluateCompletion(answer) {
    if (!cleanText(answer)) return { complete: false, reason: "The model returned no final result." };
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
    return [
      "BOOLEAN CONTROLLER: Do not stop yet.",
      reason,
      this.lastFailure ? "Inspect the failure, choose a different corrective action, and retry safely." : "Use the available tools to finish the missing work now.",
      this.debugRequired
        ? "Follow the debug checkpoints in order. Record concrete reproduction, root-cause, and post-fix evidence with record_debug_evidence; do not skip directly to editing or completion."
        : "After the latest change, run a relevant test/build/check (and visual inspection for UI work). Return a concise result only when that evidence succeeds."
    ].join(" ");
  }
}

export function createAgentController(options) {
  return new AgentController(options);
}
