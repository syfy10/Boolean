import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { executeTool, inferDesktopProject, inferWebProject, isUnmanagedProcessTerminationCommand } from "../src/tools.js";

test("run_project recognizes existing Next.js and Vite projects", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-web-preview-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, "package.json"), JSON.stringify({
    scripts: { dev: "next dev" }, dependencies: { next: "14.2.3" }
  }));
  const inferred = inferWebProject(base);
  assert.equal(inferred?.type, "website");
  assert.equal(inferred?.framework, "next");
  assert.match(inferred?.run || "", /npm\.cmd run dev/);
  assert.match(inferred?.run || "", /--hostname 127\.0\.0\.1 --port \{port\}/);
});

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

test("run_command refuses foreground desktop launches that would block the task", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-desktop-run-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, "SnipIt.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>');
  let approved = false;
  const result = await executeTool("run_command", {
    command: '& ".\\bin\\Debug\\net8.0-windows\\SnipIt.exe" 2>&1 | Out-String'
  }, {
    projectDir: base,
    config: { commandTimeoutMs: 60_000 },
    approve: async () => { approved = true; return true; }
  });
  assert.equal(approved, false);
  assert.match(result, /desktop GUI in the foreground/i);
  assert.match(result, /run_project/i);
});

test("existing WPF folders are inferred as runnable desktop projects", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-desktop-infer-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "SnipIt.csproj");
  fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>');
  assert.deepEqual(inferDesktopProject(base), {
    type: "desktop",
    run: `dotnet run --project "${project}"`,
    executable: "",
    inferred: true
  });
});

test("run_command cannot kill Boolean or another unmanaged process", async () => {
  assert.equal(isUnmanagedProcessTerminationCommand("Stop-Process -Id 14992 -Force"), true);
  assert.equal(isUnmanagedProcessTerminationCommand("taskkill /PID 14992 /F"), true);
  assert.equal(isUnmanagedProcessTerminationCommand("node --version"), false);
  let approved = false;
  const result = await executeTool("run_command", {
    command: "Stop-Process -Id 14992 -Force"
  }, {
    projectDir: os.tmpdir(),
    config: { commandTimeoutMs: 60_000 },
    approve: async () => { approved = true; return true; }
  });
  assert.equal(approved, false);
  assert.match(result, /will not terminate an arbitrary system process/i);
  assert.match(result, /stop_process/i);
});
