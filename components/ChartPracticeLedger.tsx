'use client';

/**
 * 走圖練習簿 — 跟著走圖游標做紙上模擬交易
 *
 * - 從 useReplayStore 讀當前股票 + 當下游標 candle（日期 + 收盤）
 * - 從 usePracticeStore 讀該檔的 session（每檔獨立 ledger）
 * - 買賣按鈕用該日收盤價成交、扣手續費（5.7 折）+ 證交稅（賣出 0.3%）
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, RotateCcw, Settings, Undo2 } from 'lucide-react';
import { useReplayStore } from '@/store/replayStore';
import { useChartSyncStore } from '@/store/chartSyncStore';
import { usePracticeStore } from '@/store/practiceStore';
import {
  deriveSessionSummary,
  calcTradeCost,
  practiceKey,
} from '@/lib/practice/calcPractice';
import { formatNumber, formatPercent, bullBearClass } from '@/lib/format';
import { lotSizeOf, unitLabelOf, marketFromSymbol } from '@/lib/utils/shareUnits';
import type { MarketId } from '@/lib/scanner/types';

function stripSuffix(symbol: string): string {
  return symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

const FALLBACK_SESSION = {
  symbol: '',
  market: 'TW' as MarketId,
  initialCapital: 1_000_000,
  feeDiscount: 0.57,
  trades: [] as ReturnType<typeof usePracticeStore.getState>['sessions'][string]['trades'],
  createdAt: '',
};

export function ChartPracticeLedger() {
  // 全部 hooks 都先呼叫，避免 Rules of Hooks 違規
  const currentStock = useReplayStore(s => s.currentStock);
  const currentIndex = useReplayStore(s => s.currentIndex);
  const allCandles = useReplayStore(s => s.allCandles);
  const crosshairTime = useChartSyncStore(s => s.lastCrosshairTime);

  const [open, setOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [customLots, setCustomLots] = useState(1);
  // 手動成交日期 / 價格（空字串 = 跟隨走圖游標；用戶填了就以填的為準）
  const [customDate, setCustomDate] = useState<string>('');
  const [customPrice, setCustomPrice] = useState<string>('');

  const tickerRaw = currentStock?.ticker ?? '';
  // 排除：未載入 / 範例資料 / 大盤指數（^TWII、000001.SS、^GSPC…）
  const isIndex = tickerRaw.startsWith('^') || /^(000001|399001)\.S[SZ]$/i.test(tickerRaw);
  const isReady = !!currentStock && currentStock.ticker !== 'DEMO' && !isIndex;
  const market: MarketId = isReady ? marketFromSymbol(tickerRaw) : 'TW';
  const code = isReady ? stripSuffix(tickerRaw) : '';
  const lot = lotSizeOf(market);
  const unitLabel = unitLabelOf(market);
  const sessionKey = isReady ? practiceKey(market, tickerRaw) : '';

  const sessionFromStore = usePracticeStore(s => (sessionKey ? s.sessions[sessionKey] : undefined));

  // 第一次進該股自動建 session（useEffect，不在 render 期間 mutate store）
  useEffect(() => {
    if (!isReady || sessionFromStore) return;
    usePracticeStore.getState().getOrCreate(market, tickerRaw);
  }, [isReady, sessionFromStore, market, tickerRaw]);

  // 切換股票時，把手動成交欄位 reset 回「跟隨游標」
  useEffect(() => {
    setCustomDate('');
    setCustomPrice('');
  }, [tickerRaw]);

  const liveSession = sessionFromStore ?? { ...FALLBACK_SESSION, symbol: code, market };

  // 優先用 hover 在走圖上的那根 K（讓人滑回過去日期成交），無 hover 就用 replay currentIndex
  const hoverCandle = useMemo(() => {
    if (!crosshairTime) return null;
    const target = String(crosshairTime).slice(0, 10);
    return allCandles.find(c => c.date.slice(0, 10) === target) ?? null;
  }, [crosshairTime, allCandles]);
  const cursor = hoverCandle ?? allCandles[currentIndex];
  const cursorDate = cursor?.date ?? null;
  const cursorPrice = cursor?.close ?? null;
  const isHover = !!hoverCandle;

  const summary = useMemo(
    () => deriveSessionSummary(liveSession, cursorPrice ?? undefined),
    [liveSession, cursorPrice],
  );

  const sortedTrades = useMemo(
    () => [...liveSession.trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [liveSession.trades],
  );

  // 沒選股不顯示（所有 hooks 已呼叫完）
  if (!isReady) return null;

  const ticker = tickerRaw;

  // 自訂區的有效值：使用者輸入優先，沒填就跟隨走圖游標
  const effDateRaw = customDate || (cursorDate ? cursorDate.slice(0, 10) : '');
  const parsedCustomPrice = customPrice ? parseFloat(customPrice) : NaN;
  const effPrice = Number.isFinite(parsedCustomPrice) && parsedCustomPrice > 0 ? parsedCustomPrice : cursorPrice;
  const customShares = customLots * lot;
  const buyPreview = effPrice != null && effPrice > 0
    ? calcTradeCost(effPrice, customShares, 'BUY', market, code, liveSession.feeDiscount)
    : null;
  const sellPreview = effPrice != null && effPrice > 0
    ? calcTradeCost(effPrice, customShares, 'SELL', market, code, liveSession.feeDiscount)
    : null;

  // ── 行動 handlers ───────────────────────────────────────────────────

  const canTrade = cursorDate != null && cursorPrice != null && cursorPrice > 0;
  const canCustomTrade = !!effDateRaw && effPrice != null && effPrice > 0;
  const buyCost = effPrice != null && buyPreview
    ? customShares * effPrice + buyPreview.fee
    : 0;
  const canBuy = canCustomTrade && summary.cash >= buyCost && customLots > 0;
  const canSell = canCustomTrade && summary.position.shares >= customShares && customLots > 0;
  const canSellAll = canTrade && summary.position.shares > 0;

  // All-in：用現有現金能買到的最大張數（整數張，預留手續費）
  const allInLots = (() => {
    if (!canTrade || cursorPrice == null) return 0;
    // 一張總成本 ≈ price × lot × (1 + 0.001425 × feeDiscount)
    const costPerLot = cursorPrice * lot * (1 + 0.001425 * liveSession.feeDiscount);
    return Math.max(0, Math.floor(summary.cash / costPerLot));
  })();
  const allInShares = allInLots * lot;
  const canAllIn = canTrade && allInLots > 0;

  function doBuy(shares: number, opts?: { date?: string; price?: number }) {
    const tradeDate = opts?.date ?? (cursorDate ? cursorDate.slice(0, 10) : '');
    const tradePrice = opts?.price ?? cursorPrice;
    if (!tradeDate || !tradePrice || tradePrice <= 0) return;
    if (shares <= 0) return;
    const cost = calcTradeCost(tradePrice, shares, 'BUY', market, code, liveSession.feeDiscount);
    const total = shares * tradePrice + cost.fee;
    if (summary.cash < total) {
      toast.error(`現金不足，需要 ${formatNumber(Math.round(total))}，剩 ${formatNumber(Math.round(summary.cash))}`);
      return;
    }
    usePracticeStore.getState().buy(market, ticker, {
      date: tradeDate,
      shares,
      price: tradePrice,
    });
    toast.success(`買 ${shares / lot} ${unitLabel} @ ${tradePrice.toFixed(2)}（${tradeDate}）`);
  }

  function doSell(shares: number, opts?: { date?: string; price?: number }) {
    const tradeDate = opts?.date ?? (cursorDate ? cursorDate.slice(0, 10) : '');
    const tradePrice = opts?.price ?? cursorPrice;
    if (!tradeDate || !tradePrice || tradePrice <= 0) return;
    if (shares <= 0) return;
    if (shares > summary.position.shares) {
      toast.error(`持有不足，只能賣 ${summary.position.shares / lot} ${unitLabel}`);
      return;
    }
    usePracticeStore.getState().sell(market, ticker, {
      date: tradeDate,
      shares,
      price: tradePrice,
    });
    toast.success(`賣 ${shares / lot} ${unitLabel} @ ${tradePrice.toFixed(2)}（${tradeDate}）`);
  }

  function doUndo() {
    if (liveSession.trades.length === 0) return;
    usePracticeStore.getState().undoLastTrade(market, ticker);
    toast.success('已復原最後一筆');
  }

  function doReset() {
    if (liveSession.trades.length === 0) return;
    if (!window.confirm(`確定清空 ${code} 的所有練習交易？此操作不可復原。`)) return;
    usePracticeStore.getState().resetSession(market, ticker);
    toast.success('已重置練習簿');
  }

  // ── Render ──────────────────────────────────────────────────────────

  const sharesDisplay = summary.position.shares > 0
    ? `${summary.position.shares / lot}${unitLabel} @ ${summary.position.avgCost.toFixed(2)}`
    : '無';

  return (
    <div className="border-t border-border bg-card/50">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-bold">📒</span>
          <span className="font-medium text-foreground">走圖練習簿</span>
          <span className="text-muted-foreground">{code}</span>
          {summary.position.shares > 0 && (
            <span className="text-[10px] text-sky-400">
              {summary.position.shares / lot}{unitLabel}
            </span>
          )}
          {summary.tradeCount > 0 && (
            <span className={`text-[10px] font-mono ${bullBearClass(summary.totalReturn)}`}>
              {formatPercent(summary.totalReturn * 100)}
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-3 pb-2 space-y-2 text-[10px]">
          {/* Summary grid */}
          <div className="grid grid-cols-3 gap-1 pt-1">
            <Stat label="初始" value={formatNumber(Math.round(liveSession.initialCapital))} />
            <Stat label="現金" value={formatNumber(Math.round(summary.cash))} accent />
            <Stat label="持有" value={sharesDisplay} />

            <Stat
              label="已實現"
              value={`${summary.position.realizedPnL >= 0 ? '+' : ''}${formatNumber(Math.round(summary.position.realizedPnL))}`}
              tone={summary.position.realizedPnL >= 0 ? 'bull' : 'bear'}
            />
            <Stat
              label="未實現"
              value={summary.position.shares > 0
                ? `${summary.unrealizedPnL >= 0 ? '+' : ''}${formatNumber(Math.round(summary.unrealizedPnL))}`
                : '—'}
              tone={summary.unrealizedPnL >= 0 ? 'bull' : 'bear'}
            />
            <Stat
              label="總報酬"
              value={summary.tradeCount > 0 ? formatPercent(summary.totalReturn * 100) : '—'}
              tone={summary.totalReturn >= 0 ? 'bull' : 'bear'}
            />
          </div>

          {/* 跟著走圖 — 當日成交區 */}
          <div className="bg-muted/30 rounded px-2 py-1.5 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {isHover ? '滑鼠停在：' : '跟著走圖：'}
                {cursorDate ? (
                  <>
                    <span className={`font-mono ${isHover ? 'text-amber-300' : 'text-foreground'}`}>{cursorDate.slice(0, 10)}</span>
                    <span className="ml-1.5">收</span>
                    <span className={`ml-0.5 font-mono font-bold ${isHover ? 'text-amber-300' : 'text-foreground'}`}>
                      {cursorPrice?.toFixed(2)}
                    </span>
                    {isHover && <span className="ml-1 text-[8px] text-amber-400/80">(在此買賣)</span>}
                  </>
                ) : (
                  <span className="italic">未選擇日期</span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowSettings(s => !s)}
                  className="p-0.5 text-muted-foreground hover:text-foreground"
                  title="設定"
                >
                  <Settings className="w-3 h-3" />
                </button>
                <button
                  onClick={doUndo}
                  disabled={liveSession.trades.length === 0}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                  title="復原最後一筆"
                >
                  <Undo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={doReset}
                  disabled={liveSession.trades.length === 0}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                  title="重置練習簿"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* 快速按鈕 — 一鍵 All In / 全賣，要分批用下方自訂張數 */}
            <div className="flex flex-wrap gap-1">
              <ActionButton
                disabled={!canAllIn}
                tone="bull"
                onClick={() => doBuy(allInShares)}
                title={canAllIn ? `用現金買 ${allInLots} ${unitLabel}（約 ${formatNumber(Math.round(allInShares * (cursorPrice ?? 0)))}）` : undefined}
              >
                All In{canAllIn ? ` ${allInLots}${unitLabel}` : ''}
              </ActionButton>
              <ActionButton
                disabled={!canSellAll}
                tone="bear"
                onClick={() => doSell(summary.position.shares)}
              >
                全賣{canSellAll ? ` ${summary.position.shares / lot}${unitLabel}` : ''}
              </ActionButton>
            </div>

            {/* 自訂日期 / 價格 / 張數 — 可手動 override，買賣用這裡的值 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground shrink-0">自訂</span>
              <input
                type="date"
                value={effDateRaw}
                onChange={e => setCustomDate(e.target.value)}
                className="px-1 py-0.5 bg-card border border-border rounded text-foreground font-mono outline-none focus:border-sky-400"
                title="成交日（可改成過去日期）"
              />
              <input
                type="number"
                step="0.01"
                min={0}
                placeholder={cursorPrice != null ? cursorPrice.toFixed(2) : '價格'}
                value={customPrice}
                onChange={e => setCustomPrice(e.target.value)}
                className="w-16 px-1 py-0.5 bg-card border border-border rounded text-foreground font-mono text-right outline-none focus:border-sky-400"
                title="成交價（空白＝游標當日收盤）"
              />
              <input
                type="number"
                min={1}
                value={customLots}
                onChange={e => setCustomLots(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-12 px-1 py-0.5 bg-card border border-border rounded text-foreground font-mono text-center outline-none focus:border-sky-400"
                title="張數"
              />
              <span className="text-muted-foreground shrink-0">{unitLabel}</span>
              {(customDate || customPrice) && (
                <button
                  type="button"
                  onClick={() => { setCustomDate(''); setCustomPrice(''); }}
                  className="px-1 py-0.5 text-[9px] text-amber-300 hover:text-amber-200 underline"
                  title="重設成游標當日"
                >
                  跟游標
                </button>
              )}
              <ActionButton
                disabled={!canBuy}
                tone="bull"
                onClick={() => doBuy(customShares, { date: effDateRaw, price: effPrice ?? undefined })}
                title={buyPreview ? `費 ${formatNumber(buyPreview.fee)}` : undefined}
              >
                買進
              </ActionButton>
              <ActionButton
                disabled={!canSell}
                tone="bear"
                onClick={() => doSell(customShares, { date: effDateRaw, price: effPrice ?? undefined })}
                title={sellPreview ? `費 ${formatNumber(sellPreview.fee)} 稅 ${formatNumber(sellPreview.tax)}` : undefined}
              >
                賣出
              </ActionButton>
            </div>

            <div className="text-[9px] text-muted-foreground/70">
              手續費 {(liveSession.feeDiscount * 100).toFixed(0)}% 折
              {market === 'TW' && ' + 0.3% 證交稅'}
              {market === 'CN' && ' + 0.05% 印花稅'}
            </div>
          </div>

          {/* 設定 popover */}
          {showSettings && (
            <div className="bg-secondary/60 rounded px-2 py-1.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0">初始資金</span>
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={liveSession.initialCapital}
                  onChange={e => {
                    const v = parseInt(e.target.value) || 0;
                    usePracticeStore.getState().setInitialCapital(market, ticker, v);
                  }}
                  className="flex-1 px-1.5 py-0.5 bg-card border border-border rounded text-foreground font-mono outline-none focus:border-sky-400"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground shrink-0">手續費折數</span>
                <input
                  type="number"
                  min={0.1}
                  max={1}
                  step={0.01}
                  value={liveSession.feeDiscount}
                  onChange={e => {
                    const v = parseFloat(e.target.value) || 1;
                    usePracticeStore.getState().setFeeDiscount(market, ticker, v);
                  }}
                  className="w-16 px-1.5 py-0.5 bg-card border border-border rounded text-foreground font-mono outline-none focus:border-sky-400"
                />
                <span className="text-[9px] text-muted-foreground">
                  ({(liveSession.feeDiscount * 100).toFixed(0)}% 折)
                </span>
              </div>
            </div>
          )}

          {/* 交易紀錄 */}
          {sortedTrades.length > 0 && (
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              <div className="text-[9px] text-muted-foreground/70 sticky top-0 bg-card/80 backdrop-blur px-1 py-0.5">
                紀錄 {sortedTrades.length} 筆
              </div>
              {sortedTrades.map(t => (
                <div
                  key={t.id}
                  className="flex items-center justify-between px-1 py-0.5 font-mono text-[9.5px]"
                >
                  <span className="text-muted-foreground shrink-0">{t.date.slice(5)}</span>
                  <span
                    className={`shrink-0 w-7 text-center font-bold ${
                      t.side === 'BUY' ? 'text-bull' : 'text-bear'
                    }`}
                  >
                    {t.side === 'BUY' ? '買' : '賣'}
                  </span>
                  <span className="shrink-0 w-12 text-right text-foreground">
                    {t.shares / lot}{unitLabel}
                  </span>
                  <span className="shrink-0 w-14 text-right text-foreground">
                    {t.price.toFixed(2)}
                  </span>
                  <span className="shrink-0 w-14 text-right text-muted-foreground/80">
                    費{formatNumber(t.fee)}
                  </span>
                  {t.side === 'SELL' && t.tax > 0 && (
                    <span className="shrink-0 w-14 text-right text-muted-foreground/80">
                      稅{formatNumber(t.tax)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  accent,
}: {
  label: string;
  value: string;
  tone?: 'bull' | 'bear';
  accent?: boolean;
}) {
  const toneClass =
    tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : accent ? 'text-sky-400' : 'text-foreground';
  return (
    <div className="bg-card/80 rounded px-1.5 py-1">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`font-mono font-bold text-[10.5px] truncate ${toneClass}`}>{value}</div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: 'bull' | 'bear';
  title?: string;
}) {
  const base =
    tone === 'bull'
      ? 'bg-red-900/60 hover:bg-red-800 border-red-700/50 text-red-100'
      : 'bg-green-900/60 hover:bg-green-800 border-green-700/50 text-green-100';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2 py-0.5 border rounded font-medium text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${base}`}
    >
      {children}
    </button>
  );
}
