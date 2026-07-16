import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as sea from "node:sea";
import { fileURLToPath } from "node:url";
import * as browse from "./browse.js";
import * as engine from "./engine.js";
import { saveConfig } from "./config.js";
import { SYSTEM_ACTION_DEFINITIONS, executeSystemAction } from "./system-actions.js";

// where the bundled project templates live (installed next to the exe, or the
// repo's templates/ folder in dev)
function templatesDir() {
  if (sea.isSea && sea.isSea()) return path.join(path.dirname(process.execPath), "templates");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
}
export function listTemplates() {
  try { return fs.readdirSync(templatesDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

// Tool schemas sent to the model (Ollama native tool-calling format).
export const TOOL_DEFINITIONS = [
  ...SYSTEM_ACTION_DEFINITIONS,
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command on the user's Windows machine and return stdout/stderr. " +
        "Use PowerShell syntax by default (shell='powershell'), or shell='cmd' for cmd.exe syntax. " +
        "Can run anything: winget, git, npm, dotnet, msbuild, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
          shell: {
            type: "string",
            enum: ["powershell", "cmd"],
            description: "Which shell to use. Default: powershell"
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file and return its contents. For large files, pass offset (1-based start line) and limit (line count) to read only a slice.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          offset: { type: "integer", description: "Optional 1-based line number to start reading from" },
          limit: { type: "integer", description: "Optional number of lines to read from offset" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file (creates parent directories, overwrites if it exists). " +
        "For changing part of an EXISTING file, prefer edit_file — it is safer and cheaper than rewriting the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Full file content to write" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Make a targeted edit to an existing file by replacing an exact string. " +
        "Prefer this over write_file for changes to existing files. " +
        "old_string must match the file EXACTLY (including whitespace/indentation) and be unique, unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          old_string: { type: "string", description: "Exact text to find and replace" },
          new_string: { type: "string", description: "Text to replace it with" },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." }
        },
        required: ["path", "old_string", "new_string"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory (single level).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path. Default: current directory" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find files by name recursively using a glob pattern (e.g. **/*.js, src/**, *.css). " +
        "Use to discover files across the project. Skips node_modules, .git, build output, etc.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts or src/**/*.json" },
          path: { type: "string", description: "Root directory to search from. Default: project folder" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search file CONTENTS across the project for a regular-expression pattern. " +
        "Returns matching files with line numbers and the matching line. Use to find where a symbol, string, or code lives.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "Directory to search in. Default: project folder" },
          glob: { type: "string", description: "Optional file filter, e.g. *.js or **/*.ts" },
          case_insensitive: { type: "boolean", description: "Case-insensitive match. Default false." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Record or update a short step-by-step plan for a multi-step task so the user can follow progress. " +
        "Send the FULL list of steps each time with an updated status for each. Use for non-trivial builds; skip it for simple one-step tasks.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "The full ordered list of steps",
            items: {
              type: "object",
              properties: {
                step: { type: "string", description: "Short description of the step" },
                status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Current status" }
              },
              required: ["step", "status"]
            }
          }
        },
        required: ["steps"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description:
        "Scaffold a new app from a tested, working template into the projects folder. " +
        "ALWAYS use this to START an app instead of writing project files from scratch — it is far more reliable. " +
        "All templates run offline with NO npm install. After creating, edit files as needed, then call run_project to test.",
      parameters: {
        type: "object",
        properties: {
          template: {
            type: "string",
            enum: ["website", "api", "desktop"],
            description: "website = static HTML/CSS/JS site; api = Node JSON API server; desktop = Windows desktop window app"
          },
          name: { type: "string", description: "Project folder name, created inside the projects folder" }
        },
        required: ["template", "name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "screenshot_page",
      description:
        "Capture a visual screenshot of a rendered web page (a URL, or the page already open in the browser) and review it visually. " +
        "Use this after building or changing a website/app UI to SEE how it actually looks, then refine the design. " +
        "For a local dev server, pass its URL (e.g. http://localhost:3210). Needs the Boolean desktop app and a vision-capable model.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Optional URL to open and capture; defaults to the page already open in the browser" } },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Read the visible text of the page currently open in the user's in-app browser (or a given URL). " +
        "Use this to answer questions about documentation, websites, or the local dev server / app being built.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Optional URL; defaults to the page open in the browser" } },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "visible_browser_read",
      description:
        "Read the currently visible in-app browser tab. This uses the user's actual visible browser, " +
        "including dynamic pages and signed-in pages, and returns URL, title, visible text, and OCR from visible pixels when available. " +
        "Use when the user asks about the visible browser/current page, or when a requested browser task needs the current page contents.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "visible_browser_open",
      description: "Open a URL or search query in the visible in-app browser tab, then return the page URL, title, visible text, and OCR. Only use when the user asks to open, use, search, or navigate the visible browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "URL or search/address text to open in the visible browser" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "visible_browser_click",
      description:
        "Click an element in the visible in-app browser by visible text, aria-label, title, placeholder, or CSS selector. " +
        "Use after visible_browser_read/open to interact with what the user can see for a requested browser task. Do not submit sensitive final actions.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Visible text, aria-label, title, placeholder, or CSS selector to click" }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "visible_browser_type",
      description:
        "Type into the visible in-app browser. Optionally focuses an input by placeholder/label/CSS selector first, then types text and can press Enter. Use only for a requested browser task, and do not submit sensitive final actions.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Optional input placeholder, label text, aria-label, or CSS selector to focus" },
          text: { type: "string", description: "Text to type" },
          enter: { type: "boolean", description: "Press Enter after typing. Default false." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "visible_browser_draft_email",
      description:
        "Insert a drafted reply into the visible email page's reply editor. Use only after the user asks you to put a reviewed draft into email. " +
        "This opens/focuses Reply when possible and types the draft, but never sends the email.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The exact email reply draft to insert. Do not include extra commentary." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "notepad_read",
      description: "Read the active in-app notepad tab so you can use the user's notes as context. Use proactively when Full access is on.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "notepad_write",
      description: "Write text into the active in-app notepad tab. Use append by default; replace only when the user asks. Use proactively when Full access is on to save useful notes.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to write into the notepad" },
          mode: { type: "string", enum: ["append", "replace"], description: "append or replace. Default append." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet and get numbered results with URLs and snippets. " +
        "Use this for current information, documentation, news, prices, downloads. " +
        "Follow up with browser_click (a result [number]) or browser_open (a URL).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_open",
      description:
        "Open a website in the browser and return its title, readable text, and numbered links. " +
        "This browses the real internet. The page becomes the 'current page' for browser_click / browser_form.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The URL to open (https:// added if missing)" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Follow a link on the current page (opened via browser_open / web_search). " +
        "Pass the link's [number] or (part of) its text. Returns the new page.",
      parameters: {
        type: "object",
        properties: { link: { type: "string", description: "Link number like '3', or link text" } },
        required: ["link"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_form",
      description:
        "Fill and submit a form on the current page (e.g. a site's search box or login form). " +
        "Provide field names and values; unlisted fields keep their defaults. Returns the resulting page.",
      parameters: {
        type: "object",
        properties: {
          fields: { type: "object", description: "Map of form field name -> value to fill in" },
          form: { type: "number", description: "Which form on the page (1 = first). Default: 1" }
        },
        required: ["fields"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_download",
      description: "Download a file from a URL into the user's Downloads folder.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The file URL" },
          filename: { type: "string", description: "Optional filename to save as" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download_local_model",
      description:
        "Download and select a public/free local GGUF model from Boolean's curated model library. " +
        "Use this when the user asks to get, download, install, use, or switch to a local LLM/model. " +
        "Only downloads known public catalog models into the local models folder; never invent model URLs.",
      parameters: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description:
              "Model id, filename, or friendly name. Known ids: " +
              "qwen2.5-3b, qwen2.5-7b, qwen2.5-coder-7b, gemma4-e4b, llama3.1-8b, qwen2.5-vl-7b"
          }
        },
        required: ["model"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "install_public_local_model",
      description:
        "Install and select a public GGUF that is not in Boolean's curated library. " +
        "Use source_url for a direct huggingface.co .gguf link, or local_path when the GGUF already exists on this PC. " +
        "Boolean validates the file and places it in its own models folder; do not use browser_download, curl, Ollama, or another model app.",
      parameters: {
        type: "object",
        properties: {
          source_url: { type: "string", description: "Direct HTTPS huggingface.co URL ending in .gguf" },
          local_path: { type: "string", description: "Absolute path to an existing .gguf file on this PC" },
          move_source: { type: "boolean", description: "After a successful local import, remove the original file to avoid keeping a duplicate" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_connectors",
      description: "List configured MCP servers and agent connectors. Use this before calling an agent connector or when the user asks what connectors are available.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "agent_connector_call",
      description:
        "Send a message to a configured HTTP agent connector by name or id. " +
        "Use this when the user asks to use a connected agent/service. The connector must be enabled in Settings.",
      parameters: {
        type: "object",
        properties: {
          connector: { type: "string", description: "Connector id or name" },
          message: { type: "string", description: "Message/task to send to the connected agent" }
        },
        required: ["connector", "message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_project",
      description:
        "Launch a project created with create_project and VERIFY it actually runs. For website/api it starts the " +
        "server and checks it responds; for desktop it opens the app window. Always call this to TEST before telling " +
        "the user the app is done. Reports ✓ success or ✗ with the error.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The project folder name" } },
        required: ["name"]
      }
    }
  }
];

const MAX_OUTPUT_CHARS = 12000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n... [output truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`
  );
}

function runCommand(command, shell, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const isCmd = shell === "cmd";
    const exe = isCmd ? "cmd.exe" : "powershell.exe";
    const args = isCmd
      ? ["/d", "/s", "/c", command]
      : ["-NoProfile", "-NonInteractive", "-Command", command];

    const child = spawn(exe, args, { cwd, windowsHide: true });

    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      out += `\n[command timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`;
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const body = out.trim() || "(no output)";
      resolve(`exit code: ${code}\n${truncate(body)}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`failed to start shell: ${err.message}`);
    });
  });
}

function listFilesRec(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFilesRec(p, out);
    else out.push(p);
  }
  return out;
}

