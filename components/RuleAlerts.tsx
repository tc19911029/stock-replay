'use client';

import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { RuleSignal } from '@/types';
import { classifySignal, subtypeToActionLabel, SignalSubtype } from '@/lib/rules/signalClassifier';
import ChartCoachAdvice from './ChartCoachAdvice';
import { formatSharesAsLots, marketFromSymbol } from '@/lib/utils/shareUnits';

function getFirstReasonLine(reason: string): string {
  const lines = reason.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('【'));
  return lines[0] ?? '';
}

/** 分類後的訊號（subtype 已確定） */
interface ClassifiedSignal extends RuleSignal {
  subtype: SignalSubtype;
}

function classifyAll(signals: RuleSignal[]): ClassifiedSignal[] {
  return signals.map(s => ({ ...s, subtype: s.subtype ?? classifySignal(s) }));
}

function countBySubtype(signals: ClassifiedSignal[]): Record<SignalSubtype, number> {
  const c: Record<SignalSubtype, number> = {
    entry_strong: 0, entry_soft: 0, exit_strong: 0, exit_soft: 0, trend: 0, warn: 0,
  };
  for (const s of signals) c[s.subtype]++;
  return c;
}

type ActionAdvice = { text: string; basis: string; color: string };

/**
 * 依持倉狀態分流建議。
 *
 * 持股中（hasPosition=true）：看「該不該出場」
 *   - 硬出場訊號 → 明確出場
 *   - 軟出場≥2  → 減碼警示
 *   - 軟出場=1 + 強進場 → 矛盾，緊盯盤面
 *   - 僅趨勢/警示 → 續抱
 *
 * 空手中（hasPosition=false）：看「該不該進場」
 *   - 強進場 + 無出場 → 可進場
 *   - 強進場 + 有出場 → 不追高
 *   - 只有出場 → 空手觀望
 *   - 僅趨勢/警示 → 持續觀察
 */
function getActionAdvice(
  signals: ClassifiedSignal[],
  ma5: number | null | undefined,
  hasPosition: boolean,
): ActionAdvice {
  const counts = countBySubtype(signals);
  const actionCount = counts.entry_strong + counts.entry_soft + counts.exit_strong + counts.exit_soft;

  // 抓代表性 label 當「根據」說明
  const exitStrongLabels = signals.filter(s => s.subtype === 'exit_strong').map(s => s.label);
  const exitSoftLabels   = signals.filter(s => s.subtype === 'exit_soft').map(s => s.label);
  const entryStrongLabels = signals.filter(s => s.subtype === 'entry_strong').map(s => s.label);
  const ma5Str = ma5 ? `（守MA5=${ma5.toFixed(0)}）` : '';

  if (actionCount === 0) {
    return hasPosition
      ? { text: '無出場訊號，續抱', basis: '', color: 'text-red-300' }
      : { text: '無進場訊號，持續觀察', basis: '', color: 'text-muted-foreground' };
  }

  if (hasPosition) {
    // 持股中：優先看出場訊號
    if (counts.exit_strong > 0) {
      return {
        text: '硬出場訊號觸發 → 出場',
        basis: exitStrongLabels.join('、'),
        color: 'text-green-400',
      };
    }
    if (counts.exit_soft >= 2) {
      return {
        text: '多項減碼警示 → 減碼或緊盯',
        basis: exitSoftLabels.join('、'),
        color: 'text-green-300',
      };
    }
    if (counts.exit_soft === 1 && counts.entry_strong > 0) {
      return {
        text: '方向不明 → 持股緊盯明日',
        basis: `${exitSoftLabels[0]} 與 ${entryStrongLabels[0]} 同時觸發`,
        color: 'text-yellow-400',
      };
    }
    if (counts.exit_soft === 1) {
      return {
        text: '輕微減碼警示 → 緊盯停損',
        basis: exitSoftLabels.join('、'),
        color: 'text-yellow-300',
      };
    }
    // 只剩進場/趨勢 → 續抱
    return { text: `多頭延續 → 續抱${ma5Str}`, basis: '', color: 'text-red-300' };
  }

  // 空手中：看進場訊號
  if (counts.entry_strong > 0 && counts.exit_strong === 0 && counts.exit_soft === 0) {
    return {
      text: `進場訊號成立 → 可進場${ma5Str}`,
      basis: entryStrongLabels.join('、'),
      color: 'text-red-400',
    };
  }
  if (counts.entry_strong > 0 && (counts.exit_strong > 0 || counts.exit_soft > 0)) {
    const exitLabels = counts.exit_strong > 0 ? exitStrongLabels : exitSoftLabels;
    return {
      text: '進場+出場同時觸發 → 不追高、等確認',
      basis: `${entryStrongLabels[0]} vs ${exitLabels[0]}`,
      color: 'text-yellow-400',
    };
  }
  if (counts.exit_strong > 0 || counts.exit_soft > 0) {
    return {
      text: '轉弱訊號 → 空手觀望勿進場',
      basis: [...exitStrongLabels, ...exitSoftLabels].join('、'),
      color: 'text-green-400',
    };
  }
  if (counts.entry_soft > 0) {
    return {
      text: '觀察中，未具備硬進場條件',
      basis: signals.filter(s => s.subtype === 'entry_soft').map(s => s.label).join('、'),
      color: 'text-muted-foreground',
    };
  }
  return { text: '無明確訊號，持續觀察', basis: '', color: 'text-muted-foreground' };
}

