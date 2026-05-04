'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useWatchlistStore } from '@/store/watchlistStore';
import { useSettingsStore } from '@/store/settingsStore';
import { PageShell, EmptyState } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { formatPrice, formatPercent, formatDate, formatTime, bullBearClass } from '@/lib/format';

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
  matchedMethods?: string[];
  loading?: boolean;
  error?: string;
}

const METHOD_LABELS: Record<string, string> = {
  A: '六條件',
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底',
  E: '缺口進場',
  F: 'V形反轉',
  G: 'ABC 突破',
  H: '突破大量黑K',
  I: 'K 線橫盤突破',
};

export default function WatchlistPage() {
  const { items, remove, add, updateNote, addTag, removeTag } = useWatchlistStore();
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteInput, setNoteInput] = useState('');
  const [tagInput, setTagInput] = useState<Record<string, string>>({});
  const [data, setData] = useState<Record<string, ConditionData>>({});
  const [addInput, setAddInput] = useState('');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addLoading, setAddLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // 避免 zustand persist 與 SSR 不一致：等 client mount 後再渲染依賴 items 的內容
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => { setHasMounted(true); }, []);

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
    setLastUpdated(formatTime(new Date()));
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
      // Fast path: resolve symbol + get current price via lightweight quotes endpoint.
      // This avoids the heavy 1-year candle fetch that times out when providers are down.
      const isTwDigits = /^\d+$/.test(sym);
      const candidates = isTwDigits ? [`${sym}.TW`, `${sym}.TWO`] : [sym.toUpperCase()];

      let resolvedSymbol = '';
      let resolvedName = '';
      let resolvedPrice = 0;

      for (const candidate of candidates) {
        try {
          const qRes = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(candidate)}`);
          if (!qRes.ok) continue;
          const qJson = await qRes.json();
          const q = (qJson.quotes ?? []).find((x: { symbol: string; price: number }) => x.price > 0);
          if (q) {
            resolvedSymbol = q.symbol ?? candidate;
            resolvedName = q.name ?? '';
            resolvedPrice = q.price;
            break;
          }
        } catch { continue; }
      }

      if (!resolvedSymbol) throw new Error('找不到股票，請確認代號是否正確');

      // 查詢加入日期的收盤價，用於計算加入至今漲幅
      let addedPrice: number | undefined;
      const today = new Date().toISOString().slice(0, 10);
      if (addDate === today) {
        addedPrice = resolvedPrice > 0 ? resolvedPrice : undefined;
      } else {
        try {
          const pr = await fetch(`/api/watchlist/price-at?symbol=${encodeURIComponent(resolvedSymbol)}&date=${addDate}`);
          if (pr.ok) {
            const pd = await pr.json() as { price?: number };
            if (pd.price && pd.price > 0) addedPrice = pd.price;
          }
        } catch { /* ignore */ }
      }

      add(resolvedSymbol, resolvedName || resolvedSymbol, addedPrice, addDate + 'T00:00:00.000Z');
      setAddInput('');
      toast.success(`已加入 ${resolvedName || resolvedSymbol}${addedPrice ? `（基準 ${addedPrice}）` : ''}`);

      // Load full conditions in background (may fail gracefully)
      fetchConditions(resolvedSymbol);
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
      <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors shrink-0 text-lg leading-none">←</Link>
      <span className="font-bold text-sm whitespace-nowrap">⭐ 自選股</span>
      <span className="text-muted-foreground shrink-0">{hasMounted ? items.length : 0} 支</span>
      {lastUpdated && <span className="text-muted-foreground/60 hidden sm:block">{lastUpdated}</span>}
      <Button onClick={refreshAll} disabled={isRefreshing} variant="secondary" size="sm"
        className="flex items-center gap-1">
        <span className={isRefreshing ? 'animate-spin' : ''}>↻</span><span className="hidden sm:inline">{isRefreshing ? '刷新中' : '刷新'}</span>
      </Button>
    </div>
  );

  return (
    <PageShell headerSlot={watchlistHeader}>
      <div className="p-3 sm:p-4 max-w-4xl mx-auto space-y-3 sm:space-y-4">

        {/* Add stock input */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={addInput}
              onChange={e => setAddInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="輸入股票代號（如：2330、603986.SS）"
              className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-blue-500"
            />
            <Button onClick={handleAdd} disabled={addLoading || !addInput.trim()}
              className="bg-blue-600 hover:bg-blue-500 font-bold shrink-0">
              {addLoading ? '載入中...' : '+ 加入'}
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>加入日期（計算報酬基準）：</span>
            <input
              type="date"
              value={addDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => setAddDate(e.target.value)}
              className="bg-secondary border border-border rounded px-2 py-0.5 text-xs text-foreground focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        {hasMounted && items.length === 0 && (
          <EmptyState
            icon="⭐"
            title="尚未加入任何自選股"
            description="在上方輸入股票代號，或從掃描結果直接加入"
            cta={{ label: '前往掃描', href: '/scanner' }}
          />
        )}

        {/* Stock cards */}
        <div className="space-y-3">
          {hasMounted && sorted.map(item => {
            const d = data[item.symbol];
            const score = d?.sixConditions?.totalScore ?? null;
            const scoreColor = score == null ? 'bg-muted text-muted-foreground' :
              score >= 5 ? 'bg-green-600 text-white' :
              score >= 3 ? 'bg-yellow-500 text-black' : 'bg-muted text-foreground/80';

            return (
              <div key={item.symbol} className="bg-secondary border border-border rounded-xl overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{item.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                      <span className="text-xs text-muted-foreground truncate">{d?.name ?? item.name}</span>
                    </div>
                    {/* Strategy chips：只顯示有命中的買法 */}
                    {d && !d.loading && !d.error && (d.matchedMethods?.length ?? 0) > 0 && (
                      <div className="flex gap-1 mt-1.5 flex-wrap">
                        {(d.matchedMethods ?? []).map(m => (
                          <span key={m} className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-red-900/60 text-red-300">
                            {m} {METHOD_LABELS[m]}
                          </span>
                        ))}
                      </div>
                    )}
                    {d?.loading && <p className="text-xs text-muted-foreground mt-1 animate-pulse">載入中...</p>}
                    {d?.error && <p className="text-xs text-red-400 mt-1">⚠ {d.error}</p>}
                  </div>

                  {/* Price */}
                  {d && !d.loading && !d.error && (() => {
                    const sinceAdd = item.addedPrice && item.addedPrice > 0
                      ? (d.price - item.addedPrice) / item.addedPrice * 100
                      : null;
                    return (
                      <div className="text-right shrink-0">
                        <div className="font-mono font-bold text-foreground">{formatPrice(d.price)}</div>
                        <div className={`text-xs font-mono ${bullBearClass(d.changePercent)}`}>
                          今 {formatPercent(d.changePercent)}
                        </div>
                        {sinceAdd != null && (
                          <div className={`text-[10px] font-mono ${bullBearClass(sinceAdd)}`}>
                            自加入 {formatPercent(sinceAdd)}
                          </div>
                        )}
                      </div>
                    );
                  })()}

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
                    <Button onClick={() => remove(item.symbol)} variant="ghost" size="sm"
                      className="text-muted-foreground hover:bg-red-900/60 hover:text-red-300">
                      ✕
                    </Button>
                  </div>
                </div>

                {/* Trend / position info row */}
                {d && !d.loading && !d.error && (
                  <div className="px-4 pb-1 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-popover text-foreground/80 font-medium">{d.trend}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-popover text-foreground/80 font-medium">{d.position}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground/60">
                      加入 {formatDate(item.addedAt)}
                    </span>
                  </div>
                )}

                {/* Tags */}
                <div className="px-4 pb-1.5 flex flex-wrap items-center gap-1 min-h-[28px]">
                  {(item.tags ?? []).map(tag => (
                    <span key={tag} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-900/50 text-sky-300 border border-sky-700/40">
                      {tag}
                      <button onClick={() => removeTag(item.symbol, tag)} className="hover:text-red-400 transition-colors ml-0.5 leading-none">&times;</button>
                    </span>
                  ))}
                  <div className="flex items-center gap-0.5">
                    <input
                      value={tagInput[item.symbol] ?? ''}
                      onChange={e => setTagInput(p => ({ ...p, [item.symbol]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          const v = (tagInput[item.symbol] ?? '').trim();
                          if (v) { addTag(item.symbol, v); setTagInput(p => ({ ...p, [item.symbol]: '' })); }
                        }
                      }}
                      placeholder="+ 標籤"
                      className="text-[10px] w-16 bg-transparent border-b border-border/50 focus:border-sky-500 outline-none text-muted-foreground placeholder-muted-foreground/50 py-0.5"
                    />
                  </div>
                </div>

                {/* Note */}
                <div className="px-4 pb-2.5">
                  {editingNote === item.symbol ? (
                    <div className="flex gap-1">
                      <textarea
                        autoFocus
                        value={noteInput}
                        onChange={e => setNoteInput(e.target.value)}
                        onBlur={() => { updateNote(item.symbol, noteInput); setEditingNote(null); }}
                        onKeyDown={e => { if (e.key === 'Escape') { setNoteInput(item.note ?? ''); setEditingNote(null); } }}
                        rows={2}
                        className="flex-1 text-[11px] bg-muted/60 border border-sky-500/50 rounded px-2 py-1 text-foreground/80 resize-none focus:outline-none"
                        placeholder="記錄觀察重點（如：等回測MA20、量能不足觀察中）"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => { setNoteInput(item.note ?? ''); setEditingNote(item.symbol); }}
                      className="w-full text-left text-[11px] text-muted-foreground/60 hover:text-muted-foreground italic py-0.5"
                    >
                      {item.note ? item.note : '點擊新增筆記...'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PageShell>
  );
}
