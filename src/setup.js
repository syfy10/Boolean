// First-run setup, per provider:
//  local              → embedded engine binary + at least one GGUF model
//  openai/glm/claude  → an API key is set
import * as engine from "./engine.js";
import { CLOUD } from "./config.js";

async function yes(ask, question) {
  const a = (await ask(question)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

function progressLine(text) {
  process.stdout.write(`\r  ${text}          `);
}

async function ensureLocal(config, ask, C) {
  // 1. engine binary
  if (!engine.findEngineBinary()) {
    console.log(`${C.yellow}  the local inference engine is missing.${C.reset}`);
    if (!(await yes(ask, "  download it now (~40 MB)? [y/n]: "))) return false;
    try {
      await engine.downloadEngine((t) => progressLine(t));
      console.log(`\n${C.green}  engine ready.${C.reset}`);
    } catch (err) {
      console.log(`\n${C.red}  engine download failed: ${err.message}${C.reset}`);
      return false;
    }
  }

  // 2. at least one model
  if (engine.listLocalModels().length === 0) {
    console.log(`${C.yellow}  no local models downloaded yet.${C.reset} options:`);
    engine.CATALOG.forEach((m, i) =>
      console.log(`    ${i + 1}. ${m.id}  (${m.size}) — ${m.note}`)
    );
    const pick = (await ask(`  download which? [1-${engine.CATALOG.length}, or n to skip]: `)).trim();
    const entry = engine.CATALOG[Number(pick) - 1];
    if (!entry) {
      console.log("  ok — download later from /models or Settings\n");
      return false;
    }
    try {
      const file = await engine.downloadModel(entry.id, (pct, mb) =>
        progressLine(`downloading ${entry.id}: ${pct}% (${mb} MB)`)
      );
      config.local.model = file;
      console.log(`\n${C.green}  model ready: ${file}${C.reset}`);
    } catch (err) {
      console.log(`\n${C.red}  model download failed: ${err.message}${C.reset}`);
      return false;
    }
  }
  return true;
}

async function ensureApiKey(config, ask, C, provider) {
  const label = CLOUD[provider];
  if (config[provider].apiKey) return true;
  console.log(`${C.yellow}  no ${label} API key set.${C.reset}`);
  const key = (await ask(`  paste your ${label} API key (or press Enter to skip): `)).trim();
  if (!key) return false;
  config[provider].apiKey = key;
  return true;
}

/**
 * Ensure the active provider is usable. Interactive: uses ask() for consent.
 * Returns true when the app is ready to chat.
 */
export async function ensureReady(config, ask, C) {
  if (config.provider === "local") return ensureLocal(config, ask, C);
  if (CLOUD[config.provider]) return ensureApiKey(config, ask, C, config.provider);
  return false;
}
