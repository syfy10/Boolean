// Embedded local inference engine: manages the bundled llama.cpp server
// (llama-server.exe), local GGUF model files, and model downloads.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as sea from "node:sea";
import { SAZ_DIR, saveConfig } from "./config.js";

export const MODELS_DIR = path.join(SAZ_DIR, "models");
const ENGINE_DIR = path.join(SAZ_DIR, "engine");

// curated starter catalog (bartowski's GGUF builds are single-file & reliable)
export const CATALOG = [
  {
    id: "qwen2.5-3b",
    file: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    size: "2.1 GB",
    note: "Fast mode for most home PCs (recommended 6 GB RAM)",
    url: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf"
  },
  {
    id: "qwen2.5-7b",
    file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    size: "4.7 GB",
    note: "Default balanced chat model (recommended 8 GB RAM)",
    url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"
  },
  {
    id: "qwen2.5-coder-7b",
    file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    size: "4.7 GB",
    note: "Code mode for building and fixing apps (recommended 8 GB RAM)",
    url: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
  },
  {
    id: "gemma4-e4b",
    file: "google_gemma-4-E4B-it-Q4_K_M.gguf",
    size: "5.2 GB",
    note: "Google model with strong small-model chat quality (recommended 8 GB RAM)",
    url: "https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf"
  },
  {
    id: "llama3.1-8b",
    file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    size: "4.9 GB",
    note: "Meta Llama option for general chat and reasoning (recommended 8 GB RAM)",
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"
  },
  {
    id: "qwen2.5-vl-7b",
    file: "Qwen_Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    size: "6+ GB",
    note: "Vision model for screenshots and images; downloads matching projector too (recommended 12 GB RAM)",
    url: "https://huggingface.co/bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/Qwen_Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    extraFiles: [
      {
        file: "mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf",
        url: "https://huggingface.co/bartowski/Qwen_Qwen2.5-VL-7B-Instruct-GGUF/resolve/main/mmproj-Qwen_Qwen2.5-VL-7B-Instruct-f16.gguf"
      }
    ]
  }
];

function appDir() {
  if (sea.isSea && sea.isSea()) return path.dirname(process.execPath);
  return path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
}

export function findEngineBinary() {
  const candidates = [
    path.join(appDir(), "engine", "llama-server.exe"),      // installed layout
    path.join(appDir(), "build", "engine", "llama-server.exe"), // dev layout
    path.join(ENGINE_DIR, "llama-server.exe")               // downloaded at runtime
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// download the llama.cpp CPU build from GitHub releases into ~/.saz/engine
export async function downloadEngine(onStatus) {
  onStatus("finding latest llama.cpp release...");
  const rel = await (await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    headers: { "user-agent": "saz" }
  })).json();
  const asset = (rel.assets || []).find((a) => /bin-win-cpu-x64\.zip$/.test(a.name));
  if (!asset) throw new Error("no windows cpu build found in latest llama.cpp release");

  fs.mkdirSync(ENGINE_DIR, { recursive: true });
  const zipPath = path.join(ENGINE_DIR, "engine.zip");
  await downloadFile(asset.browser_download_url, zipPath, (pct, mb) =>
    onStatus(`downloading engine ${pct}% (${mb} MB)`)
  );

  onStatus("extracting engine...");
  const r = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${ENGINE_DIR}' -Force`
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error("failed to extract engine zip");
  fs.rmSync(zipPath, { force: true });

  // the zip may nest the exe in a subfolder — find it and note its real location
  const found = findFileRecursive(ENGINE_DIR, "llama-server.exe");
  if (!found) throw new Error("llama-server.exe not found after extraction");
  if (path.dirname(found) !== ENGINE_DIR) {
    // move everything next to it up into ENGINE_DIR so dlls stay together
    for (const f of fs.readdirSync(path.dirname(found))) {
      fs.renameSync(path.join(path.dirname(found), f), path.join(ENGINE_DIR, f));
    }
  }
  return findEngineBinary();
}

function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return p;
    if (entry.isDirectory()) {
      const hit = findFileRecursive(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

export async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = dest + ".part";
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress?.(pct, Math.round(got / 1048576));
    }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
}

const modelDownloads = new Map();

export function listLocalModels() {
  try {
    return fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(f));
  } catch {
    return [];
  }
}

// ── vision (.mmproj) support ──────────────────────────────────────────

export function listMmprojFiles() {
  try {
    return fs.readdirSync(MODELS_DIR).filter((f) => f.toLowerCase().endsWith(".gguf") && /mmproj/i.test(f));
  } catch {
    return [];
  }
}

/**
 * Minimal GGUF header parser — reads metadata KV pairs from the start of the
 * file until the wanted keys are found (general.architecture is normally the
 * first KV, so only a few MB are ever read).
 */
