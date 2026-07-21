import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalChatMemory } from "../src/store.js";

test("local chat memory retrieves relevant saved conversation excerpts", () => {
  const threads = [
    {
      id: "current",
      title: "Boolean polish",
      kind: "project",
      projectDir: "C:\\Users\\S10\\Documents\\Boolean",
      updatedAt: Date.now(),
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "Going forward dont build and deploy anything until i say it" },
        { role: "assistant", content: "Understood. I will not build or deploy unless you ask." },
        { role: "user", content: "When user updates shouldn't remove saved keys" },
        { role: "assistant", content: "I will preserve saved keys during updates." }
      ]
    },
    {
      id: "old",
      title: "Website detector",
      kind: "chat",
      updatedAt: Date.now() - 1000,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "Build website tech detector for WordPress Shopify Wix Webflow" },
        { role: "assistant", content: "Added detector rules and UI." }
      ]
    }
  ];

  const memory = buildLocalChatMemory(threads, {
    currentThreadId: "current",
    latestText: "what did i tell you about deploy and saved keys?",
    projectDir: "C:\\Users\\S10\\Documents\\Boolean"
  });

  assert.match(memory, /CURRENT THREAD MEMORY/);
  assert.match(memory, /dont build and deploy anything until i say it/i);
  assert.match(memory, /preserve saved keys/i);
  assert.match(memory, /Boolean polish/);
});

test("local chat memory skips blank starter chats", () => {
  const memory = buildLocalChatMemory([
    {
      id: "blank",
      title: "New chat",
      kind: "chat",
      updatedAt: Date.now(),
      messages: [{ role: "system", content: "system" }],
      log: []
    }
  ], {
    currentThreadId: "blank",
    latestText: "what did we talk about?"
  });

  assert.equal(memory, "");
});
