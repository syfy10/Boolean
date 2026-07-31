import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseYahooChart, parseYahooNews, parseYahooScreener, parseYahooFundamentals,
  parseAlphaQuote, parseAlphaDaily, parseOccOptionSymbol, parseYahooOptions,
  parseAlpacaOptions, parseMassiveOptions, massiveConnectionError, buildTradeIdea, parseCftcSnapshot,
  getSectorPerformance, runStrategyBacktest, BACKTEST_STRATEGIES
} from "../src/markets.js";

test("Strategy Lab exposes five understandable presets", () => {
  assert.deepEqual(BACKTEST_STRATEGIES.map((item) => item.key), [
    "buyHold", "movingAverage", "momentum", "meanReversion", "breakout"
  ]);
});

test("backtests use next-bar signals, include costs, and report benchmark risk", () => {
  const points = Array.from({ length: 90 }, (_, index) => ({
    time: Date.UTC(2026, 0, index + 1),
    close: index < 45 ? 100 + index : 145 - (index - 45) * .6
  }));
  const noCost = runStrategyBacktest({ symbol: "TEST", source: "Fixture", points }, {
    strategy: "movingAverage", fast: 5, slow: 15, costBps: 0
  });
  const withCost = runStrategyBacktest({ symbol: "TEST", source: "Fixture", points }, {
    strategy: "movingAverage", fast: 5, slow: 15, costBps: 25
  });
  assert.equal(noCost.symbol, "TEST");
  assert.ok(noCost.tradeCount >= 1);
  assert.ok(noCost.equityCurve.length === points.length);
  assert.ok(Number.isFinite(noCost.sharpe));
  assert.ok(noCost.maxDrawdown <= 0);
  assert.ok(withCost.endingEquity < noCost.endingEquity);
  assert.ok(Number.isFinite(noCost.benchmarkReturn));
});

test("backtests reject histories too short to be meaningful", () => {
  assert.throws(() => runStrategyBacktest({
    symbol: "SHORT",
    points: Array.from({ length: 10 }, (_, index) => ({ time: index + 1, close: 100 + index }))
  }), /At least 30/);
});

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

test("sector performance uses previous period-end closes for YTD and MTD", async () => {
  const realFetch=globalThis.fetch;
  const now=new Date(), year=now.getUTCFullYear(), month=now.getUTCMonth();
  const timestamps=[
    Date.UTC(year-1,11,31)/1000,
    Date.UTC(year,Math.max(0,month-1),28)/1000,
    Date.UTC(year,month,1)/1000,
    Date.UTC(year,month,15)/1000
  ];
  globalThis.fetch=async url=>({
    ok:true,
    text:async()=>JSON.stringify({chart:{result:[{
      meta:{symbol:decodeURIComponent(String(url).match(/chart\/([^?]+)/)?.[1]||"XLB"),regularMarketPrice:132,regularMarketPreviousClose:131},
      timestamp:timestamps,
      indicators:{quote:[{close:[100,120,125,132],open:[100,120,125,132],high:[100,120,125,132],low:[100,120,125,132],volume:[1,1,1,1]}]}
    }]}})
  });
  try{
    const result=await getSectorPerformance();
    assert.equal(result.sectors.length,11);
    assert.equal(result.sectors[0].symbol,"XLB");
    assert.equal(Math.round(result.sectors[0].ytd),32);
    assert.equal(Math.round(result.sectors[0].mtd),10);
  }finally{globalThis.fetch=realFetch;}
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
  const navStart=ui.indexOf('<div class="workspace-tabs" id="workspaceTabs">');
  const navEnd=ui.indexOf("</div>",navStart);
  const mainNav=ui.slice(navStart,navEnd);
  assert.doesNotMatch(mainNav, /id="exploreWorkspaceTab"|data-ws="explore"/);
  assert.match(ui, /id="exploreToggle"[^>]*aria-label="Toggle Explore"/);
  assert.doesNotMatch(mainNav, /data-ws="markets"|id="marketsWorkspaceTab"/);
  assert.match(ui, /function marketsAccessAllowed\(\)/);
  assert.match(ui, /\["education","markets"\]\.includes\(ws\)&&!marketsAccessAllowed\(\)/);
  assert.match(ui, /Save snapshot to Notepad/);
  assert.match(ui, /Major market indexes|Major market indexes/i);
  assert.match(ui, /id="marketSectors"[^>]*Sector year-to-date and month-to-date performance/);
  assert.match(ui, /YTD \$\{percent\(item\.ytd\)\}/);
  assert.match(ui, /MTD \$\{percent\(item\.mtd\)\}/);
  assert.match(server, /p === "\/api\/markets\/sectors"/);
  for(const symbol of ["XLB","XLC","XLE","XLF","XLI","XLK","XLP","XLRE","XLU","XLV","XLY"])assert.match(ui,new RegExp(`"${symbol}"`));
  assert.match(ui,/\/api\/markets\/snapshot\?symbol=\$\{symbol\}&range=1y/);
  assert.match(ui, /Market Movers/i);
  assert.match(ui, /Breaking News/);
  assert.doesNotMatch(ui, />News &amp; Filings</);
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
  assert.match(server, /Sign in to your Boolean account to use Markets\./);
});

