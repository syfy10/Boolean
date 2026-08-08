import { useState, useMemo } from 'react';
import { Stock } from '@/types/stock';

interface StockScreenerProps {
  stocks: Stock[];
  sectors: string[];
  selectedSector: string;
  onSectorChange: (sector: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export default function StockScreener({
  stocks,
  sectors,
  selectedSector,
  onSectorChange,
  searchQuery,
  onSearchChange,
}: StockScreenerProps) {
  const [sortBy, setSortBy] = useState<keyof Stock>('symbol');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [showOnlyGainers, setShowOnlyGainers] = useState(false);
  const [showOnlyLosers, setShowOnlyLosers] = useState(false);
  const [minPrice, setMinPrice] = useState<number | ''>('');
  const [maxPrice, setMaxPrice] = useState<number | ''>('');

  // Filter and sort stocks
  const filteredStocks = useMemo(() => {
    let result = [...stocks];

    // Filter by gainers/losers
    if (showOnlyGainers) {
      result = result.filter(s => s.changePercent > 0);
    }
    if (showOnlyLosers) {
      result = result.filter(s => s.changePercent < 0);
    }

    // Filter by price range
    if (minPrice !== '') {
      result = result.filter(s => s.price >= (minPrice as number));
    }
    if (maxPrice !== '') {
      result = result.filter(s => s.price <= (maxPrice as number));
    }

    // Sort
    result.sort((a, b) => {
      let aValue = a[sortBy];
      let bValue = b[sortBy];

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [stocks, sortBy, sortOrder, showOnlyGainers, showOnlyLosers, minPrice, maxPrice]);

  const handleSort = (column: keyof Stock) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-6 border border-slate-700">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <h2 className="text-xl font-bold text-white flex items-center">
            <span className="mr-2">🔍</span>
            Stock Screener
          </h2>
          <span className="text-sm text-slate-400">
            Showing {filteredStocks.toLocaleString()} of {stocks.length.toLocaleString()} stocks
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Search */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Search</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Symbol or name..."
              className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Sector Filter */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Sector</label>
            <select
              value={selectedSector}
              onChange={(e) => onSectorChange(e.target.value)}
              className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {sectors.map(sector => (
                <option key={sector} value={sector}>{sector}</option>
              ))}
            </select>
          </div>

          {/* Price Range */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Price Range</label>
            <div className="flex space-x-2">
              <input
                type="number"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value ? Number(e.target.value) : '')}
                placeholder="Min"
                className="w-1/2 px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <input
                type="number"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value ? Number(e.target.value) : '')}
                placeholder="Max"
                className="w-1/2 px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Performance Filter */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Performance</label>
            <div className="flex space-x-2">
              <button
                onClick={() => {
                  setShowOnlyGainers(!showOnlyGainers);
                  setShowOnlyLosers(false);
                }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showOnlyGainers
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Gainers
              </button>
              <button
                onClick={() => {
                  setShowOnlyLosers(!showOnlyLosers);
                  setShowOnlyGainers(false);
                }}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  showOnlyLosers
                    ? 'bg-red-600 text-white'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-700'
                }`}
              >
                Losers
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Stock Table */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl border border-slate-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-900/50">
              <tr>
                <th
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('symbol')}
                >
                  Symbol {sortBy === 'symbol' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('name')}
                >
                  Name {sortBy === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider"
                >
                  Sector
                </th>
                <th
                  className="px-6 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('price')}
                >
                  Price {sortBy === 'price' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('change')}
                >
                  Change {sortBy === 'change' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('changePercent')}
                >
                  % Change {sortBy === 'changePercent' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-right text-xs font-semibold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-200 transition-colors"
                  onClick={() => handleSort('volume')}
                >
                  Volume {sortBy === 'volume' && (sortOrder === 'asc' ? '↑' : '↓')}
                </th>
                <th
                  className="px-6 py-4 text-center text-xs font-semibold text-slate-400 uppercase tracking-wider"
                >
                  Trend
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredStocks.slice(0, 100).map((stock, index) => (
                <tr
                  key={stock.symbol}
                  className={`hover:bg-slate-700/30 transition-colors ${
                    index % 2 === 0 ? 'bg-slate-800/30' : ''
                  }`}
                >
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="font-semibold text-white">{stock.symbol}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-slate-300">{stock.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="px-2 py-1 text-xs font-medium bg-slate-700 text-slate-300 rounded-full">
                      {stock.sector}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm font-medium text-white">${stock.price.toFixed(2)}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className={`text-sm font-medium ${
                      stock.change >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {stock.change >= 0 ? '+' : ''}{stock.change.toFixed(2)}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className={`text-sm font-semibold ${
                      stock.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {stock.changePercent >= 0 ? '+' : ''}{stock.changePercent.toFixed(2)}%
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="text-sm text-slate-300">{(stock.volume / 1000000).toFixed(2)}M</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <div className={`w-16 h-8 ${
                      stock.trend === 'bullish' ? 'bg-emerald-900/30' :
                      stock.trend === 'bearish' ? 'bg-red-900/30' :
                      'bg-slate-700/30'
                    } rounded flex items-end justify-center p-1`}>
                      <svg className="w-12 h-6" viewBox="0 0 48 24">
                        <path
                          d={`M 0 ${stock.trend === 'bullish' ? 20 : stock.trend === 'bearish' ? 4 : 12} 
                             L 8 ${stock.trend === 'bullish' ? 16 : stock.trend === 'bearish' ? 8 : 12}
                             L 16 ${stock.trend === 'bullish' ? 18 : stock.trend === 'bearish' ? 6 : 12}
                             L 24 ${stock.trend === 'bullish' ? 12 : stock.trend === 'bearish' ? 12 : 12}
                             L 32 ${stock.trend === 'bullish' ? 8 : stock.trend === 'bearish' ? 16 : 12}
                             L 40 ${stock.trend === 'bullish' ? 4 : stock.trend === 'bearish' ? 20 : 12}
                             L 48 ${stock.trend === 'bullish' ? 2 : stock.trend === 'bearish' ? 22 : 12}`}
                          fill="none"
                          stroke={stock.trend === 'bullish' ? '#34d399' : stock.trend === 'bearish' ? '#f87171' : '#94a3b8'}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredStocks.length > 100 && (
          <div className="px-6 py-4 bg-slate-900/30 border-t border-slate-700">
            <p className="text-sm text-slate-400 text-center">
              Showing first 100 of {filteredStocks.toLocaleString()} results. Use filters to narrow your search.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}