// Heavy/generated directories to skip during project-wide find/search.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next",
  "__pycache__", ".venv", "venv", "bin", "obj", "coverage", ".idea", ".vscode", ".cache"]);
const MAX_WALK_FILES = 5000;

// Collect files under root (relative paths), skipping heavy dirs and capping work.
function walkProject(root, onFile, budget = { n: 0 }) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (budget.n >= MAX_WALK_FILES) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      walkProject(path.join(root, e.name), onFile, budget);
    } else {
      budget.n++;
      onFile(path.join(root, e.name));
    }
  }
}

// Translate a glob (supports **, *, ?) to a RegExp matched against a forward-slash relative path.
function globToRegExp(glob) {
  const g = String(glob || "").replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("+.^${}()|[]".includes(c)) re += "\\" + c;
    else re += c;
  }
  // a bare pattern with no slash matches by basename anywhere
  const anchored = g.includes("/") ? `^${re}$` : `(^|/)${re}$`;
  return new RegExp(anchored, "i");
}

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip",
  ".gz", ".exe", ".dll", ".gguf", ".bin", ".woff", ".woff2", ".ttf", ".mp4", ".mp3", ".wasm"]);

async function createProject(args, ctx, base) {
  const template = String(args.template || "").toLowerCase();
  const tdir = path.join(templatesDir(), template);
  if (!fs.existsSync(tdir)) {
    return `error: unknown template '${template}'. Available: ${listTemplates().join(", ") || "none"}.`;
  }
  let name = path.basename(String(args.name || "app")).replace(/[^\w .-]/g, "").trim() || "app";
  const dest = path.join(base, name);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
    return `error: folder '${name}' already exists and is not empty — pick a different name.`;
  }
  const ok = await ctx.approve(`create ${template} project at: ${dest}`);
  if (!ok) return "user declined to create the project";
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(tdir, dest, { recursive: true });
  const files = listFilesRec(dest).map((f) => path.relative(dest, f));
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dest, "saz.project.json"), "utf8")); } catch { /* ignore */ }
  return `created ${template} project '${name}' at ${dest}\n` +
    `files: ${files.join(", ")}\n` +
    `dependencies: ${meta.deps || "none"}\n` +
    `Next: edit files if needed, then call run_project with name="${name}" to launch and test it.`;
}

