'use client';

/**
 * 買法條件面板（2026-04-21 重命名後）
 *
 * 根據當前選中買法（B/C/D/E/F）顯示對應的進場條件評分。
 * A 六條件走既有 SixConditionsPanel，本元件不處理 A。
 *
 * 字母對照（2026-04-21 rename）：
 *   B=回後買上漲、C=盤整突破（新拆）、D=一字底、E=缺口、F=V形反轉
 *   G=變盤線（走圖輔助，無 detector）、H=切線（走圖輔助，無 detector）
 */

import { useReplayStore } from '@/store/replayStore';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import type { CandleWithIndicators } from '@/types';
import { EmptyState } from '@/components/shared';

type BuyMethod = 'B' | 'C' | 'D' | 'E' | 'F';

interface ConditionItem {
  icon: string;
  name: string;
  detail: string;
  pass: boolean;
  metric?: string;
}

const METHOD_TITLE: Record<BuyMethod, string> = {
  B: '回後買上漲',
  C: '盤整突破',
  D: '一字底',
  E: '缺口',
  F: 'V 型反轉',
};

function evaluateMethod(
  method: BuyMethod,
  candles: CandleWithIndicators[],
  idx: number,
): { title: string; subTitle?: string; conditions: ConditionItem[]; allPass: boolean } {
  const title = METHOD_TITLE[method];
  if (idx < 1 || candles.length === 0) {
    return { title, conditions: [], allPass: false };
  }
  const c = candles[idx];
  const prev = candles[idx - 1];

  switch (method) {
    case 'B': {
      // B=回後買上漲 — 各條件獨立計算，避免 r=null 時全部顯示相同失敗訊息
      const r = detectBreakoutEntry(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;

      const isTrend = c.ma5 != null && detectTrend(candles, idx) === '多頭';
      const hasMa5 = c.ma5 != null && prev?.ma5 != null;
      const prevBelowMa5 = hasMa5 && prev!.close < prev!.ma5!;
      const todayAboveMa5 = hasMa5 && c.close > c.ma5!;
      const isMa5Reclaim = prevBelowMa5 && todayAboveMa5;
      const prevHigh = prev?.high ?? 0;
      const isBreakoutHigh = prevHigh > 0 && c.close > prevHigh;

      const ma5ReclaimDetail = (() => {
        if (!hasMa5) return '無 MA5 資料';
        if (!prevBelowMa5) return `昨收${prev!.close}≥MA5(${prev!.ma5!.toFixed(0)})，昨日未在MA5下`;
        if (!todayAboveMa5) return `今收${c.close}≤MA5(${c.ma5!.toFixed(0)})，今日未站回`;
        return `昨收${prev!.close}<MA5(${prev!.ma5!.toFixed(0)})，今收${c.close}>MA5(${c.ma5!.toFixed(0)})`;
      })();

      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: isTrend ? '多頭（頭頭高底底高）' : '非多頭趨勢',
          pass: isTrend,
        },
        {
          icon: '②', name: '昨日<MA5 + 今日站回MA5',
          detail: ma5ReclaimDetail,
          pass: isMa5Reclaim,
        },
        {
          icon: '③', name: '收盤突破前K高',
          detail: isBreakoutHigh
            ? `突破前K高 ${prevHigh.toFixed(0)}`
            : `未突破前K高 ${prevHigh.toFixed(0)}`,
          pass: isBreakoutHigh,
          metric: prevHigh > 0 ? prevHigh.toFixed(0) : undefined,
        },
        {
          icon: '④', name: '紅 K 實體 ≥ 2.5%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.5,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '⑤', name: '量比 ≥ 1.3',
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }

    case 'C': {
      // C=盤整突破
      const r = detectConsolidationBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '前置盤整',
          detail: r ? `盤整 ${r.preEntryDays} 天（detectTrend=盤整）` : '無盤整前置',
          pass: !!r,
          metric: r ? `${r.preEntryDays}天` : undefined,
        },
        {
          icon: '②', name: '收盤突破上頸線',
          detail: r ? `突破 ${r.breakoutPrice.toFixed(2)}` : '未突破上頸線',
          pass: !!r,
          metric: r ? r.breakoutPrice.toFixed(2) : undefined,
        },
        {
          icon: '③', name: '紅 K 實體 ≥ 2.5%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.5,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: '量比 ≥ 1.3',
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }

    case 'D': {
      // D=一字底
      const r = detectStrategyE(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '盤整 40 天以上',
          detail: r ? `盤整 ${r.consolidationDays} 天` : '盤整天數不足',
          pass: !!r,
          metric: r ? `${r.consolidationDays}天` : undefined,
        },
        {
          icon: '②', name: '均線糾結',
          detail: r ? '盤整末段 MA5/10/20 糾結 ≥5 天' : 'MA 未糾結',
          pass: !!r,
        },
        {
          icon: '③', name: '量縮 → 突破量',
          detail: r ? '盤整期量 < 前期60%、當日量 ≥ 盤整均量 × 2' : '量能未達標',
          pass: !!r,
        },
        {
          icon: '④', name: '紅 K 突破頸線',
          detail: r ? r.detail : '未突破盤整上頸線',
          pass: !!r,
        },
      ];
      return { title, conditions, allPass: !!r };
    }

    case 'E': {
      // E=缺口進場
      const r = detectStrategyD(candles, idx);
      const gapPct = prev && prev.high > 0 ? (c.open - prev.high) / prev.high * 100 : 0;
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '向上跳空',
          detail: gapPct > 0 ? `開盤 ${c.open.toFixed(2)} > 前日高 ${prev?.high.toFixed(2)}` : '未跳空',
          pass: gapPct > 0,
          metric: `+${gapPct.toFixed(2)}%`,
        },
        {
          icon: '②', name: '紅 K 實體 ≥ 2.5%',
          detail: bodyPct >= 2.5 ? `實體 ${bodyPct.toFixed(2)}%` : `實體僅 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.5,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '③', name: '量比 ≥ 1.3',
          detail: volRatio >= 1.3 ? `量比 ×${volRatio.toFixed(2)}` : `量比不足 ×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
      ];
      return { title, conditions, allPass: !!r?.isGapEntry };
    }

    case 'F': {
      // F=V形反轉
      const r = detectVReversal(candles, idx);
      const prev5 = candles.slice(idx - 5, idx);
      const vols = prev5.map(k => k.volume).filter(v => v > 0);
      const avgVol5 = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      const volRatio5 = avgVol5 > 0 ? c.volume / avgVol5 : 0;
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const breakPrevHigh = !!prev && c.close > prev.high;

      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '連續下跌（5 根 ≥ 3 跌 + 跌幅 ≥ 10%）',
          detail: r
            ? `前 ${r.precedingDownDays}/5 天下跌，段跌幅 ${r.precedingDrop.toFixed(1)}%`
            : '未偵測到符合的下跌段',
          pass: !!r,
          metric: r ? `${r.precedingDownDays}/5 · -${r.precedingDrop.toFixed(1)}%` : '—',
        },
        {
          icon: '②', name: '變盤線止跌（十字/紡錘/長下影）',
          detail: r
            ? `${r.stopBarOffset} 根前出現 [${r.stopBarShape}]`
            : '過去 15 根內未找到變盤線',
          pass: !!r,
          metric: r ? `${r.stopBarShape}·${r.stopBarOffset}根前` : '—',
        },
        {
          icon: '③', name: '止跌等待（不破變盤線低）',
          detail: r
            ? `變盤線 low ${r.stopBarLow.toFixed(2)} 之後 ${r.stopBarOffset - 1} 天未跌破`
            : '前提未成立（需先有變盤線）',
          pass: !!r,
        },
        {
          icon: '④', name: '今日紅 K + 帶量（× 1.4）',
          detail: c.close > c.open
            ? `實體 +${bodyPct.toFixed(2)}%、量 ×${volRatio5.toFixed(2)} 5日均量`
            : '今日為黑 K',
          pass: c.close > c.open && volRatio5 >= 1.4,
          metric: `×${volRatio5.toFixed(2)}`,
        },
        {
          icon: '⑤', name: '收盤 > 前 K 高（含上影線）',
          detail: prev
            ? `收 ${c.close.toFixed(2)} vs 前高 ${prev.high.toFixed(2)}`
            : '無前日資料',
          pass: breakPrevHigh,
        },
      ];
      return { title, conditions, allPass: !!r?.isVReversal };
    }
  }
}

