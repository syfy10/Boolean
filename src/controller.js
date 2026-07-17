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

const ACTION_REQUEST = /(?:^|\b(?:please|can you|could you|would you|i want you to|i need you to)\s+)(?:open|send|download|install|connect|schedule|change|set|create|build|make|edit|fix|update|delete|remove|move|rename|run|test|deploy|publish|commit|push|draft|reply)\b/i;

const CHECK_COMMAND = /\b(?:test|tests|build|lint|check|compile|typecheck|verify|validate|smoke)\b|\bnode\s+--check\b|\bdotnet\s+(?:test|build)\b/i;
const FAILURE_RESULT = /^(?:error\b|failed\b|failure\b|timed out\b|user declined\b|could not\b|cannot\b)|\bexited\s*\(?(?:code\s*)?[1-9]\d*\)?|\b(?:request|connection|network|syntax|parse|build|test) error\b/i;

function cleanText(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function defaultPlan(projectBound) {
  return [
    { step: projectBound ? "Inspect the current project" : "Prepare the project workspace", status: "in_progress" },
    { step: "Implement the requested result", status: "pending" },
    { step: "Run checks and inspect the result", status: "pending" },
    { step: "Report the verified outcome", status: "pending" }
  ];
}

function normalizePlan(plan, projectBound) {
  const source = Array.isArray(plan) && plan.length ? plan : defaultPlan(projectBound);
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
    this.actionRequired = !!(saved.actionRequired || this.artifactRequired || ACTION_REQUEST.test(this.objective));
    this.projectBound = !!(options.projectDir || saved.projectBound);
    this.phase = saved.phase || (this.artifactRequired ? "planning" : "executing");
    this.plan = this.artifactRequired ? normalizePlan(saved.plan, this.projectBound) : [];
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
    this.updatedAt = Date.now();
  }

  snapshot() {
    return {
      version: 1,
      objective: this.objective,
      artifactRequired: this.artifactRequired,
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
      updatedAt: this.updatedAt
    };
  }

  prompt() {
    const lines = [
      "BOOLEAN TASK CONTROLLER:",
      `Objective: ${this.objective || "Complete the latest user request."}`,
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
    if (this.artifactRequired) {
      lines.push("Completion gate: change the requested artifact, then run a relevant check after the latest change. A claim that it works is not evidence.");
    } else if (this.actionRequired) {
      lines.push("Completion gate: perform the requested action with the relevant tool and rely on its result. Instructions or a claim of success are not evidence.");
    }
    lines.push("Choose the tool whose result directly advances the objective. Do not substitute web search, browser activity, or unrelated inspection for the requested action.");
    return lines.join("\n");
  }

  noteTool(name, args = {}, result = "") {
    this.toolCount++;
    this.updatedAt = Date.now();

    if (name === "update_plan" && Array.isArray(args.steps) && args.steps.length) {
      this.plan = normalizePlan(args.steps, this.projectBound);
      this.phase = "executing";
      return this.snapshot();
    }

    const failed = isFailure(result);
    if (failed) {
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
      setPlanProgress(this.plan, 0, "done");
      if (this.plan[1]?.status === "pending") this.plan[1].status = "in_progress";
    }

    if (MUTATION_TOOLS.has(name)) {
      this.mutationCount++;
      this.lastMutation = this.toolCount;
      this.phase = "executing";
      setPlanProgress(this.plan, 1, "done");
      if (this.plan[2]) this.plan[2].status = "in_progress";
    }

    if (isVerification(name, args) || SELF_VERIFYING_TOOLS.has(name)) {
      this.lastVerification = this.toolCount;
      this.phase = "verifying";
      const evidence = `${name}: ${cleanText(result, 180)}`;
      if (evidence) this.verificationEvidence.push(evidence);
      this.verificationEvidence = this.verificationEvidence.slice(-6);
      setPlanProgress(this.plan, 2, "done");
      if (this.plan[3]) this.plan[3].status = "in_progress";
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
      "After the latest change, run a relevant test/build/check (and visual inspection for UI work). Return a concise result only when that evidence succeeds."
    ].join(" ");
  }
}

export function createAgentController(options) {
  return new AgentController(options);
}
