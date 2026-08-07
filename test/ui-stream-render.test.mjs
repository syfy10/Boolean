// The chat streams a message by committing finished markdown blocks once and
// re-rendering only the unfinished tail. That is only safe if the committed
// pieces concatenate to exactly what a single full render would have produced,
// so this pins that equivalence against the real md()/stableCommitPoint source
// in src/ui.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "src", "ui.html"), "utf8");

function grabFunction(pattern) {
  const match = pattern.exec(src);
  assert.ok(match, "function not found in src/ui.html: " + pattern);
  let depth = 0, index = src.indexOf("{", match.index);
  for (; index < src.length; index++) {
    if (src[index] === "{") depth++;
    else if (src[index] === "}" && !--depth) { index++; break; }
  }
  return src.slice(match.index, index);
}

const blockTail = /^ {2}const MD_BLOCK_TAIL=.*$/m.exec(src);
assert.ok(blockTail, "MD_BLOCK_TAIL not found in src/ui.html");

const context = {
  state: { ui: {} },
  console,
  isFilePath: () => false,
  chatLinkFile: (_href, label) => "<code>" + label + "</code>",
};
vm.createContext(context);
vm.runInContext([
  blockTail[0],
  grabFunction(/ {2}function esc\(/),
  grabFunction(/ {2}function mdInline\(/),
  grabFunction(/ {2}function mdBlocks\(/),
  grabFunction(/ {2}function maskSensitiveDisplay\(/),
  grabFunction(/ {2}function md\(/),
  grabFunction(/ {2}function stableCommitPoint\(/),
].join("\n"), context);

const { md, stableCommitPoint } = context;

// Mirrors the commit loop in renderLiveBody, one character at a time so every
// possible split point is exercised.
function renderIncrementally(text) {
  let stable = 0, committed = "", rendered = "";
  for (let upto = 1; upto <= text.length; upto++) {
    const pending = text.slice(stable, upto);
    const commit = stableCommitPoint(pending);
    if (commit > 0 && pending.length - commit >= 3) {
      committed += md(pending.slice(0, commit), !/^\s*```/.test(pending.slice(commit)));
      stable += commit;
    }
    rendered = committed + md(text.slice(stable, upto));
  }
  return rendered;
}

const cases = {
  "single line": "Hello world",
  "heading then paragraphs": "# Title\n\nA paragraph here.\n\nAnother paragraph.",
  "list between paragraphs": "Intro line\n\n- one\n- two\n- three\n\nAfter the list.",
  "fence containing a blank line": "Text\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the fence.",
  "table then text": "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nTail text.",
  "multi-line paragraphs and a heading": "Para one\nline two\n\nPara two\nline two\n\n## Head\n\nlast",
  "ordered list, bare fence, inline marks": "1. first\n2. second\n\n```\nraw\n```\n\n**bold** and `code`",
  "inline code opening a paragraph": "Text\n\n`code` here and more",
  "trailing blank lines": "no trailing newline\n\n",
  "consecutive fences": "a\n\n```\none\n```\n\n```\ntwo\n```\n\nend",
};

for (const [name, text] of Object.entries(cases)) {
  test("incremental render matches full render: " + name, () => {
    assert.equal(renderIncrementally(text), md(text));
  });
}

test("stableCommitPoint never splits inside a code fence", () => {
  const text = "intro\n\n```\nline one\n\nline two\n```\n\ntail";
  const commit = stableCommitPoint(text);
  const fenceStart = text.indexOf("```");
  const fenceEnd = text.lastIndexOf("```") + 3;
  assert.ok(commit <= fenceStart || commit >= fenceEnd, "commit point " + commit + " landed inside the fence");
});

test("stableCommitPoint returns zero when no block has finished", () => {
  assert.equal(stableCommitPoint("a partial sentence still being written"), 0);
});