const browserDisabled = (ctx) => ctx.config?.ui && ctx.config.ui.aiBrowser === false;
const BROWSER_OFF_MSG = "AI browser access is disabled in Settings.";

async function screenshotPage(args, ctx) {
  if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
  if (typeof ctx.captureScreenshot !== "function") {
    return "Screenshots need the Boolean desktop app (the embedded browser). Not available in this session — use read_page for the page text instead.";
  }
  const body = await ctx.captureScreenshot(args.url ? { url: String(args.url) } : {});
  if (!body || body.ok === false || !body.image) {
    return "Could not capture the page: " + (body?.error || "no page is open — pass a url, or open one first.");
  }
  const dataUrl = String(body.image).startsWith("data:") ? String(body.image) : ("data:image/png;base64," + body.image);
  const info = body.result ? truncate(String(body.result)) : "";
  // always show the screenshot to the user in the transcript
  ctx.onImage?.(dataUrl, body.url ? String(body.url) : "screenshot");
  // only hand the image to models that can actually see it
  let vision = ctx.config?.provider !== "local";
  if (!vision) { try { vision = !!engine.visionState(ctx.config).supported; } catch { vision = false; } }
  if (vision) {
    (ctx.pendingImages = ctx.pendingImages || []).push(dataUrl);
    return `Screenshot captured${body.url ? ` of ${body.url}` : ""}. Review the attached image and refine the design as needed.` +
      (info ? `\n\nPage text/OCR:\n${info}` : "");
  }
  return "Screenshot captured, but the current local model can't view images. Install a vision projector (Settings > Models) or switch to a cloud vision model to review it. " +
    (info ? `Page text/OCR:\n${info}` : "");
}

