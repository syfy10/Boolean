"use client";

import { useState, useMemo, useEffect, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface ScanResult {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  relativeVolume: number;
  signal: "Bullish" | "Bearish" | "Neutral";
  signalStrength: number;
  range: number;
  spark: number[];
}

interface FilterState {
  signal: "All" | "Bullish" | "Bearish" | "Neutral";
  minRelVol: number;
  minChange: number;
  search: string;
}

// ─── Mock Data ───────────────────────────────────────────────────────────────
const STOCK_POOL: Omit<ScanResult, "spark" | "price" | "change" | "changePct" | "volume" | "relativeVolume" | "signal" | "signalStrength">[] = [
  { ticker: "NVDA", name: "NVIDIA Corporation", range: 8, avgVolume: 45_000_000 },
  { ticker: "TSLA", name: "Tesla Inc.", range: 12, avgVolume: 98_000_000 },
  { ticker: "AAPL", name: "Apple Inc.", range: 4, avgVolume: 55_000_000 },
  { ticker: "AMD", name: "Advanced Micro Devices", range: 9, avgVolume: 62_000_000 },
  { ticker: "META", name: "Meta Platforms Inc.", range: 6, avgVolume: 20_000_000 },
  { ticker: "AMZN", name: "Amazon.com Inc.", range: 5, avgVolume: 38_000_000 },
  { ticker: "MSFT", name: "Microsoft Corporation", range: 3, avgVolume: 25_000_000 },
  { ticker: "GOOGL", name: "Alphabet Inc.", range: 4, avgVolume: 28_000_000 },
  { ticker: "PLTR", name: "Palantir Technologies", range: 15, avgVolume: 75_000_000 },
  { ticker: "SOFI", name: "SoFi Technologies", range: 11, avgVolume: 52_000_000 },
  { ticker: "COIN", name: "Coinbase Global", range: 18, avgVolume: 14_000_000 },
  { ticker: "MARA", name: "Marathon Digital", range: 22, avgVolume: 40_000_000 },
  { ticker: "SMCI", name: "Super Micro Computer", range: 16, avgVolume: 8_000_000 },
  { ticker: "MSTR", name: "MicroStrategy", range: 14, avgVolume: 6_500_000 },
  { ticker: "FCEL", name: "FuelCell Energy", range: 10, avgVolume: 18_000_000 },
  { ticker: "NKLA", name: "Nikola Corporation", range: 13, avgVolume: 35_000_000 },
  { ticker: "GME", name: "GameStop Corp.", range: 9, avgVolume: 4_500_000 },
  { ticker: "AMC", name: "AMC Entertainment", range: 8, avgVolume: 12_000_000 },
  { ticker: "BB", name: "BlackBerry Limited", range: 6, avgVolume: 15_000_000 },
  { ticker: "NIO", name: "NIO Inc.", range: 10, avgVolume: 48_000_000 },
];

function genSpark(base: number, range: number, isUp: boolean): number[] {
  const pts: number[] = [];
  let val = base;
  for (let i = 0; i < 32; i++) {
    const vol = range * 0.02;
    const drift = isUp ? 0.001 : -0.001;
    const noise = (Math.random() - 0.5) * vol;
    val = val * (1 + drift + noise);
    pts.push(val);
  }
  return pts;
}

function generateData(): ScanResult[] {
  return STOCK_POOL.map((stock) => {
    const basePrice = 20 + Math.random() * 480;
    const changePct = (Math.random() - 0.45) * stock.range;
    const price = basePrice * (1 + changePct / 100);
    const change = basePrice * (changePct / 100);
    const volume = Math.floor(stock.avgVolume * (0.3 + Math.random() * 2.5));
    const relativeVolume = volume / stock.avgVolume;
    const isUp = changePct >= 0;
    const signal: ScanResult["signal"] =
      changePct > 2 && relativeVolume > 1.2
        ? "Bullish"
        : changePct < -2 && relativeVolume > 1.2
        ? "Bearish"
        : "Neutral";
    const signalStrength = Math.min(
      100,
      Math.round(Math.abs(changePct) * 8 + relativeVolume * 15 + Math.random() * 20)
    );
    return {
      ...stock,
      price,
      change,
      changePct,
      volume,
      relativeVolume,
      signal,
      signalStrength,
      spark: genSpark(price, stock.range, isUp),
    };
  });
}

// ─── Sparkline Component ─────────────────────────────────────────────────────
function Sparkline({ data, isUp }: { data: number[]; isUp: boolean }) {
  const w = 100;
  const h = 30;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(" ");
  const color = isUp ? "#10b981" : "#ef4444";
  const gid = `spark-${isUp ? "u" : "d"}-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${points} ${w},${h}`} fill={`url(#${gid})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Signal Badge ────────────────────────────────────────────────────────────
function SignalBadge({ signal, strength }: { signal: ScanResult["signal"]; strength: number }) {
  const styles: Record<ScanResult["signal"], string> = {
    Bullish: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    Bearish: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    Neutral: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  };
  const icon: Record<ScanResult["signal"], string> = {
    Bullish: "▲",
    Bearish: "▼",
    Neutral: "◆",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${styles[signal]}`}
    >
      <span className="text-[10px]">{icon[signal]}</span>
      {signal}
      <span className="text-[10px] opacity-60">{strength}%</span>
    </span>
  );
}

