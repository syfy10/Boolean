import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { executeTool, TOOL_DEFINITIONS } from "../src/tools.js";
import { toolDefinitionsForTurnMode } from "../src/agent.js";
import { createAgentController } from "../src/controller.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-repo-map-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "clipboard.js"), [
    'import { normalizeText } from "./text.js";',
    "export function copyConversation(messages) {",
    "  return normalizeText(messages.join(\"\\n\"));",
    "}"
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "text.js"), "export function normalizeText(value) { return value.trim(); }\n");
  fs.writeFileSync(path.join(root, "test", "clipboard.test.js"), [
    'import { copyConversation } from "../src/clipboard.js";',
    'test("copies errors", () => copyConversation(["Error: failed"]));'
  ].join("\n"));
  fs.writeFileSync(path.join(root, "node_modules", "ignored", "clipboard.js"), "export const copyConversation = null;\n");
  return root;
}

test("repository_map ranks task-relevant source and test files with symbols", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await executeTool("repository_map", {
    query: "copy whole conversation including error messages",
    limit: 8
  }, {
    config: { projectsDir: root },
    approve: async () => true
  });

  assert.match(result, /Repository map for:/);
  assert.match(result, /src\/clipboard\.js/);
  assert.match(result, /copyConversation@\d+/);
  assert.match(result, /test\/clipboard\.test\.js/);
  assert.doesNotMatch(result, /node_modules/);
  assert.doesNotMatch(result, /src\/text\.js/);
});

test("repository_map is available to native and compatibility coding turns", () => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === "repository_map"));
  assert.ok(toolDefinitionsForTurnMode("action", true, false, true)
    .some((tool) => tool.function.name === "repository_map"));

  const controller = createAgentController({
    objective: "Fix clipboard errors",
    projectDir: "C:\\demo",
    effectiveAccessMode: "full_access"
  });
  assert.equal(controller.allowTool("repository_map", { query: "clipboard errors" }).allowed, true);
});