async function readPage(args, ctx) {
  if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
  const url = args.url || ctx.browserUrl;
  if (!url) return "no page is open in the browser — ask the user to open one, or pass a url.";
  try {
    const { res, finalUrl } = await browse.fetchRaw(url, { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const text = browse.htmlToText(html);
    return truncate(`URL: ${finalUrl} (HTTP ${res.status})\n\n${text || "(no readable text)"}`);
  } catch (err) {
    return `could not read ${url}: ${err.message}`;
  }
}

async function visibleBrowser(action, args, ctx) {
  if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
  if (typeof ctx.visibleBrowser !== "function") return "visible browser control is not available in this session.";
  return await ctx.visibleBrowser({ action, ...args });
}

async function notepad(action, args, ctx) {
  if (typeof ctx.notepad !== "function") return "notepad control is not available in this session.";
  return await ctx.notepad({ action, ...args });
}

function connectorList(ctx) {
  const c = ctx.config?.connectors || {};
  const mcp = (c.mcp || []).map((x) => {
    const target = x.type === "remote" || x.url ? x.url : `${x.command || ""} ${x.args || ""}`.trim();
    return `${x.enabled === false ? "off" : "on"} MCP ${x.name || x.id}: ${target}`.trim();
  });
  const agents = (c.agents || []).map((x) => `${x.enabled === false ? "off" : "on"} Agent ${x.name || x.id}: ${x.url || ""}${x.apiKey ? " (key saved)" : ""}`);
  return [...mcp, ...agents].join("\n") || "no connectors configured";
}

async function callAgentConnector(args, ctx) {
  const name = String(args.connector || "").trim().toLowerCase();
  const msg = String(args.message || "").trim();
  if (!name) return "error: missing 'connector'";
  if (!msg) return "error: missing 'message'";
  const agents = ctx.config?.connectors?.agents || [];
  const hit = agents.find((a) => a.enabled !== false &&
    (String(a.id || "").toLowerCase() === name || String(a.name || "").toLowerCase() === name));
  if (!hit) return `error: no enabled agent connector named '${args.connector}'. Use list_connectors first.`;
  if (!/^https?:\/\//i.test(hit.url || "")) return `error: connector '${hit.name || hit.id}' has an invalid URL.`;
  const headers = { "content-type": "application/json" };
  if (hit.apiKey) headers.authorization = `Bearer ${hit.apiKey}`;
  const ok = await ctx.approve(`call agent connector '${hit.name || hit.id}' at ${hit.url}`);
  if (!ok) return "user declined calling the agent connector";
  const res = await fetch(hit.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: msg, input: msg, source: "saz3" }),
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  let body = text;
  try {
    const json = JSON.parse(text);
    body = json.reply || json.answer || json.result || json.message || JSON.stringify(json, null, 2);
  } catch { /* plain text */ }
  return truncate(`Agent connector: ${hit.name || hit.id}\nHTTP ${res.status}\n\n${body}`);
}

function matchCatalogModel(input) {
  const q = String(input || "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
  if (!q) return null;
  const stop = new Set(["model", "models", "llm", "local", "download", "install", "get", "use", "free", "public", "a", "an", "the", "me", "for"]);
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2 && !stop.has(t));
  if (!tokens.length) return null;
  const score = (m) => {
    const hay = `${m.id} ${m.file} ${m.note || ""}`.toLowerCase();
    if (m.id.toLowerCase() === q || m.file.toLowerCase() === q) return 1000;
    let s = 0;
    for (const t of tokens) if (hay.includes(t)) s += t.length >= 3 ? 3 : 1;
    if (hay.includes(q)) s += 20;
    return s;
  };
  const best = engine.CATALOG.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s)[0];
  return best?.s >= 3 ? best.m : null;
}

async function downloadLocalModel(args, ctx) {
  if (!explicitModelInstallRequest(ctx?.latestUserText)) {
    return "Download not started: the user asked for information or a recommendation, not an installation. Answer the question without downloading or switching models.";
  }
  const wanted = String(args.model || "").trim();
  const entry = matchCatalogModel(wanted);
  if (!entry) {
    return "error: unknown model. Public/free curated options: " +
      engine.CATALOG.map((m) => `${m.id} (${m.size})`).join(", ");
  }
  const summary = `download public local model '${entry.id}' (${entry.size}) to ${engine.MODELS_DIR} and use it`;
  const ok = await ctx.approve(summary);
  if (!ok) return "user declined downloading the model";
  let last = "";
  const file = await engine.downloadModel(entry.id, (pct, mb) => { last = `${pct}% (${mb} MB)`; });
  ctx.config.provider = "local";
  ctx.config.local = ctx.config.local || {};
  ctx.config.local.model = file;
  saveConfig(ctx.config);
  try { engine.stopEngine(); } catch { /* reload next request */ }
  const extras = (entry.extraFiles || []).map((x) => x.file).join(", ");
  return `Downloaded and selected ${entry.id}.\nModel file: ${file}\nFolder: ${engine.MODELS_DIR}` +
    (extras ? `\nExtra files: ${extras}` : "") +
    (last ? `\nProgress: ${last}` : "");
}

async function installPublicLocalModel(args, ctx) {
  if (!explicitModelInstallRequest(ctx?.latestUserText)) {
    return "Install not started: the user did not explicitly ask to install or switch models.";
  }
  const sourceUrl = String(args.source_url || "").trim();
  const localPath = String(args.local_path || "").trim();
  if (!!sourceUrl === !!localPath) return "error: provide exactly one source_url or local_path";

  let file;
  let last = "";
  let lastReported = -10;
  const progress = (name, pct) => {
    last = `${pct}%`;
    if (pct >= lastReported + 10 || pct === 100) {
      lastReported = pct;
      ctx.onStatus?.(`Installing ${name} in Boolean: ${pct}%`);
    }
  };
  if (localPath) {
    if (!path.isAbsolute(localPath)) return "error: local_path must be an absolute .gguf path";
    const name = path.basename(localPath);
    const ok = await ctx.approve(`Install ${name} in Boolean`);
    if (!ok) return "user declined installing the model";
    file = await engine.importModel(localPath, (pct) => progress(name, pct));
    if (args.move_source && path.resolve(localPath).toLowerCase() !== path.resolve(engine.MODELS_DIR, file).toLowerCase()) {
      fs.rmSync(localPath, { force: true });
    }
  } else {
    let name = "public GGUF model";
    try { name = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || name); } catch { /* engine gives exact error */ }
    const ok = await ctx.approve(`Install ${name} in Boolean`);
    if (!ok) return "user declined installing the model";
    file = await engine.downloadPublicModel(sourceUrl, (pct) => progress(name, pct));
  }

  ctx.config.provider = "local";
  ctx.config.local = ctx.config.local || {};
  ctx.config.local.model = file;
  saveConfig(ctx.config);
  try { engine.stopEngine(); } catch { /* reload next request */ }
  return `Installed and selected ${file} in Boolean.` + (last ? ` (${last})` : "");
}

