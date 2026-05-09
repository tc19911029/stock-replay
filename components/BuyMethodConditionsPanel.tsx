'use client';

/**
 * 買法條件面板（v12 Phase 1.12 UI 改造，2026-05-09）
 *
 * 根據當前選中買法（B-I 既有 + J-Q v12 新增）顯示對應的進場條件評分。
 * A 六條件走既有 SixConditionsPanel，本元件不處理 A。
 *
 * 字母對照：
 *   v11 既有：B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
 *             G=ABC 突破（寶典位置 6）、H=突破大量黑K（位置 8）、I=K線橫盤（位置 5）
 *   v12 新增：J=ABC 突破（=v11 G）、K=K線橫盤（=v11 I）、L=過大量黑K（=v11 H）
 *             M=突破軌道線（寶典 p.387）、N=型態確認（25 型態）、O=打底完成（位置 1）
 *             P=高檔拉回（位置 3 等拉回）、Q=三條均線戰法（MA3+10+24，戰法軌）
 */

import { useReplayStore } from '@/store/replayStore';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import { detectABCBreakout } from '@/lib/analysis/abcBreakoutEntry';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import { detectKlineConsolidationBreakout } from '@/lib/analysis/klineConsolidationBreakout';
// v12 新訊號 detectors
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectLetterN } from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import type { CandleWithIndicators } from '@/types';
import ProhibitionsBlock from './ProhibitionsBlock';

