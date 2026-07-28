import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseYahooChart, parseYahooNews, parseYahooScreener, parseYahooFundamentals,
  parseAlphaQuote, parseAlphaDaily, parseOccOptionSymbol, parseYahooOptions,
  parseAlpacaOptions, parseMassiveOptions, massiveConnectionError, buildTradeIdea, parseCftcSnapshot
} from "../src/markets.js";

test("Massive connection errors explain key, plan, and rate-limit failures", () => {
  assert.match(massiveConnectionError({ status: 401 }), /rejected this API key/i);
  assert.match(massiveConnectionError({ status: 403 }), /does not include Option Chain Snapshot access/i);
  assert.match(massiveConnectionError({ status: 429 }), /request limit was reached/i);
});

test("Yahoo chart payload becomes a normalized market snapshot", () => {
  const snapshot = parseYahooChart({
    chart: { result: [{
      meta: { symbol: "AAPL", regularMarketPrice: 201, chartPreviousClose: 198, currency: "USD" },
      timestamp: [100, 200],
      indicators: { quote: [{ close: [198, 201], high: [200, 202], low: [197, 199], volume: [10, 12] }] }
    }] }
  }, "AAPL");
  assert.equal(snapshot.symbol, "AAPL");
  assert.equal(snapshot.change, 3);
  assert.equal(snapshot.points.length, 2);
});

test("Alpha Vantage quote and daily history are normalized", () => {
  const quote = parseAlphaQuote({ "Global Quote": {
    "01. symbol": "IBM", "05. price": "250", "08. previous close": "248",
    "09. change": "2", "10. change percent": "0.8065%"
  } }, "IBM");
  const points = parseAlphaDaily({ "Time Series (Daily)": {
    "2026-07-26": { "1. open": "248", "2. high": "251", "3. low": "247", "4. close": "250", "5. volume": "100" }
  } }, "IBM");
  assert.equal(quote.price, 250);
  assert.equal(points[0].close, 250);
});

test("Yahoo news and market movers become compact dashboard data", () => {
  const news = parseYahooNews({ news: [{ title: "Apple update", publisher: "Reuters", link: "https://example.com/a", providerPublishTime: 123 }] });
  const movers = parseYahooScreener({ finance: { result: [{ quotes: [{ symbol: "XYZ", shortName: "Example", regularMarketPrice: 10, regularMarketChangePercent: 4.5 }] }] } });
  assert.equal(news[0].publisher, "Reuters");
  assert.equal(movers[0].changePercent, 4.5);
});

test("Yahoo annual fundamentals become a compact financial table", () => {
  const data = parseYahooFundamentals({ timeseries: { result: [{
    meta: { type: ["annualTotalRevenue"] },
    annualTotalRevenue: [{ asOfDate: "2025-09-30", reportedValue: { raw: 416161000000, fmt: "416.16B" } }]
  }] } });
  assert.deepEqual(data.years, ["2025"]);
  assert.equal(data.metrics[0].label, "Revenue");
  assert.equal(data.metrics[0].values["2025"].formatted, "416.16B");
});

test("OCC symbols and Yahoo option chains become normalized contracts", () => {
  assert.deepEqual(parseOccOptionSymbol("AAPL260918C00200000"), {
    symbol: "AAPL260918C00200000", underlying: "AAPL", expiration: "2026-09-18", side: "call", strike: 200
  });
  const chain = parseYahooOptions({ optionChain: { result: [{
    quote: { symbol: "AAPL", regularMarketPrice: 201 },
    expirationDates: [1789689600],
    options: [{ expirationDate: 1789689600, calls: [{
      contractSymbol: "AAPL260918C00200000", strike: 200, bid: 8, ask: 8.2,
      openInterest: 120, impliedVolatility: 0.25, expiration: 1789689600
    }], puts: [] }]
  }] } }, "AAPL");
  assert.equal(chain.contracts[0].side, "call");
  assert.equal(chain.contracts[0].strike, 200);
  assert.equal(chain.source, "Yahoo Finance (experimental)");
});