export function explicitModelInstallRequest(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return false;
  if (/\b(?:download|install|reinstall|redownload|import)\b/.test(text)) return true;
  if (/\bmove\b.*\b(?:boolean|models? folder|local models?)\b/.test(text)) return true;
  if (/^(?:please\s+)?(?:get|add|use|select)\b/.test(text)) return true;
  if (/^(?:please\s+)?switch\s+(?:me\s+)?to\b/.test(text)) return true;
  if (/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:get|add|use|select)\b/.test(text)) return true;
  if (/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?switch\s+(?:me\s+)?to\b/.test(text)) return true;
  if (/\b(?:i\s+want\s+you\s+to|go\s+ahead\s+and|let'?s)\s+(?:get|add|use|select|switch)\b/.test(text)) return true;
  return false;
}

const previews = {}; // dir -> child process, so re-running replaces the old one

async function runProject(args, ctx, base) {
  const name = path.basename(String(args.name || ""));
  const dir = path.join(base, name);
  const metaPath = path.join(dir, "saz.project.json");
  if (!fs.existsSync(metaPath)) {
    return `error: no project named '${name}'. Create it first with create_project.`;
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return "error: project metadata is unreadable"; }
  const ok = await ctx.approve(`run project '${name}': ${meta.run}`);
  if (!ok) return "user declined to run the project";

  if (previews[dir] && previews[dir].exitCode === null) { try { previews[dir].kill(); } catch { /* ignore */ } }

  const parts = meta.run.split(" ");
  const child = spawn(parts[0], parts.slice(1), { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  previews[dir] = child;
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  if (meta.port) {
    const url = `http://localhost:${meta.port}${meta.healthPath || "/"}`;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (child.exitCode !== null) return `✗ the project crashed on startup:\n${truncate(log)}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.status < 500) return `✓ ${meta.type} is running at http://localhost:${meta.port} (HTTP ${res.status}). It launched successfully.`;
      } catch { /* not up yet */ }
    }
    return `✗ started but did not respond at ${url} within 8s. Check the code.\n${truncate(log)}`;
  }

  // desktop / no port — the launcher exits after opening the window
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode && child.exitCode !== 0) return `✗ failed to launch:\n${truncate(log)}`;
  return `✓ ${meta.type} launched (${meta.run}) — the app window should be open.`;
}