const metaCache = new Map(); // path|size|mtime -> meta
export function ggufMeta(filePath, wanted = ["general.architecture", "general.name"]) {
  let fd;
  try {
    const st = fs.statSync(filePath);
    const cacheKey = `${filePath}|${st.size}|${st.mtimeMs}`;
    if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    const meta = {};
    if (b.length < 24 || b.toString("ascii", 0, 4) !== "GGUF") return meta;
    let off = 8; // skip magic + version
    const readU64 = () => { const v = Number(b.readBigUInt64LE(off)); off += 8; return v; };
    readU64(); // tensor count
    const kvCount = readU64();
    const readStr = () => { const len = readU64(); const s = b.toString("utf8", off, off + len); off += len; return s; };
    // value byte sizes per GGUF type id (8=string, 9=array handled separately)
    const sizes = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    for (let i = 0; i < kvCount && off < b.length - 16; i++) {
      const key = readStr();
      const type = b.readUInt32LE(off); off += 4;
      if (type === 8) {
        const v = readStr();
        if (wanted.includes(key)) meta[key] = v;
      } else if (type === 9) {
        const et = b.readUInt32LE(off); off += 4;
        const cnt = readU64();
        if (et === 8) { for (let j = 0; j < cnt; j++) { if (off > b.length - 8) break; const l = readU64(); off += l; } }
        else off += cnt * (sizes[et] || 4);
      } else off += sizes[type] || 4;
      if (wanted.every((w) => meta[w] !== undefined)) break;
    }
    metaCache.set(cacheKey, meta);
    return meta;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// fuzzy filename match: shared meaningful tokens between model and projector
const TOKEN_STOP = new Set(["gguf", "mmproj", "model", "instruct", "it", "chat", "q2", "q3", "q4", "q5",
  "q6", "q8", "k", "m", "s", "l", "xl", "f16", "f32", "bf16", "fp16", "gs", "0", "1"]);
const nameTokens = (f) => f.toLowerCase().replace(/\.gguf$/, "").split(/[-_. ]+/).filter((t) => t && !TOKEN_STOP.has(t));

export function autoMatchMmproj(model, candidates = listMmprojFiles()) {
  if (!model || !candidates.length) return null;
  const mt = new Set(nameTokens(model));
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const score = nameTokens(c).filter((t) => mt.has(t)).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (bestScore >= 2) return best;
  // a single projector in the folder is almost always meant for the one VL model
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** The projector to use for a model: manual choice wins, else auto-detect. */
export function resolveMmproj(config, model) {
  const map = config.local.mmprojMap || {};
  if (Object.prototype.hasOwnProperty.call(map, model)) {
    const v = map[model];
    if (!v) return null; // explicitly "none"
    return fs.existsSync(path.join(MODELS_DIR, v)) ? v : null;
  }
  return autoMatchMmproj(model);
}

export const TEXT_ONLY_MSG = "This model is text-only. Select a vision-capable model and its matching .mmproj file.";
export const visionTestKey = (model, mmproj) => `${model || ""}|${mmproj || ""}`;

/** Full vision status for the current local model (drives the Settings UI). */
export function visionState(config) {
  const model = config.local.model || listLocalModels()[0] || "";
  const candidates = listMmprojFiles();
  const map = config.local.mmprojMap || {};
  const manual = Object.prototype.hasOwnProperty.call(map, model);
  const mmproj = resolveMmproj(config, model);
  const source = mmproj ? (manual ? "manual" : "auto") : (manual ? "off" : "none");
  const tested = mmproj ? (config.local.visionTestMap || {})[visionTestKey(model, mmproj)] : null;
  let compatible = null;
  if (mmproj) {
    const meta = ggufMeta(path.join(MODELS_DIR, mmproj));
    compatible = meta["general.architecture"] ? meta["general.architecture"] === "clip" : null;
  }
  const supported = !!mmproj && compatible !== false && tested?.ok === true;
  let reason;
  if (!model) reason = "no local model selected";
  else if (supported) reason = "Vision ready - projector: " + mmproj + (source === "auto" ? " (auto-detected)" : "");
  else if (tested && tested.ok === false) reason = tested.message || "Image input test failed for this model/projector pair";
  else if (compatible === false) reason = "'" + mmproj + "' is not a vision projector (wrong GGUF type)";
  else if (source === "off") reason = TEXT_ONLY_MSG;
  else if (mmproj) reason = "Projector selected: " + mmproj + ". Run Test image input to enable image attachments.";
  else if (candidates.length) reason = "no matching projector auto-detected - pick one below, then Test";
  else reason = TEXT_ONLY_MSG;
  return { model, mmproj, source, candidates, supported, compatible, tested, reason };
}

/**
 * Import a .gguf model from anywhere (USB drive, downloads folder) by copying
 * it into the models dir. Returns the model filename.
 */
export async function importModel(sourcePath, onProgress) {
  if (!/\.gguf$/i.test(sourcePath)) throw new Error("model files must end in .gguf");
  if (!fs.existsSync(sourcePath)) throw new Error(`file not found: ${sourcePath}`);
  const name = path.basename(sourcePath);
  const dest = path.join(MODELS_DIR, name);
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const total = fs.statSync(sourcePath).size;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(sourcePath);
    const ws = fs.createWriteStream(dest + ".part");
    let got = 0, lastPct = -1;
    rs.on("data", (chunk) => {
      got += chunk.length;
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress?.(pct, Math.round(got / 1048576));
      }
    });
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    rs.pipe(ws);
  });
  fs.renameSync(dest + ".part", dest);
  return name;
}

