// /api/markets/* — market data, settings, and the strategy backtest.
//
// The first route group lifted out of server.js's single request handler. The
// contract every group should follow: take one ctx, return true when the
// request was handled and false to let the handler keep looking. Nothing here
// touches res directly — ctx.json owns the response.
import {
  getCotSnapshot,
  getMarketDashboard,
  getMarketQuote,
  getMarketSnapshot,
  getOptionsChain,
  getSectorPerformance,
  getTradeIdeas,
  runStrategyBacktest,
  testMarketSettings
} from "../markets.js";

export async function marketsRoutes({ req, p, url, config, json, readBody, saveConfig, marketAccessAllowed }) {
  if (!p.startsWith("/api/markets/")) return false;

  if (p.startsWith("/api/markets/") && !marketAccessAllowed(config)) {
    json({ error: "Markets is available only to signed-in Boollm administrators." }, 403);
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/settings") {
    const market = config.connectors?.marketData || {};
    json({
      provider: market.provider || "yahoo",
      configured: !!market.apiKey,
      selectedSymbol: market.selectedSymbol || "AAPL",
      watchlist: Array.isArray(market.watchlist) ? market.watchlist : [],
      optionsProvider: market.optionsProvider || "alpaca",
      optionsFeed: market.optionsFeed === "opra" ? "opra" : "indicative",
      alpacaConfigured: !!(market.alpacaKeyId && market.alpacaSecretKey),
      massiveConfigured: !!market.massiveApiKey,
      yahooExperimental: true
    });
    return true;
  }

  if (req.method === "POST" && p === "/api/markets/settings") {
    const body = await readBody(req);
    const old = config.connectors?.marketData || {};
    const provider = body.provider === "alphaVantage" ? "alphaVantage" : "yahoo";
    const cleanSymbol = (value) => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "").slice(0, 24);
    const watchlist = Array.isArray(body.watchlist)
      ? [...new Set(body.watchlist.map(cleanSymbol).filter(Boolean))].slice(0, 20)
      : (old.watchlist || []);
    const apiKey = body.apiKey === "__keep__" ? (old.apiKey || "") : String(body.apiKey || "").trim().slice(0, 500);
    const next = {
      provider,
      apiKey: provider === "alphaVantage" ? apiKey : "",
      selectedSymbol: cleanSymbol(body.selectedSymbol) || old.selectedSymbol || "AAPL",
      watchlist: watchlist.length ? watchlist : ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"],
      optionsProvider: ["alpaca", "massive"].includes(body.optionsProvider) ? body.optionsProvider : (old.optionsProvider || "alpaca"),
      optionsFeed: body.optionsFeed === "opra" ? "opra" : "indicative",
      alpacaKeyId: body.alpacaKeyId === "__keep__" ? (old.alpacaKeyId || "") : String(body.alpacaKeyId || "").trim().slice(0, 500),
      alpacaSecretKey: body.alpacaSecretKey === "__keep__" ? (old.alpacaSecretKey || "") : String(body.alpacaSecretKey || "").trim().slice(0, 500),
      massiveApiKey: body.massiveApiKey === "__keep__" ? (old.massiveApiKey || "") : String(body.massiveApiKey || "").trim().slice(0, 500)
    };
    if (provider === "alphaVantage" && !next.apiKey) {
      json({ error: "Alpha Vantage API key required." }, 400);
      return true;
    }
    if (body.test === true) {
      try {
        await testMarketSettings(next);
        const testOptions = (next.optionsProvider === "alpaca" && next.alpacaKeyId && next.alpacaSecretKey)
          || (next.optionsProvider === "massive" && next.massiveApiKey);
        if (testOptions) await getOptionsChain(next, next.selectedSymbol);
      }
      catch (error) { json({ error: String(error?.message || error) }, 400); return; }
    }
    config.connectors = config.connectors || {};
    config.connectors.marketData = next;
    saveConfig(config, { preserveSecrets: false });
    if (adminCloudVaultEnabled(config)) syncCloudVault(config, { merge: false }).catch(() => {});
    json({
      ok: true, provider, configured: !!next.apiKey, selectedSymbol: next.selectedSymbol, watchlist: next.watchlist,
      optionsProvider: next.optionsProvider, optionsFeed: next.optionsFeed,
      alpacaConfigured: !!(next.alpacaKeyId && next.alpacaSecretKey), massiveConfigured: !!next.massiveApiKey
    });
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/snapshot") {
    try {
      const snapshot = await getMarketSnapshot(
        config.connectors?.marketData || {},
        url.searchParams.get("symbol") || "AAPL",
        url.searchParams.get("range") || "6mo",
        url.searchParams.get("interval") || ""
      );
      json({ ok: true, ...snapshot });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/quote") {
    try {
      const quote = await getMarketQuote(
        config.connectors?.marketData || {},
        url.searchParams.get("symbol") || "AAPL"
      );
      json({ ok: true, ...quote });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/dashboard") {
    try {
      const dashboard = await getMarketDashboard(
        config.connectors?.marketData || {},
        url.searchParams.get("symbol") || "AAPL"
      );
      json({ ok: true, ...dashboard });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/sectors") {
    try {
      json({ ok: true, ...await getSectorPerformance() });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/options") {
    try {
      const chain = await getOptionsChain(
        config.connectors?.marketData || {},
        url.searchParams.get("symbol") || "AAPL",
        url.searchParams.get("expiration") || ""
      );
      json({ ok: true, ...chain });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/trade-ideas") {
    try {
      const ideas = await getTradeIdeas(
        config.connectors?.marketData || {},
        url.searchParams.get("symbol") || "AAPL"
      );
      json({ ok: true, ...ideas });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  if (req.method === "POST" && p === "/api/markets/backtest") {
    try {
      const body = await readBody(req);
      const symbol = String(body.symbol || "AAPL").slice(0, 16);
      const range = ["6mo", "1y", "2y", "5y", "max"].includes(body.range) ? body.range : "5y";
      const interval = String(body.interval || "").toLowerCase();
      const validIntervals = new Set(["5m", "15m", "30m", "1h", "1d", "1wk", "1mo"]);
      const snapshot = await getMarketSnapshot(
        config.connectors?.marketData || {},
        symbol,
        range,
        validIntervals.has(interval) ? interval : ""
      );
      json({ ok: true, ...runStrategyBacktest(snapshot, { ...body, symbol }) });
    } catch (error) {
      json({ error: String(error?.message || error) }, 400);
    }
    return true;
  }

  if (req.method === "GET" && p === "/api/markets/cot") {
    try {
      const cot = await getCotSnapshot(url.searchParams.get("market") || "nasdaq");
      json({ ok: true, ...cot });
    } catch (error) {
      json({ error: String(error?.message || error) }, 502);
    }
    return true;
  }

  return false;
}