async function editFile(args, ctx, resolve) {
  if (!args.path) return "error: missing 'path' argument";
  if (typeof args.old_string !== "string" || !args.old_string) return "error: missing 'old_string' argument";
  if (typeof args.new_string !== "string") return "error: missing 'new_string' argument";
  if (args.old_string === args.new_string) return "error: old_string and new_string are identical";
  const target = resolve(args.path);
  let content;
  try { content = fs.readFileSync(target, "utf8"); } catch { return `error: cannot read ${target} — use write_file to create a new file`; }
  const parts = content.split(args.old_string);
  const count = parts.length - 1;
  if (count === 0) return "error: old_string not found in the file. It must match exactly, including whitespace and indentation.";
  if (count > 1 && !args.replace_all) return `error: old_string appears ${count} times — add more surrounding context to make it unique, or set replace_all=true.`;
  const updated = args.replace_all ? parts.join(args.new_string) : content.replace(args.old_string, args.new_string);
  const ok = await ctx.approve(`edit ${target} (${args.replace_all ? count + " replacements" : "1 replacement"})`);
  if (!ok) return "user declined this file edit";
  fs.writeFileSync(target, updated);
  return `edited ${target} — ${args.replace_all ? count + " replacements" : "1 replacement"} made`;
}

function findFiles(args, resolve) {
  if (!args.pattern) return "error: missing 'pattern' argument";
  const root = resolve(args.path || ".");
  if (!fs.existsSync(root)) return `error: no such directory: ${root}`;
  let rx;
  try { rx = globToRegExp(args.pattern); } catch { return "error: invalid glob pattern"; }
  const hits = [];
  walkProject(root, (file) => {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (rx.test(rel)) hits.push(rel);
  });
  if (!hits.length) return `no files match '${args.pattern}' under ${root}`;
  const shown = hits.slice(0, 300);
  return truncate(shown.join("\n") + (hits.length > shown.length ? `\n... and ${hits.length - shown.length} more` : ""));
}

