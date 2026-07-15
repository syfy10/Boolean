import test from "node:test";
import assert from "node:assert/strict";
import { decideAiRoute, normalizeUserText } from "../src/ai-policy.js";
import { selectFifaEvents } from "../src/sports.js";

const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

test("normal conversation does not search", () => {
  assert.equal(decideAiRoute("what should we do today", []).needsWeb, false);
  assert.equal(decideAiRoute("talk to me", []).needsWeb, false);
});

test("explicit search and current facts use the web", () => {
  assert.equal(decideAiRoute("search the web for laptop deals", []).needsWeb, true);
  assert.equal(decideAiRoute("what is the weather in Miami", []).domain, "weather");
});

test("FIFA timeframes stay distinct", () => {
  const last = decideAiRoute("who won the last FIFA game", []);
  assert.equal(last.timeframe, "latest-completed");
  assert.equal(last.asksWinner, true);
  assert.equal(decideAiRoute("who won the FIFA match yesterday", []).timeframe, "yesterday");
  assert.equal(decideAiRoute("when is the next FIFA match", []).timeframe, "next");
  assert.equal(decideAiRoute("when is the final game?", [user("who won fifa game?"), assistant("Checking FIFA.")]).timeframe, "final");
  assert.equal(decideAiRoute("last game of the tournament", [user("who won fifa game?"), assistant("Spain beat France.")]).timeframe, "final");
  assert.equal(decideAiRoute("is july 19 last game?", [user("when is next FIFA match?"), assistant("Argentina plays England.")]).timeframe, "final");
});

test("short FIFA follow-up inherits the current conversation", () => {
  const messages = [user("who won the last FIFA game?"), assistant("Checking."), user("who won?")];
  const route = decideAiRoute("who won?", messages);
  assert.equal(route.domain, "fifa");
  assert.equal(route.timeframe, "latest-completed");
  assert.equal(route.needsWeb, true);
});

test("contextual FIFA follow-up about teams stays in sports route", () => {
  const messages = [user("who won fifa game?"), assistant("Spain beat France 2-0."), user("what happand with france and spain")];
  const route = decideAiRoute("what happand with france and spain", messages);
  assert.equal(route.domain, "fifa");
  assert.equal(route.timeframe, "latest-completed");
  assert.equal(route.needsWeb, true);
});

test("common winner typo is normalized", () => {
  assert.equal(normalizeUserText("who own yesterday?"), "who won yesterday?");
});

test("latest completed FIFA event excludes a future match", () => {
  const events = [
    { date: "2026-07-14T19:00:00Z", status: { type: { state: "post" } } },
    { date: "2026-07-15T19:00:00Z", status: { type: { state: "pre" } } }
  ];
  const selected = selectFifaEvents(events, "latest-completed", new Date("2026-07-15T12:00:00Z"));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].date, "2026-07-14T19:00:00Z");
});

test("FIFA final selects the last scheduled event, not latest completed", () => {
  const events = [
    { date: "2026-07-14T19:00:00Z", status: { type: { state: "post" } } },
    { date: "2026-07-15T19:00:00Z", status: { type: { state: "pre" } } },
    { date: "2026-07-19T19:00:00Z", status: { type: { state: "pre" } } }
  ];
  const selected = selectFifaEvents(events, "final", new Date("2026-07-15T12:00:00Z"));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].date, "2026-07-19T19:00:00Z");
});
