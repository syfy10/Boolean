// Market-data adapters for the Markets workspace.
// Yahoo is an experimental, keyless fallback. Alpha Vantage is the supported
// user-key path and can provide fresher data when the user's plan is entitled.

const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": "Boolean/0.9 markets workspace",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload?.error || payload?.message || payload?.status || "";
    const error = new Error(`Market data request failed (${response.status})${detail ? `: ${detail}` : "."}`);
    error.status = response.status;
    error.detail = String(detail || "");
    throw error;
  }
  return payload ?? {};
};

export function massiveConnectionError(error) {
  const status = Number(error?.status || 0);
  if (status === 401) return "Massive rejected this API key. Copy the key from your Massive dashboard and try again.";
  if (status === 403) return "Massive accepted the key, but this account does not include Option Chain Snapshot access. Choose an eligible Massive Options plan.";
  if (status === 429) return "Massive accepted the key, but its request limit was reached. Wait a moment and try again.";
  const detail = String(error?.detail || error?.message || "").trim();
  return detail ? `Massive could not connect: ${detail}` : "Massive could not connect. Check the key and options-plan access, then try again.";
}

const numberOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function parseYahooChart(payload, symbol) {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "Yahoo returned no market data.");
  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  const points = (result.timestamp || []).map((time, index) => ({
    time: Number(time) * 1000,
    open: numberOrNull(quote.open?.[index]),
    high: numberOrNull(quote.high?.[index]),
    low: numberOrNull(quote.low?.[index]),
    close: numberOrNull(adjusted[index] ?? quote.close?.[index]),
    volume: numberOrNull(quote.volume?.[index])
  })).filter((point) => point.close !== null);
  const price = numberOrNull(meta.regularMarketPrice ?? points.at(-1)?.close);
  // chartPreviousClose is the close immediately before the requested range
  // (six months ago here), not yesterday's close. Prefer Yahoo's explicit
  // daily field and otherwise use the preceding daily candle.
  const previousClose = numberOrNull(
    meta.regularMarketPreviousClose ??
    meta.previousClose ??
    points.at(-2)?.close ??
    meta.chartPreviousClose
  );
  const change = price !== null && previousClose !== null ? price - previousClose : null;
  const changePercent = change !== null && previousClose ? change / previousClose * 100 : null;
  return {
    source: "Yahoo Finance (experimental)",
    delayed: true,
    symbol: String(meta.symbol || symbol).toUpperCase(),
    name: meta.longName || meta.shortName || String(symbol).toUpperCase(),
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    price,
    previousClose,
    change,
    changePercent,
    marketState: meta.marketState || "",
    open: numberOrNull(meta.regularMarketOpen ?? points.at(-1)?.open),
    dayHigh: numberOrNull(meta.regularMarketDayHigh),
    dayLow: numberOrNull(meta.regularMarketDayLow),
    fiftyTwoWeekHigh: numberOrNull(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: numberOrNull(meta.fiftyTwoWeekLow),
    volume: numberOrNull(meta.regularMarketVolume),
    marketCap: numberOrNull(meta.marketCap),
    timezone: meta.exchangeTimezoneName || meta.timezone || "",
    points
  };
}

export function parseYahooFundamentals(payload) {
  const rows = payload?.timeseries?.result || [];
  const labels = {
    annualTotalRevenue: "Revenue",
    annualGrossProfit: "Gross profit",
    annualOperatingIncome: "Operating income",
    annualNetIncome: "Net income",
    annualDilutedEPS: "EPS (diluted)",
    annualFreeCashFlow: "Free cash flow"
  };
  const metrics = [];
  const years = new Set();
  for (const row of rows) {
    const type = row?.meta?.type?.[0];
    if (!labels[type] || !Array.isArray(row[type])) continue;
    const values = {};
    for (const item of row[type]) {
      const year = String(item.asOfDate || "").slice(0, 4);
      if (!year) continue;
      years.add(year);
      values[year] = {
        raw: numberOrNull(item.reportedValue?.raw),
        formatted: String(item.reportedValue?.fmt || "")
      };
    }
    metrics.push({ key: type, label: labels[type], values });
  }
  return { years: [...years].sort().slice(-4), metrics };
}

