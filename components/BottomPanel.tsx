'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, Star, Briefcase } from 'lucide-react';
import { POLLING } from '@/lib/config';
import { useWatchlistStore } from '@/store/watchlistStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { useSettingsStore } from '@/store/settingsStore';
import { type MarketTab, filterByMarket, classifyMarket } from '@/lib/market/classify';

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

  const fetchPrice = useCallback(async (symbol: string) => {
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

  // Lightweight polling via /api/portfolio/quotes
  const refreshQuotes = useCallback(async () => {
    if (uniqueSymbols.length === 0) return;
    try {
      const res = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(uniqueSymbols.join(','))}`);
      if (!res.ok) return;
      const json = await res.json();
      const quotes: Array<{ symbol: string; price: number; changePercent: number }> = json.quotes ?? [];
      setPrices(prev => {
        const next = { ...prev };
        for (const q of quotes) {
          if (q.price > 0) {
            next[q.symbol] = { ...next[q.symbol], price: q.price, changePercent: q.changePercent, loading: false };
          }
        }
        return next;
      });
    } catch {
      // Mark all as failed so UI shows error instead of stale "..."
      setPrices(prev => {
        const next = { ...prev };
        for (const s of uniqueSymbols) {
          if (!next[s] || next[s].loading) {
            next[s] = { ...next[s], price: 0, changePercent: 0, loading: false, error: '更新失敗' };
          }
        }
        return next;
      });
    }
  }, [uniqueSymbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch prices when panel opens + start 30s polling
  useEffect(() => {
    if (!open || uniqueSymbols.length === 0) return;

    // Initial fetch (full conditions for first load)
    uniqueSymbols.forEach(s => {
      if (!prices[s] || prices[s].error) fetchPrice(s);
    });

    // Start 30s lightweight polling
    pollRef.current = setInterval(refreshQuotes, POLLING.QUOTE_INTERVAL);

    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [open, uniqueSymbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Portfolio summary ──────────────────────────────────────────────────────

  const summary = holdings.reduce(
    (acc, h) => {
      const p = prices[h.symbol];
      const cur = p?.price ?? 0;
      const costVal = h.shares * h.costPrice;
      const mktVal = cur > 0 ? h.shares * cur : costVal;
      const dailyChange = cur > 0 ? h.shares * cur * (p?.changePercent ?? 0) / 100 : 0;
      acc.totalCost += costVal;
      acc.totalValue += mktVal;
      acc.totalPnL += cur > 0 ? mktVal - costVal : 0;
      acc.todayPnL += dailyChange;
      return acc;
    },
    { totalCost: 0, totalValue: 0, totalPnL: 0, todayPnL: 0 },
  );

  const totalReturnPct = summary.totalCost > 0 ? (summary.totalPnL / summary.totalCost) * 100 : 0;

  const filteredHoldings = filterByMarket(holdings, marketTab);
  const filteredWatchlist = filterByMarket(watchlist, marketTab);

  // Recalculate summary for filtered holdings
  const filteredSummary = filteredHoldings.reduce(
    (acc, h) => {
      const p = prices[h.symbol];
      const cur = p?.price ?? 0;
      const costVal = h.shares * h.costPrice;
      const mktVal = cur > 0 ? h.shares * cur : costVal;
      const dailyChange = cur > 0 ? h.shares * cur * (p?.changePercent ?? 0) / 100 : 0;
      acc.totalCost += costVal;
      acc.totalValue += mktVal;
      acc.totalPnL += cur > 0 ? mktVal - costVal : 0;
      acc.todayPnL += dailyChange;
      return acc;
    },
    { totalCost: 0, totalValue: 0, totalPnL: 0, todayPnL: 0 },
  );
  const filteredReturnPct = filteredSummary.totalCost > 0 ? (filteredSummary.totalPnL / filteredSummary.totalCost) * 100 : 0;

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
            <PortfolioContent holdings={filteredHoldings} prices={prices} summary={filteredSummary} totalReturnPct={filteredReturnPct} />
          ) : (
            <WatchlistContent watchlist={filteredWatchlist} prices={prices} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Portfolio Sub-component ──────────────────────────────────────────────────

interface PortfolioContentProps {
  holdings: ReturnType<typeof usePortfolioStore.getState>['holdings'];
  prices: Record<string, PriceInfo>;
  summary: { totalCost: number; totalValue: number; totalPnL: number; todayPnL: number };
  totalReturnPct: number;
}

function PortfolioContent({ holdings, prices, summary, totalReturnPct }: PortfolioContentProps) {
  if (holdings.length === 0) {
    return (
      <div className="py-6 text-center text-muted-foreground text-xs space-y-2">
        <p>尚無持倉</p>
        <Link href="/portfolio" className="text-sky-400 hover:text-sky-300 underline">前往新增</Link>
      </div>
    );
  }

  return (
    <div>
      {/* Summary row (styled like the app screenshot) */}
      <div className="grid grid-cols-3 gap-px bg-muted text-center text-[10px]">
        <div className="bg-card py-1.5 px-1">
          <div className="text-muted-foreground">今日損益</div>
          <div className={`font-mono font-bold text-xs ${summary.todayPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
            {summary.todayPnL >= 0 ? '+' : ''}{formatMoney(summary.todayPnL)}
          </div>
        </div>
        <div className="bg-card py-1.5 px-1">
          <div className="text-muted-foreground">累積損益</div>
          <div className={`font-mono font-bold text-xs ${summary.totalPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
            {summary.totalPnL >= 0 ? '+' : ''}{formatMoney(summary.totalPnL)}
          </div>
          <div className={`text-[9px] ${totalReturnPct >= 0 ? 'text-bull/70' : 'text-bear/70'}`}>
            {totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(2)}%
          </div>
        </div>
        <div className="bg-card py-1.5 px-1">
          <div className="text-muted-foreground">股票市值</div>
          <div className="font-mono font-bold text-xs text-foreground">{formatMoney(summary.totalValue)}</div>
          <div className="text-[9px] text-muted-foreground">成本 {formatMoney(summary.totalCost)}</div>
        </div>
      </div>

      {/* Holdings list */}
      <div className="divide-y divide-border">
        {holdings.map(h => {
          const p = prices[h.symbol];
          const cur = p?.price ?? 0;
          const pnl = cur > 0 ? (cur - h.costPrice) * h.shares : 0;
          const pnlPct = h.costPrice > 0 && cur > 0 ? ((cur - h.costPrice) / h.costPrice) * 100 : 0;
          const dailyPnL = cur > 0 ? h.shares * cur * (p?.changePercent ?? 0) / 100 : 0;

          return (
            <Link
              key={h.id}
              href={`/?load=${stripSuffix(h.symbol)}`}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted/60 transition-colors"
            >
              {/* Name + Symbol */}
              <div className="shrink-0 w-14">
                <div className="text-xs font-bold text-foreground leading-tight">{h.name || stripSuffix(h.symbol)}</div>
                <div className="text-[10px] text-muted-foreground">{stripSuffix(h.symbol)}</div>
              </div>

              {/* Today P&L */}
              <div className={`text-right text-[11px] font-mono shrink-0 w-16 ${dailyPnL >= 0 ? 'text-bull' : 'text-bear'}`}>
                {p?.loading ? '...' : dailyPnL !== 0 ? `${dailyPnL >= 0 ? '+' : ''}${formatMoney(dailyPnL)}` : '—'}
              </div>

              {/* Price + Change% */}
              <div className="text-right shrink-0 w-14">
                {p?.loading ? (
                  <span className="text-[10px] text-muted-foreground animate-pulse">...</span>
                ) : cur > 0 ? (
                  <>
                    <div className="text-[11px] font-mono font-bold text-foreground">{cur.toFixed(cur >= 100 ? 0 : 1)}</div>
                    <div className={`text-[9px] font-mono ${(p?.changePercent ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {(p?.changePercent ?? 0) >= 0 ? '+' : ''}{(p?.changePercent ?? 0).toFixed(2)}%
                    </div>
                  </>
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </div>

              {/* Total P&L */}
              <div className={`text-right shrink-0 w-20 ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {cur > 0 ? (
                  <>
                    <div className="text-[11px] font-mono font-bold">
                      {pnl >= 0 ? '+' : ''}{formatMoney(pnl)}
                    </div>
                    <div className="text-[9px] font-mono">
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                    </div>
                  </>
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </div>
            </Link>
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

function WatchlistContent({ watchlist, prices }: WatchlistContentProps) {
  if (watchlist.length === 0) {
    return (
      <div className="py-6 text-center text-muted-foreground text-xs space-y-2">
        <p>尚無自選股</p>
        <Link href="/watchlist" className="text-sky-400 hover:text-sky-300 underline">前往新增</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-border">
        {watchlist.map(item => {
          const p = prices[item.symbol];
          const isUp = (p?.changePercent ?? 0) >= 0;

          return (
            <Link
              key={item.symbol}
              href={`/?load=${stripSuffix(item.symbol)}`}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted/60 transition-colors"
            >
              <div className="shrink-0 w-14">
                <div className="text-xs font-bold text-foreground leading-tight">{p?.name ?? item.name}</div>
                <div className="text-[10px] text-muted-foreground">{stripSuffix(item.symbol)}</div>
              </div>

              {p?.loading ? (
                <span className="text-[10px] text-muted-foreground animate-pulse">載入中...</span>
              ) : p && p.price > 0 ? (
                <>
                  <div className="text-right shrink-0">
                    <div className="text-[11px] font-mono font-bold text-foreground">{p.price.toFixed(p.price >= 100 ? 0 : 1)}</div>
                  </div>
                  <div className={`text-right shrink-0 w-14 text-[11px] font-mono font-bold ${isUp ? 'text-bull' : 'text-bear'}`}>
                    {isUp ? '+' : ''}{p.changePercent.toFixed(2)}%
                  </div>
                </>
              ) : (
                <span className="text-[10px] text-muted-foreground">—</span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Footer link */}
      <div className="px-3 py-1.5 text-center border-t border-border">
        <Link href="/watchlist" className="text-[10px] text-sky-400 hover:text-sky-300">
          查看完整自選股 →
        </Link>
      </div>
    </div>
  );
}
