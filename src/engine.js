// Embedded local inference engine: manages the bundled llama.cpp server
// (llama-server.exe), local GGUF model files, and model downloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as sea from "node:sea";
import { SAZ_DIR, saveConfig } from "./config.js";
import { appPath } from "./paths.js";

export const MODELS_DIR = path.join(SAZ_DIR, "models");
const ENGINE_DIR = path.join(SAZ_DIR, "engine");
const RUNTIME_ENGINE_DIR = path.join(ENGINE_DIR, "runtime");

const gib = (bytes) => Math.round((Number(bytes) / 1073741824) * 10) / 10;
let hardwareCache = null;

function engineBackend(exe = findEngineBinary()) {
  if (!exe) return "cpu";
  let names = [];
  try { names = fs.readdirSync(path.dirname(exe)).map((name) => name.toLowerCase()); } catch { return "cpu"; }
  if (names.some((name) => name.includes("ggml-cuda"))) return "cuda";
  if (names.some((name) => name.includes("ggml-vulkan"))) return "vulkan";
  if (names.some((name) => name.includes("ggml-hip"))) return "hip";
  if (names.some((name) => name.includes("ggml-sycl"))) return "sycl";
  return "cpu";
}

function windowsGpuInfo() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress";
  try {
    const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 3000
    });
    if (result.status !== 0 || !String(result.stdout || "").trim()) return [];
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((gpu) => ({
      name: String(gpu.Name || "Graphics adapter"),
      vramGb: Math.max(0, gib(gpu.AdapterRAM || 0))
    }));
  } catch { return []; }
}

export function detectLocalHardware({ refresh = false } = {}) {
  if (hardwareCache && !refresh) return hardwareCache;
  const gpus = windowsGpuInfo();
  hardwareCache = {
    ramGb: gib(os.totalmem()),
    logicalCpus: os.cpus()?.length || 1,
    cpu: os.cpus()?.[0]?.model || "Unknown CPU",
    gpus,
    gpu: gpus.sort((a, b) => b.vramGb - a.vramGb)[0] || null,
    backend: engineBackend()
  };
  return hardwareCache;
}

export function recommendLocalSettings(hardware = detectLocalHardware(), modelBytes = 0) {
  const ramGb = Math.max(0, Number(hardware?.ramGb) || 0);
  const backend = String(hardware?.backend || "cpu");
  const vramGb = Math.max(0, Number(hardware?.gpu?.vramGb) || 0);
  const modelGb = Math.max(0, Number(modelBytes) / 1073741824);
  const modelId = ramGb < 8 ? "qwen2.5-3b" : "qwen2.5-7b";
  const effectiveModelGb = modelGb || (modelId === "qwen2.5-3b" ? 2.1 : 4.7);
  const ctx = ramGb < 8 ? 4096 : ramGb >= 24 ? 16384 : 8192;
  let gpuLayers = 0;
  if (backend !== "cpu" && vramGb >= 2) {
    const usableGb = Math.max(0, vramGb - 1.25);
    gpuLayers = usableGb >= effectiveModelGb * 1.15 ? 999 : Math.max(1, Math.min(40, Math.floor(40 * usableGb / (effectiveModelGb * 1.15))));
  }
  return {
    modelId,
    model: CATALOG.find((entry) => entry.id === modelId)?.file || "",
    ctx,
    gpuLayers,
    backend,
    accelerated: gpuLayers > 0,
    summary: gpuLayers > 0
      ? `${backend.toUpperCase()} acceleration with ${gpuLayers === 999 ? "full" : `${gpuLayers}-layer`} GPU offload`
      : `CPU mode${hardware?.gpu ? "; install a llama.cpp GPU backend to accelerate" : ""}`
  };
}

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

