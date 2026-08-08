'use client';

import { useState, useMemo } from 'react';
import { mockStocks, mockMarketBreadth, mockMarketIndexes, mockSwingSetups, mockMarketCommentary } from '@/lib/mockData';
import { Stock, SwingSetup } from '@/types/stock';
import Header from '@/components/Header';
import MarketOverview from '@/components/MarketOverview';
import StockScreener from '@/components/StockScreener';
import SwingSetups from '@/components/SwingSetups';
import MarketCommentary from '@/components/MarketCommentary';

export default function Home() {
  const [stocks] = useState<Stock[]>(mockStocks);
  const [selectedSector, setSelectedSector] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewMode, setViewMode] = useState<'dashboard' | 'screener' | 'setups'>('dashboard');

  // Get unique sectors
  const sectors = ['All', ...Array.from(new Set(stocks.map(s => s.sector)))];

  // Filter stocks based on search and sector
  const filteredStocks = useMemo(() => {
    return stocks.filter(stock => {
      const matchesSearch = 
        stock.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
        stock.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesSector = selectedSector === 'All' || stock.sector === selectedSector;
      return matchesSearch && matchesSector;
    });
  }, [stocks, searchQuery, selectedSector]);

  // Get top movers
  const topGainers = useMemo(() => {
    return [...stocks].sort((a, b) => b.changePercent - a.changePercent).slice(0, 10);
  }, [stocks]);

  const topLosers = useMemo(() => {
    return [...stocks].sort((a, b) => a.changePercent - b.changePercent).slice(0, 10);
  }, [stocks]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <Header 
        viewMode={viewMode} 
        onViewModeChange={setViewMode}
        stockCount={stocks.length}
      />
      
      <main className="container mx-auto px-4 py-6">
        {viewMode === 'dashboard' && (
          <div className="space-y-6">
            {/* Market Overview */}
            <MarketOverview 
              indexes={mockMarketIndexes}
              breadth={mockMarketBreadth}
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Market Commentary */}
              <div className="lg:col-span-2">
                <MarketCommentary commentary={mockMarketCommentary} />
              </div>

              {/* Top Movers */}
              <div className="space-y-4">
                <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-4 border border-slate-700">
                  <h3 className="text-lg font-semibold text-emerald-400 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5.293 9.707a1 1 0 010-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 01-1.414 1.414L11 7.414V15a1 1 0 11-2 0V7.414L6.707 9.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                    Top Gainers
                  </h3>
                  <div className="space-y-2">
                    {topGainers.map(stock => (
                      <div key={stock.symbol} className="flex justify-between items-center p-2 rounded-lg hover:bg-slate-700/50 transition-colors">
                        <div>
                          <div className="font-semibold text-slate-100">{stock.symbol}</div>
                          <div className="text-xs text-slate-400">{stock.name}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-slate-100">${stock.price.toFixed(2)}</div>
                          <div className="text-sm text-emerald-400">+{stock.changePercent.toFixed(2)}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-800/50 backdrop-blur-sm rounded-xl p-4 border border-slate-700">
                  <h3 className="text-lg font-semibold text-red-400 mb-3 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M14.707 10.293a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L9 12.586V5a1 1 0 012 0v7.586l2.293-2.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Top Losers
                  </h3>
                  <div className="space-y-2">
                    {topLosers.map(stock => (
                      <div key={stock.symbol} className="flex justify-between items-center p-2 rounded-lg hover:bg-slate-700/50 transition-colors">
                        <div>
                          <div className="font-semibold text-slate-100">{stock.symbol}</div>
                          <div className="text-xs text-slate-400">{stock.name}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-slate-100">${stock.price.toFixed(2)}</div>
                          <div className="text-sm text-red-400">{stock.changePercent.toFixed(2)}%</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Swing Setups */}
            <SwingSetups setups={mockSwingSetups} stocks={stocks} />
          </div>
        )}

        {viewMode === 'screener' && (
          <StockScreener 
            stocks={filteredStocks}
            sectors={sectors}
            selectedSector={selectedSector}
            onSectorChange={setSelectedSector}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
        )}

        {viewMode === 'setups' && (
          <SwingSetups setups={mockSwingSetups} stocks={stocks} expanded />
        )}
      </main>
    </div>
  );
}