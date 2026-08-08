import { Stock, MarketBreadth, MarketIndex, SwingSetup, MarketCommentary } from '@/types/stock';

// Sectors and industries for realistic data
const SECTORS = [
  'Technology', 'Healthcare', 'Financial', 'Consumer Cyclical',
  'Consumer Defensive', 'Energy', 'Industrials', 'Utilities',
  'Real Estate', 'Communication', 'Materials', 'Basic Materials'
];

const INDUSTRIES = {
  'Technology': ['Software', 'Semiconductors', 'IT Services', 'Hardware', 'Cloud Computing'],
  'Healthcare': ['Biotechnology', 'Pharmaceuticals', 'Medical Devices', 'Healthcare Services'],
  'Financial': ['Banks', 'Insurance', 'Asset Management', 'FinTech'],
  'Consumer Cyclical': ['Retail', 'Automotive', 'Restaurants', 'Travel & Leisure', 'E-commerce'],
  'Consumer Defensive': ['Food & Beverage', 'Household Products', 'Tobacco'],
  'Energy': ['Oil & Gas', 'Renewable Energy', 'Electric Utilities'],
  'Industrials': ['Manufacturing', 'Aerospace & Defense', 'Construction', 'Machinery'],
  'Utilities': ['Electric Utilities', 'Water Utilities', 'Gas Utilities'],
  'Real Estate': ['REITs', 'Property Management', 'Construction'],
  'Communication': ['Telecom', 'Media', 'Entertainment', 'Social Media'],
  'Materials': ['Chemicals', 'Mining', 'Paper & Forest Products'],
  'Basic Materials': ['Metals & Mining', 'Chemicals', 'Construction Materials']
};

// Stock name prefixes for realistic generation
const NAME_PREFIXES = ['Advanced', 'American', 'United', 'Global', 'National', 'Pacific', 'Atlantic', 'Central', 'General', 'Strategic'];
const NAME_BASES = ['Tech', 'Systems', 'Energy', 'Financial', 'Health', 'Innovations', 'Dynamics', 'Solutions', 'Partners', 'Holdings', 'Group', 'Enterprises', 'Corp', 'Industries', 'Networks', 'Digital', 'Smart', 'Future', 'Prime', 'Elite'];
const NAME_SUFFIXES = ['Inc', 'Corp', 'Group', 'Holdings', 'Ltd', 'PLC', 'Co', 'International', 'Worldwide', 'Global'];

function generateStockName(): string {
  const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
  const base = NAME_BASES[Math.floor(Math.random() * NAME_BASES.length)];
  const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
  return `${prefix} ${base} ${suffix}`;
}

function generateStockSymbol(name: string): string {
  const words = name.split(' ');
  const symbols = words.filter(w => w.length > 2).map(w => w[0]);
  while (symbols.length < 3) {
    symbols.push(String.fromCharCode(65 + Math.floor(Math.random() * 26)));
  }
  return symbols.slice(0, 4).join('').toUpperCase();
}

function generatePriceHistory(basePrice: number, days: number = 30): number[] {
  const history: number[] = [];
  let price = basePrice;
  for (let i = 0; i < days; i++) {
    const change = (Math.random() - 0.5) * (basePrice * 0.04);
    price = Math.max(price + change, basePrice * 0.7);
    history.push(price);
  }
  return history;
}

export function generateStock(count: number = 4000): Stock[] {
  const stocks: Stock[] = [];
  const usedSymbols = new Set<string>();

  while (stocks.length < count) {
    const sector = SECTORS[Math.floor(Math.random() * SECTORS.length)];
    const industry = INDUSTRIES[sector][Math.floor(Math.random() * INDUSTRIES[sector].length)];
    const name = generateStockName();
    let symbol = generateStockSymbol(name);

    // Ensure unique symbols
    let attempt = 0;
    while (usedSymbols.has(symbol) && attempt < 10) {
      symbol = symbol.slice(0, 3) + String.fromCharCode(65 + Math.floor(Math.random() * 26));
      attempt++;
    }
    usedSymbols.add(symbol);

    const basePrice = 10 + Math.random() * 490; // $10 to $500
    const priceHistory = generatePriceHistory(basePrice);
    const change = (Math.random() - 0.45) * 10; // Slight upward bias
    const changePercent = (change / basePrice) * 100;
    const volume = Math.floor(1000000 + Math.random() * 50000000); // 1M to 51M shares

    stocks.push({
      symbol,
      name,
      price: basePrice,
      change,
      changePercent,
      volume,
      avgVolume: Math.floor(volume * (0.8 + Math.random() * 0.4)),
      marketCap: Math.floor(basePrice * (10000000 + Math.random() * 10000000000)),
      sector,
      industry,
      priceHistory,
      lastUpdated: new Date()
    });
  }

  return stocks;
}