export function findEngineBinary() {
  const candidates = [
    path.join(RUNTIME_ENGINE_DIR, "llama-server.exe"),       // current downloaded runtime
    path.join(ENGINE_DIR, "llama-server.exe"),               // user-installed accelerator/runtime
    appPath("engine", "llama-server.exe"),      // installed layout
    appPath("build", "engine", "llama-server.exe"), // dev layout
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// download the llama.cpp CPU build from GitHub releases into ~/.saz/engine
export async function downloadEngine(onStatus, { backend = "cpu" } = {}) {
  onStatus("finding latest llama.cpp release...");
  const rel = await (await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    headers: { "user-agent": "saz" }
  })).json();
  const wanted = backend === "vulkan" ? /bin-win-vulkan-x64\.zip$/ : /bin-win-cpu-x64\.zip$/;
  const asset = (rel.assets || []).find((a) => wanted.test(a.name));
  if (!asset) throw new Error(`no Windows ${backend} build found in the latest llama.cpp release`);

  fs.mkdirSync(RUNTIME_ENGINE_DIR, { recursive: true });
  const zipPath = path.join(ENGINE_DIR, "engine.zip");
  await downloadFile(asset.browser_download_url, zipPath, (pct, mb) =>
    onStatus(`downloading engine ${pct}% (${mb} MB)`)
  );

  onStatus("extracting engine...");
  const r = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${RUNTIME_ENGINE_DIR}' -Force`
  ], { windowsHide: true });
  if (r.status !== 0) throw new Error("failed to extract engine zip");
  fs.rmSync(zipPath, { force: true });

  // the zip may nest the exe in a subfolder — find it and note its real location
  const found = findFileRecursive(RUNTIME_ENGINE_DIR, "llama-server.exe");
  if (!found) throw new Error("llama-server.exe not found after extraction");
  if (path.dirname(found) !== RUNTIME_ENGINE_DIR) {
    // copy everything next to it up so runtime DLLs stay together
    for (const f of fs.readdirSync(path.dirname(found))) {
      const source = path.join(path.dirname(found), f);
      const destination = path.join(RUNTIME_ENGINE_DIR, f);
      if (fs.statSync(source).isFile()) fs.copyFileSync(source, destination);
    }
  }
  return findEngineBinary();
}

export async function installGpuEngine(onStatus = () => {}) {
  const hardware = detectLocalHardware({ refresh: true });
  if (!hardware.gpu) throw new Error("no compatible graphics adapter was detected");
  stopEngine();
  await downloadEngine(onStatus, { backend: "vulkan" });
  hardwareCache = null;
  const refreshed = detectLocalHardware({ refresh: true });
  if (refreshed.backend !== "vulkan") throw new Error("the Vulkan engine was installed but its backend could not be verified");
  return refreshed;
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
  try {
    if (!res.body) throw new Error("download failed: empty response");
    for await (const chunk of res.body) {
      if (!out.write(chunk)) await once(out, "drain");
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress?.(pct, Math.round(got / 1048576));
      }
    }
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
    if (total && got !== total) throw new Error(`download incomplete: received ${got} of ${total} bytes`);
    fs.renameSync(tmp, dest);
  } catch (err) {
    out.destroy();
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
    throw err;
  }
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

export function projectorCanAcceptImages(mmproj, compatible, tested) {
  return !!mmproj && compatible !== false && tested?.ok !== false;
}

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
  // A matching projector is usable immediately. The self-test is a diagnostic,
  // not an activation step; only a recorded failure should block attachments.
  const supported = projectorCanAcceptImages(mmproj, compatible, tested);
  let reason;
  if (!model) reason = "no local model selected";
  else if (supported) reason = "Vision ready - projector: " + mmproj + (source === "auto" ? " (auto-detected)" : "");
  else if (tested && tested.ok === false) reason = tested.message || "Image input test failed for this model/projector pair";
  else if (compatible === false) reason = "'" + mmproj + "' is not a vision projector (wrong GGUF type)";
  else if (source === "off") reason = TEXT_ONLY_MSG;
  else if (mmproj) reason = "Projector selected: " + mmproj;
  else if (candidates.length) reason = "no matching projector auto-detected - pick one below, then Test";
  else reason = TEXT_ONLY_MSG;
  return { model, mmproj, source, candidates, supported, compatible, tested, reason };
}

/**
 * Import a .gguf model from anywhere (USB drive, downloads folder) by copying
 * it into the models dir. Returns the model filename.
 */
export async function importModel(sourcePath, onProgress, options = {}) {
  if (!/\.gguf$/i.test(sourcePath)) throw new Error("model files must end in .gguf");
  if (!fs.existsSync(sourcePath)) throw new Error(`file not found: ${sourcePath}`);
  const name = path.basename(sourcePath);
  const dest = path.join(MODELS_DIR, name);
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  if (path.resolve(sourcePath).toLowerCase() === path.resolve(dest).toLowerCase()) {
    const health = modelFileHealth(name);
    if (!health.ok) throw new Error(`model failed validation: ${health.reason}`);
    return name;
  }
  if (options.force) {
    try { fs.rmSync(dest, { force: true }); } catch { /* replaced after validation */ }
    try { fs.rmSync(dest + ".part", { force: true }); } catch { /* best effort */ }
  } else if (fs.existsSync(dest)) {
    const health = modelFileHealth(name);
    if (!health.ok) throw new Error(`a model with this name already exists but is invalid: ${health.reason}`);
    return name;
  }

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
  const health = modelFileHealth(name);
  if (!health.ok) {
    fs.rmSync(dest, { force: true });
    throw new Error(`imported model failed validation: ${health.reason}`);
  }
  return name;
}

