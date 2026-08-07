export interface Stock {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  sector: string;
  industry: string;
  priceHistory: number[];
  lastUpdated: Date;
}

export interface MarketBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  total: number;
  advDecRatio: number;
  newHighs: number;
  newLows: number;
}

export interface MarketIndex {
  name: string;
  symbol: string;
  value: number;
  change: number;
  changePercent: number;
}

export interface SwingSetup {
  symbol: string;
  setupType: 'breakout' | 'pullback' | 'momentum' | 'reversal';
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
  confidence: number;
  reason: string;
}

export interface MarketCommentary {
  date: Date;
  title: string;
  summary: string;
  highlights: string[];
  keyStocks: string[];
}
