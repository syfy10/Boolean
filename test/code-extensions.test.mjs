import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCodeExtensions, discoverLanguageServices } from "../src/code-extensions.js";

test("project language packs are bounded declarative manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-code-ext-"));
  const folder = path.join(root, ".boolean", "extensions", "astro-pack");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "boolean-extension.json"), JSON.stringify({ id: "astro-pack", name: "Astro", version: "1.0.0", main: "evil.js", contributes: { languages: [{ id: "html", extensions: [".astro", "../../bad"] }] } }));
  const result = listCodeExtensions(root);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.languageMap.astro, "html");
  assert.equal("main" in result.extensions[0], false);
  assert.deepEqual(result.extensions[0].languages[0].extensions, [".astro"]);
});

test("language service discovery always exposes Monaco without probing processes", () => {
  const services = discoverLanguageServices({ probe: false });
  assert.equal(services.find(item => item.id === "typescript").available, true);
  assert.equal(services.find(item => item.id === "python").status, "Not checked");
});
