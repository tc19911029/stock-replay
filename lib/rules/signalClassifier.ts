/**
 * Signal Classifier — 把 RuleSignal 分成細類，讓 UI 不用再用關鍵字猜
 *
 * 為什麼不直接改 36 個 rule 檔加 subtype 欄位？
 *   - 範圍過大、改動風險高
 *   - 各 detector 的 type/label/ruleId 已穩定，這裡當 adapter 更經濟
 *
 * 2026-05-11 改為 ruleId-first lookup table：
 *   - 每個已知 ruleId 都有明確 subtype（單一真實來源）
 *   - 對歷史相容保留 label/ruleId pattern 後備（舊測試或第三方 RuleSignal）
 *   - 真的歸不到才走 default（BUY→entry_soft / SELL→exit_strong）
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

// ────────────────────────────────────────────────────────────────────────────
// ruleId → subtype 主要查表（每加一條 rule，請同步加進這裡 + 寫測試）
// 來源：scripts/audit-signal-classifier.ts 巡查 + 書本對應
// ────────────────────────────────────────────────────────────────────────────

export const RULE_ID_TO_SUBTYPE: Record<string, SignalSubtype> = {
  // ── 進場硬訊號 ───────────────────────────────────────────────────
  // 朱進場位置（書本 4 位置）
  'zhu-bull-pullback-entry':            'entry_strong',
  'zhu-bull-breakout-entry':            'entry_strong',
  'zhu-bull-ma-support-entry':          'entry_strong',
  // 朱 SOP（短線做多 7 項全過）
  'zhu-short-bull-sop':                 'entry_strong',
  // 朱底部反轉（《抓住線圖》第2章 ①②③，③最強）
  'zhu-flat-bottom-breakout':           'entry_strong',
  'zhu-higher-bottom-breakout':         'entry_strong',
  'zhu-false-breakdown-breakout':       'entry_strong',
  'zhu-consolidation-breakout-direction': 'entry_strong',
  // 朱 K 線轉折硬訊號（已成立的紅K，無需再等確認）
  'zhu-rising-sun':                     'entry_strong',
  'zhu-bullish-engulfing-low':          'entry_strong',
  'zhu-bullish-piercing-low':           'entry_strong',
  'zhu-morning-star-low':               'entry_strong',
  'zhu-bullish-double-star':            'entry_strong',
  // 朱底部確認
  'zhu-golden-right-foot':              'entry_strong',
  'zhu-ma-bottom-confirm':              'entry_strong',
  // 朱轉折波（中長線 / 共振算硬）
  'zhu-turning-wave-10ma-bull':         'entry_strong',
  'zhu-turning-wave-20ma-bull':         'entry_strong',
  'zhu-turning-wave-triple-bull':       'entry_strong',
  // 走圖 SOP 多頭
  'sop-bull-confirm-entry':             'entry_strong',
  'sop-bull-pullback-buy':              'entry_strong',
  'sop-consolidation-breakout':         'entry_strong',
  // 缺口進場
  'gap-up-long-red':                    'entry_strong',
  'gap-three-day-two-gaps-up':          'entry_strong',
  // gap-island-reversal 為 BUY/SELL 雙向 detector，用 type:ruleId 區分（見下方）
  'BUY:gap-island-reversal':            'entry_strong',
  'SELL:gap-island-reversal':           'exit_strong',
  // K 線組合（強勢續攻）
  'kline-one-star-two-yang':            'entry_strong',
  'kline-rising-three-methods':         'entry_strong',
  'kline-three-line-reverse-red':       'entry_strong',
  'kline-three-consecutive-red':        'entry_strong',
  'kline-down-gap-filled':              'entry_strong',
  'kline-trading-bull-entry':           'entry_strong',
  'kline-v-shape-reversal-buy':         'entry_strong',
  // 長線進場（《抓住長線》SOP）
  'long-term-select-monthly':           'entry_strong',
  'long-term-select-weekly':            'entry_strong',
  'long-term-select-daily':             'entry_strong',
  'long-term-entry':                    'entry_strong',
  'long-term-second-wave':              'entry_strong',
  // 均線戰法
  'single-ma20-buy':                    'entry_strong',
  'triple-ma-golden-cross-buy':         'entry_strong',
  'dual-ma10-ma24-buy':                 'entry_strong',
  // 飆股
  'surge-stock-breakout':               'entry_strong',
  'momentum-continuation-buy':          'entry_strong',
  'zhu-surge-long-consol-break':        'entry_strong',
  'zhu-surge-double-bottom':            'entry_strong',
  'zhu-surge-ma-cluster':               'entry_strong',
  'zhu-surge-downtrend-break':          'entry_strong',
  // 攻擊買進（smart K 線）
  'low-long-red-attack':                'entry_strong',
  'low-engulf-attack':                  'entry_strong',
  // 週線
  'weekly-ma20-buy':                    'entry_strong',
  'weekly-ma20-add-near-support':       'entry_strong',
  // 葛蘭碧 1-3
  'granville-buy-1':                    'entry_strong',
  'granville-buy-2':                    'entry_strong',
  'granville-buy-3':                    'entry_strong',
  // 布林壓縮突破
  'bollinger-squeeze-up':               'entry_strong',

  // ── 進場軟訊號（需配合其他條件確認） ────────────────────────────
  // 母子懷抱（變盤要等下一根突破才算硬）
  'zhu-bullish-harami-low':             'entry_soft',
  'zhu-bullish-mother-son-transition':  'entry_soft',
  // 朱轉折波短線（5MA 太短易雜訊）
  'zhu-turning-wave-5ma-bull':          'entry_soft',
  // K 線中性提示（變盤）
  'candle-merge-signal':                'entry_soft',
  'low-hammer-attack':                  'entry_soft',
  'low-cross-attack':                   'entry_soft',
  'low-three-red-attack':               'entry_soft',
  // 走圖 SOP 低檔變盤（「準備停利」= 軟訊號，等確認）
  'sop-low-reversal-signal':            'entry_soft',
  // 葛蘭碧 4
  'granville-buy-4':                    'entry_soft',
  // 量價 9 種，label 內容變動，預設 soft（具體強度看 label 文字）
  'zhu-price-volume-9':                 'entry_soft',
  // 朱低檔急跌回補（反空訊號）
  'zhu-takeprofit-low-climax-bear':     'entry_soft',

  // ── 出場硬訊號 ───────────────────────────────────────────────────
  // 走圖 SOP 空頭
  'sop-bear-confirm-entry':             'exit_strong',
  'sop-bear-bounce-sell':               'exit_strong',
  'sop-consolidation-breakdown':        'exit_strong',
  // 缺口空頭
  'gap-down-long-black':                'exit_strong',
  'gap-three-day-two-gaps-down':        'exit_strong',
  // K 線組合（強勢續跌 / 反轉確認）
  'kline-three-line-reverse-black':     'exit_strong',
  'kline-inner-three-black':            'exit_strong',
  'kline-three-consecutive-black':      'exit_strong',
  'kline-trading-bull-exit':            'exit_strong',
  'kline-inverted-v-reversal-sell':     'exit_strong', // 4 條件全符合的明確反轉
  'kline-major-resistance-ahead':       'exit_strong', // 大敵當前出貨（已連續上影線）
  'kline-one-star-two-yin':             'exit_strong', // 已破低
  'kline-falling-three-methods':        'exit_strong', // 已長黑吞噬反彈
  'kline-black-red-black':              'exit_strong', // 下跌中繼確認
  // 朱頂部反轉（書本對應底部三型）
  'zhu-flat-top-breakdown':             'exit_strong',
  'zhu-lower-top-breakdown':            'exit_strong',
  'zhu-false-breakout-breakdown':       'exit_strong', // 穿頭破底（頂部最弱，但仍是硬訊號）
  // 朱 K 線轉折硬訊號（黑K已成立）
  'zhu-dark-cloud-cover':               'exit_strong',
  'zhu-bearish-engulfing-high':         'exit_strong',
  'zhu-bearish-piercing-high':          'exit_strong',
  'zhu-bearish-double-star':            'exit_strong',
  'zhu-evening-star-high':              'exit_strong',
  // 朱進場位置反向（空頭三進場 = 多單反向出場硬訊號）
  'zhu-short-bear-sop':                 'exit_strong',
  'zhu-bear-bounce-entry':              'exit_strong',
  'zhu-bear-breakdown-entry':           'exit_strong',
  'zhu-bear-break-low-entry':           'exit_strong',
  'zhu-bear-engulf-entry':              'exit_strong',
  // 朱停損紀律（書本硬規則）
  'zhu-stoploss-kline-low':             'exit_strong',
  'zhu-stoploss-trend-change':          'exit_strong',
  'zhu-stoploss-max-10pct':             'exit_strong',
  'zhu-long-trend-ma20-exit':           'exit_strong',
  'zhu-short-kline-exit':               'exit_strong',
  'zhu-short-ma5-exit':                 'exit_strong',
  // 朱停利紀律（達標即出場是書本硬規則，不算「建議」）
  'zhu-takeprofit-10pct':               'exit_strong',
  'zhu-takeprofit-high-climax-bull':    'exit_strong',
  'zhu-takeprofit-resistance':          'exit_strong',
  // 朱轉折波空頭
  'zhu-turning-wave-20ma-bear':         'exit_strong',
  'zhu-turning-wave-triple-bear':       'exit_strong',
  // 飆股出場
  'surge-stock-exit':                   'exit_strong',
  'zhu-surge-hold-or-sell':             'exit_strong',
  // 高檔 smart K 線（已成立轉折）
  'high-shooting-star':                 'exit_strong',
  'high-engulf-sell':                   'exit_strong',
  'high-evening-star':                  'exit_strong',
  // 均線 sell（書本明確跌破出場）
  'single-ma20-sell':                   'exit_strong',
  'triple-ma-death-cross-sell':         'exit_strong',
  'dual-ma10-ma24-sell':                'exit_strong',
  'weekly-ma20-sell':                   'exit_strong',
  // 長線出場
  'long-term-head-lower-exit':          'exit_strong',
  // 葛蘭碧 5-7（跌破均線、反彈失敗、急跌）
  'granville-sell-5':                   'exit_strong',
  'granville-sell-6':                   'exit_strong',
  'granville-sell-7':                   'exit_strong',
  // 布林壓縮跌破
  'bollinger-squeeze-down':             'exit_strong',

  // ── 出場軟訊號（提示型，需等其他條件確認） ──────────────────────
  // 變盤類（要等下根確認）
  'zhu-bearish-mother-son-transition':  'exit_soft',
  'zhu-bearish-harami-high':            'exit_soft',
  'sop-high-reversal-warning':          'exit_soft', // 「準備停利」= 軟訊號
  // 短線變盤
  'high-cross-sell':                    'exit_soft',
  // 長線停利建議
  'long-term-profit-take':              'exit_soft',
  'long-term-doubled-warning':          'exit_soft',
  // 葛蘭碧 8（停利建議）
  'granville-sell-8':                   'exit_soft',
  // 量價背離
  'zhu-turning-wave-5ma-bear':          'exit_soft',
  'zhu-turning-wave-10ma-bear':         'exit_soft',
  // K 線提示
  'kline-up-gap-filled':                'exit_soft', // 上缺回補反轉（需配合趨勢確認）
  'smart-kline-sell':                   'exit_soft', // 智慧K線賣出（綜合提示）

  // ── 趨勢/持股提示（不觸發動作） ─────────────────────────────────
  // 飆股位置 / 階段提示
  'zhu-position-risk':                  'warn',
  'zhu-market-cycle-4stage':            'warn',
  'zhu-surge-volume-5types':            'warn',
  // 量能型態
  'zhu-accumulation-volume':            'warn',
  // 高乖離警示
  'zhu-bias-warning':                   'warn',
  // 半值線（中性強度提示）
  'zhu-half-price-strength':            'warn',
};

// ────────────────────────────────────────────────────────────────────────────
// Legacy pattern lists（給沒在上表內的 ruleId / 第三方 RuleSignal 兜底）
// ────────────────────────────────────────────────────────────────────────────

/** 硬出場 ruleId/label 關鍵字（書本硬規則） */
const EXIT_STRONG_PATTERNS: readonly (string | RegExp)[] = [
  '破MA5',
  '破月線',
  '跌破前低',
  '跌破頸線',
  '長黑吞噬',
  '長黑K',
  '跌破支撐',
  '布林壓縮跌破',
  /^ma5-exit/i,
  /^sell-break-/i,
  /^granville-sell-(5|6|7)/i,
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
  '葛蘭碧⑧停利',
  /^granville-sell-8/i,
];