type Direction = { label: string; icon: string; color: string; detail: string };

/**
 * 整體偏向只看「會觸發動作」的訊號（entry/exit），trend/warn 不列入計算。
 * 避免「1 持股 vs 5 出場 → 多空分歧」這種誤導。
 */
function getDirection(signals: ClassifiedSignal[]): Direction {
  const buyCount  = signals.filter(s => s.subtype === 'entry_strong' || s.subtype === 'entry_soft').length;
  const sellCount = signals.filter(s => s.subtype === 'exit_strong' || s.subtype === 'exit_soft').length;

  if (buyCount === 0 && sellCount === 0) {
    return { label: '無動作訊號', icon: '◇', color: 'text-muted-foreground', detail: '僅趨勢或警示訊號' };
  }
  if (buyCount > 0 && sellCount === 0) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 個進場` };
  }
  if (sellCount > 0 && buyCount === 0) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${sellCount} 個出場` };
  }
  if (buyCount >= sellCount * 2) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 進場 / ${sellCount} 出場` };
  }
  if (sellCount >= buyCount * 2) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${buyCount} 進場 / ${sellCount} 出場` };
  }
  return { label: '多空分歧', icon: '◆', color: 'text-yellow-400', detail: `${buyCount} 進場 / ${sellCount} 出場` };
}

