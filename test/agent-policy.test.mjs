import assert from "node:assert/strict";
import test from "node:test";

import { BOOLEAN_AGENT_RULES, booleanAgentPolicy } from "../src/agent-policy.js";

test("operating policy covers scope safety verification continuity and handoff", () => {
  const policy = booleanAgentPolicy();
  const required = [
    /latest user request/i,
    /do not invent authority/i,
    /explicit prohibitions/i,
    /exact project.*account.*mailbox/i,
    /preserve user work/i,
    /smallest coherent change/i,
    /secrets/i,
    /destructive actions/i,
    /verify the connected mailbox/i,
    /never loop/i,
    /original request/i,
    /not completion/i,
    /bug fixes/i,
    /UI work/i,
    /responsive layout/i,
    /focused tests/i,
    /Never claim/i,
    /successful build is not a deployment/i,
    /temporary processes/i,
    /primary evidence/i,
    /final diff/i,
    /test-only/i,
    /compatible schemas/i,
    /Complete only when/i
  ];
  for (const pattern of required) assert.match(policy, pattern);
  assert.equal(BOOLEAN_AGENT_RULES.every((rule) => rule.length > 20), true);
});
