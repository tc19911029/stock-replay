/**
 * 14 字母（含 v11 G/H/I alias）持倉操作 SOP 單一事實表
 *
 * 0513 建立目的：把散落在 4+ 個檔案的字母 set/map/switch 統一到一份表，
 * - HoldingV12Signals.tsx：step5HintFor + ENHANCED_DISCIPLINE_LETTERS + SELL_SIGNAL_NON_APPLICABLE + PATTERN_BREAK_LETTERS + VBOTTOM_BREAK_LETTERS
 * - lib/sell/v12StopLoss.ts：SIGNAL_TO_PRIMARY_STOP + SIGNAL_TO_TRAILING_MA + SIGNAL_TO_FIXED_STOP_PCT
 * - lib/sell/v12Operation.ts：getOperationMA
 * 改動規則：改一處（這個檔），其他地方都從這裡讀。
 *
 * 書本依據：寶典 Part 11-1 + 抓住K線 + 朱家泓網路課程
 *
 * 引用慣例：
 * - 寶典 = 朱家泓《活用技術分析寶典》2024 版
 * - 抓住飆股 = 朱家泓《抓住飆股輕鬆賺》
 * - 抓住K線 = 朱家泓《抓住K線獲利無限》
 * - 5 步驟 = 朱家泓《做對 5 個實戰步驟》
 */

import { normalizeLetter } from '@/lib/scanner/buyMethodTracks';
import type { V12Letter } from '@/lib/analysis/v12Signals';

/**
 * 持倉操作守則 — 書本對齊：每字母對應書本特定 SOP
 *
 * 為什麼書本要分字母：
 * - B/P 守 MA5、進階紀律：寶典 #5/#6（短線進攻型）
 * - C/E/K 守支撐線（盤整下緣/缺口/橫盤下緣）
 * - J/M 守 pivot low（ABC 突破/軌道線突破）
 * - L 守黑 K low（過大量黑 K 高）
 * - D/O 守 MA20（反轉訊號進場後跟季線）
 * - F 守 V 底 + MA3（V 反轉戰法明寫 3 日均線）
 * - N 守頸線+目標價（型態確認）
 * - Q 守 MA10（戰法獨立）
 */
