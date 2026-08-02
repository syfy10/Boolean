import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { announcesUnperformedAction, classifyTurnMode, focusedMessagesForTurn, parseFallbackToolCall, runTurn, systemPrompt } from "../src/agent.js";

test("plain compatibility tool JSON is executed instead of displayed as a final answer", () => {
  const allowedNames = new Set(["run_command"]);
  const command = "node --version";
  assert.deepEqual(
    parseFallbackToolCall(`I'll run the check now.\n{\"name\":\"run_command\",\"arguments\":{\"command\":\"${command}\"}}`, {
      strict: true,
      allowedNames
    }),
    { name: "run_command", arguments: { command } }
  );
  assert.deepEqual(
    parseFallbackToolCall(`{\"name\":\"run_command\",\"arguments\":{\"command\":\"${command}\"}}}`, {
      strict: true,
      allowedNames
    }),
    { name: "run_command", arguments: { command } }
  );
  assert.equal(
    parseFallbackToolCall('{"name":"delete_file","arguments":{"path":"project"}}', { strict: true, allowedNames }),
    null,
    "a known tool that is unavailable this turn must not execute"
  );
  assert.equal(
    parseFallbackToolCall('{"name":"not_a_boolean_tool","arguments":{}}', { strict: true, allowedNames }),
    null,
    "arbitrary JSON must remain ordinary assistant text"
  );
  assert.equal(
    parseFallbackToolCall('I will edit it. {"name":"write_file","arguments":{"path":"app.js","content":"unsafe"}}', {
      strict: true,
      allowedNames: new Set(["write_file"])
    }),
    null,
    "direct compatibility file mutations still require a fenced call"
  );
});

test("a plain compatibility tool call continues the run end to end", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-plain-tool-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 7;\n");
  const mock = await mockServer((call) => call === 1
    ? { role: "assistant", content: 'I will inspect it now.\n{"name":"read_file","arguments":{"path":"app.js"}}' }
    : { role: "assistant", content: "app.js defines value as 7." });
  t.after(() => mock.server.close());
  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "plain-tool-test", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, codingAgent: { compatibilityMode: "patch", stopLoop: false, autopilot: false } },
    connectors: { mcp: [], agents: [] }
  };
  const steps = [];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus() {},
    onStep(step) { steps.push(step.name); },
    onUsage() {},
    onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Inspect app.js and tell me which value it defines." }
  ]);

  assert.equal(answer, "app.js defines value as 7.");
  assert.deepEqual(steps, ["read_file"]);
  assert.equal(mock.requests.length, 2);
  assert.match(mock.requests[1].messages.at(-1).content, /TOOL RESULT for read_file/);
});

async function mockServer(handler) {
  const requests = [];
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    calls++;
    const message = await handler(calls, requests.at(-1));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, port: server.address().port };
}

test("a bare announcement forces a native tool call on the next turn (forceToolCallNext is wired)", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-force-tool-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer((call) => {
    // Turn 1: the exact GLM stall — announce an action, take none.
    if (call === 1) return { role: "assistant", content: "Let me inspect the current logo now." };
    // Turn 2: after the nudge, actually make a tool call so the run can finish.
    if (call === 2) return {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } }]
    };
    return { role: "assistant", content: "Inspected the project structure." };
  });
  t.after(() => mock.server.close());
  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "gpt-native-test", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, codingAgent: { compatibilityMode: "auto", stopLoop: false, autopilot: true } },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Review the project files and tell me what is there." }
  ];
  await runTurn({
    config: cfg, projectDir, approve: async () => true,
    onStatus() {}, onStep() {}, onUsage() {}, onCheckpoint() {}
  }, messages);

  assert.ok(mock.requests.length >= 2, "the run should continue past the bare announcement");
  assert.notEqual(mock.requests[0].tool_choice, "required", "the first turn is not force-called");
  assert.ok(
    mock.requests.some((r) => r.tool_choice === "required"),
    "the announce nudge must force tool_choice:required so the model acts instead of stalling"
  );
});

test("a compatibility model cannot finish after promising another tool step", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-compat-stall-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer((call) => {
    if (call === 1) return {
      role: "assistant",
      content: '```tool\n{"name":"read_file","arguments":{"path":"app.js"}}\n```'
    };
    if (call === 2) return {
      role: "assistant",
      content: "I have the relevant code. Now let me inspect the rest of the file before making changes."
    };
    if (call === 3) return {
      role: "assistant",
      content: '```tool\n{"name":"read_file","arguments":{"path":"app.js"}}\n```'
    };
    return { role: "assistant", content: "The file currently defines value as 1." };
  });
  t.after(() => mock.server.close());
  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "compat-test", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, codingAgent: { compatibilityMode: "patch", stopLoop: false, autopilot: false } },
    connectors: { mcp: [], agents: [] }
  };
  const messages = [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Inspect app.js and tell me what value it defines." }
  ];
  const steps = [];
  const answer = await runTurn({
    config: cfg, projectDir, approve: async () => true,
    onStatus() {}, onStep(step) { steps.push(step); }, onUsage() {}, onCheckpoint() {}
  }, messages);

  assert.equal(answer, "The file currently defines value as 1.");
  assert.equal(mock.requests.length, 4, "the compatibility run must continue after the announcement");
  assert.match(mock.requests[2].messages.at(-1).content, /exactly one fenced tool call/i);
  assert.equal(steps.filter((step) => step.name === "read_file").length, 2);
});

