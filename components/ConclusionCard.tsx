'use client';

/**
 * ConclusionCard.tsx — 訊號頁面頂部結論卡（草案 A 緊湊型，2026-05-09 新增）
 *
 * 設計目的：
 *   訊號分頁原本 4 個面板（V12SignalAlerts / ProhibitionAlerts / WinnerPatternAlerts / RuleAlerts）
 *   資訊太雜，使用者抱怨「不知道要幹嘛」。本卡片放最頂，給「一句話結論」+ 停損/停利 + 跟隨均線。
 *
 * 持股中：「📍 持股中｜🟢 繼續持有 / 🔴 該出場」+ 停損 + 停利 + 跟隨均線
 * 未持倉：「📭 未持倉｜🟢 可進場 / 🟡 觀察 / 🔴 不要進場」+ 假設進場停損 + 停利 + 跟隨均線
 */

import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal, SignalSubtype } from '@/lib/rules/signalClassifier';
import { calcKLineStopLoss } from '@/lib/sell/v12StopLoss';
import { getOperationMA } from '@/lib/sell/v12Operation';
import { getTickSize } from '@/lib/utils/tickSize';
import { marketFromSymbol } from '@/lib/utils/shareUnits';
import type { V12Letter } from '@/lib/analysis/v12Signals';

interface Verdict {
  emoji: string;
  label: string;
  color: string;
  basis: string;
}

function getVerdict(
  hasPosition: boolean,
  signals: ReturnType<typeof classifySignal>[],
  signalLabels: { entry: string[]; exit: string[] },
): Verdict {
  const counts: Record<SignalSubtype, number> = {
    entry_strong: 0, entry_soft: 0, exit_strong: 0, exit_soft: 0, trend: 0, warn: 0,
  };
  for (const s of signals) counts[s]++;

  if (hasPosition) {
    if (counts.exit_strong > 0) {
      return { emoji: '🔴', label: '該出場', color: 'text-rose-400', basis: signalLabels.exit.slice(0, 2).join('、') || '硬出場訊號觸發' };
    }
    if (counts.exit_soft >= 2) {
      return { emoji: '🟠', label: '減碼或緊盯', color: 'text-amber-400', basis: signalLabels.exit.slice(0, 2).join('、') };
    }
    if (counts.exit_soft === 1 && counts.entry_strong > 0) {
      return { emoji: '🟡', label: '方向不明，緊盯', color: 'text-yellow-400', basis: '進場+出場同時觸發' };
    }
    if (counts.exit_soft === 1) {
      return { emoji: '🟡', label: '緊盯停損', color: 'text-yellow-300', basis: signalLabels.exit[0] ?? '輕微減碼警示' };
    }
    return { emoji: '🟢', label: '繼續持有', color: 'text-emerald-400', basis: '多頭延續、無出場訊號' };
  }

  // 未持倉
  if (counts.entry_strong > 0 && counts.exit_strong === 0 && counts.exit_soft === 0) {
    return { emoji: '🟢', label: '可進場', color: 'text-emerald-400', basis: signalLabels.entry.slice(0, 2).join('、') || '進場訊號成立' };
  }
  if (counts.entry_strong > 0 && (counts.exit_strong > 0 || counts.exit_soft > 0)) {
    return { emoji: '🟡', label: '不追高、等確認', color: 'text-yellow-400', basis: '進場+出場同時觸發' };
  }
  if (counts.exit_strong > 0 || counts.exit_soft > 0) {
    return { emoji: '🔴', label: '空手觀望', color: 'text-rose-400', basis: signalLabels.exit.slice(0, 2).join('、') || '轉弱訊號' };
  }
  if (counts.entry_soft > 0) {
    return { emoji: '🟡', label: '觀察', color: 'text-yellow-300', basis: signalLabels.entry.slice(0, 1).join('、') ?? '觀察中' };
  }
  return { emoji: '⚪', label: '持續觀察', color: 'text-muted-foreground', basis: '無明確訊號' };
}

