#!/usr/bin/env node
// Writes a capture file from a synthetic scenario, in exactly the format the
// live recorder produces.
//
//   node orderflow/src/synth-capture.js dynamicLayering
//
// This exists so the capture → calibrate path can be exercised before any
// brokerage access. calibrate.js is the first tool that touches real market
// data; it should not be running for the first time on a session you cannot
// repeat.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { SCENARIOS } from "./scenarios.js";
import { createCaptureWriter, CAPTURE_DIR } from "./capture.js";

export function synthesizeCapture(scenario, write) {
  let cumulativeVolume = 0;
  let frames = 0;

  for (const event of scenario.events) {
    if (event.type === "trade") {
      cumulativeVolume += event.payload.size;
      const quote = {
        Symbol: "SYNTH",
        Last: event.payload.price.toFixed(2),
        LastSize: String(event.payload.size),
        Volume: String(cumulativeVolume),
        TradeTime: `T${event.t}`
      };
      write("quotes", JSON.stringify(quote), event.t);
      continue;
    }
    if (event.type !== "depth") continue;

    const text = JSON.stringify(event.payload);
    frames++;
    // Split some frames across two records. Proxies re-chunk the real stream,
    // so a capture that never does is a softer test than reality.
    if (frames % 7 === 0) {
      const cut = Math.floor(text.length / 2);
      write("depth", text.slice(0, cut), event.t);
      write("depth", text.slice(cut), event.t);
    } else {
      write("depth", text, event.t);
    }
  }

  return { frames, volume: cumulativeVolume };
}

async function main() {
  const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "dynamicLayering";
  const factory = SCENARIOS[name];
  if (!factory) {
    console.error(`unknown scenario: ${name}`);
    console.error(`available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  const scenario = factory();
  const file = path.join(CAPTURE_DIR, `synthetic-${scenario.name}.ndjson`);
  const writer = createCaptureWriter(file);
  const stats = synthesizeCapture(scenario, (kind, chunk, t) => writer.write(kind, chunk, t));
  await writer.close();

  console.log(`wrote ${file}`);
  console.log(`${stats.frames} depth frames, ${writer.stats.chunks} records, ${writer.stats.bytes} bytes`);
  console.log(`\nnow run:\n  node orderflow/src/calibrate.js ${path.relative(process.cwd(), file).replace(/\\/g, "/")}`);
}

// Importing this module must not write files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
