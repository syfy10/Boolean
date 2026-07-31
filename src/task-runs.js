import crypto from "node:crypto";

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S+)\b/gi;
const MAX_EVENTS = 160;

function clean(value, max = 320) {
  return String(value || "").replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (/key|secret|token|password|authorization/i.test(key)) result[key] = "[redacted]";
    else result[key] = clean(typeof value === "object" ? JSON.stringify(value) : value, 500);
  }
  return result;
}

export function createTaskRun({ id, objective, startedAt, persisted } = {}) {
  const saved = persisted && typeof persisted === "object" ? persisted : {};
  return {
    id: clean(id || saved.id, 80) || crypto.randomUUID(),
    objective: clean(objective || saved.objective, 1200),
    state: ["running", "waiting", "completed", "failed", "paused"].includes(saved.state) ? saved.state : "running",
    startedAt: Number(startedAt || saved.startedAt) || Date.now(),
    updatedAt: Number(saved.updatedAt) || Date.now(),
    completedAt: Number(saved.completedAt) || 0,
    sequence: Math.max(0, Number(saved.sequence) || 0),
    events: Array.isArray(saved.events) ? saved.events.slice(-MAX_EVENTS).map(normalizeEvent) : []
  };
}

function normalizeEvent(event = {}) {
  return {
    id: clean(event.id, 80) || crypto.randomUUID(),
    sequence: Math.max(0, Number(event.sequence) || 0),
    type: clean(event.type, 60) || "activity",
    status: ["active", "done", "failed", "waiting", "info"].includes(event.status) ? event.status : "info",
    title: clean(event.title, 180) || "Activity",
    detail: clean(event.detail, 600),
    at: Number(event.at) || Date.now(),
    details: safeDetails(event.details)
  };
}

export function appendTaskRunEvent(run, event = {}, { dedupe = true } = {}) {
  if (!run || typeof run !== "object") return run;
  const next = normalizeEvent({ ...event, sequence: ++run.sequence });
  const previous = run.events?.[run.events.length - 1];
  if (dedupe && previous && previous.type === next.type && previous.status === next.status &&
      previous.title === next.title && previous.detail === next.detail) {
    previous.at = next.at;
    run.updatedAt = next.at;
    return run;
  }
  run.events = [...(run.events || []), next].slice(-MAX_EVENTS);
  run.updatedAt = next.at;
  if (next.type === "permission.requested") run.state = "waiting";
  else if (next.type === "run.completed") {
    run.state = "completed";
    run.completedAt = next.at;
  } else if (next.type === "run.failed") {
    run.state = "failed";
    run.completedAt = next.at;
  } else if (next.type === "run.paused") run.state = "paused";
  else if (run.state !== "completed" && run.state !== "failed") run.state = "running";
  return run;
}

export function syncTaskRunFromController(run, controller = {}) {
  if (!run) return run;
  const plan = Array.isArray(controller.plan) ? controller.plan : [];
  const previousPlan = run._plan || [];
  plan.forEach((step, index) => {
    const status = step?.status === "done" ? "done" : step?.status === "in_progress" ? "active" : "info";
    const before = previousPlan[index];
    if (!before || before.step !== step.step || before.status !== step.status) {
      appendTaskRunEvent(run, {
        type: status === "done" ? "step.completed" : status === "active" ? "step.started" : "step.planned",
        status,
        title: step.step,
        detail: status === "done" ? "Completed" : status === "active" ? "In progress" : "Queued",
        details: { step: index + 1 }
      });
    }
  });
  if (controller.lastFailure && controller.lastFailure !== run._lastFailure) {
    appendTaskRunEvent(run, {
      type: "tool.failed", status: "failed", title: "Needs attention", detail: controller.lastFailure
    });
  }
  run._plan = plan.map((step) => ({ step: clean(step?.step, 180), status: step?.status || "pending" }));
  run._lastFailure = clean(controller.lastFailure, 600);
  return run;
}

export function taskRunToolEvent(run, name, args = {}, result = "", failed = false) {
  const target = args.path || args.file || args.url || args.command || args.query || "";
  return appendTaskRunEvent(run, {
    type: failed ? "tool.failed" : "tool.completed",
    status: failed ? "failed" : "done",
    title: clean(name, 100).replaceAll("_", " "),
    detail: clean(target || result, 320),
    details: { tool: name }
  });
}

export function publicTaskRun(run) {
  if (!run) return null;
  return {
    id: clean(run.id, 80),
    objective: clean(run.objective, 1200),
    state: run.state || "running",
    startedAt: Number(run.startedAt) || 0,
    updatedAt: Number(run.updatedAt) || 0,
    completedAt: Number(run.completedAt) || 0,
    events: (run.events || []).slice(-80).map(normalizeEvent)
  };
}

export function compactTaskRun(run, controller = {}) {
  const events = (run?.events || []).slice(-40);
  return {
    objective: clean(run?.objective || controller.objective, 800),
    state: run?.state || controller.phase || "running",
    completedSteps: (controller.plan || []).filter((step) => step.status === "done").map((step) => clean(step.step, 180)),
    currentStep: clean((controller.plan || []).find((step) => step.status === "in_progress")?.step, 180),
    remainingSteps: (controller.plan || []).filter((step) => step.status === "pending").map((step) => clean(step.step, 180)),
    verifiedChecks: (controller.checks || []).slice(-6).map((item) => clean(item, 260)),
    changedFiles: (controller.changedFiles || []).slice(-12).map((item) => clean(item, 260)),
    decisions: (controller.conversationDigest?.recentDecisions || []).slice(-6).map((item) => clean(item, 220)),
    teamWorkers: Object.values(controller.teamWorkers || {}).slice(0, 8).map((worker) => ({
      role: clean(worker?.role, 80),
      provider: clean(worker?.provider, 60),
      model: clean(worker?.model, 120),
      state: ["working", "retrying", "done", "failed"].includes(worker?.state) ? worker.state : "failed",
      attempt: Math.max(1, Number(worker?.attempt) || 1),
      detail: clean(worker?.detail, 320)
    })),
    failures: events.filter((event) => event.status === "failed").slice(-6).map((event) => clean(`${event.title}: ${event.detail}`, 320))
  };
}
