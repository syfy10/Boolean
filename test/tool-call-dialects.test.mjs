import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { looksLikeToolCall, parseFallbackToolCall, runTurn, systemPrompt } from "../src/agent.js";

const allowedNames = new Set(["read_file", "run_command", "write_file", "browser_open", "web_search"]);
const parse = (text, options = {}) => parseFallbackToolCall(text, { strict: true, allowedNames, ...options });

// Tag names are assembled rather than written out so that this file can be read
// by the same agents it describes without the examples closing their own turn.
const open = (prefix, tag, attrs) => `<${prefix}${tag}${attrs ? ` ${attrs}` : ""}>`;
const close = (prefix, tag) => `<\/${prefix}${tag}>`;
const invoke = (prefix, name, body) => open(prefix, "invoke", `name="${name}"`) + body + close(prefix, "invoke");
const param = (prefix, name, value, attrs = "") => open(prefix, "parameter", `name="${name}"${attrs ? ` ${attrs}` : ""}`) + value + close(prefix, "parameter");

// Each model family writes a text tool call in its own dialect. The bridge read
// only JSON, so every other family looked like it was refusing to work.
test("every model family's tool-call dialect is read the same way", () => {
  const expected = { name: "read_file", arguments: { path: "src/ui.html" } };

  // DeepSeek: special tokens fenced with fullwidth pipes, arriving as literal
  // text because the endpoint never decoded them into tool_calls.
  const ds = "｜｜DSML｜｜";
  assert.deepEqual(
    parse(`${open(ds, "tool_calls")}\n${invoke(ds, "read_file", "\n" + param(ds, "path", "src/ui.html", 'string="true"') + "\n")}\n${close(ds, "tool_calls")}`),
    expected
  );

  // Anthropic-style invoke/parameter, bare and namespaced.
  assert.deepEqual(parse(invoke("", "read_file", param("", "path", "src/ui.html"))), expected);
  assert.deepEqual(parse(invoke("antml:", "read_file", param("antml:", "path", "src/ui.html"))), expected);

  // Qwen / Hermes / OpenAI-compatible open-weight servers.
  assert.deepEqual(parse('<tool_call>{"name":"read_file","arguments":{"path":"src/ui.html"}}</tool_call>'), expected);
  assert.deepEqual(parse('<tool_use>{"name":"read_file","input":{"path":"src/ui.html"}}</tool_use>'), expected);

  // Llama-style named function tag.
  assert.deepEqual(parse('<function=read_file>{"path":"src/ui.html"}</function>'), expected);

  // The JSON dialects that already worked must keep working.
  assert.deepEqual(parse('```json\n{"name":"read_file","arguments":{"path":"src/ui.html"}}\n```'), expected);
  assert.deepEqual(parse('I will look now.\n{"name":"read_file","arguments":{"path":"src/ui.html"}}'), expected);
  assert.deepEqual(parse('{"name":"read_file","arguments":{"path":"src/ui.html"}}}'), expected, "one surplus brace is still repaired");
});

test("tag parameters are typed, and string parameters keep their exact content", () => {
  const call = parse(invoke("", "run_command", [
    param("", "command", "npm test"),
    param("", "timeout", "45"),
    param("", "elevated", "false")
  ].join("")));
  assert.deepEqual(call, { name: "run_command", arguments: { command: "npm test", timeout: 45, elevated: false } });

  // string="true" means the value is content, not a value to interpret: an exact
  // edit depends on it surviving byte for byte apart from the framing newline.
  const exact = parse(invoke("", "write_file", [
    param("", "path", "a.js"),
    param("", "content", "\nconst n = 1;\n  indented\n\n", 'string="true"')
  ].join("")), { allowedNames: new Set(["write_file"]) });
  assert.equal(exact.arguments.content, "const n = 1;\n  indented\n");

  // string="false" asks for the value to be parsed, not kept as text.
  const parsed = parse(invoke("", "run_command", param("", "command", '"npm test"', 'string="false"')));
  assert.equal(parsed.arguments.command, "npm test");
});