test("Markets uses the selected flat floating-workspace layout", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(ui,/class="markets-shell market-flat"/);
  assert.match(ui,/\.workspace-float \.markets-shell\.market-flat\{[^}]*border:0;[^}]*border-radius:0;[^}]*box-shadow:none;/s);
  assert.match(ui,/\.workspace-float \.markets-shell\.market-flat\{[^}]*width:100%;[^}]*min-width:0;[^}]*overflow:hidden;/s);
  assert.match(ui,/\.markets-panel\{[^}]*overflow:auto;/s);
  const headerStart=ui.indexOf('<header class="markets-head">');
  const headerEnd=ui.indexOf("</header>",headerStart);
  const header=ui.slice(headerStart,headerEnd);
  assert.ok(headerStart>=0&&headerEnd>headerStart,"Markets should retain its flat page header");
  assert.doesNotMatch(header,/<h2>|Boolean Markets/);
  assert.doesNotMatch(header,/id="marketCommand"/);
  assert.doesNotMatch(header,/id="marketSource"|market-source-wrap|market-source-info/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-index\{[^}]*height:26px;[^}]*min-height:26px;[^}]*padding:1px 10px;/s);
  assert.match(ui,/\.workspace-float \.market-flat \.market-sector-strip\{[^}]*width:100%; min-width:0; min-height:58px;[^}]*grid-template-columns:repeat\(11,minmax\(0,1fr\)\);/s);
  assert.match(ui,/\.workspace-float \.market-flat \.market-sector-head b\{ font-size:10px; \}/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-sector-returns\{ grid-template-columns:1fr; gap:2px; margin-top:4px; \}/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-sector-return\{[^}]*grid-template-columns:27px minmax\(0,1fr\);[^}]*white-space:nowrap;/s);
  assert.match(ui,/\.workspace-float \.market-flat \.market-sector-return strong\{ font-size:10px; \}/);
  assert.match(ui,/data-sector-symbol="\$\{esc\(item\.symbol\)\}"/);
  assert.match(ui,/box\.querySelectorAll\("\[data-sector-symbol\]"\)\.forEach\(button=>button\.onclick=\(\)=>loadMarketSymbol\(button\.dataset\.sectorSymbol\)\)/);
  assert.match(ui,/marketState\.selectedSymbol=String\(symbol\|\|"AAPL"\)\.trim\(\)\.toUpperCase\(\);\s*renderMarketSectors\(\);/);
  assert.match(ui,/\.workspace-float\[data-workspace-theme="light"\] \.market-flat \.market-watch-row\.active\{[^}]*color:#172027!important; background:#fff2e8!important;/s);
  assert.match(ui,/\.workspace-float\[data-workspace-theme="light"\] \.market-flat \.market-watch-row:hover\{ background:#f1f5f7!important; \}/);
  assert.match(ui,/\.workspace-float\[data-workspace-theme="light"\] \.market-flat \.market-watch-row\.active:hover\{ background:#fff2e8!important; \}/);
  const toolsStart=ui.indexOf('<nav class="market-mode-tabs" id="marketModeTabs"');
  const toolsEnd=ui.indexOf("</nav>",toolsStart);
  const tools=ui.slice(toolsStart,toolsEnd);
  assert.ok(toolsStart>=0&&toolsEnd>toolsStart,"Markets should retain its Monitor and Research Desk row");
  let previous=-1;
  for(const token of ['data-market-mode="monitor"','data-market-mode="ideas"','id="marketCommand"']){
    const next=tools.indexOf(token);
    assert.ok(next>previous,`${token} should remain on the shared Markets tool row`);
    previous=next;
  }
  assert.match(tools,/class="market-search-box"/);
  assert.match(tools,/id="marketRefresh"/);
  assert.match(tools,/id="marketSettings"[^>]*aria-label="Market data settings"/);
  assert.doesNotMatch(tools,/id="marketSource"|Yahoo Finance \(experimental\)|delayed\/indicative/);
  assert.doesNotMatch(ui,/id="marketSource"/);
  assert.doesNotMatch(ui,/\$\("marketSource"\)\.textContent/,"removed provider copy must not leave a missing-element write behind");
  assert.match(ui,/\.workspace-float \.market-flat \.markets-grid\{ grid-template-columns:230px minmax\(380px,1fr\) 265px;/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-watch,[\s\S]*?\.workspace-float \.market-flat \.market-right-block\{[\s\S]*?background:var\(--approved-card,var\(--card\)\)!important;[\s\S]*?box-shadow:none!important;/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-chart-sentiment\{[^}]*grid-template-columns:1fr;/);
});

test("Markets retains the monitor, intelligence, and Research Desk feature set", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  for (const id of [
    "marketCommand","marketRefresh","marketSettings","marketSetup","marketSetupSave",
    "marketModeTabs","marketIndexes","marketWatchlist","marketAddSymbol","marketAddBtn","marketMoverTabs","marketMovers",
    "marketTitle","marketRanges","marketIndicators","marketChartType","marketChartFullscreen","marketChart",
    "marketSentimentGauge","marketSentimentComponents","marketSecurityTabs","marketFinancials",
    "marketHeadlines","marketAlertPrice","marketAiPrompt","marketAsk","marketAiSummary","marketDrivers",
    "marketSectorContext","marketBrowser","marketNews","marketNote","marketBottomTape","marketResearchPage",
    "marketScanReset","marketScanRefresh","marketScanUniverse","marketScanSetup","marketScanRank","marketScanCap",
    "marketScanVolatility","marketScanList","marketViewFullScanner","marketIdeaRanges","marketIdeaIndicators",
    "marketIdeaFullscreen","marketIdeaChart","marketPlanSetup","marketIdeaWhy","marketIdeaCatalysts","marketIdeaRisks",
    "marketIdeaNews","marketIdeaChat","marketIdeaBrowser","marketIdeaNote","marketCotCard","marketCotMarket","marketCotGrid"
  ]) assert.match(ui, new RegExp(`id="${id}"`), `${id} should remain in Markets`);
  assert.match(ui,/data-market-mode="monitor"/);
  assert.match(ui,/data-market-mode="ideas"/);
  assert.match(ui,/Discuss in Chat/);
  assert.match(ui,/Open (?:quote|sources) in Browser/);
  assert.match(ui,/Save to Notepad/);
  for (const id of [
    "marketModeTabs","marketMoverTabs","marketScanRefresh","marketScanReset","marketIdeaRanges",
    "marketIdeaIndicators","marketIdeaFullscreen","marketCotMarket","marketRefresh","marketCommand",
    "marketRanges","marketIndicators","marketChartType","marketChartFullscreen","marketSecurityTabs",
    "marketSettings","marketSetupSave","marketAddBtn","marketBrowser","marketNews","marketNote",
    "marketAsk","marketAiPrompt","marketIdeaBrowser","marketIdeaChat","marketIdeaNote"
  ]) assert.match(ui,new RegExp(`\\$\\("${id}"\\)\\.(?:onclick|onchange|onkeydown)=`),`${id} should keep its interaction binding`);
  assert.match(ui,/\["marketScanUniverse","marketScanSetup","marketScanRank","marketScanCap","marketScanVolatility"\]\.forEach\(id=>\$\(id\)\.onchange=renderTradeResearch\)/);
  assert.doesNotMatch(ui,/>News &amp; Filings</);
  assert.doesNotMatch(ui,/id="marketNewsTable"/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-lower-grid\{[^}]*grid-template-columns:1fr 1fr;/);
  assert.match(ui,/\.workspace-float \.market-flat \.market-mover-row \.mover-value\{[^}]*text-align:center;[^}]*font-size:9px!important;/);
});

test("Strategy Lab runs five local presets with benchmark metrics and saved reruns", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(ui,/data-market-mode="strategy">Strategy Lab/);
  for(const id of ["marketStrategyPage","strategySymbol","strategyPreset","strategyRange","strategyCapital","strategyCost","strategyRun","strategyMetrics","strategyChart","strategySave","strategySavedList"]){
    assert.match(ui,new RegExp(`id="${id}"`));
  }
  for(const preset of ["buyHold","movingAverage","momentum","meanReversion","breakout"]){
    assert.match(ui,new RegExp(`value="${preset}"`));
  }
  assert.match(ui,/Educational backtest only/);
  assert.match(ui,/This never places an order or connects to a broker/);
  assert.match(ui,/booleanMarketStrategies/);
  assert.match(ui,/Signals execute on the next observation/);
  assert.match(server,/POST" && p === "\/api\/markets\/backtest"/);
  assert.match(server,/runStrategyBacktest\(snapshot/);
});

test("Markets keeps the bottom ticker after both page bodies and in the final grid row", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const shellStart=ui.indexOf('<div class="markets-shell market-flat">');
  const monitorStart=ui.indexOf('<div class="markets-grid"',shellStart);
  const researchStart=ui.indexOf('id="marketResearchPage"',monitorStart);
  const tickerStart=ui.indexOf('id="marketBottomTape"',researchStart);
  const shellEnd=ui.indexOf("</section>",tickerStart);
  assert.ok(
    shellStart>=0&&monitorStart>shellStart&&researchStart>monitorStart&&tickerStart>researchStart&&shellEnd>tickerStart,
    "the ticker must stay after the Monitor and Research Desk content in the Markets shell"
  );
  assert.match(ui,/\.market-bottom-tape\{[^}]*grid-row:6;/s);
  assert.match(ui,/\.markets-shell\{[^}]*grid-template-rows:auto auto auto auto minmax\(0,1fr\) 24px;/s);
});

test("Markets shows a transparent local composite instead of an options card", () => {
  const ui = fs.readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  assert.match(ui, /\.workspace-float \.market-flat \.market-chart-sentiment\{[^}]*grid-template-columns:1fr;/);
  assert.match(ui, /Boolean Sentiment/);
  assert.match(ui, /Sentiment &amp; Sources/);
  assert.match(ui, /function marketCompositeSentiment\(\)/);
  assert.match(ui, /Price action/);
  assert.match(ui, /Price \+ volume/);
  assert.match(ui, /Boolean news tone/);
  assert.match(ui, /Filing fundamentals/);
  assert.match(ui, /Missing inputs are excluded and remaining weights are normalized/);
  assert.match(ui, /No social or crowd data/);
  assert.match(ui, /data-market-section="earnings"/);
  assert.match(ui, /finance\.yahoo\.com\/quote\/\$\{symbol\}\/analysis/);
  assert.match(ui, /finance\.yahoo\.com\/quote\/\$\{symbol\}\/history\/\?filter=div/);
  assert.match(ui, /finance\.yahoo\.com\/quote\/\$\{symbol\}\/holders/);
  assert.match(ui, /sec\.gov\/edgar\/search/);
  assert.match(ui, /nasdaq\.com\/market-activity\/stocks/);
  assert.match(ui, /market-sentiment-source-meta/);
  assert.match(ui, /role="link" tabindex="0"/);
  assert.doesNotMatch(ui, /<h3>Options Chain<\/h3>/);
  assert.doesNotMatch(ui, /<button id="marketOptionsTab"/);
  const loadSymbol = ui.slice(ui.indexOf("async function loadMarketSymbol"), ui.indexOf("function renderTradeIdeaChart"));
  assert.doesNotMatch(loadSymbol, /\/api\/markets\/options/);
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
