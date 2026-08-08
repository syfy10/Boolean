interface MarketIndex {
  name: string;
  symbol: string;
  value: number;
  change: number;
  changePercent: number;
}

interface MarketBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  total: number;
  advDecRatio: number;
  newHighs: number;
  newLows: number;
}

interface MarketOverviewProps {
  indexes: MarketIndex[];
  breadth: MarketBreadth;
}

export default function MarketOverview({ indexes, breadth }: MarketOverviewProps) {
  const advPct = (breadth.advancing / breadth.total) * 100;
  const decPct = (breadth.declining / breadth.total) * 100;
  const unchangedPct = (breadth.unchanged / breadth.total) * 100;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Major Indexes */}
      <div className="lg:col-span-2 bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white flex items-center">
            <span className="mr-2">📈</span>
            Major Indexes
          </h2>
          <span className="text-sm text-slate-400">Real-time</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {indexes.map((index) => (
            <div
              key={index.symbol}
              className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50 hover:border-slate-600 transition-colors"
            >
              <div className="text-xs text-slate-400 mb-1">{index.name}</div>
              <div className="text-lg font-bold text-white">{index.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div className={`text-sm font-semibold mt-1 ${
                index.change >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}>
                {index.change >= 0 ? '+' : ''}{index.change.toFixed(2)} ({index.changePercent >= 0 ? '+' : ''}{index.changePercent.toFixed(2)}%)
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Market Breadth */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 border border-slate-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white flex items-center">
            <span className="mr-2">📊</span>
            Market Breadth
          </h2>
          <span className={`text-sm font-semibold ${
            breadth.advDecRatio > 1 ? 'text-emerald-400' : 'text-red-400'
          }`}>
            A/D Ratio: {breadth.advDecRatio.toFixed(2)}
          </span>
        </div>

        {/* Breadth Bars */}
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-emerald-400 font-medium">Advancing</span>
              <span className="text-slate-300">{breadth.advancing.toLocaleString()}</span>
            </div>
            <div className="h-3 bg-slate-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${advPct}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-red-400 font-medium">Declining</span>
              <span className="text-slate-300">{breadth.declining.toLocaleString()}</span>
            </div>
            <div className="h-3 bg-slate-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-red-600 to-red-400 rounded-full transition-all duration-500"
                style={{ width: `${decPct}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-slate-400 font-medium">Unchanged</span>
              <span className="text-slate-300">{breadth.unchanged.toLocaleString()}</span>
            </div>
            <div className="h-3 bg-slate-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-slate-600 to-slate-400 rounded-full transition-all duration-500"
                style={{ width: `${unchangedPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* New Highs/Lows */}
        <div className="grid grid-cols-2 gap-4 mt-6 pt-4 border-t border-slate-700">
          <div className="text-center">
            <div className="text-2xl font-bold text-emerald-400">{breadth.newHighs}</div>
            <div className="text-xs text-slate-400 mt-1">New Highs</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-400">{breadth.newLows}</div>
            <div className="text-xs text-slate-400 mt-1">New Lows</div>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-slate-700">
          <div className="text-sm text-slate-400 text-center">
            Total: {breadth.total.toLocaleString()} stocks
          </div>
        </div>
      </div>
    </div>
  );
}