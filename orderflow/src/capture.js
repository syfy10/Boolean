// Records raw stream bytes so a live session can be replayed offline.
//
// This is what turns the guessed thresholds into measured ones: capture a real
// session, then run calibrate.js over it. It also pins the actual depth field
// names, which the normalizer currently only guesses at.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_DIR = path.join(here, "..", "captures");

export function captureFilePath(symbol, at = new Date()) {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(CAPTURE_DIR, `${symbol.replace(/[^\w]/g, "_")}-${stamp}.ndjson`);
}

export function createCaptureWriter(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath, { flags: "a" });
  let chunks = 0;
  let bytes = 0;

  return {
    path: filePath,
    write(kind, text, t = Date.now()) {
      chunks++;
      bytes += text.length;
      out.write(`${JSON.stringify({ t, kind, chunk: text })}\n`);
    },
    close() {
      return new Promise((resolve) => out.end(resolve));
    },
    get stats() {
      return { chunks, bytes };
    }
  };
}

export function readCapture(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // a capture truncated mid-write still has usable history before the tear
    }
  }
  return records;
}