test("Alpaca and Massive option snapshots preserve freshness and Greeks", () => {
  const alpaca = parseAlpacaOptions({ snapshots: {
    AAPL260918P00200000: {
      latestQuote: { bp: 7.8, ap: 8.1, t: "2026-07-27T14:00:00Z" },
      greeks: { delta: -0.45 }, impliedVolatility: 0.3, openInterest: 90
    }
  } }, "AAPL", "indicative");
  assert.equal(alpaca.contracts[0].side, "put");
  assert.equal(alpaca.contracts[0].delta, -0.45);
  assert.equal(alpaca.delayed, true);

  const massive = parseMassiveOptions({ results: [{
    ticker: "O:AAPL260918C00200000",
    details: { expiration_date: "2026-09-18", contract_type: "call", strike_price: 200 },
    last_quote: { bid: 8, ask: 8.2, last_updated: Date.now() * 1e6 },
    greeks: { gamma: 0.02 }
  }] }, "AAPL");
  assert.equal(massive.contracts[0].gamma, 0.02);
  assert.equal(massive.expirations[0], "2026-09-18");
});

test("trade ideas calculate entry, stop, targets, and a directional score", () => {
  const points = Array.from({ length: 60 }, (_, index) => ({
    time: index,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index
  }));
  const idea = buildTradeIdea({ symbol: "TEST", name: "Test", price: 160, changePercent: 2, points, source: "fixture" });
  assert.equal(idea.direction, "Long");
  assert.ok(idea.stop < idea.entryLow);
  assert.ok(idea.target2 > idea.target1);
  assert.ok(idea.confidence >= 45);
});

test("CFTC rows become a compact weekly positioning snapshot", () => {
  const cot = parseCftcSnapshot([
    { report_date_as_yyyy_mm_dd: "2026-07-21", open_interest_all: "1000", asset_mgr_positions_long: "500", asset_mgr_positions_short: "200", lev_money_positions_long: "100", lev_money_positions_short: "300", dealer_positions_long_all: "250", dealer_positions_short_all: "350" },
    { report_date_as_yyyy_mm_dd: "2026-07-14", open_interest_all: "900", asset_mgr_positions_long: "450", asset_mgr_positions_short: "220", lev_money_positions_long: "110", lev_money_positions_short: "280", dealer_positions_long_all: "225", dealer_positions_short_all: "340" }
  ], "nasdaq");
  assert.equal(cot.assetManagerLong, 500);
  assert.equal(cot.assetManagerShort, 200);
  assert.equal(cot.assetManagerNet, 300);
  assert.equal(cot.assetManagerWeeklyChange, 70);
  assert.equal(cot.leveragedNet, -200);
  assert.equal(cot.dealerNet, -100);
  assert.equal(cot.dealerWeeklyChange, 15);
});

