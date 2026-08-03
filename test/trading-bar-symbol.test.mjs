import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const shell = fs.readFileSync(path.join(root, "shell", "Program.cs"), "utf8").replace(/\r/g, "");

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

test("market session uses New York timezone and labels pre/after as non-open", () => {
  const sessionFn = loadMarketSessionNow();
  const pre = sessionFn(new Date("2026-01-02T08:30:00-05:00"));
  const open = sessionFn(new Date("2026-01-02T10:00:00-05:00"));
  const after = sessionFn(new Date("2026-01-02T16:30:00-05:00"));
  const closed = sessionFn(new Date("2026-01-02T20:00:00-05:00"));
  const weekend = sessionFn(new Date("2026-01-03T10:00:00-05:00"));
  assert.equal(pre.id, "extended");
  assert.equal(open.id, "open");
  assert.equal(after.id, "extended");
  assert.equal(closed.id, "closed");
  assert.equal(weekend.id, "closed");
  assert.equal(weekend.label, "Weekend");
});

test("the quote is read from the broker page, not a second market feed", () => {
  const quoteFromPageText = loadPageQuoteReader();
  // Exactly what Robinhood Legend renders while GOOGL is open.
  const legend = quoteFromPageText("GOOGL\n$371.99\n▲ $15.86 (4.45%)\nB $371.85 x 10\nA $371.98 x 80");
  assert.equal(legend.symbol, "GOOGL");
  assert.equal(legend.price, 371.99);
  assert.equal(legend.changePercent, 4.45);
  assert.equal(legend.source, "page");
  // ▼ means down even though the numbers carry no sign.
  const falling = quoteFromPageText("TSLA\n$402.10\n▼ $8.40 (2.05%)\nBuy Short");
  assert.equal(falling.changePercent, -2.05);
  assert.equal(falling.changeAbs, -8.4);
  // A page with no quote must not invent one.
  assert.equal(quoteFromPageText("Robinhood Legend\nWatchlist"), null);
  assert.equal(quoteFromPageText(""), null);
});

test("the page read is fast-path only — OCR is too slow to poll", () => {
  // The bar polls pageText (script only); "context" runs OCR and takes seconds.
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"pageText",id\}\)/);
  assert.match(shell, /case "pageText":/);
  assert.match(shell, /async Task SendPageTextAsync\(string id\)/);
  assert.doesNotMatch(
    ui.slice(ui.indexOf("function requestPageText()"), ui.indexOf("function quoteFromPageText")),
    /ocr/i
  );
});

function loadPageQuoteReader() {
  const script = ui.match(/<script>([\s\S]*?)<\/script>/)[1];
  const symStart = script.indexOf("  // Words that look like tickers");
  const symEnd = script.indexOf("\n  }", script.indexOf("function symbolFromPageText"));
  const quoteStart = script.indexOf('  // "GOOGL $371.99');
  const quoteEnd = script.indexOf("\n  }", script.indexOf("function quoteFromPageText"));
  assert.ok(quoteStart >= 0 && quoteEnd > quoteStart, "quoteFromPageText not found in ui.html");
  const block = `${script.slice(symStart, symEnd + 4)}\n${script.slice(quoteStart, quoteEnd + 4)}`;
  return new Function("normalizeSymbolInput", `${block}\nreturn quoteFromPageText;`)(
    (value) => String(value || "").toUpperCase().trim()
  );
}

function loadMarketSessionNow() {
  const start = ui.indexOf("  // Market session, in New York time.");
  const end = ui.indexOf("\n  function renderTradingSession()", start);
  assert.ok(start >= 0 && end > start, "marketSessionNow not found in ui.html");
  const block = ui.slice(start, end);
  return new Function(`${block}\nreturn marketSessionNow;`)();
}

test("an unread page does not fall back to a stale ticker", () => {
  // The bar showed "AAPL price unavailable" while GOOGL/TSLA was on screen. If the
  // symbol did not come from the page, URL, or a pin, the bar must say so.
  assert.match(ui, /const fromPage=lastTradingSymbolSource==="page"\|\|lastTradingSymbolSource==="url"\|\|lastTradingSymbolSource==="pin";/);
  assert.match(ui, /"no symbol on this page"/);
  // An older shell has no pageText command; the slower context read still works.
  assert.match(ui, /if\(!page\) page=\(await requestShellContext\(6000\)\)\?\.browser\|\|null;/);
  assert.match(ui, /quoteFromPageText\(page\.text\)\|\|quoteFromPageText\(page\.ocr\)/);
});

test("the company name between ticker and price does not break the read", () => {
  const quoteFromPageText = loadPageQuoteReader();
  // Legend renders "TSLA / Tesla / $322.93" — the ticker is not adjacent to the price.
  const tsla = quoteFromPageText("Futures chart Market hours Add widget Individual TSLA Tesla $322.93 ▲ $11.72 (3.77%) B $322.91 x 1 A $322.92 x 19 Buy Short");
  assert.equal(tsla.symbol, "TSLA");
  assert.equal(tsla.price, 322.93);
  assert.equal(tsla.changePercent, 3.77);
});

test("a page read that times out reports why", () => {
  // The context read runs OCR; 2.5s was too short and looked like "no symbol".
  assert.match(ui, /if\(!page\) page=\(await requestShellContext\(6000\)\)\?\.browser\|\|null;/);
  assert.match(ui, /lastPageReadIssue="the browser pane did not answer in time"/);
  assert.match(ui, /if\(!shown&&lastPageReadIssue\) quote\.title=`Could not read a quote: \$\{lastPageReadIssue\}`;/);
});