type BuyMethod =
  | 'B' | 'C' | 'D' | 'E' | 'F'
  | 'G' | 'H' | 'I'
  | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q';

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
  G: 'ABC 突破（v11，建議改用 J）',
  H: '突破大量黑 K（v11，建議改用 L）',
  I: 'K 線橫盤突破（v11，建議改用 K）',
  // v12 新字母
  J: 'ABC 突破',
  K: 'K 線橫盤突破',
  L: '過大量黑 K 高',
  M: '突破軌道線',
  N: '型態確認',
  O: '打底完成',
  P: '高檔拉回（淺回）',
  Q: '三條均線戰法（MA3+10+24）',
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
          icon: '④', name: '紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
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
          icon: '③', name: '紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
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
          icon: '②', name: '紅 K 實體 ≥ 2%',
          detail: bodyPct >= 2.0 ? `實體 ${bodyPct.toFixed(2)}%` : `實體僅 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
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

    case 'G': {
      // G=ABC 突破（寶典 Part 11-1 位置 6）
      const r = detectABCBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const aboveMa20 = c.ma20 != null && c.close > c.ma20;
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: 'ABC 修正結構（頭頭低+底底低）',
          detail: r
            ? `A峰 ${r.legAHigh.toFixed(1)}→A底 ${r.legALow.toFixed(1)}→B峰 ${r.legBHigh.toFixed(1)}→C底 ${r.legCLow.toFixed(1)}（修正 ${r.preEntryDays} 天）`
            : '未偵測到 ABC 修正結構',
          pass: !!r,
          metric: r ? `${r.preEntryDays}天` : '—',
        },
        {
          icon: '②', name: '收盤突破下降切線',
          detail: r ? `切線延伸值 ${r.trendlineValue.toFixed(2)}` : '未突破下降切線',
          pass: !!r,
          metric: r ? r.trendlineValue.toFixed(2) : '—',
        },
        {
          icon: '③', name: '紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: '量比 ≥ 1.3',
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑤', name: '收盤站上 MA20',
          detail: c.ma20 != null
            ? `${c.close.toFixed(2)} vs MA20 ${c.ma20.toFixed(2)}`
            : '無 MA20 資料',
          pass: aboveMa20,
        },
      ];
      return { title, conditions, allPass: !!r?.isABCBreakout };
    }

    case 'H': {
      // H=突破大量黑 K（寶典 Part 11-1 位置 8）
      const r = detectBlackKBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const isUptrend = detectTrend(candles, idx) === '多頭';
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: isUptrend ? '多頭（頭頭高底底高）' : '非多頭趨勢',
          pass: isUptrend,
        },
        {
          icon: '②', name: '近 3 日內出現大量黑 K（跌破前日低 / MA5）',
          detail: r
            ? `${r.blackKDate} 大量黑 K（高 ${r.blackKHigh.toFixed(2)}，量×${r.blackKVolumeRatio.toFixed(2)}）`
            : '未發現符合條件的大量黑 K',
          pass: !!r,
          metric: r ? `${r.daysSinceBlackK}日前` : '—',
        },
        {
          icon: '③', name: '今日紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '④', name: '今日量比 ≥ 1.3',
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑤', name: '收盤突破大量黑 K 最高點',
          detail: r
            ? `${c.close.toFixed(2)} > 黑K高 ${r.blackKHigh.toFixed(2)}`
            : '前提未成立',
          pass: !!r?.isBlackKBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBlackKBreakout };
    }

    case 'I': {
      // I=K 線橫盤突破（寶典 Part 11-1 位置 3）
      const r = detectKlineConsolidationBreakout(candles, idx);
      const bodyPct = c.open > 0 && c.close > c.open ? (c.close - c.open) / c.open * 100 : 0;
      const volRatio = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const isUptrend = detectTrend(candles, idx) === '多頭';
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: isUptrend ? '多頭（頭頭高底底高）' : '非多頭趨勢',
          pass: isUptrend,
        },
        {
          icon: '②', name: '中長紅 K 錨點（實體 ≥ 3%）',
          detail: r
            ? `${r.anchorDate} 中長紅 K（高 ${r.anchorHigh.toFixed(2)}，實體 ${r.anchorBodyPct.toFixed(2)}%）`
            : '未找到 5-15 天前的中長紅 K 錨點',
          pass: !!r,
          metric: r ? `${r.anchorBodyPct.toFixed(2)}%` : '—',
        },
        {
          icon: '③', name: '錨點上方狹幅橫盤（5-15 天 / 幅度 ≤ 5%）',
          detail: r
            ? `橫盤 ${r.consolidationDays} 天，幅度 ${r.rangeWidthPct.toFixed(2)}%`
            : '橫盤條件未成立',
          pass: !!r,
          metric: r ? `${r.consolidationDays}天` : '—',
        },
        {
          icon: '④', name: '今日紅 K 實體 ≥ 2%',
          detail: `實體 ${bodyPct.toFixed(2)}%`,
          pass: bodyPct >= 2.0,
          metric: `${bodyPct.toFixed(2)}%`,
        },
        {
          icon: '⑤', name: '量比 ≥ 1.3',
          detail: `×${volRatio.toFixed(2)}`,
          pass: volRatio >= 1.3,
          metric: `×${volRatio.toFixed(2)}`,
        },
        {
          icon: '⑥', name: '收盤突破橫盤最高點',
          detail: r
            ? `${c.close.toFixed(2)} > 橫盤高 ${r.rangeHigh.toFixed(2)}`
            : '前提未成立',
          pass: !!r?.isBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }
    // ── v12 新字母（與 v11 G/H/I 共用 detector 但顯示新名稱）─────────────
    case 'J': {
      // J=ABC 突破（= v11 G，邏輯相同）
      const r = detectABCBreakout(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: detectTrend(candles, idx) === '多頭' ? '多頭' : '非多頭',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '②', name: 'ABC 修正結構',
          detail: r ? `legA=${r.legAHigh.toFixed(2)} → C 底=${r.legCLow.toFixed(2)}` : '未找到 ABC 結構',
          pass: !!r,
        },
        {
          icon: '③', name: '突破下降切線',
          detail: r ? `切線值 ${r.trendlineValue.toFixed(2)} → close ${c.close.toFixed(2)}` : '未突破',
          pass: !!r,
        },
        {
          icon: '④', name: 'close ≥ MA20',
          detail: c.ma20 ? `close ${c.close.toFixed(2)} vs MA20 ${c.ma20.toFixed(2)}` : '無 MA20',
          pass: c.ma20 != null && c.close >= c.ma20,
        },
      ];
      return { title, conditions, allPass: !!r?.isABCBreakout };
    }
    case 'K': {
      // K=K 線橫盤突破（= v11 I，邏輯相同）
      const r = detectKlineConsolidationBreakout(candles, idx);
      const isUptrend = detectTrend(candles, idx) === '多頭';
      const conditions: ConditionItem[] = [
        { icon: '①', name: '多頭趨勢', detail: isUptrend ? '多頭' : '非多頭', pass: isUptrend },
        {
          icon: '②', name: 'K 線橫盤 ≥ 3 根（寶典 p.156-157）',
          detail: r ? `橫盤 ${r.consolidationDays} 天，幅度 ${r.rangeWidthPct.toFixed(2)}%` : '橫盤條件未成立',
          pass: !!r,
        },
        {
          icon: '③', name: '中長紅 K 收盤突破上頸線',
          detail: r ? `${c.close.toFixed(2)} > 橫盤高 ${r.rangeHigh.toFixed(2)}` : '前提未成立',
          pass: !!r?.isBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBreakout };
    }
    case 'L': {
      // L=過大量黑 K 高（= v11 H，邏輯相同）
      const r = detectBlackKBreakout(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: detectTrend(candles, idx) === '多頭' ? '多頭' : '非多頭',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '②', name: '近 3 日內出現大量黑 K',
          detail: r ? `黑 K 高 ${r.blackKHigh.toFixed(2)}（${r.daysSinceBlackK} 天前）` : '未找到大量黑 K',
          pass: !!r,
        },
        {
          icon: '③', name: '紅 K 收盤突破黑 K 高',
          detail: r ? `${c.close.toFixed(2)} > ${r.blackKHigh.toFixed(2)}` : '未突破',
          pass: !!r?.isBlackKBreakout,
        },
      ];
      return { title, conditions, allPass: !!r?.isBlackKBreakout };
    }
    case 'M': {
      // M=突破軌道線（v12 新訊號，寶典 p.387）
      const r = detectLetterM(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: detectTrend(candles, idx) === '多頭' ? '多頭' : '非多頭',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '②', name: '2 個 pivot low + 中間最高',
          detail: r.triggered
            ? `軌道值 ${r.channelValue?.toFixed(2)}（兩低點+中間最高 ${r.channelAnchorPrice?.toFixed(2)}）`
            : '軌道線結構未成立',
          pass: r.triggered,
        },
        {
          icon: '③', name: 'close ≥ 軌道線 ×3% 真突破',
          detail: r.triggered
            ? `close ${c.close.toFixed(2)} ≥ ${r.breakoutThreshold?.toFixed(2)}`
            : '未過 ×3% 真突破',
          pass: r.triggered,
        },
        {
          icon: '④', name: '紅 K + 量 ≥ 1.3',
          detail: r.triggered ? `紅 K ${r.bodyPct?.toFixed(2)}% / 量 ×${r.volumeRatio?.toFixed(2)}` : '前提未成立',
          pass: r.triggered,
        },
      ];
      return { title, subTitle: '寶典 p.387 上升軌道線', conditions, allPass: r.triggered };
    }
    case 'N': {
      // N=型態確認（v12 新訊號，7 種底部型態）
      const r = detectLetterN(candles, idx);
      const patternName = r.patternType
        ? ({
            'head-shoulder': '頭肩底',
            'triple-bottom': '三重底',
            'rounding-bottom': '圓弧底',
            'double-bottom': '雙重底',
            'complex-head-shoulder': '複式頭肩底',
            'falling-diamond': '跌菱形',
            'descending-wedge': '下降楔形',
            'n-shape': 'N 字底',
          } as const)[r.patternType]
        : '尚未識別';
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '型態結構',
          detail: r.triggered ? `${patternName}（達成率 ${r.achievementRate}%）` : '未識別',
          pass: r.triggered,
        },
        {
          icon: '②', name: '頸線突破 ×3%',
          detail: r.necklinePrice
            ? `頸線 ${r.necklinePrice.toFixed(2)} → close ${c.close.toFixed(2)}`
            : '無頸線',
          pass: r.triggered,
        },
        {
          icon: '③', name: '型態目標價（停利參考）',
          detail: r.patternTargetPrice ? `目標 ${r.patternTargetPrice.toFixed(2)}` : '—',
          pass: !!r.patternTargetPrice,
        },
        {
          icon: '④', name: '紅 K + 量 ≥ 1.3',
          detail: r.triggered ? `紅 K ${r.bodyPct?.toFixed(2)}% / 量 ×${r.volumeRatio?.toFixed(2)}` : '—',
          pass: r.triggered,
        },
      ];
      return {
        title,
        subTitle: r.triggered ? `${patternName}（達成率 ${r.achievementRate}%）` : '抓飆股 25 型態',
        conditions,
        allPass: r.triggered,
      };
    }
    case 'O': {
      // O=打底完成（v12 新訊號，寶典 Part 11-1 位置 1）
      const r = detectLetterO(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '空頭→盤整轉換 + 大量打底',
          detail: r.hadHighVolume ? '✅ 已偵測到打底大量' : '尚未偵測',
          pass: !!r.hadHighVolume,
        },
        {
          icon: '②', name: '反轉多頭確認',
          detail: detectTrend(candles, idx) === '多頭' ? '✅ 翻多' : '尚未翻多',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '③', name: '站上 MA20 + MA20 上揚',
          detail: c.ma20 ? `close ${c.close.toFixed(2)} vs MA20 ${c.ma20.toFixed(2)}` : '無 MA20',
          pass: c.ma20 != null && c.close >= c.ma20,
        },
        {
          icon: '④', name: '紅 K 突破打底盤整高 ×3%',
          detail: r.triggered
            ? `突破 ${r.triggerPrice?.toFixed(2)}（×3% = ${r.breakoutThreshold?.toFixed(2)}）`
            : '未突破',
          pass: r.triggered,
        },
        {
          icon: '⑤', name: '加分項：站上 MA60（可長多）',
          detail: r.aboveMA60 ? '✅ 站上季線' : '— 未站上',
          pass: !!r.aboveMA60,
        },
      ];
      return { title, subTitle: '寶典 Part 11-1 位置 1', conditions, allPass: r.triggered };
    }
    case 'P': {
      // P=高檔拉回（v12 新訊號，寶典 Part 11-1 位置 3 等拉回）
      const r = detectLetterP(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '多頭趨勢',
          detail: detectTrend(candles, idx) === '多頭' ? '多頭' : '非多頭',
          pass: detectTrend(candles, idx) === '多頭',
        },
        {
          icon: '②', name: '近期高 + 1-2 天淺回',
          detail: r.triggered
            ? `${r.pullbackDays} 天淺回（前高 ${r.prevSwingHigh?.toFixed(2)}）`
            : '淺回結構未成立',
          pass: r.triggered,
        },
        {
          icon: '③', name: '不破 MA10 / 不破前低',
          detail: r.triggered ? '✅ 守 MA10 + 不破前低' : '前提未成立',
          pass: r.triggered,
        },
        {
          icon: '④', name: '紅 K + 量 ≥ 1.3 + 突破前 K 高',
          detail: r.triggered
            ? `紅 K ${r.bodyPct?.toFixed(2)}% / 量 ×${r.volumeRatio?.toFixed(2)} / 突破 ${r.triggerPrice?.toFixed(2)}`
            : '前提未成立',
          pass: r.triggered,
        },
      ];
      return { title, subTitle: '寶典位置 3 等拉回（B 的淺回版）', conditions, allPass: r.triggered };
    }
    case 'Q': {
      // Q=三條均線戰法（v12 新訊號，戰法軌獨立 SOP）
      const r = detectLetterQ(candles, idx);
      const conditions: ConditionItem[] = [
        {
          icon: '①', name: '股價 ≥ MA24',
          detail: c.ma24 ? `close ${c.close.toFixed(2)} vs MA24 ${c.ma24.toFixed(2)}` : '無 MA24',
          pass: c.ma24 != null && c.close >= c.ma24,
        },
        {
          icon: '②', name: 'MA24 上揚（趨勢方向）',
          detail: r.ma24Up ? '✅ 上揚' : '未上揚',
          pass: !!r.ma24Up,
        },
        {
          icon: '③', name: 'MA3 黃金交叉 MA10',
          detail: r.goldenCrossToday ? '✅ 今日金叉' : '未金叉',
          pass: !!r.goldenCrossToday,
        },
        {
          icon: '④', name: '股價站上 MA3',
          detail: r.aboveMA3 ? '✅ 站上 MA3' : '未站上',
          pass: !!r.aboveMA3,
        },
        {
          icon: '⑤', name: '紅 K 實體 ≥ 2%',
          detail: r.triggered ? `${r.bodyPct?.toFixed(2)}%` : '—',
          pass: r.triggered,
        },
      ];
      return {
        title,
        subTitle: '抓住線圖 第 4 篇 第 8 章 — 朱老師「年獲利 1 倍」首選戰法',
        conditions,
        allPass: r.triggered,
      };
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

      {/* 進場 10 大戒律狀態（書本：硬性禁忌，任一觸發即不應進場） */}
      <ProhibitionsBlock />
    </div>
  );
}