/** 明確進場（書本硬規則） */
const ENTRY_STRONG_PATTERNS: readonly (string | RegExp)[] = [
  '回後買',
  '盤整突破',
  '假跌破反彈',
  '一字底',
  '缺口突破',
  '攻擊買進',
  '買上漲',
  '打底突破',
  '葛蘭碧①',
  '葛蘭碧②',
  '葛蘭碧③',
  '布林壓縮突破',
  '朱SOP做多',
  '破底穿頭',
  '底底高突破',
  '上升旭日',
  '低檔長紅吞噬',
  '低檔長紅貫穿',
  '早晨之星',
  '多頭雙星變盤',
  '黃金右腳',
  /^breakout-/i,
  /^entry-/i,
  /^granville-buy-(1|2|3)/i,
  /^bollinger-squeeze-up/i,
];

/** 軟進場 */
const ENTRY_SOFT_PATTERNS: readonly (string | RegExp)[] = [
  '可能買點',
  '觀察買點',
  '葛蘭碧④反彈',
  '低檔母子',
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
 *
 * 順序：
 *   1. sig.subtype 已設（detector 自帶分類，最權威）
 *   2. WATCH type → warn（先攔住）
 *   3. RULE_ID_TO_SUBTYPE 查表（先試 type:ruleId 複合鍵，再試 ruleId 單鍵）
 *   4. Pattern list 後備（label/description/ruleId 子字串/regex 比對）
 *   5. Type-based default（BUY/ADD→entry_soft, SELL/REDUCE→exit_strong）
 */
export function classifySignal(sig: RuleSignal): SignalSubtype {
  // 1) detector 自帶分類最權威
  if (sig.subtype) return sig.subtype;

  // 2) WATCH type 一律 warn（在 lookup 前先攔住，避免雙向 detector 的 WATCH 分支誤吃 lookup）
  if (sig.type === 'WATCH') return 'warn';

  // 3) ruleId lookup — 先試 type:ruleId 複合鍵（雙向 detector），再試 ruleId 單鍵
  const composite = RULE_ID_TO_SUBTYPE[`${sig.type}:${sig.ruleId}`];
  if (composite) return composite;
  const fromTable = RULE_ID_TO_SUBTYPE[sig.ruleId];
  if (fromTable) return fromTable;

  const isExitType = sig.type === 'SELL' || sig.type === 'REDUCE';
  const isBuyType  = sig.type === 'BUY' || sig.type === 'ADD';

  // 4) Pattern list 後備
  if (isExitType) {
    if (matches(sig, EXIT_STRONG_PATTERNS)) return 'exit_strong';
    if (matches(sig, EXIT_SOFT_PATTERNS)) return 'exit_soft';
    // 5a) 不認得的 SELL/REDUCE 保守歸 exit_strong（寧可早出場）
    return 'exit_strong';
  }

  if (isBuyType) {
    if (matches(sig, TREND_PATTERNS)) return 'trend';
    if (matches(sig, WARN_PATTERNS)) return 'warn';
    if (matches(sig, ENTRY_STRONG_PATTERNS)) return 'entry_strong';
    if (matches(sig, ENTRY_SOFT_PATTERNS)) return 'entry_soft';
    // 5b) 不認得的 BUY/ADD 保守歸 entry_soft（不誤升為硬進場）
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