function searchFiles(args, resolve) {
  if (!args.pattern) return "error: missing 'pattern' argument";
  const root = resolve(args.path || ".");
  if (!fs.existsSync(root)) return `error: no such directory: ${root}`;
  let rx;
  try { rx = new RegExp(args.pattern, args.case_insensitive ? "i" : ""); } catch (err) { return `error: invalid regular expression — ${err.message}`; }
  const globRx = args.glob ? globToRegExp(args.glob) : null;
  const MAX_MATCHES = 200;
  const out = [];
  let filesMatched = 0;
  let truncatedEarly = false;
  walkProject(root, (file) => {
    if (out.length >= MAX_MATCHES) { truncatedEarly = true; return; }
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) return;
    const rel = path.relative(root, file).replace(/\\/g, "/");
    if (globRx && !globRx.test(rel)) return;
    let text;
    try {
      if (fs.statSync(file).size > 2_000_000) return; // skip very large files
      text = fs.readFileSync(file, "utf8");
    } catch { return; }
    if (text.includes("\0")) return; // binary guard
    const lines = text.split(/\r?\n/);
    let fileHit = false;
    for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
      if (rx.test(lines[i])) { out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); fileHit = true; }
    }
    if (fileHit) filesMatched++;
  });
  if (!out.length) return `no matches for /${args.pattern}/ under ${root}`;
  const header = `${out.length} match${out.length === 1 ? "" : "es"} in ${filesMatched} file${filesMatched === 1 ? "" : "s"}${truncatedEarly ? " (stopped at " + MAX_MATCHES + ")" : ""}:\n`;
  return truncate(header + out.join("\n"));
}

function formatPlan(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) return "error: 'steps' must be a non-empty array";
  const mark = { done: "[x]", in_progress: "[»]", pending: "[ ]" };
  const lines = steps.slice(0, 40).map((s) => `${mark[s.status] || "[ ]"} ${String(s.step || "").slice(0, 200)}`);
  const done = steps.filter((s) => s.status === "done").length;
  return `Plan (${done}/${steps.length} done):\n${lines.join("\n")}`;
}

/**
 * Execute one tool call.
 * @param {string} name tool name
 * @param {object} args tool arguments
 * @param {object} ctx { config, approve } where approve(summary) resolves to true/false
 * @returns {Promise<string>} result text fed back to the model
 */
