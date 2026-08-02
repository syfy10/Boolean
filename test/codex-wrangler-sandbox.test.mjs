import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "esbuild";
import {
  codexSandboxAllowsPath,
  codexSandboxAllowsWrite,
  codexSandboxCommandCheck,
  codexToolEnvironment,
  codexWorkspaceSandboxPolicy
} from "../src/codex-runner.js";

test("Codex Wrangler sandbox resolves a project bundle but denies writes outside approved roots", async (t) => {
  const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-wrangler-sandbox-"));
  const project = path.join(fixtureBase, "selected project");
  const approvedTemp = path.join(fixtureBase, "approved-temp");
  const outside = path.join(fixtureBase, "outside-project");
  fs.mkdirSync(path.join(project, "app"), { recursive: true });
  fs.mkdirSync(path.join(project, ".wrangler"), { recursive: true });
  fs.mkdirSync(approvedTemp, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(project, "wrangler.toml"), [
    'name = "boolean-sandbox-regression"',
    'main = "cloudflare-worker.js"',
    'compatibility_date = "2026-08-01"',
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(project, "app", "response.js"), 'export const response = "sandbox ok";\n');
  fs.writeFileSync(path.join(project, "cloudflare-worker.js"), [
    'import { response } from "./app/response.js";',
    "export default { fetch() { return new Response(response); } };",
    ""
  ].join("\n"));

  try {
    const environment = codexToolEnvironment({
      TEMP: approvedTemp,
      TMP: approvedTemp,
      LOCALAPPDATA: approvedTemp
    }, { tempDir: approvedTemp });
    const policy = codexWorkspaceSandboxPolicy(project, {
      networkAccess: true,
      env: environment,
      tempDir: approvedTemp
    });

    assert.equal(policy.type, "workspaceWrite");
    assert.equal(policy.readOnlyAccess.type, "restricted");
    assert.equal(policy.readOnlyAccess.includePlatformDefaults, false);
    assert.deepEqual(policy.readOnlyAccess.readableRoots, policy.writableRoots);
    for (const target of [
      path.join(project, "wrangler.toml"),
      path.join(project, "cloudflare-worker.js"),
      path.join(project, "app", "response.js"),
      path.join(project, ".wrangler", "bundle.js"),
      path.join(environment.npm_config_cache, "cache-entry"),
      environment.WRANGLER_LOG_PATH
    ]) assert.equal(codexSandboxAllowsWrite(policy, target), true, target);
    assert.equal(codexSandboxAllowsPath(policy, path.join(project, "app", "..", "cloudflare-worker.js")), true);
    assert.equal(codexSandboxAllowsPath(policy, path.join(project, "app", "response.js")), true);
    assert.equal(codexSandboxAllowsPath(policy, "C:\\Windows\\win.ini"), false);
    assert.equal(codexSandboxCommandCheck(policy, 'Get-Content "C:\\Windows\\win.ini"', project).allowed, false);
    assert.equal(codexSandboxCommandCheck(policy, 'Get-Content ".\\app\\response.js"', project).allowed, true);
    assert.equal(codexSandboxAllowsWrite(policy, path.join(outside, "denied.txt")), false);
    try {
      const escape = path.join(project, "app", "outside-link");
      fs.symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
      assert.equal(codexSandboxAllowsWrite(policy, path.join(escape, "denied-through-link.txt")), false);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      t.diagnostic("This platform does not permit the test process to create a directory link.");
    }

    const bundlePath = path.join(project, ".wrangler", "bundle.js");
    const wranglerConfig = fs.readFileSync(path.join(project, "wrangler.toml"), "utf8");
    const configuredMain = /^main\s*=\s*["']([^"']+)["']/m.exec(wranglerConfig)?.[1];
    assert.equal(configuredMain, "cloudflare-worker.js");
    await build({
      entryPoints: [path.resolve(project, configuredMain)],
      outfile: bundlePath,
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent"
    });
    assert.match(fs.readFileSync(bundlePath, "utf8"), /sandbox ok/);

    // A deploy verification project belongs under Boolean's dedicated temp
    // project root, never beside unrelated files in the user's general TEMP.
    const tempWorker = path.join(environment.BOOLEAN_CODEX_TEMP_PROJECTS, "codex-worker-sandbox-verify");
    fs.mkdirSync(path.join(tempWorker, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tempWorker, "worker.js"), 'export default { fetch() { return new Response("temp worker ok"); } };\n');
    fs.writeFileSync(path.join(tempWorker, "assets", "index.html"), "<!doctype html><title>temp asset</title>\n");
    fs.writeFileSync(path.join(tempWorker, "wrangler.toml"), [
      'name = "boolean-temp-worker-regression"',
      'main = "worker.js"',
      'compatibility_date = "2026-08-01"',
      '[assets]',
      'directory = "./assets"',
      ""
    ].join("\n"));
    assert.equal(codexSandboxAllowsPath(policy, path.join(tempWorker, "worker.js")), true);
    assert.equal(codexSandboxAllowsPath(policy, path.join(tempWorker, "assets", "index.html")), true);
    assert.equal(codexSandboxAllowsWrite(policy, path.join(tempWorker, ".wrangler", "dry-run", "worker.js")), true);
    await build({
      entryPoints: [path.join(tempWorker, "worker.js")],
      outfile: path.join(tempWorker, "dry-run.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      logLevel: "silent"
    });
    assert.match(fs.readFileSync(path.join(tempWorker, "dry-run.js"), "utf8"), /temp worker ok/);

    const npxCommand = process.platform === "win32" ? process.execPath : "npx";
    const npxPrefix = process.platform === "win32"
      ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")]
      : [];
    const requestedPackage = String(process.env.BOOLEAN_WRANGLER_PACKAGE || "").trim();
    const wranglerArgs = requestedPackage
      ? ["--yes", requestedPackage]
      : ["--no-install", "wrangler"];
    const available = spawnSync(npxCommand, [...npxPrefix, ...wranglerArgs, "--version"], {
      cwd: tempWorker,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000
    });
    if (available.status !== 0) {
      t.diagnostic("Wrangler CLI is not installed in this test environment; the equivalent esbuild bundle regression passed.");
      return;
    }
    const dryRun = spawnSync(npxCommand, [
      ...npxPrefix, ...wranglerArgs, "deploy", "--dry-run", "--config", "wrangler.toml",
      "--outdir", path.join(tempWorker, ".wrangler", "dry-run")
    ], {
      cwd: tempWorker,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000
    });
    assert.equal(dryRun.status, 0, `${dryRun.stdout || ""}\n${dryRun.stderr || ""}`);
    assert.match(`${dryRun.stdout || ""}\n${dryRun.stderr || ""}`, /Total Upload|dry-run|No bindings found/i);
  } finally {
    fs.rmSync(fixtureBase, { recursive: true, force: true });
  }
});
