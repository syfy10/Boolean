import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeWorkspaceChanges,
  workspaceChangeStats,
  workspaceChangesReport,
  workspaceChangesReview
} from "../src/workspace-changes.js";
import { booleanWorkspaceChanges } from "../src/server.js";

test("Boollm Changes tracks a Codex create and delete cycle without Git", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-non-git-changes-"));
  try {
    assert.equal(fs.existsSync(path.join(root, ".git")), false);
    const filename = "codex-final-test.txt";
    const absolutePath = path.join(root, filename);
    const createDiff = `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1 @@\n+Boollm verified this non-git file.\n`;
    fs.writeFileSync(absolutePath, "Boollm verified this non-git file.\n");

    let changes = mergeWorkspaceChanges([], [{
      path: filename,
      absolutePath,
      status: "added",
      diff: createDiff
    }], root);

    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, filename);
    assert.equal(path.resolve(changes[0].absolutePath), path.resolve(absolutePath));
    assert.equal(changes[0].status, "created");
    assert.equal(changes[0].diff, createDiff);
    assert.deepEqual(workspaceChangeStats(changes), { files: 1, additions: 1, deletions: 0 });
    const review = workspaceChangesReview(changes);
    assert.equal(review.files.length, 1);
    assert.equal(review.files[0].status, "created");
    assert.equal(review.files[0].lines.some((line) => line.type === "add" && line.text === "Boollm verified this non-git file."), true);
    assert.match(workspaceChangesReport(changes), /Boollm Changes: 1 file/);
    assert.match(workspaceChangesReport(changes), /created: .*codex-final-test\.txt/);
    assert.match(workspaceChangesReport(changes), /\+Boollm verified this non-git file\./);

    fs.rmSync(absolutePath);
    changes = mergeWorkspaceChanges(changes, [{
      path: filename,
      absolutePath,
      status: "deleted",
      diff: `--- a/${filename}\n+++ /dev/null\n@@ -1 +0,0 @@\n-Boollm verified this non-git file.\n`
    }], root);

    assert.equal(changes.length, 0);
    assert.deepEqual(workspaceChangeStats(changes), { files: 0, additions: 0, deletions: 0 });
    assert.equal(workspaceChangesReview(changes).files.length, 0);
    assert.equal(workspaceChangesReport(changes), "Boollm Changes: 0 files.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Boollm rejects Changes paths outside the selected workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-change-boundary-"));
  try {
    const changes = mergeWorkspaceChanges([], [{
      path: path.join("..", "outside.txt"),
      status: "created",
      diff: "+outside"
    }], root);
    assert.deepEqual(changes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project Changes aggregate across chats and a later delete clears an earlier create", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-project-ledger-"));
  try {
    const filename = "codex-final-test.txt";
    const created = {
      id: "create-chat", kind: "project", projectDir: root, updatedAt: 1,
      workspaceChanges: [{ path: filename, status: "created", diff: `+++ b/${filename}\n+created\n` }]
    };
    const threads = new Map([[created.id, created]]);
    let changes = booleanWorkspaceChanges(created, root, threads);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, "created");
    const deleted = {
      id: "delete-chat", kind: "project", projectDir: root, updatedAt: 2,
      workspaceChanges: [{ path: filename, status: "deleted", diff: `--- a/${filename}\n-deleted\n` }]
    };
    threads.set(deleted.id, deleted);
    changes = booleanWorkspaceChanges(deleted, root, threads);
    assert.deepEqual(changes, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the server, store, and UI keep the Boollm Changes bridge wired independently of Git", () => {
  const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const storeSource = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const uiSource = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");

  assert.match(serverSource, /p === "\/api\/workspace-changes"/);
  assert.match(serverSource, /type: "workspaceChanges"/);
  assert.match(serverSource, /workspaceChangesReport\(booleanWorkspaceChanges/);
  assert.match(storeSource, /workspaceChanges: Array\.isArray\(t\.workspaceChanges\)/);
  assert.match(uiSource, /ev\.type==="workspaceChanges"/);
  assert.match(uiSource, /refreshProjectDashboard\(\{force:true\}\)/);
  assert.match(uiSource, /df-status\.added,\.diff-file-head \.df-status\.created/);
  assert.match(uiSource, /\$\("chatUtilityChanges"\)\?\.addEventListener\("click",\(\)=>reviewCurrentDiff\(\)\)/);
  assert.match(uiSource, /const filesClick=e\.target\.closest\("#cmdFilesChip"\);[\s\S]*?reviewCurrentDiff\(\); return;/);
  assert.doesNotMatch(uiSource, /\$\("chatUtilityChanges"\)\?\.addEventListener\("click",\(\)=>\$\("cmdReview"\)\?\.click\(\)\)/);
});
