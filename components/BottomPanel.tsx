'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { ChevronDown, Star, Briefcase } from 'lucide-react';
import { POLLING } from '@/lib/config';
import { useWatchlistStore } from '@/store/watchlistStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useReplayStore } from '@/store/replayStore';
import { type MarketTab, filterByMarket, classifyMarket } from '@/lib/market/classify';
import { calcNetPnL } from '@/lib/portfolio/fees';
import { formatPercent, bullBearClass } from '@/lib/format';

// ── Types ────────────────────────────────────────────────────────────────────

interface PriceInfo {
  price: number;
  changePercent: number;
  name?: string;
  loading?: boolean;
  error?: string;
}

type PanelTab = 'watchlist' | 'portfolio';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripSuffix(symbol: string) {
  return symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

function formatMoney(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}億`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}萬`;
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
}

// ── Component ────────────────────────────────────────────────────────────────

export default function BottomPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('portfolio');
  const [prices, setPrices] = useState<Record<string, PriceInfo>>({});
  const [marketTab, setMarketTab] = useState<MarketTab>('all');

  const watchlist = useWatchlistStore(s => s.items);
  const holdings = usePortfolioStore(s => s.holdings);

  // Collect all symbols that need prices
  const allSymbols = [
    ...watchlist.map(w => w.symbol),
    ...holdings.map(h => h.symbol),
  ];
  const uniqueSymbols = [...new Set(allSymbols)];

  const _fetchPrice = useCallback(async (symbol: string) => {
    setPrices(prev => ({ ...prev, [symbol]: { ...prev[symbol], loading: true } as PriceInfo }));
    try {
      const strategyId = useSettingsStore.getState().activeStrategyId;
      const res = await fetch(
        `/api/watchlist/conditions?symbol=${encodeURIComponent(symbol)}&strategyId=${encodeURIComponent(strategyId)}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setPrices(prev => ({
        ...prev,
        [symbol]: { price: json.price, changePercent: json.changePercent, name: json.name, loading: false },
      }));
    } catch {
      setPrices(prev => ({
        ...prev,
        [symbol]: { price: 0, changePercent: 0, loading: false, error: '—' },
      }));
    }
  }, []);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lightweight polling via /api/portfolio/quotes（穩定快路徑）
  // 改進：AbortController 卸載時取消 + 8s timeout + 連續失敗才提示
  const failureCountRef = useRef(0);
  const refreshQuotes = useCallback(async (signal?: AbortSignal) => {
    if (uniqueSymbols.length === 0) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      // Compose signals: respect external signal (for cleanup) + own timeout
      if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      const res = await fetch(
        `/api/portfolio/quotes?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`,
        { signal: ctrl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) { failureCountRef.current++; return; }
      const json = await res.json();
      const quotes: Array<{ symbol: string; price: number; changePercent: number; name?: string }> = json.quotes ?? [];
      failureCountRef.current = 0; // 成功 reset 失敗計數
      setPrices(prev => {
        const next = { ...prev };
        for (const q of quotes) {
          if (q.price > 0) {
            next[q.symbol] = { ...next[q.symbol], price: q.price, changePercent: q.changePercent, loading: false, ...(q.name ? { name: q.name } : {}) };
          }
        }
        return next;
      });

      // Auto-backfill: 用 quote 帶回的真實 name 寫回 store
      const portfolioState = usePortfolioStore.getState();
      for (const q of quotes) {
        if (!q.name || q.price <= 0) continue;
        const holding = portfolioState.holdings.find(h => h.symbol === q.symbol);
        if (!holding) continue;
        const codeOnly = stripSuffix(holding.symbol);
        const namePlaceholder = !holding.name || holding.name === holding.symbol || holding.name === codeOnly;
        const marketMissing = !holding.market;
        if (namePlaceholder || marketMissing) {
          const market: 'TW' | 'CN' = classifyMarket(holding.symbol) === 'CN' ? 'CN' : 'TW';
          portfolioState.update(holding.id, {
            ...(namePlaceholder ? { name: q.name } : {}),
            ...(marketMissing ? { market } : {}),
          });
        }
      }
    } catch (err) {
      // AbortError = 元件 unmount / 換股，不算失敗
      if (err instanceof Error && err.name === 'AbortError') return;
      failureCountRef.current++;
      // 連續 3 次失敗才標 error 並 toast，避免單次 timeout 就誤報
      if (failureCountRef.current >= 3) {
        setPrices(prev => {
          const next = { ...prev };
          for (const s of uniqueSymbols) {
            if (!next[s] || next[s].loading) {
              next[s] = { ...next[s], price: 0, changePercent: 0, loading: false, error: '更新失敗' };
            }
          }
          return next;
        });
        toast.error('報價連續更新失敗，請檢查網路', { id: 'quote-error', duration: 4000 });
        failureCountRef.current = 0;
      }
    }
  }, [uniqueSymbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch prices when panel opens + start 30s polling
  useEffect(() => {
    if (!open || uniqueSymbols.length === 0) return;

    // 立即取得輕量報價（不用 watchlist/conditions，那個會 timeout）
    refreshQuotes();

    // Start 30s lightweight polling
    pollRef.current = setInterval(refreshQuotes, POLLING.QUOTE_INTERVAL);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [open, uniqueSymbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Portfolio summary ──────────────────────────────────────────────────────

  function calcSummary(list: typeof holdings) {
    return list.reduce(
      (acc, h) => {
        const p = prices[h.symbol];
        const cur = p?.price ?? 0;
        const costVal = h.shares * h.costPrice;
        const mktVal = cur > 0 ? h.shares * cur : costVal;
        const dailyChange = cur > 0 ? h.shares * cur * (p?.changePercent ?? 0) / 100 : 0;
        const { pnl } = calcNetPnL(h.symbol, h.shares, h.costPrice, cur);
        acc.totalCost += costVal;
        acc.totalValue += mktVal;
        acc.totalPnL += pnl;
        acc.todayPnL += dailyChange;
        return acc;
      },
      { totalCost: 0, totalValue: 0, totalPnL: 0, todayPnL: 0 },
    );
  }

  const filteredHoldings = filterByMarket(holdings, marketTab);
  const filteredWatchlist = filterByMarket(watchlist, marketTab);

  const filteredSummary = calcSummary(filteredHoldings);
  const filteredReturnPct = filteredSummary.totalCost > 0 ? (filteredSummary.totalPnL / filteredSummary.totalCost) * 100 : 0;

  // 分市場 summary（全部 tab 時顯示 TWD / CNY 分開）
  const twSummary = calcSummary(filterByMarket(filteredHoldings, 'TW'));
  const cnSummary = calcSummary(filterByMarket(filteredHoldings, 'CN'));
  const twReturnPct = twSummary.totalCost > 0 ? (twSummary.totalPnL / twSummary.totalCost) * 100 : 0;
  const cnReturnPct = cnSummary.totalCost > 0 ? (cnSummary.totalPnL / cnSummary.totalCost) * 100 : 0;

  const itemCount = tab === 'watchlist' ? filteredWatchlist.length : filteredHoldings.length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="shrink-0 border-t border-border bg-card/80 rounded-b-lg overflow-hidden">
      {/* Header bar — always visible */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted transition-colors"
      >
        <div className="flex items-center gap-2">
          {tab === 'watchlist' ? <Star className="w-3 h-3 text-yellow-400" /> : <Briefcase className="w-3 h-3 text-sky-400" />}
          <span className="font-medium">{tab === 'watchlist' ? '自選股' : '持倉'}</span>
          <span className="text-muted-foreground">{itemCount}</span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Collapsible content */}
      <div className={`transition-all duration-300 ${open ? 'max-h-[320px]' : 'max-h-0'} overflow-hidden`}>
        {/* Tab switcher */}
        <div className="flex border-b border-border text-[11px]">
          {([
            { key: 'portfolio' as PanelTab, label: '持倉', icon: Briefcase },
            { key: 'watchlist' as PanelTab, label: '自選股', icon: Star },
          ]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-1.5 font-medium transition-colors ${
                tab === t.key ? 'text-sky-400 border-b border-sky-400 bg-secondary/50' : 'text-muted-foreground hover:text-foreground/80'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Market filter */}
        <div className="flex gap-1 px-2 py-1.5 border-b border-border">
          {([
            { id: 'all' as MarketTab, label: '全部' },
            { id: 'TW' as MarketTab, label: '台股' },
            { id: 'CN' as MarketTab, label: '陸股' },
          ]).map(m => (
            <button
              key={m.id}
              onClick={() => setMarketTab(m.id)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                marketTab === m.id
                  ? 'bg-sky-600 text-foreground'
                  : 'bg-secondary text-muted-foreground hover:bg-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="overflow-y-auto max-h-[270px]">
          {tab === 'portfolio' ? (
            <PortfolioContent
              holdings={filteredHoldings}
              prices={prices}
              summary={filteredSummary}
              totalReturnPct={filteredReturnPct}
              marketTab={marketTab}
              twSummary={twSummary}
              cnSummary={cnSummary}
              twReturnPct={twReturnPct}
              cnReturnPct={cnReturnPct}
            />
          ) : (
            <WatchlistContent watchlist={filteredWatchlist} prices={prices} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Portfolio Sub-component ──────────────────────────────────────────────────

type SummaryData = { totalCost: number; totalValue: number; totalPnL: number; todayPnL: number };

interface PortfolioContentProps {
  holdings: ReturnType<typeof usePortfolioStore.getState>['holdings'];
  prices: Record<string, PriceInfo>;
  summary: SummaryData;
  totalReturnPct: number;
  marketTab: MarketTab;
  twSummary: SummaryData;
  cnSummary: SummaryData;
  twReturnPct: number;
  cnReturnPct: number;
}

function SummaryRow({ label, summary, returnPct, currency }: { label?: string; summary: SummaryData; returnPct: number; currency: string }) {
  return (
    <div className="grid grid-cols-3 gap-px bg-muted text-center text-[10px]">
      <div className="bg-card py-1 px-1">
        {label && <div className="text-[9px] text-sky-400 font-bold">{label}</div>}
        <div className="text-muted-foreground">今日損益</div>
        <div className={`font-mono font-bold text-xs ${summary.todayPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
          {summary.todayPnL >= 0 ? '+' : ''}{formatMoney(summary.todayPnL)}
        </div>
      </div>
      <div className="bg-card py-1 px-1">
        <div className="text-muted-foreground">累積損益</div>
        <div className={`font-mono font-bold text-xs ${summary.totalPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
          {summary.totalPnL >= 0 ? '+' : ''}{formatMoney(summary.totalPnL)}
        </div>
        <div className={`text-[9px] ${returnPct >= 0 ? 'text-bull/70' : 'text-bear/70'}`}>
          {formatPercent(returnPct)}
        </div>
      </div>
      <div className="bg-card py-1 px-1">
        <div className="text-muted-foreground">市值 <span className="text-[9px] text-muted-foreground/60">{currency}</span></div>
        <div className="font-mono font-bold text-xs text-foreground">{formatMoney(summary.totalValue)}</div>
        <div className="text-[9px] text-muted-foreground">成本 {formatMoney(summary.totalCost)}</div>
      </div>
    </div>
  );
}

function PortfolioContent({ holdings, prices, summary, totalReturnPct, marketTab, twSummary, cnSummary, twReturnPct, cnReturnPct }: PortfolioContentProps) {
  if (holdings.length === 0) {
    return (
      <div className="py-6 text-center text-muted-foreground text-xs space-y-2">
        <p>尚無持倉</p>
        <Link href="/portfolio" className="text-sky-400 hover:text-sky-300 underline">前往新增</Link>
      </div>
    );
  }

  const hasTW = twSummary.totalCost > 0 || holdings.some(h => classifyMarket(h.symbol) === 'TW');
  const hasCN = cnSummary.totalCost > 0 || holdings.some(h => classifyMarket(h.symbol) === 'CN');

  return (
    <div>
      {/* Summary — 全部時分 TWD/CNY 兩列，單市場時一列 */}
      {marketTab === 'all' && hasTW && hasCN ? (
        <>
          <SummaryRow label="台幣" summary={twSummary} returnPct={twReturnPct} currency="TWD" />
          <SummaryRow label="人民幣" summary={cnSummary} returnPct={cnReturnPct} currency="CNY" />
        </>
      ) : (
        <SummaryRow
          summary={summary}
          returnPct={totalReturnPct}
          currency={marketTab === 'CN' ? 'CNY' : 'TWD'}
        />
      )}

      {/* Holdings list */}
      <div className="divide-y divide-border">
        {holdings.map(h => {
          const p = prices[h.symbol];
          const cur = p?.price ?? 0;
          const isCN = classifyMarket(h.symbol) === 'CN';
          const lotSize = isCN ? 100 : 1000;
          const lots = h.shares / lotSize;
          const { pnl, pnlPct } = calcNetPnL(h.symbol, h.shares, h.costPrice, cur);
          const dailyPnL = cur > 0 ? h.shares * cur * (p?.changePercent ?? 0) / 100 : 0;

          return (
            <button
              key={h.id}
              onClick={() => { const s = useReplayStore.getState(); s.loadStock(stripSuffix(h.symbol)).then(() => s.startPolling()); }}
              className="w-full px-3 py-2 hover:bg-muted/60 transition-colors text-left"
            >
              {/* Row 1: Name/Code/張數 ── Price + Change% */}
              <div className="flex items-baseline justify-between">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="text-xs font-bold text-foreground truncate">{p?.name || h.name || stripSuffix(h.symbol)}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{stripSuffix(h.symbol)}</span>
                  <span className="text-[9px] text-muted-foreground/60 shrink-0">{lots % 1 === 0 ? lots : lots.toFixed(1)}張</span>
                </div>
                <div className="text-right shrink-0 ml-2">
                  {p?.loading ? (
                    <span className="text-[10px] text-muted-foreground animate-pulse">...</span>
                  ) : cur > 0 ? (
                    <span className="text-[11px] font-mono font-bold text-foreground">
                      {cur.toFixed(cur >= 100 ? 0 : 2)}
                      <span className={`ml-1 text-[9px] ${bullBearClass(p?.changePercent ?? 0)}`}>
                        {formatPercent(p?.changePercent ?? 0)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">—</span>
                  )}
                </div>
              </div>

              {/* Row 2: 今日損益 ── 累積損益 */}
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-[9px] text-muted-foreground">
                  今日
                  <span className={`ml-1 font-mono ${dailyPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {p?.loading ? '...' : dailyPnL !== 0 ? `${dailyPnL >= 0 ? '+' : ''}${formatMoney(dailyPnL)}` : '—'}
                  </span>
                </span>
                <span className="text-[9px] text-muted-foreground">
                  累積
                  {cur > 0 ? (
                    <span className={`ml-1 font-mono font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {pnl >= 0 ? '+' : ''}{formatMoney(pnl)}
                      <span className="font-normal ml-1">({formatPercent(pnlPct, 1)})</span>
                    </span>
                  ) : <span className="ml-1 text-muted-foreground">—</span>}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer link */}
      <div className="px-3 py-1.5 text-center border-t border-border">
        <Link href="/portfolio" className="text-[10px] text-sky-400 hover:text-sky-300">
          查看完整持倉 →
        </Link>
      </div>
    </div>
  );
}

// ── Watchlist Sub-component ──────────────────────────────────────────────────

interface WatchlistContentProps {
  watchlist: ReturnType<typeof useWatchlistStore.getState>['items'];
  prices: Record<string, PriceInfo>;
}

function WatchlistNoteEditor({ symbol, note }: { symbol: string; note?: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(note ?? '');
  const updateNote = useWatchlistStore(s => s.updateNote);

  const save = () => {
    updateNote(symbol, val.trim());
    setEditing(false);
  };

  return (
    <div className="px-3 pb-1.5" onClick={e => e.stopPropagation()}>
      {editing ? (
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="w-full text-[9px] bg-muted/40 border border-border rounded px-1.5 py-0.5 text-foreground outline-none"
          placeholder="加備注..."
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full text-left text-[9px] text-muted-foreground hover:text-foreground/70 truncate"
        >
          {val ? val : <span className="italic opacity-50">加備注...</span>}
        </button>
      )}
    </div>
  );
}

/** 自動補取加入時收盤價（L1 本地快取，失敗靜默） */
function useFetchAddedPrice(symbol: string, addedAt: string, hasPrice: boolean) {
  const updateAddedPrice = useWatchlistStore(s => s.updateAddedPrice);
  useEffect(() => {
    if (hasPrice) return;
    const date = addedAt.slice(0, 10);
    fetch(`/api/watchlist/price-at?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { price?: number } | null) => {
        if (d?.price && d.price > 0) updateAddedPrice(symbol, d.price);
      })
      .catch(() => {});
  }, [symbol, addedAt, hasPrice, updateAddedPrice]);
}

function WatchlistItemRow({ item, prices }: { item: ReturnType<typeof useWatchlistStore.getState>['items'][0]; prices: Record<string, PriceInfo> }) {
  const p = prices[item.symbol];
  const cur = p?.price ?? 0;
  const sinceAddedPct = item.addedPrice && cur > 0
    ? ((cur - item.addedPrice) / item.addedPrice) * 100
    : null;

  useFetchAddedPrice(item.symbol, item.addedAt, !!item.addedPrice);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => { const s = useReplayStore.getState(); s.loadStock(stripSuffix(item.symbol)).then(() => s.startPolling()); }}
        className="w-full px-3 pt-2 pb-1 hover:bg-muted/60 transition-colors text-left"
      >
        {/* Row 1: 名稱+代號 | 現價+今日% */}
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-xs font-bold text-foreground truncate">{p?.name ?? item.name}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">{stripSuffix(item.symbol)}</span>
          </div>
          <div className="text-right shrink-0 ml-2">
            {p?.loading ? (
              <span className="text-[10px] text-muted-foreground animate-pulse">...</span>
            ) : cur > 0 ? (
              <span className="text-[11px] font-mono font-bold text-foreground">
                {cur.toFixed(cur >= 100 ? 0 : 2)}
                <span className={`ml-1 text-[9px] ${bullBearClass(p?.changePercent ?? 0)}`}>
                  {formatPercent(p?.changePercent ?? 0)}
                </span>
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground">—</span>
            )}
          </div>
        </div>

        {/* Row 2: 加入日期 | 加入至今漲幅 */}
        <div className="flex items-baseline justify-between mt-0.5">
          <span className="text-[9px] text-muted-foreground">
            加入 {item.addedAt.slice(0, 10)}
          </span>
          {sinceAddedPct != null ? (
            <span className={`text-[9px] font-mono ${bullBearClass(sinceAddedPct)}`}>
              {formatPercent(sinceAddedPct)}
            </span>
          ) : (
            <span className="text-[9px] text-muted-foreground/40 animate-pulse">抓取中...</span>
          )}
        </div>
      </button>

      {/* Row 3: 備注（獨立，不觸發走圖） */}
      <WatchlistNoteEditor symbol={item.symbol} note={item.note} />
    </div>
  );
}

function WatchlistContent({ watchlist, prices }: WatchlistContentProps) {
  if (watchlist.length === 0) {
    return (
      <div className="py-6 text-center text-muted-foreground text-xs space-y-2">
        <p>尚無自選股</p>
        <Link href="/watchlist" className="text-sky-400 hover:text-sky-300 underline">前往新增</Link>
      </div>
    );
  }

  const twList = watchlist.filter(i => classifyMarket(i.symbol) === 'TW');
  const cnList = watchlist.filter(i => classifyMarket(i.symbol) === 'CN');

  function marketSummary(list: typeof watchlist, label: string) {
    if (list.length === 0) return null;
    const withReturn = list.filter(i => i.addedPrice && (prices[i.symbol]?.price ?? 0) > 0);
    const avgPct = withReturn.length > 0
      ? withReturn.reduce((sum, i) => {
          const cur = prices[i.symbol]?.price ?? 0;
          return sum + ((cur - i.addedPrice!) / i.addedPrice!) * 100;
        }, 0) / withReturn.length
      : null;

    return (
      <div className="grid grid-cols-3 gap-px bg-muted text-center text-[10px] border-b border-border">
        <div className="bg-card py-1 px-1">
          <div className="text-[9px] text-sky-400 font-bold">{label}</div>
          <div className="text-muted-foreground">{list.length} 支</div>
        </div>
        <div className="bg-card py-1 px-1 col-span-2">
          <div className="text-muted-foreground">加入平均漲幅</div>
          {avgPct != null ? (
            <div className={`font-mono font-bold text-xs ${bullBearClass(avgPct)}`}>
              {formatPercent(avgPct)}
            </div>
          ) : (
            <div className="text-muted-foreground/40 text-[9px]">計算中...</div>
          )}
        </div>
      </div>
    );
  }

  const hasBoth = twList.length > 0 && cnList.length > 0;

  return (
    <div>
      {/* 市場匯總（有台股+陸股時各顯一行） */}
      {hasBoth ? (
        <>
          {marketSummary(twList, '台股')}
          {marketSummary(cnList, '陸股')}
        </>
      ) : twList.length > 0 ? (
        marketSummary(twList, '台股')
      ) : (
        marketSummary(cnList, '陸股')
      )}

      <div>
        {watchlist.map(item => (
          <WatchlistItemRow key={item.symbol} item={item} prices={prices} />
        ))}
      </div>

      <div className="px-3 py-1.5 text-center border-t border-border">
        <Link href="/watchlist" className="text-[10px] text-sky-400 hover:text-sky-300">
          查看完整自選股 →
        </Link>
      </div>
    </div>
  );
}