test("the same safety gates apply to every dialect, not just to JSON", () => {
  assert.equal(parse(invoke("", "delete_file", param("", "path", "project"))), null, "a known tool that is unavailable this turn must not run");
  assert.equal(parse(invoke("", "not_a_boolean_tool", param("", "x", "1"))), null, "an unknown name stays ordinary text");
  assert.equal(parse('<tool_call>{"name":"not_a_boolean_tool","arguments":{}}</tool_call>'), null);
  assert.equal(
    parse('I will edit it. {"name":"write_file","arguments":{"path":"app.js","content":"unsafe"}}', { allowedNames: new Set(["write_file"]) }),
    null,
    "an unfenced JSON mutation is still refused in strict mode"
  );
  assert.equal(parse("Here is what I would do: read the file and report back."), null);
});

test("attempted tool calls are told apart from ordinary prose", () => {
  const ds = "｜｜DSML｜｜";
  assert.equal(looksLikeToolCall(invoke(ds, "browser_open", param(ds, "url", "https://example.com", 'string="true"'))), true);
  assert.equal(looksLikeToolCall('<tool_call>{"name":"web_search"}</tool_call>'), true);
  assert.equal(looksLikeToolCall('<function=read_file>{"path":"a"}</function>'), true);
  assert.equal(looksLikeToolCall('{"name":"read_file","arguments":{"path":"a"}}'), true);
  assert.equal(looksLikeToolCall("I compared the two sites and here is what I would change."), false);
  assert.equal(looksLikeToolCall('<div class="hero">A marketing section</div>'), false, "ordinary HTML in a web task is not a tool call");
  // The marker has to be the tag name, not a word sitting in an attribute -
  // otherwise a site redesign answer would be mistaken for a broken tool call.
  assert.equal(looksLikeToolCall('<button onclick="invoke()">Deploy</button>'), false);
  assert.equal(looksLikeToolCall('<script>function tool_call() { return 1; }</script>'), false);
  assert.equal(parse('<button onclick="invoke()" name="read_file">x</button>'), null);
  assert.equal(looksLikeToolCall('{"name":"something_else","arguments":{}}'), false);
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

test("a tool call in an unreadable dialect is corrected, never returned as the answer", async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "boolean-dialect-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(projectDir, "app.js"), "const value = 7;\n");

  // Turn 1 emits a dialect no parser can read - not a tool name Boollm knows,
  // so recovery has to come from the protocol nudge rather than from parsing.
  const gibberish = "<<|tool_call|>> read_file :: app.js <<|end|>>";
  const mock = await mockServer((call) => {
    if (call === 1) return { role: "assistant", content: gibberish };
    if (call === 2) return { role: "assistant", content: '```json\n{"name":"read_file","arguments":{"path":"app.js"}}\n```' };
    return { role: "assistant", content: "app.js defines value as 7." };
  });
  t.after(() => mock.server.close());

  const cfg = {
    provider: "openai",
    openai: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: "dialect-test", apiKey: "test" },
    modelCapabilities: {},
    autoApprove: true,
    ui: { contextMode: "full", learnedMemory: false, codingAgent: { compatibilityMode: "patch", stopLoop: false, autopilot: false } },
    connectors: { mcp: [], agents: [] }
  };
  const steps = [];
  const statuses = [];
  const answer = await runTurn({
    config: cfg,
    projectDir,
    approve: async () => true,
    onStatus(text) { statuses.push(String(text)); },
    onStep(step) { steps.push(step.name); },
    onUsage() {},
    onCheckpoint() {}
  }, [
    { role: "system", content: systemPrompt(projectDir, true, cfg) },
    { role: "user", content: "Inspect app.js and tell me which value it defines." }
  ]);

  assert.equal(answer, "app.js defines value as 7.");
  assert.notEqual(answer, gibberish, "unreadable markup must never become the final answer");
  assert.deepEqual(steps, ["read_file"]);
  assert.ok(statuses.some((text) => /unrecognized format/i.test(text)), "the mismatch is reported, not silent");
  const corrected = mock.requests[1].messages.map((message) => String(message.content || "")).join("\n");
  assert.match(corrected, /BOOLLM PROTOCOL ERROR/, "the retry carries the exact format Boollm can read");
});
