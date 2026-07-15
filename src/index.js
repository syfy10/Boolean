#!/usr/bin/env node
import readline from "node:readline";
import { loadConfig, saveConfig, currentModel, setCurrentModel, PROVIDERS, CLOUD, APP_VERSION } from "./config.js";
import { systemPrompt, runTurn } from "./agent.js";
import { listProviderModels } from "./providers.js";
import * as engine from "./engine.js";
import { ensureReady } from "./setup.js";
import { startServer, openAppWindow } from "./server.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m"
};

const config = loadConfig();
let messages = [{ role: "system", content: systemPrompt(config.projectsDir) }];
let sessionAutoApprove = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Buffer input lines ourselves so nothing is lost if a line arrives while the
// app is busy (also makes piped/scripted input work: `"hi" | saz`).
const lineQueue = [];
let lineWaiter = null;
let stdinClosed = false;

rl.on("line", (line) => {
  if (lineWaiter) {
    const w = lineWaiter;
    lineWaiter = null;
    w(line);
  } else {
    lineQueue.push(line);
  }
});

// stdin ended (Ctrl+D or piped input ran out). Queued lines still get
// processed; exit happens when the queue drains.
rl.on("close", () => {
  stdinClosed = true;
  if (lineWaiter) {
    console.log("\nbye!");
    process.exit(0);
  }
});

function ask(question) {
  process.stdout.write(question);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) {
    console.log("\nbye!");
    process.exit(0);
  }
  return new Promise((resolve) => (lineWaiter = resolve));
}

async function approve(summary) {
  if (config.autoApprove || sessionAutoApprove) {
    console.log(`${C.yellow}  ▶ ${summary}${C.reset} ${C.dim}(auto-approved)${C.reset}`);
    return true;
  }
  const answer = (
    await ask(`${C.yellow}  ▶ ${summary}${C.reset}\n  approve? [y]es / [n]o / [a]lways this session: `)
  )
    .trim()
    .toLowerCase();
  if (answer === "a" || answer === "always") {
    sessionAutoApprove = true;
    return true;
  }
  return answer === "y" || answer === "yes";
}

function onStatus(text) {
  console.log(`${C.dim}  · ${text}${C.reset}`);
}

async function ensureEula() {
  if (config.eulaAccepted) return true;
  console.log(`${C.yellow}${C.bold}  Before we start:${C.reset}`);
  console.log("  Boolean is a local AI workspace that can run commands and edit files on this PC");
  console.log("  with your approval. AI makes mistakes — review what it asks to do.");
  console.log("  Provided as-is, no warranty; you are responsible for what it runs.");
  console.log(`  Full terms: LICENSE.txt and PRIVACY.txt in the install folder.\n`);
  const a = (await ask("  type 'agree' to accept and continue: ")).trim().toLowerCase();
  if (a === "agree" || a === "i agree" || a === "yes" || a === "y") {
    config.eulaAccepted = "1.0";
    saveConfig(config);
    return true;
  }
  console.log("  terms not accepted — exiting.");
  process.exit(0);
}

function help() {
  console.log(
    [
      "",
      `${C.bold}commands${C.reset}`,
      "  /provider [name]  show or switch provider: local | boolean | openai | glm | claude",
      "  /model <name>     switch model for the current provider",
      "  /models           list models for the current provider",
      "  /pull <id>        download a local model (e.g. /pull gemma4-e4b)",
      "  /import <path>    add a .gguf model from anywhere (USB drive, downloads)",
      "  /key <p> <key>    set API key, e.g. /key openai sk-...   /key glm ...",
      "  /auto             toggle auto-approve for commands & file writes",
      "  /clear            start a fresh conversation",
      "  /help             show this help",
      "  /exit             quit",
      "",
      "anything else is sent to the model.",
      ""
    ].join("\n")
  );
}

async function showModels() {
  try {
    const models = await listProviderModels(config);
    if (!models.length) {
      console.log("no models found for this provider.");
      return;
    }
    for (const m of models) {
      const star = m.name === currentModel(config) ? C.green + "* " : "  ";
      const extra = m.installed === false ? `${C.dim}  (not downloaded — /pull ${m.id}, ${m.size})${C.reset}` : "";
      console.log(`  ${star}${m.name}${C.reset}${extra}`);
    }
  } catch (err) {
    console.log(`${C.red}could not list models: ${err.message}${C.reset}`);
  }
}

