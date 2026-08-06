import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  firstReachableLocalPreview,
  localPreviewUrls,
  requestsLocalPreview,
  withBoollmPreviewHandoff
} from "../src/server.js";

test("preview intent is limited to explicit run/open/browser requests", () => {
  assert.equal(requestsLocalPreview("Run the current project and open its local preview in the built-in browser."), true);
  assert.equal(requestsLocalPreview("Show the game in the browser"), true);
  assert.equal(requestsLocalPreview("Explain how localhost works"), true);
  assert.equal(requestsLocalPreview("Review this project structure"), false);
});

test("local preview URLs are normalized and public URLs are ignored", () => {
  assert.deepEqual(localPreviewUrls(
    "Ready at http://0.0.0.0:4173/app). Mirror https://example.com and http://localhost:3000/"
  ), ["http://127.0.0.1:4173/app", "http://localhost:3000/"]);
});

test("Boollm preview handoff preserves text and image user messages", () => {
  const source = [{ role: "user", content: [{ type: "text", text: "Run it" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }];
  const augmented = withBoollmPreviewHandoff(source);
  assert.equal(source[0].content.length, 2);
  assert.equal(augmented[0].content.length, 3);
  assert.match(augmented[0].content.at(-1).text, /Boollm owns the built-in browser/);
  assert.match(augmented[0].content.at(-1).text, /do not use ChatGPT, Codex, Claude, MCP, or plugin browser controls/);
});

test("Boollm verifies a localhost preview before handing it to the browser", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Preview</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.equal(await firstReachableLocalPreview(["not a URL", url]), url);
});