function publicModelSource(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("model URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "huggingface.co") {
    throw new Error("public model downloads currently require a huggingface.co HTTPS URL");
  }
  let name;
  try { name = decodeURIComponent(path.posix.basename(parsed.pathname)); } catch { name = ""; }
  if (!name || path.basename(name) !== name || !name.toLowerCase().endsWith(".gguf")) {
    throw new Error("model URL must point directly to one .gguf file");
  }
  parsed.pathname = parsed.pathname.replace("/blob/", "/resolve/");
  return { name, url: parsed.toString() };
}

/** Download a public Hugging Face GGUF directly into Boollm's model folder. */
export async function downloadPublicModel(url, onProgress, options = {}) {
  const source = publicModelSource(url);
  const { name } = source;
  const dest = path.join(MODELS_DIR, name);
  if (modelDownloads.has(name)) return modelDownloads.get(name);
  const job = (async () => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    if (options.force) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(dest + ".part", { force: true }); } catch { /* best effort */ }
    }
    if (!fs.existsSync(dest)) await downloadFile(source.url, dest, onProgress);
    const health = modelFileHealth(name);
    if (!health.ok) {
      fs.rmSync(dest, { force: true });
      throw new Error(`downloaded model failed validation: ${health.reason}`);
    }
    return name;
  })();
  modelDownloads.set(name, job);
  try {
    return await job;
  } finally {
    modelDownloads.delete(name);
  }
}

function catalogEntry(idOrFile) {
  return CATALOG.find((m) => m.id === idOrFile || m.file === idOrFile);
}

function expectedBytes(entry) {
  const match = String(entry?.size || "").match(/([\d.]+)\s*GB/i);
  return match ? Number(match[1]) * 1_000_000_000 : 0;
}

export function modelFileHealth(idOrFile) {
  const entry = catalogEntry(idOrFile);
  const requested = String(idOrFile || "");
  const file = entry?.file || requested;
  if (!file || path.basename(file) !== file || !file.toLowerCase().endsWith(".gguf")) {
    return { ok: false, file, reason: "invalid model filename" };
  }
  const modelPath = path.join(MODELS_DIR, file);
  if (!fs.existsSync(modelPath)) return { ok: false, file, reason: "model file is missing" };
  try {
    const stat = fs.statSync(modelPath);
    const expected = expectedBytes(entry);
    if (stat.size < 1024 * 1024 || (expected && stat.size < expected * 0.72)) {
      return { ok: false, file, reason: "model file is incomplete", size: stat.size };
    }
    const fd = fs.openSync(modelPath, "r");
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString("ascii") !== "GGUF") return { ok: false, file, reason: "model file is not a valid GGUF" };
    return { ok: true, file, size: stat.size };
  } catch (err) {
    return { ok: false, file, reason: err.message || "model file cannot be read" };
  }
}

export function removeLocalModel(idOrFile) {
  const entry = catalogEntry(idOrFile);
  const requested = String(idOrFile || "");
  const file = entry?.file || requested;
  if (!file || path.basename(file) !== file || !file.toLowerCase().endsWith(".gguf") || /mmproj/i.test(file)) {
    throw new Error("invalid local model filename");
  }
  if (runningModel === file) stopEngine();
  const removed = [];
  for (const name of [file, ...(entry?.extraFiles || []).map((x) => x.file)]) {
    const target = path.join(MODELS_DIR, name);
    const partial = target + ".part";
    if (fs.existsSync(target)) { fs.rmSync(target, { force: true }); removed.push(name); }
    if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
  }
  return { file, removed };
}