function formatPositionLine(price: number, costPrice: number | undefined, pnlPct: number | null): string {
  if (costPrice == null) return `${price.toFixed(2)}`;
  const pnlStr = pnlPct != null ? ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)` : '';
  return `${price.toFixed(2)} 元（成本 ${costPrice.toFixed(2)}${pnlStr}）`;
}

export default function ConclusionCard() {
  const { currentSignals, allCandles, currentIndex, currentStock } = useReplayStore();
  const { holdings } = usePortfolioStore();

  const candle = allCandles[currentIndex];
  const ticker = currentStock?.ticker ?? '';
  const market = marketFromSymbol(ticker);

  if (!candle || !ticker) return null;

  const currentSymbol = ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const heldPosition = holdings.find(h => h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === currentSymbol);
  const hasPosition = !!heldPosition;

  // 訊號分類
  const subtypes = currentSignals.map(s => s.subtype ?? classifySignal(s));
  const entryLabels = currentSignals.filter(s => (s.subtype ?? classifySignal(s)).startsWith('entry')).map(s => s.label);
  const exitLabels = currentSignals.filter(s => (s.subtype ?? classifySignal(s)).startsWith('exit')).map(s => s.label);
  const verdict = getVerdict(hasPosition, subtypes, { entry: entryLabels, exit: exitLabels });

  // 停損/停利估算（簡化版 — 持倉用實際成本，未持倉用今日 close 當假設進場價）
  const entryPrice = heldPosition?.costPrice ?? candle.close;
  const tickSize = getTickSize(entryPrice, market);
  const klineStop = calcKLineStopLoss(candle, tickSize);
  const absoluteFloor = entryPrice * 0.90;
  const stopLoss = Math.max(klineStop, absoluteFloor);
  const slPct = ((stopLoss - candle.close) / candle.close) * 100;

  // 預估停利：預設 +10% 獲利（型態目標需要 N 訊號的 patternTargetPrice，
  // 由 V12SignalAlerts 該面板顯示，避免重複 API 呼叫）
  const profitTarget = entryPrice * 1.10;
  const ptPct = ((profitTarget - candle.close) / candle.close) * 100;

  // 主訊號字母（持倉用 holding.triggerSignal；未持倉預設 'B'）
  const primaryLetter = (heldPosition?.triggerSignal ?? 'B') as V12Letter;
  const operatingMA = getOperationMA(primaryLetter, 'short');

  // P&L
  const pnlPct = (heldPosition?.costPrice && candle.close)
    ? ((candle.close - heldPosition.costPrice) / heldPosition.costPrice) * 100
    : null;

  return (
    <div className="bg-card border border-border/60 rounded-lg p-3 space-y-2">
      {/* 持倉狀態列 */}
      <div className="flex items-center justify-between text-xs">
        <span className={`font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
          {hasPosition ? '📍 持股中' : '📭 未持倉'}
        </span>
        <span className="font-mono text-foreground/80">
          {formatPositionLine(candle.close, heldPosition?.costPrice, pnlPct)}
        </span>
      </div>

      {/* 結論 + 根據 */}
      <div>
        <p className={`text-base font-bold ${verdict.color}`}>
          {verdict.emoji} {verdict.label}
        </p>
        {verdict.basis && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{verdict.basis}</p>
        )}
      </div>

      {/* 停損 / 停利 + 跟隨均線（緊湊型一行） */}
      <div className="border-t border-border/40 pt-2 space-y-0.5">
        {!hasPosition && (
          <p className="text-[10px] text-muted-foreground/80">若今日進場 {candle.close.toFixed(2)}：</p>
        )}
        <p className="text-xs font-mono">
          <span className="text-rose-300">停損 {stopLoss.toFixed(2)}</span>
          <span className="text-[10px] opacity-70 ml-0.5">({slPct.toFixed(1)}%)</span>
          <span className="text-muted-foreground"> · </span>
          <span className="text-emerald-300">停利 {profitTarget.toFixed(2)}</span>
          <span className="text-[10px] opacity-70 ml-0.5">({ptPct >= 0 ? '+' : ''}{ptPct.toFixed(1)}%)</span>
        </p>
        {operatingMA && (
          <p className="text-[10px] text-muted-foreground">
            {primaryLetter} · 跟隨 {operatingMA}
          </p>
        )}
      </div>

      <p className="text-[9px] text-muted-foreground/50 text-center mt-1">
        簡略結論卡 — 詳細訊號分組見下方
      </p>
    </div>
  );
}