async function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
      help();
      break;
    case "exit":
    case "quit":
      rl.close();
      process.exit(0);
      break;
    case "clear":
      messages = [{ role: "system", content: systemPrompt(config.projectsDir) }];
      console.log("conversation cleared.");
      break;
    case "auto":
      config.autoApprove = !config.autoApprove;
      saveConfig(config);
      console.log(`auto-approve is now ${config.autoApprove ? "ON — commands run without asking" : "OFF"}`);
      break;
    case "provider":
      if (!arg) {
        console.log(`current provider: ${config.provider} (model: ${currentModel(config) || "none"})`);
        console.log(`available: ${PROVIDERS.join(", ")}`);
      } else if (!PROVIDERS.includes(arg)) {
        console.log(`unknown provider '${arg}' — options: ${PROVIDERS.join(", ")}`);
      } else {
        config.provider = arg;
        saveConfig(config);
        console.log(`provider set to ${arg} (model: ${currentModel(config) || "none"})`);
        const ready = await ensureReady(config, ask, C);
        if (ready) saveConfig(config);
      }
      break;
    case "key": {
      const [prov, ...keyParts] = rest;
      const key = keyParts.join(" ").trim();
      if (!CLOUD[prov] || !key) {
        console.log(`usage: /key <${Object.keys(CLOUD).join("|")}> <key>`);
      } else {
        config[prov].apiKey = key;
        saveConfig(config);
        console.log(`${prov} API key saved.`);
      }
      break;
    }
    case "models":
      await showModels();
      break;
    case "model":
      if (!arg) {
        console.log(`current model: ${currentModel(config) || "none"}`);
      } else {
        setCurrentModel(config, arg);
        saveConfig(config);
        console.log(`model set to ${arg}`);
      }
      break;
    case "import":
      if (!arg) {
        console.log('usage: /import <path-to-model.gguf>   e.g. /import E:\\models\\mymodel.gguf');
      } else {
        try {
          const file = await engine.importModel(arg.replace(/^"|"$/g, ""), (pct, mb) =>
            process.stdout.write(`\r  importing: ${pct}% (${mb} MB)     `)
          );
          console.log(`\n${C.green}imported: ${file}${C.reset}`);
          if (config.provider === "local") {
            config.local.model = file;
            saveConfig(config);
            console.log(`model set to ${file}`);
          }
        } catch (err) {
          console.log(`\n${C.red}import failed: ${err.message}${C.reset}`);
        }
      }
      break;
    case "pull":
      if (!arg) {
        console.log(`usage: /pull <id> — options: ${engine.CATALOG.map((m) => m.id).join(", ")}`);
      } else {
        try {
          const file = await engine.downloadModel(arg, (pct, mb) =>
            process.stdout.write(`\r  downloading: ${pct}% (${mb} MB)     `)
          );
          console.log(`\n${C.green}downloaded: ${file}${C.reset}`);
          if (config.provider === "local" && !config.local.model) {
            config.local.model = file;
            saveConfig(config);
          }
        } catch (err) {
          console.log(`\n${C.red}download failed: ${err.message}${C.reset}`);
        }
      }
      break;
    default:
      console.log(`unknown command: /${cmd} — try /help`);
  }
}

async function uiMain() {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  // fixed default port so Edge caches our favicon / taskbar identity across launches
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8765;
  const noOpen = args.includes("--no-open");
  const autoExit = args.includes("--auto-exit");

  console.log(`${C.cyan}${C.bold}Boolean${C.reset} - starting...`);

  // single-instance: if the app is already serving on the fixed port, just
  // focus that window and exit — never run two engines fighting over a port
  if (portArg < 0) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json()).appName) {
        console.log("  Boolean is already running - opening its window.");
        if (!noOpen) openAppWindow(`http://127.0.0.1:${port}`);
        process.exit(0);
      }
    } catch { /* nothing there — we'll start fresh */ }
  }

  // hidden launch has no console to answer prompts — auto-decline instead of
  // hanging; the UI shows a "not ready" banner with instructions in that case
  const uiAsk = (noOpen || autoExit) ? async () => "n" : ask;
  const ready = await ensureReady(config, uiAsk, C);
  if (ready) saveConfig(config);

  const { port: actualPort } = await startServer(config, { port, autoExit });
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`  serving at ${C.green}${url}${C.reset}`);
  // warm-start: preload the local model in the background so the first answer
  // does not wait for a cold model load (set local.warmStart=false to skip)
  if (config.provider === "local" && config.local?.model && config.local.warmStart !== false) {
    engine.ensureRunning(config, () => {}).catch(() => { /* first chat reports load errors */ });
  }
  if (!noOpen) {
    openAppWindow(url);
    console.log("  app window opened - keep this console open while using Boolean.");
  }
  rl.close();
}

async function main() {
  console.log(`${C.cyan}${C.bold}
  ┌─────────────────────────────────────────┐
  │  >Boolean - local AI workspace.  v${APP_VERSION}       │
  └─────────────────────────────────────────┘${C.reset}`);
  console.log(`  provider: ${C.green}${config.provider}${C.reset}   model: ${C.green}${currentModel(config) || "none"}${C.reset}`);
  console.log(`  cwd:      ${process.cwd()}`);
  console.log(`  type ${C.bold}/help${C.reset} for commands\n`);

  await ensureEula();

  // first-run / health check for the active provider
  const ready = await ensureReady(config, ask, C);
  if (ready) {
    saveConfig(config); // persists choices made during setup
  } else {
    console.log(`${C.yellow}  (setup incomplete — chat won't work until the provider is ready)${C.reset}\n`);
  }

  // main REPL loop
  for (;;) {
    const line = (await ask(`${C.cyan}you ›${C.reset} `)).trim();
    if (!line) continue;
    if (line.startsWith("/")) {
      await handleSlash(line);
      continue;
    }
    messages.push({ role: "user", content: line });
    try {
      const answer = await runTurn({ config, approve, onStatus }, messages);
      console.log(`\n${C.green}${currentModel(config)} ›${C.reset} ${answer}\n`);
    } catch (err) {
      messages.pop(); // drop the failed user turn so history stays consistent
      console.log(`${C.red}error: ${err.message}${C.reset}`);
    }
  }
}

if (process.argv[2] === "ui") {
  uiMain();
} else {
  main();
}
