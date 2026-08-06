import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MANIFEST = "boolean-extension.json";
const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const EXTENSION = /^\.[a-z0-9][a-z0-9._+-]{0,15}$/i;

function safeManifest(root, entry) {
  const file = path.join(root, entry, MANIFEST);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 64 * 1024) return null;
    const value = JSON.parse(raw), id = String(value.id || "").trim().toLowerCase();
    if (!ID.test(id)) return null;
    const languages = Array.isArray(value.contributes?.languages) ? value.contributes.languages.slice(0, 25).map(language => ({
      id: String(language?.id || "plaintext").slice(0, 48), aliases: Array.isArray(language?.aliases) ? language.aliases.map(String).slice(0, 8) : [],
      extensions: Array.isArray(language?.extensions) ? language.extensions.map(String).filter(ext => EXTENSION.test(ext)).slice(0, 30) : []
    })).filter(language => language.extensions.length) : [];
    return { id, name: String(value.name || id).slice(0, 80), version: String(value.version || "0.0.0").slice(0, 32), description: String(value.description || "").slice(0, 240), languages, manifest: path.relative(path.dirname(root), file).replace(/\\/g, "/") };
  } catch { return null; }
}

export function listCodeExtensions(projectDir) {
  const root = path.join(path.resolve(projectDir), ".boolean", "extensions");
  if (!fs.existsSync(root)) return { root, extensions: [], languageMap: {} };
  const extensions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 100).map(entry => safeManifest(root, entry.name)).filter(Boolean);
  const languageMap = {};
  for (const extension of extensions) for (const language of extension.languages) for (const suffix of language.extensions) languageMap[suffix.slice(1).toLowerCase()] = language.id;
  return { root, extensions, languageMap };
}

const SERVICES = [{ id: "typescript", name: "TypeScript / JavaScript", builtIn: true, command: "monaco" }, { id: "python", name: "Python", command: "pyright-langserver", args: ["--version"] }, { id: "rust", name: "Rust", command: "rust-analyzer", args: ["--version"] }, { id: "go", name: "Go", command: "gopls", args: ["version"] }];
export function discoverLanguageServices({ probe = true } = {}) {
  return SERVICES.map(service => {
    if (service.builtIn) return { ...service, available: true, status: "Built in" };
    if (!probe) return { ...service, available: false, status: "Not checked" };
    const result = spawnSync(service.command, service.args, { encoding: "utf8", windowsHide: true, timeout: 1500, shell: false }), available = !result.error && result.status === 0;
    return { id: service.id, name: service.name, command: service.command, available, status: available ? String(result.stdout || result.stderr || "Available").trim().split(/\r?\n/)[0].slice(0, 120) : "Not installed" };
  });
}