export async function downloadModel(idOrFile, onProgress, options = {}) {
  const entry = catalogEntry(idOrFile);
  if (!entry) throw new Error(`unknown model '${idOrFile}' — known: ${CATALOG.map((m) => m.id).join(", ")}`);
  if (modelDownloads.has(entry.file)) return modelDownloads.get(entry.file);
  const job = (async () => {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const modelPath = path.join(MODELS_DIR, entry.file);
  if (options.force) removeLocalModel(entry.file);
  if (!fs.existsSync(modelPath)) await downloadFile(entry.url, modelPath, onProgress);
  for (const extra of entry.extraFiles || []) {
    const extraPath = path.join(MODELS_DIR, extra.file);
    if (!fs.existsSync(extraPath)) await downloadFile(extra.url, extraPath, onProgress);
  }
  const health = modelFileHealth(entry.file);
  if (!health.ok) {
    removeLocalModel(entry.file);
    throw new Error(`downloaded model failed validation: ${health.reason}`);
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
let runningCtx = null;
let runningGpuLayers = null;
const ensureStatusListeners = new Set();
let lastEnsureStatus = null;

function broadcastEnsureStatus(text, detail) {
  lastEnsureStatus = { text, detail };
  for (const listener of ensureStatusListeners) {
    try { listener(text, detail); } catch { /* status reporting must not stop inference */ }
  }
}

export function localLoadProgressFromLine(value) {
  const line = String(value || "").trim();
  if (!line) return null;
  const explicit = line.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/);
  if (explicit) return { phase: "loading", pct: Math.max(1, Math.min(95, Math.round(Number(explicit[1])))) };
  if (/load_tensors|loading model tensors|offload.*layer/i.test(line)) return { phase: "loading model", pct: 55 };
  if (/llama_model_load|model loader|loaded meta data|loading model/i.test(line)) return { phase: "reading model", pct: 35 };
  if (/kv cache|llama_context|context.*(?:init|size)|allocat.*context/i.test(line)) return { phase: "preparing context", pct: 75 };
  if (/warmup|warming up/i.test(line)) return { phase: "warming up", pct: 88 };
  if (/server is listening|listening at|model loaded|http server/i.test(line)) return { phase: "starting server", pct: 95 };
  return null;
}

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
 * Serialized: a boot-time warm start and a first chat must not both spawn.
 */
let ensuring = null;
export async function ensureRunning(config, onStatus = () => {}) {
  ensureStatusListeners.add(onStatus);
  try {
    if (!ensuring) {
      lastEnsureStatus = null;
      const task = ensureRunningNow(config, broadcastEnsureStatus);
      ensuring = task;
      task.finally(() => {
        if (ensuring === task) {
          ensuring = null;
          lastEnsureStatus = null;
        }
      }).catch(() => {});
    } else if (lastEnsureStatus) {
      onStatus(lastEnsureStatus.text, lastEnsureStatus.detail);
    }
    return await ensuring;
  } finally {
    ensureStatusListeners.delete(onStatus);
  }
}

async function ensureRunningNow(config, onStatus = () => {}) {
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

  const catalogEntry = CATALOG.find((m) => m.file === model);
  if (catalogEntry) {
    const health = modelFileHealth(model);
    if (!health.ok) {
      onStatus(`${health.reason}; downloading a clean copy of ${model}...`);
      await downloadModel(catalogEntry.id, (pct, mb) => {
        onStatus(`repairing ${model}: ${pct}% (${mb} MB)`);
      }, { force: true });
    }
  }

  const mmproj = resolveMmproj(config, model);
  const modelBytes = (() => { try { return fs.statSync(modelPath).size; } catch { return 0; } })();
  const tuning = recommendLocalSettings(detectLocalHardware(), modelBytes);
  const tunedCtx = config.local.autoTune === false ? (Number(ctx) || 8192) : tuning.ctx;
  const configuredGpuLayers = config.local.gpuLayers;
  let gpuLayers = configuredGpuLayers === "auto" || configuredGpuLayers === undefined
    ? tuning.gpuLayers
    : Math.max(0, Math.min(999, Math.round(Number(configuredGpuLayers) || 0)));
  if (child && !child.killed && runningModel === model && runningMmproj === mmproj && runningCtx === tunedCtx && runningGpuLayers === gpuLayers && (await healthy(port))) {
    return { base: `http://127.0.0.1:${port}/v1`, model, ctx: runningCtx, tuning: { ...tuning, gpuLayers } };
  }
  if (!child && await healthy(port)) {
    runningModel = model;
    runningMmproj = mmproj;
    runningCtx = tunedCtx;
    runningGpuLayers = gpuLayers;
    return { base: `http://127.0.0.1:${port}/v1`, model, ctx: runningCtx, tuning: { ...tuning, gpuLayers } };
  }

  const exe = findEngineBinary();
  if (!exe) throw new Error("embedded engine not found — reinstall Saz or run setup again");

  if (child && !child.killed) {
    onStatus("switching local model...");
    child.kill();
    child = null;
  }

  const start = (ctxSize, label = "") => {
    let reportedPct = 15;
    const reportLoad = (text, phase, pct) => {
      if (pct < reportedPct) return;
      reportedPct = pct;
      onStatus(text, { kind: "local-model-load", model, phase, pct, staged: true });
    };
    reportLoad(`Opening ${model}${label}...`, "opening model", 15);
    child = spawn(exe, [
      "-m", modelPath,
      "--port", String(port),
      "--host", "127.0.0.1",
      "-c", String(ctxSize),
      ...(gpuLayers > 0 ? ["--n-gpu-layers", String(gpuLayers)] : []),
      "--jinja",
      ...(mmproj ? ["--mmproj", path.join(MODELS_DIR, mmproj)] : []),
      ...(catalogEntry?.args || [])
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: true });
    let engineLogBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      engineLogBuffer += chunk;
      const lines = engineLogBuffer.split(/\r?\n/);
      engineLogBuffer = lines.pop() || "";
      for (const line of lines) {
        const progress = localLoadProgressFromLine(line);
        if (progress) reportLoad(`${progress.phase} for ${model}...`, progress.phase, progress.pct);
      }
    });
    child.on("exit", () => { child = null; runningModel = null; runningMmproj = null; runningCtx = null; runningGpuLayers = null; });
    runningModel = model;
    runningMmproj = mmproj;
    runningCtx = Number(ctxSize) || 8192;
    runningGpuLayers = gpuLayers;
  };

  const waitReady = async () => {
    // wait for the model to load (CPU load of a 7B can take ~a minute)
    for (let i = 0; i < 240; i++) {
      if (await healthy(port)) {
        onStatus(`${model} is ready.`, { kind: "local-model-load", model, phase: "ready", pct: 100, staged: true });
        return true;
      }
      if (!child) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("engine did not become ready in time");
  };

  if (gpuLayers > 0) onStatus(`Using ${tuning.summary}.`);
  start(tunedCtx);
  if (await waitReady()) return { base: `http://127.0.0.1:${port}/v1`, model, ctx: tunedCtx, tuning: { ...tuning, gpuLayers } };

  if (gpuLayers > 0) {
    onStatus("GPU acceleration could not start; retrying safely on CPU...");
    child = null;
    runningModel = null;
    runningMmproj = null;
    runningCtx = null;
    runningGpuLayers = null;
    gpuLayers = 0;
    start(tunedCtx, " on CPU");
    if (await waitReady()) return { base: `http://127.0.0.1:${port}/v1`, model, ctx: tunedCtx, tuning: { ...tuning, accelerated: false, gpuLayers, summary: "CPU fallback" } };
  }

  const safeCtx = Math.min(tunedCtx, 8192);
  if (safeCtx < tunedCtx) {
    onStatus(`local engine could not start at ${tunedCtx.toLocaleString()} context; retrying at ${safeCtx.toLocaleString()}...`);
    child = null;
    runningModel = null;
    runningMmproj = null;
    runningCtx = null;
    runningGpuLayers = null;
    config.local.ctx = safeCtx;
    config.local.autoTune = false;
    try { saveConfig(config); } catch { /* keep going even if config cannot be persisted */ }
    start(safeCtx, " with safer 8k context");
    if (await waitReady()) return { base: `http://127.0.0.1:${port}/v1`, model, ctx: safeCtx, tuning: { ...tuning, ctx: safeCtx, gpuLayers } };
  }
  throw new Error(`engine exited while loading ${model}. Try a smaller model, redownload the model if it is incomplete, or lower Context length in Settings > Advanced.`);
}

export function stopEngine() {
  if (child && !child.killed) child.kill();
  child = null;
  runningModel = null;
  runningMmproj = null;
  runningCtx = null;
  runningGpuLayers = null;
}

export function keepEngineAliveOnExit() {
  if (child && !child.killed) {
    child.stderr?.unref?.();
    child.unref?.();
    child = null;
  }
}

process.on("exit", () => {
  if (process.env.BOOLLM_KEEP_ENGINE_WARM === "1" || process.env.LOCALLM_KEEP_ENGINE_WARM === "1") keepEngineAliveOnExit();
  else stopEngine();
});