test("normal mode continues an unfinished build without requiring Autopilot", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-normal-persist-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 1;\n");
  const mock = await mockServer((call) => {
    if (call === 1) return { role: "assistant", content: "I will make the requested change next." };
    if (call === 2) return {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "edit_1", type: "function", function: {
        name: "edit_file",
        arguments: JSON.stringify({ path: "app.js", old_string: "const value = 1;", new_string: "const value = 2;" })
      } }]
    };
    if (call === 3) return {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "check_1", type: "function", function: {
        name: "run_command",
        arguments: JSON.stringify({ command: "node --check app.js" })
      } }]
    };
    return { role: "assistant", content: "Updated app.js and verified it successfully." };
  });
  t.after(() => mock.server.close());
  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "normal-persist-test", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, codingAgent: { compatibilityMode: "auto", stopLoop: false, autopilot: false } },
    connectors: { mcp: [], agents: [] }
  };
  const steps = [];
  const answer = await runTurn({
    config: cfg, projectDir, approve: async () => true,
    onStatus() {}, onStep(step) { steps.push(step.name); }, onUsage() {}, onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Change app.js from value 1 to value 2 and verify it." }
  ]);

  assert.equal(answer, "Updated app.js and verified it successfully.");
  assert.equal(fs.readFileSync(path.join(projectDir, "app.js"), "utf8"), "const value = 2;\n");
  assert.deepEqual(steps, ["edit_file", "run_command"]);
  assert.equal(mock.requests.length, 4);
});

test("catches bare next-step announcements with no deliverable", () => {
  // The exact GLM stalls from the reported bug.
  assert.equal(announcesUnperformedAction("Let me read both files now."), true);
  assert.equal(announcesUnperformedAction("Let me read both files to understand the current state."), true);
  assert.equal(announcesUnperformedAction("Right, let me actually read the files now."), true);
  assert.equal(announcesUnperformedAction("My apologies — let me actually read them now."), true);
  assert.equal(announcesUnperformedAction("Let me read the files now."), true);
  assert.equal(announcesUnperformedAction("I'll check agent.js to see how ctx is built."), true);
  assert.equal(announcesUnperformedAction("Let me start with src/relay.js to check where we left off."), true);
  assert.equal(announcesUnperformedAction("Let me quickly review the current state of the app to give you specific, informed recommendations rather than generic ones."), true);
  assert.equal(announcesUnperformedAction("Let me get the current result and execute the requested action."), true);
  assert.equal(announcesUnperformedAction("I'll call the connector and submit it now."), true);
});

test("routes contextual app improvement questions through read-only inspection tools", () => {
  const messages = [
    { role: "system", content: "system" },
    {
      role: "assistant",
      content: "GreenScan is running locally at http://localhost:3210 from C:\\Users\\S10\\Documents\\GreenScan\\app."
    },
    { role: "user", content: "how would you improve this app give me 3 things." }
  ];

  assert.equal(classifyTurnMode(messages), "inspect");
  assert.equal(classifyTurnMode([
    { role: "system", content: "system" },
    { role: "user", content: "how would you improve an app?" }
  ]), "chat");
});

test("ignores real answers, questions, and long substantive text", () => {
  // A genuine answer to a question — no imminent self-action.
  assert.equal(announcesUnperformedAction("The relay executes tools via ctx.executeTool at line 260."), false);
  // Asking the user, not announcing an action to take now.
  assert.equal(announcesUnperformedAction("Which file should I start with, relay.js or agent.js?"), false);
  // Empty / whitespace.
  assert.equal(announcesUnperformedAction(""), false);
  assert.equal(announcesUnperformedAction("   "), false);
  // Long status report that merely mentions future steps is not a bare stall.
  const longStatus = "Here is where we stand. " + "We designed the relay architecture and started building relay.js. ".repeat(12);
  assert.ok(longStatus.length >= 400);
  assert.equal(announcesUnperformedAction(longStatus), false);
});

test("inspect context keeps the original request after many native tool calls", () => {
  const request = "Review app/styles.css and report the responsive layout bugs. Do not edit.";
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: request }
  ];
  for (let i = 0; i < 7; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }]
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `CSS snippet ${i}` });
  }

  const focused = focusedMessagesForTurn(messages, "inspect");
  assert.equal(focused.some((message) => message.role === "user" && message.content === request), true);
  assert.equal(focused.at(-1).content, "CSS snippet 6");
});

test("inspect context does not mistake compatibility tool results for the user request", () => {
  const request = "Find every .app-shell width rule and summarize them.";
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: request }
  ];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: `{\"name\":\"search_files\",\"arguments\":{\"query\":\"app-shell-${i}\"}}` });
    messages.push({ role: "user", content: `TOOL RESULT for search_files:\nmatch ${i}` });
  }

  const focused = focusedMessagesForTurn(messages, "inspect");
  const userPrompts = focused.filter((message) => message.role === "user").map((message) => message.content);
  assert.equal(userPrompts.includes(request), true);
  assert.equal(userPrompts.filter((text) => /^TOOL RESULT for /i.test(text)).length > 0, true);
});

test("unfinished action announcements are retried even after earlier tool work", () => {
  const source = fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8");
  assert.match(source, /const MAX_ANNOUNCE_NUDGES = 4;/);
  assert.match(source, /if \(activeToolDefinitions\.length && !signal\?\.aborted[\s\S]*?announcesUnperformedAction\(assistantContent\)\)/);
  assert.match(source, /compatibilityMode[\s\S]*?exactly one fenced tool call/);
  assert.doesNotMatch(source, /activeToolDefinitions\.length && !completedToolWork && !signal\?\.aborted/);
});