export async function executeTool(name, args, ctx) {
  args = args || {};
  const systemResult = await executeSystemAction(name, args, ctx);
  if (systemResult !== null) return systemResult;
  // resolve relative paths and command cwd inside the user's projects folder
  const base = ctx.config?.projectsDir || process.cwd();
  fs.mkdirSync(base, { recursive: true });
  const resolve = (p) => (p && path.isAbsolute(p) ? p : path.join(base, p || "."));
  try {
    switch (name) {
      case "run_command": {
        if (!args.command) return "error: missing 'command' argument";
        const shell = args.shell === "cmd" ? "cmd" : "powershell";
        const ok = await ctx.approve(`run [${shell}]: ${args.command}`);
        if (!ok) return "user declined to run this command";
        return await runCommand(args.command, shell, ctx.config.commandTimeoutMs, base);
      }
      case "read_file": {
        if (!args.path) return "error: missing 'path' argument";
        const content = fs.readFileSync(resolve(args.path), "utf8");
        const off = Number(args.offset), lim = Number(args.limit);
        if (Number.isFinite(off) || Number.isFinite(lim)) {
          const lines = content.split(/\r?\n/);
          const start = Math.max(0, (Number.isFinite(off) ? off : 1) - 1);
          const end = Number.isFinite(lim) ? start + Math.max(0, lim) : lines.length;
          const slice = lines.slice(start, end);
          return truncate(`[lines ${start + 1}-${start + slice.length} of ${lines.length}]\n` + slice.join("\n"));
        }
        return truncate(content);
      }
      case "edit_file":
        return await editFile(args, ctx, resolve);
      case "find_files":
        return findFiles(args, resolve);
      case "search_files":
        return searchFiles(args, resolve);
      case "update_plan":
        return formatPlan(args);
      case "write_file": {
        if (!args.path) return "error: missing 'path' argument";
        const target = resolve(args.path);
        const bytes = Buffer.byteLength(args.content ?? "", "utf8");
        const ok = await ctx.approve(`write ${bytes} bytes to: ${target}`);
        if (!ok) return "user declined this file write";
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, args.content ?? "");
        return `wrote ${bytes} bytes to ${target}`;
      }
      case "list_dir": {
        const dir = resolve(args.path || ".");
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return lines.length ? truncate(lines.join("\n")) : "(empty directory)";
      }
      case "create_project":
        return await createProject(args, ctx, base);
      case "run_project":
        return await runProject(args, ctx, base);
      case "screenshot_page":
        return await screenshotPage(args, ctx);
      case "read_page":
        return await readPage(args, ctx);
      case "visible_browser_read":
        return await visibleBrowser("read", args, ctx);
      case "visible_browser_open":
        if (!args.url) return "error: missing 'url' argument";
        return await visibleBrowser("open", args, ctx);
      case "visible_browser_click":
        if (!args.text) return "error: missing 'text' argument";
        return await visibleBrowser("click", args, ctx);
      case "visible_browser_type":
        if (typeof args.text !== "string") return "error: missing 'text' argument";
        return await visibleBrowser("type", args, ctx);
      case "visible_browser_draft_email": {
        if (typeof args.text !== "string" || !args.text.trim()) return "error: missing 'text' argument";
        const preview = args.text.trim().replace(/\s+/g, " ").slice(0, 220);
        const ok = await ctx.approve(`insert this draft into the visible email reply box (will not send): ${preview}`);
        if (!ok) return "user declined inserting the email draft";
        return await visibleBrowser("email_draft", { text: args.text }, ctx);
      }
      case "notepad_read":
        return await notepad("read", args, ctx);
      case "notepad_write":
        if (typeof args.text !== "string") return "error: missing 'text' argument";
        return await notepad("write", { text: args.text, mode: args.mode || "append" }, ctx);
      case "list_connectors":
        return connectorList(ctx);
      case "agent_connector_call":
        return await callAgentConnector(args, ctx);
      case "web_search": {
        if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
        if (!args.query) return "error: missing 'query' argument";
        return await browse.aiSearch(String(args.query), ctx);
      }
      case "browser_open": {
        if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
        if (!args.url) return "error: missing 'url' argument";
        return await browse.aiOpen(String(args.url), ctx);
      }
      case "browser_click": {
        if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
        return await browse.aiClick(args.link ?? args.number ?? "", ctx);
      }
      case "browser_form": {
        if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
        const fields = args.fields && typeof args.fields === "object" ? args.fields : {};
        const ok = await ctx.approve(`submit a web form with: ${JSON.stringify(fields).slice(0, 300)}`);
        if (!ok) return "user declined the form submission";
        return await browse.aiForm(args, ctx);
      }
      case "browser_download": {
        if (browserDisabled(ctx)) return BROWSER_OFF_MSG;
        if (!args.url) return "error: missing 'url' argument";
        if (ctx.config?.ui?.browserPerms?.downloads === false) {
          return "downloads are disabled in Settings → Browser permissions.";
        }
        const ok = await ctx.approve(`download to the Downloads folder: ${args.url}`);
        if (!ok) return "user declined the download";
        return await browse.aiDownload(String(args.url), args.filename, ctx);
      }
      case "download_local_model":
        if (!args.model) return "error: missing 'model' argument";
        return await downloadLocalModel(args, ctx);
      case "install_public_local_model":
        return await installPublicLocalModel(args, ctx);
      default:
        return `error: unknown tool '${name}'`;
    }
  } catch (err) {
    return `error: ${err.message}`;
  }
}
