'use client';

/**
 * ConclusionCard.tsx — 訊號頁面頂部結論卡（草案 A 緊湊型，2026-05-09 新增）
 *
 * 設計目的：
 *   訊號分頁原本 4 個面板（V12SignalAlerts / ProhibitionAlerts / WinnerPatternAlerts / RuleAlerts）
 *   資訊太雜，使用者抱怨「不知道要幹嘛」。本卡片放最頂，給「一句話結論」+ 停損/停利 + 跟隨均線。
 *
 * 持股中：「持股中｜繼續持有 / 該出場」+ 停損 + 停利 + 跟隨均線
 * 未持倉：「未持倉｜可進場 / 觀察 / 不要進場」+ 假設進場停損 + 停利 + 跟隨均線
 *
 * UI 規範（用戶反饋 feedback_no_emoji_in_panels）：
 *   - 不用裝飾 emoji（📭/📍/⚪/🟢/🟡/🔴）
 *   - 用「左邊顏色色條」+ 文字標籤表達狀態強度
 */

import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal, SignalSubtype } from '@/lib/rules/signalClassifier';
import { calcKLineStopLoss } from '@/lib/sell/v12StopLoss';
import { getOperationMA } from '@/lib/sell/v12Operation';
import { getTickSize } from '@/lib/utils/tickSize';
import { marketFromSymbol } from '@/lib/utils/shareUnits';
import type { V12Letter } from '@/lib/analysis/v12Signals';

type StrengthLevel = 'good' | 'warn' | 'bad' | 'neutral';

interface Verdict {
  level: StrengthLevel;
  label: string;
  basis: string;
}

const STRENGTH_TEXT: Record<StrengthLevel, string> = {
  good:    'text-emerald-300',
  warn:    'text-amber-300',
  bad:     'text-rose-300',
  neutral: 'text-foreground/70',
};

const STRENGTH_BAR: Record<StrengthLevel, string> = {
  good:    'bg-emerald-500',
  warn:    'bg-amber-500',
  bad:     'bg-rose-500',
  neutral: 'bg-border',
};

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
      return { level: 'bad', label: '該出場', basis: signalLabels.exit.slice(0, 2).join('、') || '硬出場訊號觸發' };
    }
    if (counts.exit_soft >= 2) {
      return { level: 'warn', label: '減碼或緊盯', basis: signalLabels.exit.slice(0, 2).join('、') };
    }
    if (counts.exit_soft === 1 && counts.entry_strong > 0) {
      return { level: 'warn', label: '方向不明，緊盯', basis: '進場+出場同時觸發' };
    }
    if (counts.exit_soft === 1) {
      return { level: 'warn', label: '緊盯停損', basis: signalLabels.exit[0] ?? '輕微減碼警示' };
    }
    return { level: 'good', label: '繼續持有', basis: '多頭延續、無出場訊號' };
  }

  // 未持倉
  if (counts.entry_strong > 0 && counts.exit_strong === 0 && counts.exit_soft === 0) {
    return { level: 'good', label: '可進場', basis: signalLabels.entry.slice(0, 2).join('、') || '進場訊號成立' };
  }
  if (counts.entry_strong > 0 && (counts.exit_strong > 0 || counts.exit_soft > 0)) {
    return { level: 'warn', label: '不追高、等確認', basis: '進場+出場同時觸發' };
  }
  if (counts.exit_strong > 0 || counts.exit_soft > 0) {
    return { level: 'bad', label: '空手觀望', basis: signalLabels.exit.slice(0, 2).join('、') || '轉弱訊號' };
  }
  if (counts.entry_soft > 0) {
    return { level: 'warn', label: '觀察', basis: signalLabels.entry.slice(0, 1).join('、') ?? '觀察中' };
  }
  return { level: 'neutral', label: '無動作訊號', basis: '今日無明確進出場訊號' };
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

  const profitTarget = entryPrice * 1.10;
  const ptPct = ((profitTarget - candle.close) / candle.close) * 100;

  const primaryLetter = (heldPosition?.triggerSignal ?? 'B') as V12Letter;
  const operatingMA = getOperationMA(primaryLetter, 'short');

  const pnlPct = (heldPosition?.costPrice && candle.close)
    ? ((candle.close - heldPosition.costPrice) / heldPosition.costPrice) * 100
    : null;

  return (
    <div className="bg-card border border-border/60 rounded-lg overflow-hidden flex">
      {/* 左邊強度色條（替代 emoji） */}
      <div className={`w-1 shrink-0 ${STRENGTH_BAR[verdict.level]}`} />
      <div className="flex-1 p-3 space-y-2">
        {/* 持倉狀態列 */}
        <div className="flex items-center justify-between text-xs">
          <span className={`font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
            {hasPosition ? '持股中' : '未持倉'}
          </span>
          <span className="font-mono text-foreground/80">
            {candle.close.toFixed(2)}
            {heldPosition?.costPrice != null && (
              <>
                <span className="text-muted-foreground"> · 成本 </span>
                {heldPosition.costPrice.toFixed(2)}
                {pnlPct != null && (
                  <span className={`ml-1 ${pnlPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                    ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                  </span>
                )}
              </>
            )}
          </span>
        </div>

        {/* 結論 + 根據 */}
        <div>
          <p className={`text-base font-bold ${STRENGTH_TEXT[verdict.level]}`}>
            {verdict.label}
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

        <p className="text-[9px] text-muted-foreground/50 mt-1">
          簡略結論卡 — 詳細訊號分組見下方
        </p>
      </div>
    </div>
  );
}
