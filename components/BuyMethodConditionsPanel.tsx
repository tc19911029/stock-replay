'use client';

/**
 * 買法條件面板（2026-04-20 重命名後）
 *
 * 根據當前選中買法（B/C/D/E）顯示對應的進場條件評分。
 * A 六條件走既有 SixConditionsPanel，本元件不處理 A。
 *
 * 字母對照（2026-04-20 rename）：
 *   B=盤整突破+回後、C=V 形反轉、D=缺口（原 E）、E=一字底（原 F）
 *   F=變盤線（走圖輔助，無 detector）、G=切線（走圖輔助，無 detector）
 */

import { useReplayStore } from '@/store/replayStore';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectBreakoutEntry } from '@/lib/analysis/breakoutEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import type { CandleWithIndicators } from '@/types';

type BuyMethod = 'B' | 'C' | 'D' | 'E';

interface ConditionItem {
  icon: string;
  name: string;
  detail: string;
  pass: boolean;
  metric?: string;
}

const METHOD_TITLE: Record<BuyMethod, string> = {
  B: 'B 突破進場',
  C: 'C V 形反轉',
  D: 'D 缺口進場',
  E: 'E 一字底突破',
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
    case 'E': {
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

    case 'D': {
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

    case 'B': {
      const r = detectBreakoutEntry(candles, idx);
      const subTitle = r?.subType === 'consolidation_breakout' ? '盤整突破（位置 1）'
        : r?.subType === 'pullback_buy' ? '回後買上漲（位置 2）'
        : undefined;
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '前置狀態',
          detail: r ? (r.subType === 'consolidation_breakout' ? `盤整 ${r.preEntryDays} 天（幅度<15%）` : `多頭回檔 ${r.preEntryDays} 天`) : '無盤整或回檔',
          pass: !!r,
        },
        {
          icon: '②', name: '收盤突破前高',
          detail: r ? `突破 ${r.breakoutPrice.toFixed(2)}` : '未突破',
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
      return { title, subTitle, conditions, allPass: !!r?.isBreakout };
    }

    case 'C': {
      const r = detectVReversal(candles, idx);
      const prev5 = candles.slice(idx - 5, idx);
      const vols = prev5.map(k => k.volume).filter(v => v > 0);
      const avgVol5 = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
      const volRatio5 = avgVol5 > 0 ? c.volume / avgVol5 : 0;
      const segment = candles.slice(idx - 10, idx);
      const blackK = segment.filter(k => k.close < k.open).length;
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '前 10 根 ≥5 黑 K',
          detail: `前段 ${blackK} 根黑 K（連跌段）`,
          pass: blackK >= 5,
          metric: `${blackK}/10`,
        },
        {
          icon: '②', name: '量 ≥ 5 日均量 ×2',
          detail: `×${volRatio5.toFixed(2)} 5日均量`,
          pass: volRatio5 >= 2,
          metric: `×${volRatio5.toFixed(2)}`,
        },
        {
          icon: '③', name: '紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: '收盤破前日最高',
          detail: prev ? `收 ${c.close.toFixed(2)} vs 前高 ${prev.high.toFixed(2)}` : '無前日',
          pass: !!prev && c.close > prev.high,
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
