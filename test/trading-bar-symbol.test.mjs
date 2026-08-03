import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");

// The trading bar reads the ticker off the page the native browser pane is showing.
// Pull the real implementation out of ui.html so these cases test shipped code.
function loadSymbolReader() {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)[1];
  const start = script.indexOf("  // Words that look like tickers");
  const end = script.indexOf("\n  }", script.indexOf("function symbolFromPageText"));
  assert.ok(start >= 0 && end > start, "symbolFromPageText not found in ui.html");
  const block = script.slice(start, end + 4);
  return new Function("normalizeSymbolInput", `${block}\nreturn symbolFromPageText;`)(
    (value) => String(value || "").toUpperCase().trim()
  );
}

test("the ticker is read from the visible page, not the URL", () => {
  const symbolFromPageText = loadSymbolReader();
  // A Robinhood Legend URL is /legend/layout/<uuid> — no ticker anywhere in it,
  // which is why the bar used to fall back to AAPL while GOOGL was on screen.
  assert.equal(
    symbolFromPageText("Futures chart Market hours Add widget Individual GOOGL $375.25 $19.12 (5.37%) Buy Short"),
    "GOOGL"
  );
  assert.equal(symbolFromPageText("AAPL $271.40 Apple Inc"), "AAPL");
  assert.equal(symbolFromPageText("watching $TSLA today"), "TSLA");
});

test("OCR noise does not become the ticker", () => {
  const symbolFromPageText = loadSymbolReader();
  // OCR of the quote card puts "Class A" directly before the price.
  assert.equal(
    symbolFromPageText("GOOGL\nAlphabet Class A\n$375.25\nA $19.12 (5.37%)\nB $375.22 x 35"),
    "GOOGL"
  );
  assert.equal(symbolFromPageText("Robinhood Legend"), "");
  assert.equal(symbolFromPageText("Inbox 12 unread messages"), "");
  assert.equal(symbolFromPageText(""), "");
});

test("a page ticker only applies when the URL carries none", () => {
  // browserSymbol (URL-derived) still wins; the page read is the fallback.
  assert.match(ui, /const browserSymbol = normalizeSymbolInput\(tradingState\.browserSymbol \|\| ""\);\s*if\(browserSymbol\)\{[\s\S]*?return browserSymbol;\s*\}\s*const pageSymbol = await symbolFromVisiblePage\(\);/);
  assert.match(ui, /if\(!SHELL\) return "";/);
});

test("a failed quote says why instead of a bare unavailable", () => {
  assert.match(ui, /let reason="";[\s\S]*?reason=String\(\(await quoteResponse\.json\(\)\)\?\.error\|\|""\);/);
  assert.match(ui, /const signIn=\/sign in\/i\.test\(why\);/);
  assert.match(ui, /sign in for live prices/);
});
