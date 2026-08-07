import Link from 'next/link';

interface HeaderProps {
  viewMode: 'dashboard' | 'screener' | 'setups';
  onViewModeChange: (mode: 'dashboard' | 'screener' | 'setups') => void;
  stockCount: number;
}

export default function Header({ viewMode, onViewModeChange, stockCount }: HeaderProps) {
  const navItems = [
    { id: 'dashboard' as const, label: 'Dashboard', icon: '📊' },
    { id: 'screener' as const, label: 'Screener', icon: '🔍' },
    { id: 'setups' as const, label: 'Swing Setups', icon: '⚡' },
  ];

  return (
    <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-700 sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center space-x-3 group">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-emerald-500 rounded-xl flex items-center justify-center transform group-hover:scale-110 transition-transform">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-white group-hover:text-blue-400 transition-colors">
                StockEdge
              </h1>
              <p className="text-xs text-slate-400">Find your edge</p>
            </div>
          </Link>

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => onViewModeChange(item.id)}
                className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all duration-200 ${
                  viewMode === item.id
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <span className="text-lg">{item.icon}</span>
                <span className="font-medium">{item.label}</span>
              </button>
            ))}
          </nav>

          {/* Right Side */}
          <div className="flex items-center space-x-4">
            {/* Stock Count Badge */}
            <div className="hidden sm:flex items-center space-x-2 px-3 py-1.5 bg-slate-800 rounded-lg border border-slate-700">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-sm text-slate-300">{stockCount.toLocaleString()} stocks</span>
            </div>

            {/* Auth Buttons */}
            <div className="flex items-center space-x-2">
              <button className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors">
                Sign in
              </button>
              <button className="px-4 py-2 text-sm font-medium bg-gradient-to-r from-blue-600 to-emerald-600 text-white rounded-lg hover:from-blue-500 hover:to-emerald-500 transition-all duration-200 shadow-lg shadow-blue-500/25">
                Get Started
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation */}
        <nav className="md:hidden pb-3 flex space-x-2 overflow-x-auto">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => onViewModeChange(item.id)}
              className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all duration-200 whitespace-nowrap ${
                viewMode === item.id
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
              >
              <span>{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}