export function generateMarketBreadth(totalStocks: number): MarketBreadth {
  const advPct = 40 + Math.random() * 30; // 40-70% advancing on good days
  const advancing = Math.floor(totalStocks * (advPct / 100));
  const declining = Math.floor(totalStocks * ((100 - advPct) / 100) * 0.9);
  const unchanged = totalStocks - advancing - declining;

  return {
    advancing,
    declining,
    unchanged,
    total: totalStocks,
    advDecRatio: advancing / Math.max(declining, 1),
    newHighs: Math.floor(Math.random() * 300),
    newLows: Math.floor(Math.random() * 150)
  };
}

export function generateMarketIndexes(): MarketIndex[] {
  return [
    {
      name: 'S&P 500',
      symbol: 'SPX',
      value: 5400 + Math.random() * 200,
      change: (Math.random() - 0.4) * 50,
      changePercent: (Math.random() - 0.4) * 1.5
    },
    {
      name: 'NASDAQ Composite',
      symbol: 'COMP',
      value: 17500 + Math.random() * 500,
      change: (Math.random() - 0.35) * 80,
      changePercent: (Math.random() - 0.35) * 2
    },
    {
      name: 'Dow Jones',
      symbol: 'DJI',
      value: 41500 + Math.random() * 300,
      change: (Math.random() - 0.4) * 200,
      changePercent: (Math.random() - 0.4) * 0.8
    },
    {
      name: 'Russell 2000',
      symbol: 'RUT',
      value: 2100 + Math.random() * 100,
      change: (Math.random() - 0.4) * 20,
      changePercent: (Math.random() - 0.4) * 1.2
    }
  ];
}

export function generateSwingSetups(stocks: Stock[], count: number = 20): SwingSetup[] {
  const setupTypes: Array<'breakout' | 'pullback' | 'momentum' | 'reversal'> = ['breakout', 'pullback', 'momentum', 'reversal'];
  const reasons = {
    breakout: ['Breaking above 50-day MA', 'Flag pattern breakout', 'Cup and handle completion', 'Volume surge on breakout'],
    pullback: ['Pullback to 200-day support', 'Retesting key support level', 'Fibonacci retracement zone', 'Oversold RSI conditions'],
    momentum: ['Strong earnings momentum', 'Institutional accumulation', 'Sector rotation play', 'Positive news flow'],
    reversal: ['Double bottom formation', 'Bullish divergence on MACD', 'Heavy oversold conditions', 'Key reversal candle']
  };

  return stocks
    .filter(() => Math.random() > 0.95) // Top 5% of stocks
    .slice(0, count)
    .map(stock => {
      const setupType = setupTypes[Math.floor(Math.random() * setupTypes.length)];
      const entryPrice = stock.price;
      const riskReward = 2 + Math.random(); // 2:1 to 3:1 risk/reward
      const stopLoss = entryPrice * (0.95 + Math.random() * 0.03);
      const targetPrice = entryPrice + (entryPrice - stopLoss) * riskReward;

      return {
        symbol: stock.symbol,
        setupType,
        entryPrice,
        targetPrice,
        stopLoss,
        confidence: Math.floor(60 + Math.random() * 35), // 60-95%
        reason: reasons[setupType][Math.floor(Math.random() * reasons[setupType].length)]
      };
    });
}

export function generateMarketCommentary(): MarketCommentary {
  const templates = [
    {
      title: 'Market Rally Extends on Tech Strength',
      summary: 'Equities continued their upward trajectory as technology stocks led the gains, with investors showing renewed appetite for risk assets.',
      highlights: ['S&P 500 tests new resistance levels', 'NASDAQ outperforms with 2% gain', 'Volume above average', 'Sector rotation into growth names']
    },
    {
      title: 'Mixed Signals as Fed Concerns Linger',
      summary: 'Markets showed indecision as investors weighed corporate earnings against persistent inflation concerns and potential Fed policy shifts.',
      highlights: ['Financials lead gains', 'Technology lags behind', 'VIX index elevated', 'Defensive stocks attract interest']
    },
    {
      title: 'Breadth Improves in Broad-Based Advance',
      summary: 'Market internals strengthened significantly as advancing issues outnumbered decliners by a wide margin, signaling healthy participation.',
      highlights: ['Strong advance-decline ratio', 'New highs expanding', 'Small caps rally', 'Market breadth confirms trend']
    }
  ];

  const template = templates[Math.floor(Math.random() * templates.length)];
  const keyStocks = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK.B']
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);

  return {
    date: new Date(),
    title: template.title,
    summary: template.summary,
    highlights: template.highlights,
    keyStocks
  };
}

// Generate all mock data
export const mockStocks = generateStock(4000);
export const mockMarketBreadth = generateMarketBreadth(mockStocks.length);
export const mockMarketIndexes = generateMarketIndexes();
export const mockSwingSetups = generateSwingSetups(mockStocks, 25);
export const mockMarketCommentary = generateMarketCommentary();