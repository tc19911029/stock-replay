/**
 * 持倉 verdict — 純函式 unit-testable
 *
 * 0513 ABCDE B1：從 HoldingV12Signals.tsx 抽出來，方便測試覆蓋所有 verdict path。
 * 結論決策樹（dispatch 順序，先匹配先回傳）：
 *   1. NaN guard（資料異常）
 *   2. absoluteStopLoss triggered → 立刻出場
 *   3. step4 klineExit / maExit → 該出場
 *   4. step5 takeProfit / kbarSignal → 該停利
 *   5. inapplicableSellSignals filter 後的 high severity → 該出場
 *   6. 同上 medium severity → 緊盯停損
 *   7. slDistancePct < 3% → 緊盯停損
 *   8. profitPct >= 10% → 可續抱
 *   9. profitPct < 0 → 緊盯停損
 *   10. default → 繼續持有
 */
import { PROFIT_TARGET_RULE_PCT } from '@/lib/analysis/bookThresholds';
import { sopFor } from './letterSOP';

export type VerdictLevel = 'good' | 'warn' | 'bad';

export interface VerdictResult {
  level: VerdictLevel;
  label: string;
  reason: string;
}

/** 最小 input — 跟 V12SignalsResponse 對齊，但拿掉用不到的欄位方便測試 */
export interface VerdictInput {
  letter: string;
  profitPct: number;
  step3: {
    stopLossPrice: number;
    slDistancePct: number;
    absoluteStopLoss?: { triggered: boolean; detail?: string };
  };
  step4: {
    operatingMA: string;
    klineExit: { shouldExit: boolean; reason?: string };
    maExit: { shouldExit: boolean; reason?: string };
  };
  step5: {
    takeProfit: { triggered: boolean; detail?: string };
    kbarSignal: { triggered: boolean; detail?: string };
    triggeredSellSignals?: Array<{ type: string; label: string; detail: string; severity: 'high' | 'medium' | 'low' }>;
  };
}

export function holdingVerdict(data: VerdictInput): VerdictResult {
  // 0513 audit H5：資料異常 guard
  if (!Number.isFinite(data.profitPct) || !Number.isFinite(data.step3.stopLossPrice)) {
    return {
      level: 'warn',
      label: '資料異常',
      reason: '損益無法計算（檢查成本價是否為 0 或 K 線是否完整）',
    };
  }

  // 強制出場（書本明寫硬條件）
  if (data.step3.absoluteStopLoss?.triggered) {
    return { level: 'bad', label: '立刻出場', reason: data.step3.absoluteStopLoss.detail ?? '觸發絕對停損' };
  }
  if (data.step4.klineExit.shouldExit) {
    return { level: 'bad', label: '該出場', reason: data.step4.klineExit.reason ?? 'K 線出場訊號' };
  }
  if (data.step4.maExit.shouldExit) {
    return { level: 'bad', label: '該出場', reason: data.step4.maExit.reason ?? '跌破操作均線' };
  }
  if (data.step5.takeProfit.triggered) {
    return { level: 'bad', label: '該停利', reason: data.step5.takeProfit.detail ?? '達停利目標' };
  }
  if (data.step5.kbarSignal.triggered) {
    return { level: 'bad', label: '該停利', reason: data.step5.kbarSignal.detail ?? 'K 棒反轉訊號' };
  }

  // 書本出場訊號（detectSellSignals）按字母過濾不適用後判 severity
  const sop = sopFor(data.letter);
  const applicableSellSigs = (data.step5.triggeredSellSignals ?? []).filter((s) => !sop.inapplicableSellSignals.has(s.type));
  const sellHigh = applicableSellSigs.filter((s) => s.severity === 'high');
  const sellMed = applicableSellSigs.filter((s) => s.severity === 'medium');
  if (sellHigh.length > 0) {
    return { level: 'bad', label: '該出場', reason: `${sellHigh[0].label}：${sellHigh[0].detail.slice(0, 30)}` };
  }
  if (sellMed.length > 0) {
    return { level: 'warn', label: '緊盯停損', reason: `${sellMed[0].label}：${sellMed[0].detail.slice(0, 30)}` };
  }

  // 距停損很近（< 3%）
  // ⚠️ 自創 padding（書本沒明寫量化）— 3% 為「接近停損」的工程經驗值
  if (data.step3.slDistancePct > 0 && data.step3.slDistancePct < 3) {
    return { level: 'warn', label: '緊盯停損', reason: `現價距停損僅 ${data.step3.slDistancePct.toFixed(1)}%` };
  }

  // 獲利達 10% — 書本可考慮停利或啟用紀律（寶典 #6）
  if (data.profitPct >= PROFIT_TARGET_RULE_PCT) {
    return { level: 'good', label: '可續抱', reason: `已達 ${(data.profitPct * 100).toFixed(1)}% 獲利，跟 ${data.step4.operatingMA} 走` };
  }

  // 虧損中
  if (data.profitPct < 0) {
    return { level: 'warn', label: '緊盯停損', reason: `目前虧損 ${(data.profitPct * 100).toFixed(1)}%，停損 ${data.step3.stopLossPrice.toFixed(2)}` };
  }

  return { level: 'good', label: '繼續持有', reason: `多頭延續，跟 ${data.step4.operatingMA} 走，停損守 ${data.step3.stopLossPrice.toFixed(2)}` };
}
