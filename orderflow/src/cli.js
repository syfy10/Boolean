#!/usr/bin/env node
// node orderflow/src/cli.js [scenario]
//
// Runs a synthetic scenario through the pipeline and prints what the engine
// concluded, next to what a naive depth reading would have concluded.

import { SCENARIOS } from "./scenarios.js";
import { replay, summarize } from "./replay.js";

const requested = process.argv[2];
const names = requested ? [requested] : Object.keys(SCENARIOS);

for (const name of names) {
  const factory = SCENARIOS[name];
  if (!factory) {
    console.error(`unknown scenario: ${name}`);
    console.error(`available: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  const scenario = factory();
  const result = replay(scenario);
  const summary = summarize(result);
  const last = result.samples[result.samples.length - 1].signal;

  console.log(`\n${scenario.name}`);
  console.log(`  ${scenario.description}`);
  console.log(`  expected           ${scenario.expect}`);
  console.log(`  signal             ${summary.dominantState.toUpperCase()}`);
  console.log(`  score (filtered)   ${summary.meanScore}`);
  console.log(`  score (naive book) ${summary.meanNaiveScore}`);
  console.log(`  confidence         ${summary.meanConfidence}`);
  console.log(`  spoof risk         ${summary.meanSpoofRisk}`);
  console.log(`  cancel:trade       ${format(last.quality.cancelToTrade)}`);
  console.log("  why:");
  for (const reason of last.reasons) {
    console.log(`    - ${reason.detail}`);
  }
}

function format(value) {
  if (!Number.isFinite(value)) return "no trades";
  return value.toFixed(1);
}
