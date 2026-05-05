/**
 * Signal Classifier — 把 RuleSignal 分成細類，讓 UI 不用再用關鍵字猜
 *
 * 為什麼不直接改 36 個 rule 檔加 subtype 欄位？
 *   - 範圍過大、改動風險高
 *   - 各 detector 的 type/label/ruleId 已穩定，這裡當 adapter 更經濟
 *
 * 未來若要源頭分類，可把結果寫回 RuleSignal.subtype（type 已預留）。
 */

import type { RuleSignal } from '@/types';

/**
 * 訊號細類（orthogonal to RuleSignal.type）：
 * - entry_strong: 明確進場訊號（書本硬規則）— 突破、回後買、假跌破反彈、一字底、缺口回補進、攻擊買進
 * - entry_soft:   情境進場訊號 — 需其他條件配合
 * - exit_strong:  硬出場訊號 — 破MA5、跌破前低、長黑吞噬、跌破頸線
 * - exit_soft:    情境出場 — KD死叉、上缺回補反轉、量能轉弱
 * - trend:        趨勢/持股提示 — 上升期（多頭）、多頭持續
 * - warn:         警示但不觸發動作 — 乖離警示、KD背離
 */
export type SignalSubtype =
  | 'entry_strong'
  | 'entry_soft'
  | 'exit_strong'
  | 'exit_soft'
  | 'trend'
  | 'warn';

/** 硬出場 ruleId/label 關鍵字（書本硬規則） */
const EXIT_STRONG_PATTERNS: readonly (string | RegExp)[] = [
  '破MA5',
  '破月線',
  '跌破前低',
  '跌破頸線',
  '長黑吞噬',
  '長黑K',
  '跌破支撐',
  '布林壓縮跌破',           // 布林通道跌破下軌
  /^ma5-exit/i,
  /^sell-break-/i,
  /^granville-sell-(5|6|7)/i,  // 葛蘭碧⑤⑥⑦：跌破均線、反彈失敗、急跌警示
];

/** 情境出場（需搭配其他訊號才有意義） */
const EXIT_SOFT_PATTERNS: readonly (string | RegExp)[] = [
  '缺口回補反轉',
  'KD死叉',
  'KD 死叉',
  'MACD轉弱',
  '背離',
  '量能轉弱',
  '智慧K線賣出',
  '上缺回補',
  '葛蘭碧⑧停利',             // 急漲停利建議減碼
  /^granville-sell-8/i,
];

/** 明確進場（書本 6 位置+攻擊買進） */
const ENTRY_STRONG_PATTERNS: readonly (string | RegExp)[] = [
  '回後買',
  '盤整突破',
  '假跌破反彈',
  '一字底',
  '缺口突破',
  '攻擊買進',
  '買上漲',
  '打底突破',
  '葛蘭碧①',                 // 突破均線買進
  '葛蘭碧②',                 // 回測支撐買進
  '葛蘭碧③',                 // 加碼買進
  '布林壓縮突破',             // 布林通道突破上軌
  /^breakout-/i,
  /^entry-/i,
  /^granville-buy-(1|2|3)/i,
  /^bollinger-squeeze-up/i,
  /^zhu-bull-pullback-entry/i,    // 朱進場位置①：回檔再上漲
  /^zhu-bull-breakout-entry/i,    // 朱進場位置②：盤整突破
  /^zhu-bull-ma-support-entry/i,  // 朱進場位置④：均線支撐再上漲
];

/** 軟進場（進場但需搭配其他條件） */
const ENTRY_SOFT_PATTERNS: readonly (string | RegExp)[] = [
  '可能買點',
  '觀察買點',
  '葛蘭碧④反彈',             // WATCH 型，已自動歸 warn 但保留以防 BUY 誤標
  /^granville-buy-4/i,
];

/** 趨勢/持股標籤（不觸發動作） */
const TREND_PATTERNS: readonly (string | RegExp)[] = [
  '上升期',
  '多頭趨勢',
  '多頭持續',
  '底底高',
  '頭頭高',
  /^trend-/i,
];

/** 警示（不觸發動作，只提醒） */
const WARN_PATTERNS: readonly (string | RegExp)[] = [
  '乖離警示',
  '乖離過大',
  '追高警示',
  '背離警示',
  'KD高檔',
  /^warn-/i,
];

function matches(sig: RuleSignal, patterns: readonly (string | RegExp)[]): boolean {
  const haystack = `${sig.label} ${sig.description} ${sig.ruleId}`;
  for (const p of patterns) {
    if (typeof p === 'string') {
      if (haystack.includes(p)) return true;
    } else {
      if (p.test(sig.ruleId) || p.test(sig.label)) return true;
    }
  }
  return false;
}

/**
 * 把 RuleSignal 分到細類。
 * 優先順序：exit_strong → exit_soft → entry_strong → entry_soft → trend → warn
 *           （硬訊號優先，避免被 label 誤配）
 */
export function classifySignal(sig: RuleSignal): SignalSubtype {
  // WATCH 型直接歸 warn
  if (sig.type === 'WATCH') return 'warn';

  const isExitType = sig.type === 'SELL' || sig.type === 'REDUCE';
  const isBuyType  = sig.type === 'BUY' || sig.type === 'ADD';

  // 出場類
  if (isExitType) {
    if (matches(sig, EXIT_STRONG_PATTERNS)) return 'exit_strong';
    if (matches(sig, EXIT_SOFT_PATTERNS)) return 'exit_soft';
    // 歸類不到的 SELL/REDUCE 預設當 exit_strong（保守）
    return 'exit_strong';
  }

  // 買進類：先判是否只是趨勢/警示，再判斷進場強度
  if (isBuyType) {
    if (matches(sig, TREND_PATTERNS)) return 'trend';
    if (matches(sig, WARN_PATTERNS)) return 'warn';
    if (matches(sig, ENTRY_STRONG_PATTERNS)) return 'entry_strong';
    if (matches(sig, ENTRY_SOFT_PATTERNS)) return 'entry_soft';
    // 歸類不到的 BUY/ADD 預設 entry_soft（保守：不當成硬進場）
    return 'entry_soft';
  }

  return 'warn';
}

/** 用來畫 UI 動作標籤 */
export function subtypeToActionLabel(subtype: SignalSubtype): string {
  switch (subtype) {
    case 'entry_strong': return '→ 可進場';
    case 'entry_soft':   return '→ 觀察進場';
    case 'exit_strong':  return '→ 出場';
    case 'exit_soft':    return '→ 考慮減碼';
    case 'trend':        return '→ 持股';
    case 'warn':         return '→ 注意';
  }
}