// ─── Format Helpers ──────────────────────────────────────────────────────────
function fmtVolume(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toString();
}

function fmtPrice(p: number): string {
  return p < 1 ? p.toFixed(4) : p.toFixed(2);
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function Home() {
  const [results, setResults] = useState<ScanResult[]>([]);
  const [filters, setFilters] = useState<FilterState>({
    signal: "All",
    minRelVol: 0,
    minChange: 0,
    search: "",
  });
  const [isLive, setIsLive] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selected, setSelected] = useState<ScanResult | null>(null);

  const refresh = useCallback(() => {
    setResults(generateData());
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [isLive, refresh]);

  const filtered = useMemo(() => {
    return results
      .filter((r) => (filters.signal === "All" ? true : r.signal === filters.signal))
      .filter((r) => r.relativeVolume >= filters.minRelVol)
      .filter((r) => Math.abs(r.changePct) >= filters.minChange)
      .filter((r) =>
        filters.search
          ? r.ticker.toLowerCase().includes(filters.search.toLowerCase()) ||
            r.name.toLowerCase().includes(filters.search.toLowerCase())
          : true
      )
      .sort((a, b) => b.signalStrength - a.signalStrength);
  }, [results, filters]);

  const stats = useMemo(() => {
    const bullish = results.filter((r) => r.signal === "Bullish").length;
    const bearish = results.filter((r) => r.signal === "Bearish").length;
    const avgRelVol =
      results.length > 0
        ? results.reduce((sum, r) => sum + r.relativeVolume, 0) / results.length
        : 0;
    const topMover = results.reduce(
      (best, r) => (Math.abs(r.changePct) > Math.abs(best?.changePct || 0) ? r : best),
      null as ScanResult | null
    );
    return { bullish, bearish, avgRelVol, topMover, total: results.length };
  }, [results]);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-zinc-100 flex flex-col">
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-[#0a0a0b]/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-sm font-black text-black">
                S
              </div>
              <span className="text-lg font-bold tracking-tight">
                Stock<span className="text-emerald-400">Edge</span>
              </span>
            </div>
            <nav className="hidden gap-6 md:flex">
              <a href="#" className="text-sm font-medium text-emerald-400">Radar</a>
              <a href="#" className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors">Screener</a>
              <a href="#" className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors">Watchlist</a>
              <a href="#" className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors">Alerts</a>
              <a href="#" className="text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors">Analytics</a>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsLive(!isLive)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                isLive
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-zinc-700 bg-zinc-800/50 text-zinc-400"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${isLive ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"}`} />
              {isLive ? "LIVE" : "PAUSED"}
            </button>
            <button className="hidden rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors sm:block">
              Sign In
            </button>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-8">
        {/* Hero / Title */}
        <div className="mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">Edge Radar</h1>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400">
              REAL-TIME
            </span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">
            Scanning {results.length} symbols · Updated {lastUpdate.toLocaleTimeString()} ·
            Auto-refresh {isLive ? "every 5s" : "paused"}
          </p>
        </div>

        {/* Stats Cards */}
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Bullish Signals</span>
              <span className="text-lg text-emerald-400">▲</span>
            </div>
            <div className="mt-3 text-3xl font-bold text-emerald-400">{stats.bullish}</div>
            <div className="mt-1 text-xs text-zinc-500">of {stats.total} scanned</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Bearish Signals</span>
              <span className="text-lg text-rose-400">▼</span>
            </div>
            <div className="mt-3 text-3xl font-bold text-rose-400">{stats.bearish}</div>
            <div className="mt-1 text-xs text-zinc-500">of {stats.total} scanned</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Avg Rel Volume</span>
              <span className="text-lg text-sky-400">⚡</span>
            </div>
            <div className="mt-3 text-3xl font-bold text-sky-400">{stats.avgRelVol.toFixed(2)}x</div>
            <div className="mt-1 text-xs text-zinc-500">vs 30-day average</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Top Mover</span>
              <span className="text-lg text-amber-400">★</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="text-2xl font-bold">{stats.topMover?.ticker ?? "—"}</span>
              <span className={`text-lg font-bold ${stats.topMover && stats.topMover.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {stats.topMover ? `${stats.topMover.changePct >= 0 ? "+" : ""}${stats.topMover.changePct.toFixed(2)}%` : ""}
              </span>
            </div>
            <div className="mt-1 text-xs text-zinc-500">biggest absolute move</div>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <input
            type="text"
            placeholder="Search ticker or name..."
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="w-48 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Signal</span>
            {(["All", "Bullish", "Bearish", "Neutral"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilters({ ...filters, signal: s })}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  filters.signal === s
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-zinc-800/50 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Min Rel Vol</span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={filters.minRelVol}
              onChange={(e) => setFilters({ ...filters, minRelVol: parseFloat(e.target.value) || 0 })}
              className="w-20 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-sm text-zinc-100 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">Min |Change| %</span>
            <input
              type="number"
              min="0"
              step="0.5"
              value={filters.minChange}
              onChange={(e) => setFilters({ ...filters, minChange: parseFloat(e.target.value) || 0 })}
              className="w-20 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-sm text-zinc-100 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          </div>
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            ↻ Refresh
          </button>
        </div>

        {/* Results Table */}
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/30">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                  <th className="px-5 py-3 font-medium">Ticker</th>
                  <th className="px-5 py-3 font-medium">Signal</th>
                  <th className="px-5 py-3 text-right font-medium">Price</th>
                  <th className="px-5 py-3 text-right font-medium">Change</th>
                  <th className="px-5 py-3 text-right font-medium">Change %</th>
                  <th className="px-5 py-3 text-right font-medium">Volume</th>
                  <th className="px-5 py-3 text-right font-medium">Rel Vol</th>
                  <th className="px-5 py-3 text-center font-medium">Chart</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-16 text-center text-zinc-500">
                      No results match your filters. Try widening your criteria.
                    </td>
                  </tr>
                )}
                {filtered.map((r) => (
                  <tr
                    key={r.ticker}
                    onClick={() => setSelected(r)}
                    className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-zinc-100">{r.ticker}</div>
                      <div className="text-xs text-zinc-500">{r.name}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <SignalBadge signal={r.signal} strength={r.signalStrength} />
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums text-zinc-200">
                      ${fmtPrice(r.price)}
                    </td>
                    <td className={`px-5 py-3.5 text-right font-mono tabular-nums ${r.change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {r.change >= 0 ? "+" : ""}{r.change.toFixed(2)}
                    </td>
                    <td className={`px-5 py-3.5 text-right font-mono tabular-nums font-semibold ${r.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono tabular-nums text-zinc-300">
                      {fmtVolume(r.volume)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span
                        className={`font-mono tabular-nums font-semibold ${
                          r.relativeVolume >= 2 ? "text-amber-400" : r.relativeVolume >= 1.2 ? "text-sky-400" : "text-zinc-400"
                        }`}
                      >
                        {r.relativeVolume.toFixed(2)}x
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex justify-center">
                        <Sparkline data={r.spark} isUp={r.changePct >= 0} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
          <span>Showing {filtered.length} of {results.length} results</span>
          <span>Sorted by signal strength (descending)</span>
        </div>
      </main>

      {/* ── Detail Drawer ── */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end bg-black/60 backdrop-blur-sm sm:items-center sm:justify-center"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border border-zinc-800 bg-[#121214] p-6 sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold">{selected.ticker}</h2>
                  <SignalBadge signal={selected.signal} strength={selected.signalStrength} />
                </div>
                <p className="mt-1 text-sm text-zinc-400">{selected.name}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-200 text-xl">✕</button>
            </div>
            <div className="mb-5 flex items-baseline gap-3">
              <span className="text-4xl font-bold font-mono tabular-nums">${fmtPrice(selected.price)}</span>
              <span className={`text-xl font-semibold ${selected.change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {selected.change >= 0 ? "+" : ""}{selected.change.toFixed(2)} ({selected.changePct.toFixed(2)}%)
              </span>
            </div>
            <div className="mb-5 flex justify-center">
              <Sparkline data={selected.spark} isUp={selected.changePct >= 0} />
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">Volume</div>
                <div className="mt-1 font-mono text-lg font-semibold">{fmtVolume(selected.volume)}</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">Relative Volume</div>
                <div className="mt-1 font-mono text-lg font-semibold text-sky-400">{selected.relativeVolume.toFixed(2)}x</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">30D Avg Volume</div>
                <div className="mt-1 font-mono text-lg font-semibold">{fmtVolume(selected.avgVolume)}</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">Daily Range</div>
                <div className="mt-1 font-mono text-lg font-semibold">{selected.range.toFixed(1)}%</div>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button className="flex-1 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-400 hover:bg-emerald-500/30 transition-colors">
                + Add to Watchlist
              </button>
              <button className="flex-1 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors">
                Set Alert
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="border-t border-zinc-800/80 py-6">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-2 px-6 text-xs text-zinc-500 sm:flex-row">
          <span>StockEdge · Edge Radar — Data is simulated for demonstration purposes.</span>
          <span>Built with Next.js · Not financial advice</span>
        </div>
      </footer>
    </div>
  );
}