export interface LetterSOP {
  /** 中文名稱 */
  name: string;
  /** 書本根據（頁碼 + 一句話原文） */
  bookRef: string;
  /** 操作均線（跌破出場） */
  operatingMA: 'MA3' | 'MA5' | 'MA10' | 'MA20' | 'MA60';
  /** 停損守線描述（給 UI hint 用） */
  stopHint: string;
  /** 停利規則描述 */
  takeProfitHint: string;
  /** 是否走 B/P 進階紀律（達 10% 後切 MA5 跟隨；乖離 ≥15% 切 MA5） */
  enhancedDiscipline: boolean;
  /** 出場訊號適用過濾 — 不適用的訊號名不影響 verdict（仍會顯示為資訊性） */
  inapplicableSellSignals: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * 14 字母（A 預選池 + 13 進場字母）對應 SOP
 * G/H/I 為 v11 alias，呼叫端應先 normalizeLetter() 轉成 v12 後查表。
 */
export const LETTER_SOP: Readonly<Record<V12Letter, LetterSOP>> = {
  A: {
    name: '六條件',
    bookRef: '寶典 Part 11-2 p.55「短線做多選股 SOP」',
    operatingMA: 'MA5',
    stopHint: '跌破進場紅 K 低點就出（書本停損 5 法 ①）',
    takeProfitHint: '達 10% 啟用進階紀律 / 乖離 ≥15% 切 MA5（書本短線守則 #6）',
    enhancedDiscipline: false,  // 六條件預選不單獨進場
    inapplicableSellSignals: EMPTY_SET,
  },
  B: {
    name: '回後買上漲',
    bookRef: '寶典 Part 11-1 位置 2 + 5 步驟 p.40',
    operatingMA: 'MA5',
    stopHint: '跌破進場紅 K 低點就出（書本停損 5 法 ①）',
    takeProfitHint: '達 10% 啟用進階紀律 / 乖離 ≥15% 切 MA5（寶典 #5/#6）',
    enhancedDiscipline: true,
    inapplicableSellSignals: EMPTY_SET,
  },
  C: {
    name: '盤整突破',
    bookRef: '寶典 Part 11-1 位置 1',
    operatingMA: 'MA10',
    stopHint: '跌破盤整下緣或 MA10 就出（書本結構支撐 ⑤）',
    takeProfitHint: '達盤整區間幅度（高低差延伸）停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  D: {
    name: '一字底',
    bookRef: '抓住飆股 25 型態 #9',
    operatingMA: 'MA20',
    stopHint: '跌破一字底盤整下緣就出',
    takeProfitHint: '跟 MA20，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: new Set(['BREAK_MA5', 'BREAK_MA10']),
  },
  E: {
    name: '缺口',
    bookRef: '寶典 Part 11-1 位置 4',
    operatingMA: 'MA10',
    stopHint: '跌破缺口下緣就出（書本結構支撐 ⑤）',
    takeProfitHint: '跟 MA10，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  F: {
    name: 'V 型反轉',
    bookRef: '寶典 Part 12 祕笈圖 #1 + 抓住K線 第 7 篇 V 反轉戰法',
    operatingMA: 'MA3',
    stopHint: '跌破 V 底（變盤線 low）就出（抓住K線 V 反轉戰法 4 條件）',
    takeProfitHint: '趨勢確認後跟 MA3；連續 3 天急漲後反轉 K 出場',
    enhancedDiscipline: false,
    // V 反轉初期股價可能還在 MA5 下方 — 不該因跌破 MA5/10 升 verdict
    inapplicableSellSignals: new Set(['BREAK_MA5', 'BREAK_MA10']),
  },
  J: {
    name: 'ABC 突破',
    bookRef: '寶典 Part 11-1 位置 6 p.697',
    operatingMA: 'MA20',
    stopHint: '跌破 C 段底（pivot low）就出（書本停損 5 法 ②）',
    takeProfitHint: '跟 MA20，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  K: {
    name: 'K 線橫盤',
    bookRef: '寶典 Part 11-1 位置 3 p.694',
    operatingMA: 'MA10',
    stopHint: '跌破橫盤區下緣或 MA10 就出（書本結構支撐 ⑤）',
    takeProfitHint: '跟 MA10，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  L: {
    name: '過大量黑 K',
    bookRef: '寶典 Part 11-1 位置 8 p.699',
    operatingMA: 'MA10',
    stopHint: '跌破大量黑 K 那根的 low 就出',
    takeProfitHint: '跟 MA10，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  M: {
    name: '突破軌道線',
    bookRef: '寶典 p.387 上升軌道線',
    operatingMA: 'MA10',
    stopHint: '跌破軌道線或 pivot low 就出（書本停損 5 法 ②）',
    takeProfitHint: '跟 MA10，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: EMPTY_SET,
  },
  N: {
    name: '型態確認',
    bookRef: '寶典 Part 11-1 位置 7 p.697「等型態確認」',
    operatingMA: 'MA10',
    stopHint: '跌破頸線就出（型態結構失效）',
    takeProfitHint: '達型態目標價停利（頸線突破後測量幅度）',
    enhancedDiscipline: false,
    // N 守頸線 + 目標價，不該因 MA5/MA10 跌破升 verdict
    inapplicableSellSignals: new Set(['BREAK_MA5', 'BREAK_MA10']),
  },
  O: {
    name: '打底完成',
    bookRef: '寶典 Part 11-1 位置 1（反轉解讀）',
    operatingMA: 'MA20',
    stopHint: '跌破打底盤整下緣就出',
    takeProfitHint: '跟 MA20，跌破即停利',
    enhancedDiscipline: false,
    inapplicableSellSignals: new Set(['BREAK_MA5', 'BREAK_MA10']),
  },
  P: {
    name: '高檔拉回',
    bookRef: '寶典 Part 11-1 位置 5「等拉回」',
    operatingMA: 'MA5',
    stopHint: '跌破進場紅 K 低點就出（書本停損 5 法 ①）',
    takeProfitHint: '達 10% 啟用進階紀律 / 乖離 ≥15% 切 MA5（寶典 #5/#6）',
    enhancedDiscipline: true,
    inapplicableSellSignals: EMPTY_SET,
  },
  Q: {
    name: '三條均線戰法',
    bookRef: '朱家泓網路課程 MA3+10+24（抓住線圖 p.262）',
    operatingMA: 'MA10',
    stopHint: '跌破 MA10 就出（戰法停損點）',
    takeProfitHint: '跟 MA10，跌破即停利',
    enhancedDiscipline: false,
    // Q 守 MA10，MA5 跌破不適用
    inapplicableSellSignals: new Set(['BREAK_MA5']),
  },
  // v11 字母 G/H/I 不在此表（V12Letter type 不含），呼叫端用 sopFor() 自動 normalizeLetter()
};

/**
 * 取字母 SOP — 自動 normalize v11 alias 並 fallback。
 * 用這個函式替代直接 LETTER_SOP[letter]，永遠安全。
 */
export function sopFor(letter: string): LetterSOP {
  const normalized = normalizeLetter(letter) as V12Letter;
  const sop = LETTER_SOP[normalized];
  if (!sop) {
    // 字母不在表內 → fallback 到 B（最常見）
    return LETTER_SOP.B;
  }
  return sop;
}
