'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import { PageShell } from '@/components/shared';

interface ConditionData {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  trend: string;
  position: string;
  hasBuySignal: boolean;
  sixConditions: {
    totalScore: number;
    trend: { pass: boolean; detail: string };
    position: { pass: boolean; detail: string };
    kbar: { pass: boolean; detail: string };
    ma: { pass: boolean; detail: string };
    volume: { pass: boolean; detail: string };
    indicator: { pass: boolean; detail: string };
  };
  surgeScore?: number;
  surgeGrade?: string;
  surgeFlags?: string[];
  loading?: boolean;
  error?: string;
}

const COND_KEYS = ['trend', 'position', 'kbar', 'ma', 'volume', 'indicator'] as const;
const COND_NAMES: Record<string, string> = { trend: '趨勢', position: '位置', kbar: 'K棒', ma: '均線', volume: '量能', indicator: '指標' };

export default function WatchlistPage() {
  const { items, remove, add } = useWatchlistStore();
  const [data, setData] = useState<Record<string, ConditionData>>({});
  const [addInput, setAddInput] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchConditions = useCallback(async (symbol: string) => {
    setData(prev => ({ ...prev, [symbol]: { ...prev[symbol], loading: true, error: undefined } as ConditionData }));
    try {
      const res = await fetch(`/api/watchlist/conditions?symbol=${encodeURIComponent(symbol)}&strategyId=${encodeURIComponent(useSettingsStore.getState().activeStrategyId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(prev => ({ ...prev, [symbol]: { ...json, loading: false } }));
    } catch (err) {
      setData(prev => ({ ...prev, [symbol]: { ...prev[symbol], loading: false, error: err instanceof Error ? err.message : '載入失敗' } as ConditionData }));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.allSettled(items.map(item => fetchConditions(item.symbol)));
    setLastUpdated(new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
    setIsRefreshing(false);
  }, [items, fetchConditions]);

  // 使用 items 的 symbol 列表作為依賴，確保新增/移除都觸發刷新
  const itemKeys = items.map(i => i.symbol).join(',');
  useEffect(() => {
    refreshAll();
  }, [itemKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd() {
    const sym = addInput.trim();
    if (!sym) return;
    setAddLoading(true);
    try {
      const res = await fetch(`/api/watchlist/conditions?symbol=${encodeURIComponent(sym)}&strategyId=${encodeURIComponent(useSettingsStore.getState().activeStrategyId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      add(json.symbol, json.name);
      setData(prev => ({ ...prev, [json.symbol]: { ...json, loading: false } }));
      setAddInput('');
      toast.success(`已加入 ${json.name || json.symbol}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '找不到股票，請確認代號是否正確');
    } finally {
      setAddLoading(false);
    }
  }

  const sorted = [...items].sort((a, b) => {
    // Sort by surgeScore first, then sixConditions
    const surgeA = data[a.symbol]?.surgeScore ?? -1;
    const surgeB = data[b.symbol]?.surgeScore ?? -1;
    if (surgeA !== surgeB) return surgeB - surgeA;
    const sa = data[a.symbol]?.sixConditions?.totalScore ?? -1;
    const sb = data[b.symbol]?.sixConditions?.totalScore ?? -1;
    return sb - sa;
  });

  const watchlistHeader = (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-bold text-sm whitespace-nowrap">⭐ 自選股</span>
      <span className="text-muted-foreground shrink-0">{items.length} 支</span>
      {lastUpdated && <span className="text-muted-foreground/60 hidden sm:block">{lastUpdated}</span>}
      <button onClick={refreshAll} disabled={isRefreshing}
        className="px-2 py-1 bg-muted hover:bg-muted/80 disabled:opacity-50 rounded transition text-foreground/80 flex items-center gap-1 font-medium">
        <span className={isRefreshing ? 'animate-spin' : ''}>↻</span><span className="hidden sm:inline">{isRefreshing ? '刷新中' : '刷新'}</span>
      </button>
    </div>
  );

  return (
    <PageShell headerSlot={watchlistHeader}>
      <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-3 sm:space-y-4">

        {/* Add stock input */}
        <div className="flex gap-2">
          <input
            value={addInput}
            onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="輸入股票代號（如：2330、AAPL）"
            className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-blue-500"
          />
          <button onClick={handleAdd} disabled={addLoading || !addInput.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-sm font-bold transition">
            {addLoading ? '載入中...' : '+ 加入'}
          </button>
        </div>
        {items.length === 0 && (
          <div className="text-center py-20 text-muted-foreground border border-dashed border-border rounded-xl">
            <p className="text-5xl mb-4">⭐</p>
            <p className="text-sm font-medium text-muted-foreground">尚未加入任何自選股</p>
            <p className="text-xs text-muted-foreground/60 mt-1">在上方輸入股票代號，或從掃描結果直接加入</p>
            <Link href="/scanner" className="inline-block mt-4 text-xs px-4 py-1.5 bg-blue-600/80 hover:bg-blue-500 rounded-lg text-foreground font-medium transition">
              前往掃描
            </Link>
          </div>
        )}

        {/* Stock cards */}
        <div className="space-y-3">
          {sorted.map(item => {
            const d = data[item.symbol];
            const score = d?.sixConditions?.totalScore ?? null;
            const isUp = (d?.changePercent ?? 0) >= 0;
            const scoreColor = score == null ? 'bg-muted text-muted-foreground' :
              score >= 5 ? 'bg-green-600 text-white' :
              score >= 3 ? 'bg-yellow-500 text-black' : 'bg-muted text-foreground/80';

            return (
              <div key={item.symbol} className={`bg-secondary border rounded-xl overflow-hidden ${
                d?.hasBuySignal ? 'border-red-500/50' : 'border-border'
              }`}>
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{item.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                      <span className="text-xs text-muted-foreground truncate">{d?.name ?? item.name}</span>
                      {d?.hasBuySignal && <span className="text-[10px] bg-red-600 text-foreground px-1.5 py-0.5 rounded font-bold">買入訊號</span>}
                    </div>
                    {/* Condition chips */}
                    {d?.sixConditions && (
                      <div className="flex gap-1 mt-1.5 flex-wrap">
                        {COND_KEYS.map(key => (
                          <span key={key} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            d.sixConditions[key]?.pass ? 'bg-red-900/60 text-red-300' : 'bg-muted text-muted-foreground line-through'
                          }`}>{COND_NAMES[key]}</span>
                        ))}
                      </div>
                    )}
                    {d?.loading && <p className="text-xs text-muted-foreground mt-1 animate-pulse">載入中...</p>}
                    {d?.error && <p className="text-xs text-red-400 mt-1">⚠ {d.error}</p>}
                  </div>

                  {/* Price */}
                  {d && !d.loading && !d.error && (
                    <div className="text-right shrink-0">
                      <div className="font-mono font-bold text-foreground">${d.price.toFixed(2)}</div>
                      <div className={`text-xs font-mono ${isUp ? 'text-bull' : 'text-bear'}`}>
                        {isUp ? '+' : ''}{d.changePercent.toFixed(2)}%
                      </div>
                    </div>
                  )}

                  {/* Surge grade badge */}
                  {d?.surgeGrade && (
                    <span className={`text-xs font-black w-7 h-7 flex items-center justify-center rounded-lg shrink-0 ${
                      d.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                      d.surgeGrade === 'A' ? 'bg-orange-500 text-white' :
                      d.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
                      'bg-muted text-foreground/80'
                    }`}>{d.surgeGrade}</span>
                  )}

                  {/* Score badge */}
                  {score != null && (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded shrink-0 ${scoreColor}`}>
                      {score}/6
                    </span>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1 shrink-0">
                    <Link
                      href={`/?load=${item.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold transition"
                    >走圖</Link>
                    <button onClick={() => remove(item.symbol)}
                      className="px-2 py-1 bg-muted hover:bg-red-900/60 hover:text-red-300 rounded text-xs text-muted-foreground transition">
                      ✕
                    </button>
                  </div>
                </div>

                {/* Trend / position info row */}
                {d && !d.loading && !d.error && (
                  <div className="px-4 pb-2.5 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-popover text-foreground/80 font-medium">{d.trend}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-popover text-foreground/80 font-medium">{d.position}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/60">
                      加入 {new Date(item.addedAt).toLocaleDateString('zh-TW')}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
