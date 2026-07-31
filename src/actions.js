const ACTIONS = [
  { id: "workspace.chat", label: "Open Chat", aliases: ["chat", "ask", "conversation"], capability: "chat", surface: "chat" },
  { id: "workspace.browser", label: "Open Browser", aliases: ["web", "browse", "page"], capability: "browser", surface: "browser" },
  { id: "workspace.notepad", label: "Open Notepad", aliases: ["notes", "scratchpad", "write note"], capability: "notes", surface: "notepad" },
  { id: "workspace.sales", label: "Open Sales", aliases: ["prospect", "outreach", "customers"], capability: "sales", surface: "sales" },
  { id: "workspace.markets", label: "Open Markets", aliases: ["stocks", "market monitor", "chart"], capability: "markets", surface: "markets" },
  { id: "workspace.education", label: "Open Education", aliases: ["practice", "exam", "learn"], capability: "education", surface: "education" },
  { id: "workspace.recipes", label: "Open Recipes", aliases: ["workflow", "template", "repeat task"], capability: "recipes", surface: "recipes" },
  { id: "workspace.automations", label: "Open Automations", aliases: ["schedule", "monitor", "recurring"], capability: "automations", surface: "automations" },
  { id: "workspace.settings", label: "Open Settings", aliases: ["preferences", "models", "providers"], capability: "settings", surface: "settings" },
  { id: "task.continue", label: "Continue Task", aliases: ["resume", "keep working"], capability: "tasks", intent: "Continue the saved task." },
  { id: "task.diagnostics", label: "Export Diagnostics", aliases: ["debug report", "support bundle", "health"], capability: "diagnostics", endpoint: "/api/diagnostics/export" }
];

function clean(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function listActions() {
  return ACTIONS.map((action) => ({ ...action, aliases: [...action.aliases] }));
}

export function searchActions(query = "", { limit = 12 } = {}) {
  const terms = clean(query, 160).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return listActions().slice(0, limit);
  return ACTIONS.map((action) => {
    const label = `${action.id} ${action.label} ${action.aliases.join(" ")} ${action.capability}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (label.includes(term) ? (action.id.includes(term) ? 4 : 2) : 0), 0);
    return { action, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 12)))
    .map((item) => ({ ...item.action, aliases: [...item.action.aliases] }));
}
