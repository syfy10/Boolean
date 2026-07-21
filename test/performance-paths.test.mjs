import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { clearProviderModelCache, listProviderModels } from "../src/providers.js";

test("cloud model discovery is local on startup and cached after refresh", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-fast-model" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  clearProviderModelCache();

  const config = {
    provider: "openai",
    openai: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      model: "selected-model",
      apiKey: "test"
    }
  };

  const startup = await listProviderModels(config, { remote: false });
  assert.equal(requests, 0);
  assert.ok(startup.length > 0);

  const refreshed = await listProviderModels(config);
  assert.equal(requests, 1);
  assert.deepEqual(refreshed.map((item) => item.name), ["gpt-fast-model"]);

  await listProviderModels(config);
  assert.equal(requests, 1, "subsequent menus should reuse the cached model list");
});

test("UI keeps the fast interaction paths and omits retry controls", () => {
  const html = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-act="retry"|data-chat-act="retry"|data-a="retry"/);
  assert.match(html, /fetch\("\/api\/status"\)/);
  assert.match(html, /THREAD_PAGE_SIZE=80/);
  assert.match(html, /loadOlderMessages\(\)/);
  assert.match(html, /requestAnimationFrame\(paintPendingStream\)/);
  assert.match(html, /fetch\("\/api\/model\/warm"/);
});