export default function BuyMethodConditionsPanel({ method }: { method: BuyMethod }) {
  const allCandles = useReplayStore(s => s.allCandles);
  const currentIndex = useReplayStore(s => s.currentIndex);

  if (!allCandles || allCandles.length === 0 || currentIndex < 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <p className="text-2xl mb-2">📊</p>
        <p className="text-sm font-medium text-muted-foreground">尚未載入股票</p>
        <p className="text-xs text-muted-foreground mt-1">請先在上方選擇一檔股票</p>
      </div>
    );
  }

  const { title, subTitle, conditions, allPass } = evaluateMethod(method, allCandles, currentIndex);
  const passCount = conditions.filter(c => c.pass).length;
  const total = conditions.length;

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {subTitle && <div className="text-[10px] text-muted-foreground mt-0.5">{subTitle}</div>}
        </div>
        <div className={`text-sm font-bold ${allPass ? 'text-green-400' : passCount >= total - 1 ? 'text-yellow-400' : 'text-red-400'}`}>
          {passCount}/{total}
        </div>
      </div>
      <ul className="space-y-2">
        {conditions.map((c) => (
          <li key={c.icon} className={`flex items-start gap-2 p-2 rounded border ${c.pass ? 'border-green-800/40 bg-green-900/10' : 'border-border bg-secondary/30'}`}>
            <span className="text-base leading-tight">{c.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-foreground">{c.name}</span>
                {c.metric && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${c.pass ? 'bg-green-900/40 text-green-300' : 'bg-muted text-muted-foreground'}`}>
                    {c.metric}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{c.detail}</div>
            </div>
            <span className={`text-base leading-tight ${c.pass ? 'text-green-400' : 'text-muted-foreground/50'}`}>
              {c.pass ? '✓' : '·'}
            </span>
          </li>
        ))}
      </ul>
      {allPass ? (
        <div className="mt-3 px-2 py-1.5 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-300 text-center">
          ✅ {title} 全部符合 — 書本明文進場位置
        </div>
      ) : (
        <div className="mt-3 px-2 py-1.5 bg-muted/30 border border-border rounded text-[11px] text-muted-foreground text-center">
          未完全符合 — 此 K 棒不滿足 {title} 條件
        </div>
      )}
    </div>
  );
}
