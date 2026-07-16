import assert from "node:assert/strict";
import test from "node:test";
import { executeTool, explicitModelInstallRequest } from "../src/tools.js";

test("model recommendation questions are answer-only", async () => {
  assert.equal(explicitModelInstallRequest("which glm is best for coding?"), false);
  assert.equal(explicitModelInstallRequest("which local model should I use?"), false);

  let approvalRequested = false;
  const result = await executeTool("download_local_model", { model: "qwen2.5-coder-7b" }, {
    latestUserText: "which glm is best for coding?",
    config: {},
    approve: async () => { approvalRequested = true; return true; }
  });

  assert.match(result, /Download not started/);
  assert.equal(approvalRequested, false);
});

test("explicit model installation wording is allowed", () => {
  assert.equal(explicitModelInstallRequest("download the best local coding model"), true);
  assert.equal(explicitModelInstallRequest("please switch me to Qwen2.5-Coder-7B"), true);
  assert.equal(explicitModelInstallRequest("can you get that model for me?"), true);
  assert.equal(explicitModelInstallRequest("move the downloaded model to Boolean"), true);
});

test("public model install requires explicit wording before approval", async () => {
  let approvalRequested = false;
  const result = await executeTool("install_public_local_model", {
    source_url: "https://huggingface.co/example/model/resolve/main/model.gguf"
  }, {
    latestUserText: "is this model good?",
    config: {},
    approve: async () => { approvalRequested = true; return true; }
  });
  assert.match(result, /Install not started/);
  assert.equal(approvalRequested, false);
});

test("public model install rejects ambiguous sources", async () => {
  const result = await executeTool("install_public_local_model", {
    source_url: "https://huggingface.co/example/model/resolve/main/model.gguf",
    local_path: "C:\\Downloads\\model.gguf"
  }, {
    latestUserText: "install this model",
    config: {},
    approve: async () => true
  });
  assert.match(result, /exactly one/);
});
