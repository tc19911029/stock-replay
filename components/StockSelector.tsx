'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { IntervalSwitcher } from '@/features/scan/components/IntervalSwitcher';
import { type ScanInterval, DEFAULT_PERIODS } from '@/lib/datasource/findAnchorIndex';

const DEFAULT_QUICK_STOCKS = [
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
  { symbol: '600519', name: '貴州茅台' },
  { symbol: '000858', name: '五糧液' },
  { symbol: '601318', name: '中國平安' },
  { symbol: '603986', name: '兆易創新' },
  { symbol: '300750', name: '寧德時代' },
  { symbol: '000333', name: '美的集團' },
];



// Extract raw symbol from ticker (e.g. "2330.TW" → "2330", "AAPL" → "AAPL")
function rawSymbol(ticker: string) {
  return ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

export default function StockSelector() {
  const { loadStock, isLoadingStock, currentStock, targetDate, startPolling, stopPolling } = useReplayStore();
  const [input,    setInput]    = useState('');
  // 不用 setInterval 命名，避免 mask global window.setInterval
  const [chartInterval, setChartInterval] = useState<ScanInterval>('1d');
  const [showDrop, setShowDrop] = useState(false);
  const [error,    setError]    = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync input when stock is loaded externally (e.g. via ?load= URL param from scanner)
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (currentStock?.ticker) {
      setInput(rawSymbol(currentStock.ticker));
    }
  }, [currentStock?.ticker]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 組件 unmount 時停止 polling
  useEffect(() => {
    return () => { stopPolling(); };
  }, [stopPolling]);

  const handleLoad = useCallback(async (symbol: string, iv: ScanInterval = chartInterval, keepTarget = false) => {
    setError('');
    setShowDrop(false);
    stopPolling(); // 切換股票/週期前先停止
    const pd = DEFAULT_PERIODS[iv];
    try {
      const td = keepTarget ? targetDate ?? undefined : undefined;
      await loadStock(symbol, iv, pd, td);
      startPolling(); // 載入成功後啟動 polling（內部判斷是否盤中）
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '載入失敗');
    }
  }, [chartInterval, targetDate, loadStock, startPolling, stopPolling]);

  // Auto-reload when interval changes — 保留訊號日定位
  const handleIntervalChange = (newIv: ScanInterval) => {
    setChartInterval(newIv);
    if (currentStock) handleLoad(rawSymbol(currentStock.ticker), newIv, true);
  };

  // Close dropdown on outside click
  const closeOnOutside = (e: React.MouseEvent) => {
    if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
  };

  const filtered = input.length > 0
    ? DEFAULT_QUICK_STOCKS.filter(s => s.symbol.toUpperCase().includes(input.toUpperCase()) || s.name.includes(input))
    : DEFAULT_QUICK_STOCKS;

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1" onClick={closeOnOutside}>
      {/* Search input + dropdown */}
      <div ref={wrapRef} className="relative shrink-0">
        <div className="flex items-center bg-muted rounded border border-border focus-within:border-blue-500 overflow-hidden">
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowDrop(true); }}
            onFocus={() => setShowDrop(true)}
            onKeyDown={e => { if (e.key === 'Enter' && input.trim()) handleLoad(input.trim()); }}
            aria-label="搜尋股票代號或名稱"
            placeholder="代號/名稱"
            className="w-28 bg-transparent px-2 py-1 text-xs text-foreground font-mono focus:outline-none"
          />
          {currentStock?.name && !showDrop && (
            <span className="text-[10px] text-muted-foreground pr-2 truncate max-w-[80px]">{currentStock.name}</span>
          )}
        </div>
        {showDrop && filtered.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-muted border border-border rounded shadow-xl z-50 max-h-52 overflow-y-auto">
            {filtered.map(s => (
              <button key={s.symbol}
                onClick={() => { setInput(s.symbol === 'mock' ? '' : s.symbol); handleLoad(s.symbol); }}
                className="w-full text-left px-2 py-1.5 text-xs flex gap-2 items-center min-w-0 hover:bg-muted"
              >
                <span className="font-mono text-yellow-400 w-10 shrink-0">{s.symbol === 'mock' ? '---' : s.symbol}</span>
                <span className="text-foreground/80 truncate">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load button */}
      <button onClick={() => handleLoad(input.trim() || 'mock')} disabled={isLoadingStock}
        className="shrink-0 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold transition">
        {isLoadingStock
          ? <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 border-2 border-foreground border-t-transparent rounded-full animate-spin" />載入</span>
          : '載入'}
      </button>
      <span className="text-muted-foreground/60 text-xs shrink-0">|</span>

      {/* Interval buttons — auto-reload on click */}
      <IntervalSwitcher value={chartInterval} onChange={handleIntervalChange} />

      {error && <span className="text-xs text-red-400 truncate">{error}</span>}
    </div>
  );
}
