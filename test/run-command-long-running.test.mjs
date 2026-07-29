import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { executeTool } from "../src/tools.js";

test("run_command refuses dev servers that should be backgrounded", async () => {
  const base = path.join(os.tmpdir(), "saz-long-running-" + Date.now());
  fs.mkdirSync(base, { recursive: true });
  let approved = false;
  const ctx = {
    config: { projectsDir: base, commandTimeoutMs: 60_000 },
    approve: async () => {
      approved = true;
      return true;
    }
  };

  const result = await executeTool("run_command", { command: "cd Boolean && npm run dev" }, ctx);

  assert.equal(approved, false);
  assert.match(result, /long-running dev server/i);
  assert.match(result, /run_background/i);
});
