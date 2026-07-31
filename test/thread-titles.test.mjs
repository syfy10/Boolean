import test from "node:test";
import assert from "node:assert/strict";
import { repairGenericWorkflowTitle, shortThreadTitle } from "../src/server.js";

test("email chat titles use the request subject instead of repeating Email draft", () => {
  assert.equal(shortThreadTitle("Draft an email to Acme about the renewal proposal"), "Email Acme Renewal Proposal");
  assert.equal(shortThreadTitle("Clean up old promotional email in my inbox"), "Email cleanup");
});

test("saved generic and numbered workflow titles are repaired smartly", () => {
  const email = {
    title: "Email draft 5",
    messages: [{ role: "user", content: "Write an email to Tesla about the service quote" }]
  };
  const project = {
    title: "Build Prepare Sourced Prospect 2",
    messages: [{ role: "user", content: "Company website: https://greenscan.us\nPrepare a sourced prospect plan." }]
  };
  const threads = [email, project];
  assert.equal(repairGenericWorkflowTitle(email, threads), true);
  assert.equal(email.title, "Email Tesla Service Quote");
  assert.equal(repairGenericWorkflowTitle(project, threads), true);
  assert.equal(project.title, "Greenscan prospect plan");
});
