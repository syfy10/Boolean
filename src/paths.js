import fs from "node:fs";
import path from "node:path";
import * as sea from "node:sea";

function hasAppFiles(dir) {
  try {
    return fsExists(path.join(dir, "package.json")) && fsExists(path.join(dir, "src"));
  } catch {
    return false;
  }
}

function fsExists(file) {
  try {
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}

export function appDir() {
  if (sea.isSea && sea.isSea()) return path.dirname(process.execPath);

  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (entry) {
    const entryDir = path.dirname(entry);
    const baseName = path.basename(entryDir).toLowerCase();
    const candidate = baseName === "src" || baseName === "dist" ? path.dirname(entryDir) : entryDir;
    if (hasAppFiles(candidate)) return candidate;
  }

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (hasAppFiles(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

export function appPath(...parts) {
  return path.join(appDir(), ...parts);
}