function SignalRow({ sig }: { sig: ClassifiedSignal }) {
  const action = subtypeToActionLabel(sig.subtype);
  const firstLine = getFirstReasonLine(sig.reason);

  const isBuySide  = sig.subtype === 'entry_strong' || sig.subtype === 'entry_soft' || sig.subtype === 'trend';
  const bg  = isBuySide ? 'bg-red-900/20' : sig.subtype === 'warn' ? 'bg-yellow-900/20' : 'bg-green-900/20';
  const badgeBg = isBuySide ? 'bg-red-700' : sig.subtype === 'warn' ? 'bg-yellow-700' : 'bg-green-800';
  const actionColor = isBuySide ? 'text-red-300' : sig.subtype === 'warn' ? 'text-yellow-300' : 'text-green-300';

  return (
    <div className={`rounded px-2.5 py-2 ${bg}`}>
      <div className="flex items-start gap-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${badgeBg} text-white`}>
          {sig.label}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold mb-0.5 ${actionColor}`}>{action}</p>
          <p className="text-xs text-foreground/80 leading-tight">{sig.description}</p>
          {firstLine && (
            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{firstLine}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RuleAlerts() {
  const { currentSignals, allCandles, currentIndex, currentStock } = useReplayStore();
  const { holdings } = usePortfolioStore();
  const candle      = allCandles[currentIndex];
  const currentDate = candle?.date;
  const ma5         = candle?.ma5;

  // 市場判斷：.TW/.TWO → TW；.SS/.SZ → CN
  const ticker = currentStock?.ticker ?? '';
  const market = marketFromSymbol(ticker);

  // 持倉偵測：比對 currentStock.ticker 去除市場後綴 vs holdings 中的 symbol
  const currentSymbol = ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const heldPosition = holdings.find(h => h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === currentSymbol);
  const hasPosition = !!heldPosition;

  const classified = classifyAll(currentSignals);
  const direction  = getDirection(classified);
  const advice     = getActionAdvice(classified, ma5, hasPosition);

  // UI 分組：進場類、出場類、其他（trend/warn）
  const entryGroup = classified.filter(s => s.subtype === 'entry_strong' || s.subtype === 'entry_soft' || s.subtype === 'trend').slice(0, 3);
  const exitGroup  = classified.filter(s => s.subtype === 'exit_strong' || s.subtype === 'exit_soft').slice(0, 3);
  const warnGroup  = classified.filter(s => s.subtype === 'warn').slice(0, 3);
  const hasActionSignals = entryGroup.length > 0 || exitGroup.length > 0 || warnGroup.length > 0;

  // 持倉損益（若有）
  const costPrice = heldPosition?.costPrice;
  const pnlPct = (hasPosition && costPrice && candle?.close)
    ? ((candle.close - costPrice) / costPrice) * 100
    : null;

  return (
    <div className="bg-secondary rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground/80">今日操作建議</h2>
        {currentDate && (
          <span className="text-xs text-muted-foreground">{currentDate}</span>
        )}
      </div>

      {/* 朱老師分析（結論優先，置頂） */}
      <ChartCoachAdvice />

      {/* 持倉狀態 bar */}
      <div className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded mb-3 ${
        hasPosition ? 'bg-red-900/20 border border-red-700/30' : 'bg-secondary border border-border/30'
      }`}>
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-bold ${hasPosition ? 'text-red-300' : 'text-muted-foreground'}`}>
            {hasPosition ? '📍 持股中' : '📭 空手中'}
          </span>
          {hasPosition && heldPosition && (
            <span className="text-xs text-muted-foreground">
              成本 {heldPosition.costPrice.toFixed(2)} · {formatSharesAsLots(heldPosition.shares, market)}
            </span>
          )}
        </div>
        {pnlPct !== null && (
          <span className={`text-xs font-semibold ${pnlPct >= 0 ? 'text-red-400' : 'text-green-400'}`}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
        )}
      </div>

      {/* 📋 操作建議 — 結論優先 */}
      <div className="bg-card border border-border/50 rounded px-3 py-2.5 mb-3">
        <p className="text-xs text-muted-foreground mb-0.5">📋 操作建議</p>
        <p className={`text-sm font-bold leading-snug ${advice.color}`}>{advice.text}</p>
        {advice.basis && (
          <p className="text-xs text-muted-foreground mt-0.5">根據：{advice.basis}</p>
        )}
      </div>

      {/* 整體偏向 */}
      <div className="flex items-center gap-1.5 px-0.5 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground">整體偏向</span>
        <span className={`text-xs font-bold ${direction.color}`}>{direction.icon} {direction.label}</span>
        <span className="text-xs text-muted-foreground">— {direction.detail}</span>
      </div>

      {!hasActionSignals ? (
        <p className="text-xs text-muted-foreground text-center py-2">本根K線無觸發規則</p>
      ) : (
        <div className="space-y-3">
          {entryGroup.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400/80 mb-1.5">📈 做多理由</p>
              <div className="space-y-1.5">
                {entryGroup.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}

          {exitGroup.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400/80 mb-1.5">⚠️ 注意事項</p>
              <div className="space-y-1.5">
                {exitGroup.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}

          {warnGroup.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-yellow-400/80 mb-1.5">🟡 警示</p>
              <div className="space-y-1.5">
                {warnGroup.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 贏家圖像（33 種寶典 Part 12）由 WinnerPatternAlerts 元件單獨顯示，避免重複 */}

      <p className="text-xs text-muted-foreground/50 mt-3 text-center">
        僅供練習參考，實際交易需自行判斷
      </p>
    </div>
  );
}