export async function downloadModel(idOrFile, onProgress) {
  const entry = CATALOG.find((m) => m.id === idOrFile || m.file === idOrFile);
  if (!entry) throw new Error(`unknown model '${idOrFile}' — known: ${CATALOG.map((m) => m.id).join(", ")}`);
  if (modelDownloads.has(entry.file)) return modelDownloads.get(entry.file);
  const job = (async () => {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const modelPath = path.join(MODELS_DIR, entry.file);
  if (!fs.existsSync(modelPath)) await downloadFile(entry.url, modelPath, onProgress);
  for (const extra of entry.extraFiles || []) {
    const extraPath = path.join(MODELS_DIR, extra.file);
    if (!fs.existsSync(extraPath)) await downloadFile(extra.url, extraPath, onProgress);
  }
  return entry.file;
  })();
  modelDownloads.set(entry.file, job);
  try {
    return await job;
  } finally {
    modelDownloads.delete(entry.file);
  }
}

// ── running server management ─────────────────────────────────────────
let child = null;
let runningModel = null;
let runningMmproj = null;

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure llama-server is running with the configured model.
 * Returns { base, model } for the OpenAI-compatible client.
 */
export async function ensureRunning(config, onStatus = () => {}) {
  const { port, ctx } = config.local;
  let model = config.local.model;

  if (!model) {
    const installed = listLocalModels();
    if (!installed.length) {
      throw new Error("no local model downloaded yet — download one first (see /models or Settings)");
    }
    model = installed[0];
    config.local.model = model;
  }
  const modelPath = path.join(MODELS_DIR, model);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`model file missing: ${modelPath}`);
  }

  const mmproj = resolveMmproj(config, model);
  if (child && !child.killed && runningModel === model && runningMmproj === mmproj && (await healthy(port))) {
    return { base: `http://127.0.0.1:${port}/v1`, model };
  }
  if (!child && await healthy(port)) {
    runningModel = model;
    runningMmproj = mmproj;
    return { base: `http://127.0.0.1:${port}/v1`, model };
  }

  const exe = findEngineBinary();
  if (!exe) throw new Error("embedded engine not found — reinstall Saz or run setup again");

  if (child && !child.killed) {
    onStatus("switching local model...");
    child.kill();
    child = null;
  }

  const catalogEntry = CATALOG.find((m) => m.file === model);

  const start = (ctxSize, label = "") => {
    onStatus(`loading ${model} into memory${label} (first response takes a moment)...`);
    child = spawn(exe, [
      "-m", modelPath,
      "--port", String(port),
      "--host", "127.0.0.1",
      "-c", String(ctxSize),
      "--jinja",
      ...(mmproj ? ["--mmproj", path.join(MODELS_DIR, mmproj)] : []),
      ...(catalogEntry?.args || [])
    ], { stdio: "ignore", windowsHide: true, detached: true });
    child.on("exit", () => { child = null; runningModel = null; runningMmproj = null; });
    runningModel = model;
    runningMmproj = mmproj;
  };

  const waitReady = async () => {
    // wait for the model to load (CPU load of a 7B can take ~a minute)
    for (let i = 0; i < 240; i++) {
      if (await healthy(port)) return true;
      if (!child) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("engine did not become ready in time");
  };

  start(ctx);
  if (await waitReady()) return { base: `http://127.0.0.1:${port}/v1`, model };

  const safeCtx = Math.min(Number(ctx) || 8192, 8192);
  if (safeCtx < Number(ctx || 0)) {
    onStatus(`local engine could not start at ${ctx.toLocaleString()} context; retrying at ${safeCtx.toLocaleString()}...`);
    child = null;
    runningModel = null;
    runningMmproj = null;
    config.local.ctx = safeCtx;
    try { saveConfig(config); } catch { /* keep going even if config cannot be persisted */ }
    start(safeCtx, " with safer 8k context");
    if (await waitReady()) return { base: `http://127.0.0.1:${port}/v1`, model };
  }
  throw new Error(`engine exited while loading ${model}. Try a smaller model, redownload the model if it is incomplete, or lower Context length in Settings > Advanced.`);
}

export function stopEngine() {
  if (child && !child.killed) child.kill();
  child = null;
  runningModel = null;
  runningMmproj = null;
}

export function keepEngineAliveOnExit() {
  if (child && !child.killed) {
    child.unref?.();
    child = null;
  }
}

process.on("exit", () => {
  if (process.env.BOOLEAN_KEEP_ENGINE_WARM === "1" || process.env.LOCALLM_KEEP_ENGINE_WARM === "1") keepEngineAliveOnExit();
  else stopEngine();
});