export function parseYahooNews(payload) {
  return (payload?.news || []).slice(0, 8).map((item) => ({
    title: String(item.title || "").trim(),
    publisher: String(item.publisher || "").trim(),
    url: String(item.link || "").trim(),
    publishedAt: Number(item.providerPublishTime || 0) * 1000,
    thumbnail: item.thumbnail?.resolutions?.[0]?.url || ""
  })).filter((item) => item.title && /^https?:\/\//i.test(item.url));
}

export function parseYahooScreener(payload) {
  const quotes = payload?.finance?.result?.[0]?.quotes || [];
  return quotes.slice(0, 8).map((quote) => ({
    symbol: String(quote.symbol || "").toUpperCase(),
    name: quote.shortName || quote.longName || quote.symbol || "",
    price: numberOrNull(quote.regularMarketPrice),
    change: numberOrNull(quote.regularMarketChange),
    changePercent: numberOrNull(quote.regularMarketChangePercent),
    volume: numberOrNull(quote.regularMarketVolume),
    marketCap: numberOrNull(quote.marketCap),
    exchange: String(quote.fullExchangeName || quote.exchange || ""),
    sector: String(quote.sector || ""),
    industry: String(quote.industry || "")
  })).filter((quote) => quote.symbol);
}

const optionSide = (value) => String(value || "").toLowerCase().startsWith("p") ? "put" : "call";

export function parseOccOptionSymbol(symbol) {
  const value = String(symbol || "").replace(/^O:/, "").trim();
  const match = value.match(/^([A-Z0-9.]{1,6})\s*(\d{6})([CP])(\d{8})$/i);
  if (!match) return { symbol: value, underlying: "", expiration: "", side: "", strike: null };
  const [, underlying, date, side, strike] = match;
  const year = 2000 + Number(date.slice(0, 2));
  return {
    symbol: value,
    underlying: underlying.toUpperCase(),
    expiration: `${year}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    side: side.toUpperCase() === "P" ? "put" : "call",
    strike: Number(strike) / 1000
  };
}

const normalizedOption = (row = {}) => ({
  symbol: String(row.symbol || ""),
  underlying: String(row.underlying || "").toUpperCase(),
  expiration: String(row.expiration || ""),
  side: optionSide(row.side),
  strike: numberOrNull(row.strike),
  bid: numberOrNull(row.bid),
  ask: numberOrNull(row.ask),
  last: numberOrNull(row.last),
  volume: numberOrNull(row.volume),
  openInterest: numberOrNull(row.openInterest),
  impliedVolatility: numberOrNull(row.impliedVolatility),
  delta: numberOrNull(row.delta),
  gamma: numberOrNull(row.gamma),
  theta: numberOrNull(row.theta),
  vega: numberOrNull(row.vega),
  updatedAt: numberOrNull(row.updatedAt)
});

export function parseYahooOptions(payload, requestedSymbol = "") {
  const result = payload?.optionChain?.result?.[0];
  if (!result) throw new Error(payload?.optionChain?.error?.description || "Yahoo returned no options chain.");
  const rows = [];
  for (const expiration of result.options || []) {
    for (const [side, contracts] of [["call", expiration.calls], ["put", expiration.puts]]) {
      for (const contract of contracts || []) rows.push(normalizedOption({
        symbol: contract.contractSymbol,
        underlying: result.quote?.symbol || requestedSymbol,
        expiration: new Date(Number(contract.expiration || expiration.expirationDate) * 1000).toISOString().slice(0, 10),
        side,
        strike: contract.strike,
        bid: contract.bid,
        ask: contract.ask,
        last: contract.lastPrice,
        volume: contract.volume,
        openInterest: contract.openInterest,
        impliedVolatility: contract.impliedVolatility,
        updatedAt: Number(contract.lastTradeDate || 0) * 1000
      }));
    }
  }
  return {
    source: "Yahoo Finance (experimental)",
    feed: "delayed",
    delayed: true,
    underlyingPrice: numberOrNull(result.quote?.regularMarketPrice),
    expirations: (result.expirationDates || []).map((value) => new Date(Number(value) * 1000).toISOString().slice(0, 10)),
    contracts: rows
  };
}

export function parseAlpacaOptions(payload, requestedSymbol = "", feed = "indicative") {
  const rows = [];
  for (const [symbol, item] of Object.entries(payload?.snapshots || {})) {
    const details = parseOccOptionSymbol(symbol);
    rows.push(normalizedOption({
      symbol, underlying: details.underlying || requestedSymbol, expiration: details.expiration,
      side: details.side, strike: details.strike,
      bid: item.latestQuote?.bp, ask: item.latestQuote?.ap, last: item.latestTrade?.p,
      volume: item.dailyBar?.v, openInterest: item.openInterest,
      impliedVolatility: item.impliedVolatility,
      delta: item.greeks?.delta, gamma: item.greeks?.gamma,
      theta: item.greeks?.theta, vega: item.greeks?.vega,
      updatedAt: Date.parse(item.latestQuote?.t || item.latestTrade?.t || "")
    }));
  }
  const expirations = [...new Set(rows.map((row) => row.expiration).filter(Boolean))].sort();
  return {
    source: "Alpaca",
    feed: feed === "opra" ? "real-time OPRA" : "indicative · trades delayed 15 min",
    delayed: feed !== "opra",
    underlyingPrice: null,
    expirations,
    contracts: rows
  };
}

export function parseMassiveOptions(payload, requestedSymbol = "") {
  const rows = (payload?.results || []).map((item) => normalizedOption({
    symbol: item.ticker,
    underlying: item.underlying_asset?.ticker || requestedSymbol,
    expiration: item.details?.expiration_date,
    side: item.details?.contract_type,
    strike: item.details?.strike_price,
    bid: item.last_quote?.bid, ask: item.last_quote?.ask, last: item.last_trade?.price,
    volume: item.session?.volume, openInterest: item.open_interest,
    impliedVolatility: item.implied_volatility,
    delta: item.greeks?.delta, gamma: item.greeks?.gamma,
    theta: item.greeks?.theta, vega: item.greeks?.vega,
    updatedAt: Number(item.last_quote?.last_updated || item.last_trade?.sip_timestamp || 0) / 1e6
  }));
  return {
    source: "Massive",
    feed: rows.some((row) => row.updatedAt && Date.now() - row.updatedAt < 120_000) ? "real-time OPRA" : "plan-dependent",
    delayed: false,
    underlyingPrice: numberOrNull(payload?.results?.[0]?.underlying_asset?.price),
    expirations: [...new Set(rows.map((row) => row.expiration).filter(Boolean))].sort(),
    contracts: rows
  };
}

export async function getOptionsChain(settings, symbol = "AAPL", requestedExpiration = "") {
  const safeSymbol = String(symbol || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 12);
  if (!safeSymbol) throw new Error("Enter a valid underlying symbol.");
  const provider = settings?.optionsProvider || "alpaca";
  let chain;
  if (provider === "alpaca" && settings?.alpacaKeyId && settings?.alpacaSecretKey) {
    const feed = settings.optionsFeed === "opra" ? "opra" : "indicative";
    const payload = await jsonFetch(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(safeSymbol)}?feed=${feed}&limit=1000`, {
      headers: {
        "APCA-API-KEY-ID": settings.alpacaKeyId,
        "APCA-API-SECRET-KEY": settings.alpacaSecretKey
      }
    });
    chain = parseAlpacaOptions(payload, safeSymbol, feed);
  } else if (provider === "massive" && settings?.massiveApiKey) {
    try {
      const payload = await jsonFetch(`https://api.massive.com/v3/snapshot/options/${encodeURIComponent(safeSymbol)}?limit=250`, {
        headers: { authorization: `Bearer ${String(settings.massiveApiKey).trim()}` }
      });
      chain = parseMassiveOptions(payload, safeSymbol);
    } catch (error) {
      throw new Error(massiveConnectionError(error));
    }
  } else {
    const suffix = requestedExpiration ? `?date=${Math.floor(Date.parse(`${requestedExpiration}T12:00:00Z`) / 1000)}` : "";
    const payload = await jsonFetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(safeSymbol)}${suffix}`);
    chain = parseYahooOptions(payload, safeSymbol);
    chain.fallback = provider === "alpaca" ? "Connect a free Alpaca account for a supported indicative feed." : "";
  }
  const expiration = requestedExpiration && chain.expirations.includes(requestedExpiration)
    ? requestedExpiration
    : (chain.expirations[0] || "");
  return {
    ...chain,
    provider,
    symbol: safeSymbol,
    selectedExpiration: expiration,
    contracts: expiration ? chain.contracts.filter((row) => row.expiration === expiration) : chain.contracts
  };
}

export function parseAlphaQuote(payload, symbol) {
  const quote = payload?.["Global Quote"] || {};
  if (payload?.Note || payload?.Information) throw new Error(payload.Note || payload.Information);
  if (!Object.keys(quote).length) throw new Error("Alpha Vantage returned no quote for this symbol.");
  const changePercent = numberOrNull(String(quote["10. change percent"] || "").replace("%", ""));
  return {
    source: "Alpha Vantage",
    delayed: true,
    symbol: String(quote["01. symbol"] || symbol).toUpperCase(),
    name: String(quote["01. symbol"] || symbol).toUpperCase(),
    currency: "USD",
    exchange: "",
    price: numberOrNull(quote["05. price"]),
    previousClose: numberOrNull(quote["08. previous close"]),
    change: numberOrNull(quote["09. change"]),
    changePercent,
    marketState: "",
    volume: numberOrNull(quote["06. volume"]),
    latestTradingDay: quote["07. latest trading day"] || "",
    points: []
  };
}

export function parseAlphaDaily(payload, symbol) {
  if (payload?.Note || payload?.Information) throw new Error(payload.Note || payload.Information);
  const series = payload?.["Time Series (Daily)"];
  if (!series) throw new Error("Alpha Vantage returned no daily history for this symbol.");
  return Object.entries(series).map(([date, row]) => ({
    time: Date.parse(`${date}T00:00:00Z`),
    open: numberOrNull(row["1. open"]),
    high: numberOrNull(row["2. high"]),
    low: numberOrNull(row["3. low"]),
    close: numberOrNull(row["4. close"]),
    volume: numberOrNull(row["5. volume"])
  })).filter((point) => point.close !== null).sort((a, b) => a.time - b.time);
}

export async function getMarketSnapshot(settings, symbol, requestedRange = "6mo") {
  const safeSymbol = String(symbol || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "").slice(0, 24);
  if (!safeSymbol) throw new Error("Enter a valid market symbol.");
  if (settings?.provider === "alphaVantage" && settings.apiKey) {
    const key = encodeURIComponent(settings.apiKey);
    const encoded = encodeURIComponent(safeSymbol);
    const [quotePayload, dailyPayload] = await Promise.all([
      jsonFetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encoded}&apikey=${key}`),
      jsonFetch(`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encoded}&outputsize=compact&apikey=${key}`)
    ]);
    return { ...parseAlphaQuote(quotePayload, safeSymbol), points: parseAlphaDaily(dailyPayload, safeSymbol) };
  }
  const encoded = encodeURIComponent(safeSymbol);
  const rangeMap = {
    "1d": ["1d", "5m"],
    "5d": ["5d", "15m"],
    "1mo": ["1mo", "1h"],
    "3mo": ["3mo", "1d"],
    "6mo": ["6mo", "1d"],
    ytd: ["ytd", "1d"],
    "1y": ["1y", "1d"],
    "5y": ["5y", "1wk"],
    max: ["max", "1mo"]
  };
  const [range, interval] = rangeMap[String(requestedRange || "").toLowerCase()] || rangeMap["6mo"];
  const payload = await jsonFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=${range}&interval=${interval}&events=div%2Csplits`);
  return parseYahooChart(payload, safeSymbol);
}

const SECTOR_ETFS = [
  ["XLB", "Materials"], ["XLC", "Communication"], ["XLE", "Energy"],
  ["XLF", "Financials"], ["XLI", "Industrials"], ["XLK", "Technology"],
  ["XLP", "Consumer Staples"], ["XLRE", "Real Estate"], ["XLU", "Utilities"],
  ["XLV", "Health Care"], ["XLY", "Consumer Discretionary"]
];

const periodReturn = (points, startTime, latestClose) => {
  const valid = points.filter((point) => Number.isFinite(point.time) && Number.isFinite(Number(point.close)));
  const before = valid.filter((point) => point.time < startTime).at(-1);
  const baseline = Number(before?.close ?? valid.find((point) => point.time >= startTime)?.close);
  return Number.isFinite(baseline) && baseline !== 0 && Number.isFinite(latestClose)
    ? (latestClose / baseline - 1) * 100
    : null;
};

export async function getSectorPerformance() {
  const now = new Date();
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const results = await Promise.allSettled(
    SECTOR_ETFS.map(([symbol]) => getMarketSnapshot({ provider: "yahoo" }, symbol, "1y"))
  );
  return {
    source: "Yahoo Finance (experimental)",
    delayed: true,
    asOf: Date.now(),
    sectors: results.map((result, index) => {
      const [symbol, name] = SECTOR_ETFS[index];
      if (result.status !== "fulfilled") return { symbol, name, ytd: null, mtd: null };
      const points = result.value.points || [];
      const latest = Number(points.at(-1)?.close ?? result.value.price);
      return {
        symbol, name,
        ytd: periodReturn(points, yearStart, latest),
        mtd: periodReturn(points, monthStart, latest)
      };
    })
  };
}

export async function getMarketDashboard(settings, symbol = "AAPL") {
  const safeSymbol = String(symbol || "AAPL").trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "").slice(0, 24) || "AAPL";
  const indexSymbols = ["^GSPC", "^DJI", "^IXIC", "^RUT", "^VIX"];
  const watchSymbols = [...new Set((Array.isArray(settings?.watchlist) ? settings.watchlist : ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"])
    .map((item) => String(item || "").trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "").slice(0, 24))
    .filter(Boolean)
    .slice(0, 10))];
  const quoteSymbols = [...indexSymbols, ...watchSymbols.filter((item) => !indexSymbols.includes(item))];
  const quoteResults = await Promise.allSettled(quoteSymbols.map((item) => getMarketSnapshot({ provider: "yahoo" }, item)));
  const quoteMap = new Map();
  quoteResults.forEach((result, index) => {
    if (result.status === "fulfilled") quoteMap.set(quoteSymbols[index], result.value);
  });
  const indexes = indexSymbols.flatMap((index) => quoteMap.has(index) ? [{
    symbol: quoteMap.get(index).symbol,
    name: quoteMap.get(index).name,
    price: quoteMap.get(index).price,
    change: quoteMap.get(index).change,
    changePercent: quoteMap.get(index).changePercent
  }] : []);
  const watchlist = watchSymbols.flatMap((item) => quoteMap.has(item) ? [{
    symbol: quoteMap.get(item).symbol,
    name: quoteMap.get(item).name,
    price: quoteMap.get(item).price,
    change: quoteMap.get(item).change,
    changePercent: quoteMap.get(item).changePercent,
    currency: quoteMap.get(item).currency
  }] : []);
  const encoded = encodeURIComponent(safeSymbol);
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (6 * 366 * 24 * 60 * 60);
  const fundamentalTypes = "annualTotalRevenue,annualGrossProfit,annualOperatingIncome,annualNetIncome,annualDilutedEPS,annualFreeCashFlow";
  const [newsResult, gainersResult, losersResult, activeResult, fundamentalsResult] = await Promise.allSettled([
    jsonFetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encoded}&quotesCount=1&newsCount=8`),
    jsonFetch("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=6&scrIds=day_gainers"),
    jsonFetch("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=6&scrIds=day_losers"),
    jsonFetch("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=6&scrIds=most_actives"),
    jsonFetch(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encoded}?symbol=${encoded}&type=${fundamentalTypes}&period1=${period1}&period2=${period2}`)
  ]);
  return {
    source: "Yahoo Finance (experimental)",
    delayed: true,
    indexes,
    watchlist,
    news: newsResult.status === "fulfilled" ? parseYahooNews(newsResult.value) : [],
    fundamentals: fundamentalsResult.status === "fulfilled" ? parseYahooFundamentals(fundamentalsResult.value) : { years: [], metrics: [] },
    movers: {
      gainers: gainersResult.status === "fulfilled" ? parseYahooScreener(gainersResult.value) : [],
      losers: losersResult.status === "fulfilled" ? parseYahooScreener(losersResult.value) : [],
      active: activeResult.status === "fulfilled" ? parseYahooScreener(activeResult.value) : []
    }
  };
}

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function buildTradeIdea(snapshot) {
  const points = (snapshot?.points || []).filter((point) =>
    ["open", "high", "low", "close"].every((key) => Number.isFinite(Number(point[key])))
  ).slice(-90);
  if (points.length < 12) throw new Error("Not enough price history to build a trade idea.");
  const closes = points.map((point) => Number(point.close));
  const latest = points.at(-1);
  const ema = (period) => {
    const multiplier = 2 / (period + 1);
    return closes.reduce((value, close, index) => index ? (close - value) * multiplier + value : close, closes[0]);
  };
  const trueRanges = points.slice(1).map((point, index) => Math.max(
    Number(point.high) - Number(point.low),
    Math.abs(Number(point.high) - Number(points[index].close)),
    Math.abs(Number(point.low) - Number(points[index].close))
  ));
  const atr = average(trueRanges.slice(-14)) || Math.max(.01, Number(latest.high) - Number(latest.low));
  const ema20 = ema(20);
  const ema50 = ema(Math.min(50, closes.length));
  const direction = Number(latest.close) >= ema20 && ema20 >= ema50 ? "Long" : "Short";
  const price = Number(snapshot?.price ?? latest.close);
  const entryLow = direction === "Long" ? price - atr * .18 : price - atr * .08;
  const entryHigh = direction === "Long" ? price + atr * .12 : price + atr * .22;
  const stop = direction === "Long" ? price - atr * 1.35 : price + atr * 1.35;
  const risk = Math.max(.01, Math.abs(price - stop));
  const target1 = direction === "Long" ? price + risk * 1.6 : price - risk * 1.6;
  const target2 = direction === "Long" ? price + risk * 2.5 : price - risk * 2.5;
  const twentyDayHigh = Math.max(...points.slice(-20).map((point) => Number(point.high)));
  const twentyDayLow = Math.min(...points.slice(-20).map((point) => Number(point.low)));
  const changePercent = numberOrNull(snapshot?.changePercent) || 0;
  const trendScore = direction === "Long"
    ? Math.min(99, Math.round(58 + Math.max(0, (price / ema20 - 1) * 450) + Math.max(0, changePercent) * 2))
    : Math.min(99, Math.round(58 + Math.max(0, (ema20 / price - 1) * 450) + Math.max(0, -changePercent) * 2));
  return {
    symbol: snapshot.symbol,
    name: snapshot.name,
    direction,
    setup: direction === "Long" ? "Momentum continuation" : "Weakness continuation",
    confidence: Math.max(45, trendScore),
    price,
    changePercent,
    entryLow,
    entryHigh,
    stop,
    target1,
    target2,
    riskReward: 2.5,
    atr,
    ema20,
    ema50,
    twentyDayHigh,
    twentyDayLow,
    rationale: direction === "Long"
      ? `Price is holding above the 20- and 50-period trend measures. Look for continuation only while ${snapshot.symbol} remains above the stop.`
      : `Price is below its short- and medium-term trend measures. Treat the setup as bearish only while ${snapshot.symbol} remains below the stop.`,
    source: snapshot.source,
    delayed: !!snapshot.delayed,
    generatedAt: Date.now()
  };
}

export const BACKTEST_STRATEGIES = Object.freeze([
  { key: "buyHold", name: "Buy & Hold", description: "Own the symbol for the full test period." },
  { key: "movingAverage", name: "Moving-average crossover", description: "Own while the fast average is above the slow average." },
  { key: "momentum", name: "Momentum", description: "Own while price is above its lookback close." },
  { key: "meanReversion", name: "Mean reversion", description: "Buy statistically weak closes and exit near the mean." },
  { key: "breakout", name: "Breakout", description: "Buy a new lookback high and exit below the lookback low." }
]);

export function runStrategyBacktest(snapshot, options = {}) {
  const points = (snapshot?.points || [])
    .map((point) => ({ ...point, time: Number(point.time), close: Number(point.close) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
    .sort((a, b) => a.time - b.time);
  if (points.length < 30) throw new Error("At least 30 price observations are required for a backtest.");

  const strategy = BACKTEST_STRATEGIES.find((item) => item.key === options.strategy)?.key || "movingAverage";
  const startingCapital = Math.max(1, Number(options.startingCapital) || 10_000);
  const costRate = Math.max(0, Number(options.costBps) || 0) / 10_000;
  const fast = Math.max(2, Math.round(Number(options.fast) || 20));
  const slow = Math.max(fast + 1, Math.round(Number(options.slow) || 50));
  const lookback = Math.max(5, Math.round(Number(options.lookback) || 20));
  const zEntry = Math.max(.25, Number(options.zEntry) || 1);
  const closes = points.map((point) => point.close);
  const positions = new Array(points.length).fill(0);
  const averageAt = (index, period) => {
    if (index + 1 < period) return null;
    const values = closes.slice(index + 1 - period, index + 1);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  let held = strategy === "buyHold" ? 1 : 0;
  for (let index = 0; index < points.length; index += 1) {
    if (strategy === "movingAverage") {
      const fastAverage = averageAt(index, fast);
      const slowAverage = averageAt(index, slow);
      if (fastAverage !== null && slowAverage !== null) held = fastAverage > slowAverage ? 1 : 0;
    } else if (strategy === "momentum" && index >= lookback) {
      held = closes[index] > closes[index - lookback] ? 1 : 0;
    } else if (strategy === "meanReversion" && index + 1 >= lookback) {
      const values = closes.slice(index + 1 - lookback, index + 1);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      const deviation = Math.sqrt(variance);
      const zScore = deviation ? (closes[index] - mean) / deviation : 0;
      if (!held && zScore <= -zEntry) held = 1;
      else if (held && zScore >= 0) held = 0;
    } else if (strategy === "breakout" && index >= lookback) {
      const prior = closes.slice(index - lookback, index);
      if (!held && closes[index] > Math.max(...prior)) held = 1;
      else if (held && closes[index] < Math.min(...prior)) held = 0;
    }
    positions[index] = held;
  }

  let equity = startingCapital;
  let benchmark = startingCapital;
  let previousPosition = 0;
  let tradeEntry = null;
  const returns = [];
  const closedTradeReturns = [];
  const trades = [];
  const equityCurve = [{ time: points[0].time, equity, benchmark }];
  for (let index = 1; index < points.length; index += 1) {
    const position = positions[index - 1];
    const priceReturn = closes[index] / closes[index - 1] - 1;
    const changed = position !== previousPosition;
    const strategyReturn = position * priceReturn - (changed ? costRate : 0);
    equity *= 1 + strategyReturn;
    benchmark *= 1 + priceReturn;
    returns.push(strategyReturn);
    if (changed) {
      const side = position ? "Buy" : "Sell";
      trades.push({ time: points[index].time, side, price: closes[index] });
      if (position) tradeEntry = closes[index] * (1 + costRate);
      else if (tradeEntry) {
        closedTradeReturns.push((closes[index] * (1 - costRate)) / tradeEntry - 1);
        tradeEntry = null;
      }
    }
    previousPosition = position;
    equityCurve.push({ time: points[index].time, equity, benchmark });
  }
  if (previousPosition && tradeEntry) closedTradeReturns.push(closes.at(-1) / tradeEntry - 1);

  const timeScale = points[1].time > 10_000_000_000 ? 1 : 1000;
  const intervals = points.slice(1).map((point, index) => (point.time - points[index].time) * timeScale / 86_400_000);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const medianDays = sortedIntervals[Math.floor(sortedIntervals.length / 2)] || 1;
  const periodsPerYear = medianDays > 20 ? 12 : medianDays > 3 ? 52 : 252;
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / Math.max(1, returns.length - 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(periodsPerYear);
  const years = Math.max(1 / periodsPerYear, returns.length / periodsPerYear);
  let peak = startingCapital;
  let maxDrawdown = 0;
  equityCurve.forEach((point) => {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.min(maxDrawdown, point.equity / peak - 1);
  });
  const label = BACKTEST_STRATEGIES.find((item) => item.key === strategy);
  return {
    strategy,
    strategyName: label.name,
    strategyDescription: label.description,
    symbol: String(snapshot?.symbol || options.symbol || "").toUpperCase(),
    source: snapshot?.source || "",
    delayed: !!snapshot?.delayed,
    startingCapital,
    endingEquity: equity,
    totalReturn: (equity / startingCapital - 1) * 100,
    benchmarkReturn: (benchmark / startingCapital - 1) * 100,
    annualizedReturn: ((equity / startingCapital) ** (1 / years) - 1) * 100,
    volatility: volatility * 100,
    sharpe: volatility ? meanReturn * periodsPerYear / volatility : 0,
    maxDrawdown: maxDrawdown * 100,
    winRate: closedTradeReturns.length ? closedTradeReturns.filter((value) => value > 0).length / closedTradeReturns.length * 100 : 0,
    tradeCount: trades.filter((trade) => trade.side === "Buy").length,
    exposure: positions.reduce((sum, value) => sum + value, 0) / positions.length * 100,
    startTime: points[0].time,
    endTime: points.at(-1).time,
    observationCount: points.length,
    equityCurve,
    trades
  };
}

export async function getTradeIdeas(settings, symbol = "AAPL") {
  const dashboard = await getMarketDashboard(settings, symbol);
  const candidates = [...(dashboard.movers?.gainers || []), ...(dashboard.movers?.active || [])]
    .filter((item, index, rows) => item.symbol && rows.findIndex((row) => row.symbol === item.symbol) === index)
    .slice(0, 8);
  const selected = await getMarketSnapshot(settings, symbol, "6mo");
  const idea = buildTradeIdea(selected);
  const selectedCandidate = candidates.find((item) => item.symbol === selected.symbol);
  const profile = {
    exchange: selected.exchange || "",
    sector: selectedCandidate?.sector || "",
    industry: selectedCandidate?.industry || "",
    marketCap: selected.marketCap,
    volume: selected.volume,
    dayHigh: selected.dayHigh,
    dayLow: selected.dayLow,
    previousClose: selected.previousClose
  };
  return {
    source: dashboard.source,
    delayed: dashboard.delayed,
    idea,
    profile,
    candidates: candidates.map((item) => ({
      ...item,
      direction: Number(item.changePercent) >= 0 ? "Long" : "Short",
      score: Math.max(35, Math.min(99, Math.round(55 + Math.abs(Number(item.changePercent) || 0) * 5))),
      setup: Number(item.changePercent) >= 3 ? "Breakout" : Number(item.changePercent) >= 0 ? "Bullish pullback" : "Bearish momentum"
    })),
    news: dashboard.news || []
  };
}

const CFTC_MARKETS = {
  sp500: { dataset: "gpe5-46if", market: "S&P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE" },
  nasdaq: { dataset: "gpe5-46if", market: "NASDAQ-100 Consolidated - CHICAGO MERCANTILE EXCHANGE" },
  dow: { dataset: "gpe5-46if", market: "DJIA Consolidated - CHICAGO BOARD OF TRADE" },
  russell: { dataset: "gpe5-46if", market: "RUSSELL E-MINI - CHICAGO MERCANTILE EXCHANGE" }
};

export function parseCftcSnapshot(rows = [], marketKey = "nasdaq") {
  const normalized = rows.slice(0, 12).map((row) => {
    const assetLong = numberOrNull(row.asset_mgr_positions_long) || 0;
    const assetShort = numberOrNull(row.asset_mgr_positions_short_all ?? row.asset_mgr_positions_short) || 0;
    const leveragedLong = numberOrNull(row.lev_money_positions_long) || 0;
    const leveragedShort = numberOrNull(row.lev_money_positions_short) || 0;
    const dealerLong = numberOrNull(row.dealer_positions_long_all ?? row.dealer_positions_long) || 0;
    const dealerShort = numberOrNull(row.dealer_positions_short_all ?? row.dealer_positions_short) || 0;
    return {
      reportDate: String(row.report_date_as_yyyy_mm_dd || ""),
      openInterest: numberOrNull(row.open_interest_all) || 0,
      assetManagerLong: assetLong,
      assetManagerShort: assetShort,
      assetManagerNet: assetLong - assetShort,
      leveragedLong,
      leveragedShort,
      dealerLong,
      dealerShort,
      dealerNet: dealerLong - dealerShort,
      leveragedNet: leveragedLong - leveragedShort
    };
  });
  const latest = normalized[0] || { reportDate: "", openInterest: 0, assetManagerNet: 0, leveragedNet: 0 };
  const prior = normalized[1] || latest;
  return {
    marketKey,
    reportDate: latest.reportDate,
    openInterest: latest.openInterest,
    assetManagerNet: latest.assetManagerNet,
    assetManagerLong: latest.assetManagerLong,
    assetManagerShort: latest.assetManagerShort,
    assetManagerWeeklyChange: latest.assetManagerNet - prior.assetManagerNet,
    leveragedNet: latest.leveragedNet,
    leveragedLong: latest.leveragedLong,
    leveragedShort: latest.leveragedShort,
    leveragedWeeklyChange: latest.leveragedNet - prior.leveragedNet,
    dealerNet: latest.dealerNet,
    dealerLong: latest.dealerLong,
    dealerShort: latest.dealerShort,
    dealerWeeklyChange: latest.dealerNet - prior.dealerNet,
    bias: latest.assetManagerNet >= 0 ? "Bullish" : "Bearish",
    history: normalized,
    source: "CFTC Traders in Financial Futures"
  };
}

export async function getCotSnapshot(marketKey = "nasdaq") {
  const key = Object.hasOwn(CFTC_MARKETS, marketKey) ? marketKey : "nasdaq";
  const config = CFTC_MARKETS[key];
  const query = [
    "select *",
    `where market_and_exchange_names='${config.market.replace(/'/g, "''")}'`,
    "order by report_date_as_yyyy_mm_dd desc",
    "limit 12"
  ].join(" ");
  const rows = await jsonFetch(`https://publicreporting.cftc.gov/resource/${config.dataset}.json?$query=${encodeURIComponent(query)}`);
  return parseCftcSnapshot(rows, key);
}

export async function testMarketSettings(settings) {
  const snapshot = await getMarketSnapshot(settings, "IBM");
  return { ok: true, provider: settings.provider || "yahoo", symbol: snapshot.symbol, price: snapshot.price };
}
