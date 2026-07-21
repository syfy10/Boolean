import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGmailCleanupQuery,
  classifyCleanupMessage,
  createCleanupPlan,
  publicCleanupPlan
} from "../src/email-cleanup.js";

test("cleanup query keeps non-negotiable Gmail protections", () => {
  const query = buildGmailCleanupQuery({
    query: "from:news@example.com",
    olderThan: "3y",
    categories: ["promotions", "social"],
    protectAttachments: true
  });
  assert.match(query, /older_than:3y/);
  assert.match(query, /category:promotions/);
  assert.match(query, /-is:starred/);
  assert.match(query, /-label:important/);
  assert.match(query, /-in:sent/);
  assert.match(query, /-has:attachment/);
});

test("cleanup classifier protects important, labeled, attachment, and sensitive mail", () => {
  const base = { id: "1", from: "sender@example.com", subject: "Weekly offer", labelIds: ["CATEGORY_PROMOTIONS"] };
  assert.equal(classifyCleanupMessage({ ...base, labelIds: ["IMPORTANT", "CATEGORY_PROMOTIONS"] }).status, "protected");
  assert.equal(classifyCleanupMessage({ ...base, labelIds: ["Label_7", "CATEGORY_PROMOTIONS"] }, { userLabelIds: ["Label_7"] }).status, "protected");
  assert.equal(classifyCleanupMessage({ ...base, hasAttachment: true }).status, "protected");
  assert.equal(classifyCleanupMessage({ ...base, subject: "Your bank statement" }).status, "protected");
});

test("cleanup plan exposes counts and samples without message ids", () => {
  const rows = [
    { id: "candidate-secret-id", from: "shop@example.com", subject: "Weekly sale", labelIds: ["CATEGORY_PROMOTIONS"] },
    { id: "protected-secret-id", from: "bank@example.com", subject: "Bank statement", labelIds: ["CATEGORY_UPDATES"] },
    { id: "review-secret-id", from: "friend@example.com", subject: "Hello", labelIds: [] }
  ];
  const plan = createCleanupPlan({ provider: "gmail", account: "person@example.com", query: "older_than:2y", rows });
  const visible = publicCleanupPlan(plan);
  assert.equal(visible.candidateCount, 1);
  assert.equal(visible.protectedCount, 1);
  assert.equal(visible.reviewCount, 1);
  assert.doesNotMatch(JSON.stringify(visible), /candidate-secret-id|protected-secret-id|review-secret-id/);
  assert.match(visible.safety, /Nothing was changed/);
});
