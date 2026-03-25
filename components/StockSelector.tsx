'use client';

import { useState, useRef } from 'react';
import { useReplayStore } from '@/store/replayStore';

const QUICK_STOCKS = [
  { symbol: 'mock',  name: '📊 範例資料（離線）' },
  { symbol: '2330',  name: '台積電' },
  { symbol: '2317',  name: '鴻海' },
  { symbol: '2454',  name: '聯發科' },
  { symbol: '2308',  name: '台達電' },
  { symbol: '6770',  name: '力積電' },
  { symbol: '3008',  name: '大立光' },
  { symbol: '2382',  name: '廣達' },
  { symbol: '2881',  name: '富邦金' },
  { symbol: '2882',  name: '國泰金' },
  { symbol: '2412',  name: '中華電' },
  { symbol: '2357',  name: '華碩' },
  { symbol: '2303',  name: '聯電' },
  { symbol: 'AAPL',  name: 'Apple' },
  { symbol: 'TSLA',  name: 'Tesla' },
  { symbol: 'NVDA',  name: 'NVIDIA' },
];

const INTERVALS = [
  { label: '日K', value: '1d' },
  { label: '週K', value: '1wk' },
  { label: '月K', value: '1mo' },
];

const PERIODS: Record<string, { label: string; value: string }[]> = {
  '1d':  [{ label:'1年', value:'1y' }, { label:'2年', value:'2y' }, { label:'3年', value:'3y' }, { label:'5年', value:'5y' }],
  '1wk': [{ label:'2年', value:'2y' }, { label:'5年', value:'5y' }, { label:'10年', value:'10y' }],
  '1mo': [{ label:'5年', value:'5y' }, { label:'10年', value:'10y' }, { label:'20年', value:'20y' }],
};

// Extract raw symbol from ticker (e.g. "2330.TW" → "2330", "AAPL" → "AAPL")
function rawSymbol(ticker: string) {
  return ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

export default function StockSelector() {
  const { loadStock, isLoadingStock, currentStock } = useReplayStore();
  const [input,    setInput]    = useState('');
  const [interval, setInterval] = useState('1d');
  const [period,   setPeriod]   = useState('2y');
  const [showDrop, setShowDrop] = useState(false);
  const [error,    setError]    = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const handleLoad = async (symbol: string, iv = interval, pd = period) => {
    setError('');
    setShowDrop(false);
    try {
      await loadStock(symbol, iv, pd);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '載入失敗');
    }
  };

  // Auto-reload when interval changes
  const handleIntervalChange = (newIv: string) => {
    const opts = PERIODS[newIv] ?? [];
    const newPd = opts.find(o => o.value === period) ? period : (opts[0]?.value ?? period);
    setInterval(newIv);
    setPeriod(newPd);
    if (currentStock) handleLoad(rawSymbol(currentStock.ticker), newIv, newPd);
  };

  // Auto-reload when period changes
  const handlePeriodChange = (newPd: string) => {
    setPeriod(newPd);
    if (currentStock) handleLoad(rawSymbol(currentStock.ticker), interval, newPd);
  };

  // Close dropdown on outside click
  const handleWrapClick = () => {};
  typeof handleWrapClick; // suppress unused warning
  const closeOnOutside = (e: React.MouseEvent) => {
    if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
  };

  const filtered = input.length > 0
    ? QUICK_STOCKS.filter(s => s.symbol.toUpperCase().includes(input.toUpperCase()) || s.name.includes(input))
    : QUICK_STOCKS;

  const periodOpts = PERIODS[interval] ?? PERIODS['1d'];

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1" onClick={closeOnOutside}>
      {/* Search input + dropdown */}
      <div ref={wrapRef} className="relative w-44 shrink-0">
        <input
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value); setShowDrop(true); }}
          onFocus={() => setShowDrop(true)}
          onKeyDown={e => { if (e.key === 'Enter' && input.trim()) handleLoad(input.trim()); }}
          placeholder="代號或名稱"
          className="w-full bg-slate-700 rounded px-2 py-1 text-xs text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
        />
        {showDrop && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-slate-700 border border-slate-600 rounded shadow-xl z-50 max-h-52 overflow-y-auto">
            {filtered.map(s => (
              <button key={s.symbol}
                onClick={() => { setInput(s.symbol === 'mock' ? '' : s.symbol); handleLoad(s.symbol); }}
                className="w-full text-left px-2 py-1.5 hover:bg-slate-600 text-xs flex gap-2 items-center"
              >
                <span className="font-mono text-yellow-400 w-10 shrink-0">{s.symbol === 'mock' ? '---' : s.symbol}</span>
                <span className="text-slate-300 truncate">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load button */}
      <button onClick={() => handleLoad(input.trim() || 'mock')} disabled={isLoadingStock}
        className="shrink-0 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold transition">
        {isLoadingStock
          ? <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" />載入</span>
          : '載入'}
      </button>

      <span className="text-slate-600 text-xs shrink-0">|</span>

      {/* Interval buttons — auto-reload on click */}
      <div className="flex gap-0.5 shrink-0">
        {INTERVALS.map(opt => (
          <button key={opt.value} onClick={() => handleIntervalChange(opt.value)}
            className={`px-2 py-1 rounded text-xs font-bold transition ${
              interval === opt.value ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* Period buttons — auto-reload on click */}
      <div className="flex gap-0.5 shrink-0">
        {periodOpts.map(opt => (
          <button key={opt.value} onClick={() => handlePeriodChange(opt.value)}
            className={`px-2 py-1 rounded text-xs transition ${
              period === opt.value ? 'bg-slate-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-400'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {error && <span className="text-xs text-red-400 truncate">{error}</span>}
    </div>
  );
}
