import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeQuoteHints, quoteFromPageText, symbolFromPageText } from "../src/ui/trading-logic.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
const shell = fs.readFileSync(path.join(root, "shell", "Program.cs"), "utf8").replace(/\r/g, "");

// The trading bar reads the ticker off the page the native browser pane is showing.
// The parsers are imported from src/ui/trading-logic.js above, so these cases run
// the shipped code. ui.html is still read below for the assertions that are
// genuinely about the page's markup and wiring.

test("the ticker is read from the visible page, not the URL", () => {
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

test("the page is the only price source — no second market feed", () => {
  // The market API was a second price that needed a Boolean account, 401'd, and
  // could disagree with the page by a cent. The bar reads the page or says so.
  assert.doesNotMatch(ui, /api\/markets\/quote\?symbol=/);
  assert.doesNotMatch(ui, /updateTradingBarQuote/);
  assert.doesNotMatch(ui, /sign in for live prices/);
  assert.match(ui, /const pageQuote=await readQuoteFromVisiblePage\(\);/);
  assert.match(ui, /"No quote"/);
});

test("Sync P&L is gone — it had no working data source", () => {
  // Robinhood exposes no realized-P&L-today scalar, so the button promised a
  // one-click sync that could never complete. record_trade_result still exists.
  assert.doesNotMatch(ui, /tbSync/);
  assert.doesNotMatch(ui, /sync_trade_pnl/);
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
  // Legend futures omit the dollar sign and prefix the contract with a slash.
  const future = quoteFromPageText("/MYMU26 53,418 ▲ 84 (0.16%) O 53428 H 53435 L 53413 C 53418 V 269.00");
  assert.equal(future.symbol, "/MYMU26");
  assert.equal(future.price, 53418);
  assert.equal(future.changePercent, 0.16);
  assert.equal(future.changeAbs, 84);
  // Windows OCR can put toolbar words between the contract and the live quote.
  const spacedFuture = quoteFromPageText("Stock trading /MYMU26 Search chart 53,429 ▲ 95 (0.18%) O 53407 H 53433 L 53395 C 53429 V 321.00");
  assert.equal(spacedFuture.symbol, "/MYMU26");
  assert.equal(spacedFuture.price, 53429);
  // When OCR misses the large quote label, Legend's C value is the page's
  // current price and remains a browser-only fallback.
  const ohlcFuture = quoteFromPageText("/MYMU26 Buy Sell Volume O 53407 H 53433 L 53395 C 53429 V 321.00");
  assert.equal(ohlcFuture.symbol, "/MYMU26");
  assert.equal(ohlcFuture.price, 53429);
  // Windows OCR can emit the headline before the symbol. It must beat a
  // historical candle C value that appears later in the same page read.
  const ocrFuture = quoteFromPageText("53,469 A 135 (0.25%)\nStock trading\nQ /MYMU26\nO 52379 H 52483 L 52364 C 52451 V 3446.00");
  assert.equal(ocrFuture.symbol, "/MYMU26");
  assert.equal(ocrFuture.price, 53469);
  assert.equal(ocrFuture.changePercent, 0.25);
  // A page with no quote must not invent one.
  assert.equal(quoteFromPageText("Robinhood Legend\nWatchlist"), null);
  assert.equal(quoteFromPageText(""), null);
});

test("Open broker always opens the Robinhood Legend workspace", () => {
  const start = ui.indexOf("async function openRobinhoodBrowser()");
  const end = ui.indexOf("\n  let aboutLoaded", start);
  const opener = ui.slice(start, end);
  assert.match(opener, /openUrlInBrowser\("https:\/\/robinhood\.com\/legend"\)/);
  assert.doesNotMatch(opener, /\/stocks\//);
});

test("an already-open browser is not replaced when one quote read fails", () => {
  assert.match(ui, /if\(SHELL&&emptyBrowser&&!browserOpen\(\)&&!tradingBrokerAutoOpened\)/);
});

test("the fast page read includes only the live quote strip OCR", () => {
  // Canvas-rendered Legend prices are absent from body.innerText. The shell
  // OCRs only the top quote strip and reserves full OCR as fallback.
  assert.match(ui, /hostPost\(\{type:"browser",cmd:"pageText",id\}\)/);
  assert.match(shell, /case "pageText":/);
  assert.match(shell, /async Task SendPageTextAsync\(string id\)/);
  assert.match(shell, /ReadVisibleBrowserQuoteOcrAsync/);
  assert.match(shell, /Accessibility\.getFullAXTree/);
  assert.match(shell, /ReadBrowserAccessibilityTextAsync/);
  assert.match(shell, /bool BrowserPaneIsOpen\(\) => !_split\.Panel2Collapsed && _browserPane\.Visible/);
  assert.match(shell, /var paneOpen = BrowserPaneIsOpen\(\);/);
  assert.match(shell, /Math\.Max\(180, source\.Height \/ 3\)/);
  // Ordered page text first, then the unordered hint block, then OCR. The
  // hints are a bounded React-state string table with no document order, so
  // "the first price after the symbol" is meaningless inside it.
  assert.match(ui, /const fastQuote=quoteFromPageText\(beforeQuoteHints\(page\?\.text\)\)\|\|quoteFromPageText\(page\?\.text\)\|\|quoteFromPageText\(page\?\.ocr\)/);
  assert.match(ui, /if\(!page\|\|!fastQuote\)\{\s*const visual=\(await requestShellContext\(10000\)\)/);
});

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
  // With the market feed gone the bar names only a pinned symbol; otherwise it
  // reports that the page has no quote rather than inventing a ticker.
  assert.doesNotMatch(ui, /lastTradingQuoteSymbol\|\|"AAPL"/);
  assert.match(ui, /\$\{pinnedTradingSymbol\} · no quote/);
  // An older shell or a canvas-rendered Legend quote uses the visual context.
  assert.match(ui, /if\(!page\|\|!fastQuote\)/);
  assert.match(ui, /requestShellContext\(10000\)/);
  assert.match(ui, /const textQuote=fastQuote\|\|quoteFromPageText\(beforeQuoteHints\(page\.text\)\)\|\|quoteFromPageText\(page\.text\);/);
  assert.match(ui, /const ocrQuote=quoteFromPageText\(page\.ocr\);/);
  assert.match(ui, /const quote=textQuote\|\|ocrQuote;/);
});

// The bar read $40.05 while the Legend header read $40.01. 40.05 was the OHLC
// strip's open, and the parser had taken "the first dollar amount within 400
// characters of the ticker" — which, once the shell's unordered hint block is
// in the text, can be almost anything.
test("the OHLC strip is not mistaken for the quote", () => {
  const page = "ENPH $40.01 ▲ $0.66 (1.69%) O 40.05 H 40.05 L 40.01 C 40.01 V 2899.00";
  const quote = quoteFromPageText(page);
  assert.equal(quote.symbol, "ENPH");
  assert.equal(quote.price, 40.01, "the header quote wins over the candle's open");
  assert.equal(quote.changePercent, 1.69);

  // Even with the OHLC strip rendered ahead of the header, the full headline
  // shape — price, change, percent — is what identifies the quote.
  const reordered = quoteFromPageText("O 40.05 H 40.05 L 40.01 C 40.01 V 2899.00 ENPH $40.01 ▲ $0.66 (1.69%)");
  assert.equal(reordered.price, 40.01);
});

test("the unordered DOM hint block is not searched for a price first", () => {
  const ui = fs.readFileSync(path.join(root, "src", "ui.html"), "utf8").replace(/\r/g, "");
  // The shell labels that block unordered on purpose; the quote reader has to
  // respect the label rather than treat it as more page text.
  assert.equal(
    beforeQuoteHints('GOOGL $371.99 ▲ $15.86 (4.45%)\nDOM quote hints: 99.99 1.00 2.00'),
    "GOOGL $371.99 ▲ $15.86 (4.45%)\n"
  );
  // A page with no hint block is passed through untouched.
  assert.equal(beforeQuoteHints("GOOGL $371.99"), "GOOGL $371.99");
  // The price inside the hint block must never win over the ordered headline.
  assert.equal(
    quoteFromPageText(beforeQuoteHints('GOOGL\n$371.99\n▲ $15.86 (4.45%)\nDOM quote hints: GOOGL $99.99')).price,
    371.99
  );
  // ui.html still has to actually call it before parsing.
  assert.match(ui, /const orderedText=beforeQuoteHints\(page\.text\);/);
});

test("the company name between ticker and price does not break the read", () => {
  // Legend renders "TSLA / Tesla / $322.93" — the ticker is not adjacent to the price.
  const tsla = quoteFromPageText("Futures chart Market hours Add widget Individual TSLA Tesla $322.93 ▲ $11.72 (3.77%) B $322.91 x 1 A $322.92 x 19 Buy Short");
  assert.equal(tsla.symbol, "TSLA");
  assert.equal(tsla.price, 322.93);
  assert.equal(tsla.changePercent, 3.77);
});

test("a page read that times out reports why", () => {
  // The context read runs OCR; 2.5s was too short and looked like "no symbol".
  assert.match(ui, /if\(!page\|\|!fastQuote\)/);
  assert.match(ui, /requestShellContext\(10000\)/);
  assert.match(ui, /lastPageReadIssue="the browser pane did not answer in time"/);
  assert.match(ui, /quote\.title=lastPageReadIssue\s*\?\s*`Could not read a quote: \$\{lastPageReadIssue\}`/);
});

test("the local quote poll is not frozen by chat work or its first promise", () => {
  assert.match(ui, /if\(document\.visibilityState!=="visible"\) return;/);
  assert.doesNotMatch(ui, /document\.visibilityState!=="visible" \|\| busy\(\)/);
  assert.match(ui, /tradingBarRefreshInFlight=call\.finally\(\(\)=>\{tradingBarRefreshInFlight=null;\}\)/);
});

test("trading consent stays local when UI preferences sync", () => {
  assert.match(ui, /Trading consent is device-local security state/);
  const payloadStart=ui.indexOf("function safeCloudUiPayload");
  const payloadEnd=ui.indexOf("async function applyCloudUiPayload",payloadStart);
  const payload=ui.slice(payloadStart,payloadEnd);
  assert.doesNotMatch(payload,/tradeConsentUser|tradeConsentAt|tradeClicks:value/);
  assert.match(ui,/const localPerms=\{\.\.\.\(state\.ui\?\.browserPerms\|\|\{\}\)\};/);
});