test("Markets workspace connects data, browser, notes, and API-key setup", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(ui, /id="marketsWorkspaceTab"[^>]*data-ws="markets"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(ui, /function marketsAccessAllowed\(\)/);
  assert.match(ui, /\["education","markets"\]\.includes\(ws\)&&!marketsAccessAllowed\(\)/);
  assert.match(ui, /Save snapshot to Notepad/);
  assert.match(ui, /Major market indexes|Major market indexes/i);
  assert.match(ui, /Market Movers/i);
  assert.match(ui, /News &amp; Filings/);
  assert.match(ui, /marketRanges/);
  assert.match(ui, /marketFinancials/);
  assert.match(ui, /marketDrivers/);
  assert.match(ui, /52-week range/);
  assert.match(ui, /finance\.yahoo\.com\/quote/);
  assert.match(ui, /insertPlainNoteText\(`Market snapshot/);
  assert.match(ui, /Alpha Vantage API key/);
  assert.match(ui, /Alpaca \(recommended\)/);
  assert.match(ui, /Massive \(OPRA plans\)/);
  assert.match(ui, /marketOptionExpiration/);
  assert.match(ui, /market-option-table/);
  assert.match(ui, /data-market-mode="ideas"/);
  assert.match(ui, /Discuss in Chat/);
  assert.match(ui, /Save to Notepad/);
  assert.match(ui, /COT Snapshot/);
  assert.match(ui, /marketScanUniverse/);
  assert.match(ui, /marketScanSetup/);
  assert.match(ui, /marketIdeaRanges/);
  assert.match(ui, /market-candle-up/);
  assert.match(ui, /market-cot-table/);
  assert.match(ui, /Top Sources/);
  assert.match(ui, /\.markets-shell\{[^}]*container-type:inline-size/);
  assert.match(ui, /@container\(max-width:610px\)/);
  assert.match(ui, /body\.markets-open \.market-intel\{ grid-column:3;/);
  assert.match(ui, /grid-template-columns:265px minmax\(380px,1fr\) 265px/);
  assert.match(ui, /width:max\(100%,680px\); height:max\(100%,520px\)/);
  assert.match(ui, /body\.markets-open \.markets-panel\{[^}]*overflow:auto/);
  assert.doesNotMatch(ui, /body\.markets-open \.market-intel\{ display:none;/);
  assert.match(ui, /:root:is\(\[data-theme="light"\],\[data-visual-theme="light"\]\) body\.markets-open \.markets-shell/);
  assert.match(ui, /--market-bg:var\(--approved-canvas\)/);
  assert.match(ui, /:root:is\(\[data-theme="dark"\],\[data-visual-theme="dark"\]\) body\.markets-open \.markets-shell/);
  assert.match(ui, /body\.markets-open \.markets-panel\{\s*background:var\(--approved-canvas\)/);
  assert.match(ui, /class="market-setup-group"/);
  assert.match(ui, /Keys stay on this PC/);
  assert.match(ui, /status\.textContent="✓ Connected and saved"/);
  assert.match(ui, /setTimeout\(\(\)=>\{[\s\S]*?\$\("marketSetup"\)\.classList\.remove\("open"\)/);
  assert.doesNotMatch(ui, /<nav class="market-terminal-nav"/);
  assert.doesNotMatch(ui, /\$\("marketNavSettings"\)/);
  assert.doesNotMatch(ui, /<aside class="market-(?:watch|intel)"/);
  assert.match(server, /\/api\/markets\/snapshot/);
  assert.match(server, /\/api\/markets\/dashboard/);
  assert.match(server, /\/api\/markets\/settings/);
  assert.match(server, /\/api\/markets\/options/);
  assert.match(server, /\/api\/markets\/trade-ideas/);
  assert.match(server, /\/api\/markets\/cot/);
  assert.match(server, /p\.startsWith\("\/api\/markets\/"\) && !marketAccessAllowed\(config\)/);
  assert.match(server, /Sign in to your Boollm account to use Markets\./);
});

test("Markets intelligence keeps drivers, context, and actions compact", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(ui, /body\.markets-open \.market-driver\{ padding:4px 0;/);
  assert.match(ui, /body\.markets-open \.market-driver b\{[\s\S]*?-webkit-line-clamp:2;/);
  assert.match(ui, /body\.markets-open \.market-context-list\{ margin:2px 0 0;[\s\S]*?line-height:1\.3;/);
  assert.match(ui, /body\.markets-open \.market-actions button\{ min-height:18px;/);
});

test("Monitor and Research Desk share the Earnings and Financials font scale", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(ui, /body\.markets-open \.market-financial-table,body\.markets-open \.market-news-table\{ font-size:7px;/);
  assert.match(ui, /body\.markets-open \.market-watch,[\s\S]*?body\.markets-open \.market-research-page\{ font-size:7px; \}/);
  assert.match(ui, /body\.markets-open \.market-watch-head,[\s\S]*?body\.markets-open \.market-idea-news-row time\{ font-size:7px!important; \}/);
});
