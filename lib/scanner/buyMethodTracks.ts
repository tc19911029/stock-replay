/**
 * 買法字母軌道分類單一事實來源（Single Source of Truth）
 *
 * 對應書本五步法 / 朱家泓 8 種進場位置 + v12 反轉 / 戰法軌設計。
 *
 * 改動前必看：CLAUDE.md 規則 #10 + memory `feedback_step2_must_pass_step1.md`。
 *
 * 軌道分流（用戶 2026-05-11 確認）：
 * - **多頭軌**：必須過 Step 1（六條件 + 戒律 + 淘汰法）— UI tab 載入時要 `matchedMethods.includes('A')` 過濾
 * - **反轉軌**：書本「抓底/反轉」設計上全市場掃，不過 Step 1 — UI 不再過濾 A
 * - **戰法軌**：朱家泓三均戰法（MA3+10+24），自含趨勢判定，不過 Step 1
 *
 * 改動本檔同時更新：
 * - `lib/scanner/ScanPipeline.ts`（生產掃描）
 * - `lib/scanner/MarketScanner.ts`
 * - `lib/storage/scanStorage.ts`（retro-filter）
 * - `store/backtestStore.ts`（UI 過濾）
 * - `features/scan/ScanPanelVertical.tsx`（UI tab 順序）
 * - `app/api/cron/scan-bm-batch/route.ts`（cron 分批）
 * - `scripts/cleanup-step1-leak.ts` + `scripts/audit-step1-vs-bm.ts`
 * - `__tests__/contracts/scan-parity.test.ts`
 */

/** 多頭軌字母（書本《活用技術分析寶典》Part 11-1 八種進場位置 + v12 鎖股對應）*/
export const BULLISH_TRACK_LETTERS = ['B', 'C', 'E', 'J', 'K', 'L', 'M', 'P'] as const;

/**
 * v11 → v12 字母對照（讀舊資料用，新代碼不寫 v11）
 *   G(ABC 突破) → J
 *   H(過大量黑 K) → L
 *   I(K 線橫盤) → K
 *
 * 2026-05-12 用戶決議：只留 v12 命名，v11 G/H/I 視為舊版 alias。
 * 載入舊 scan / lockwatch / portfolio 資料時 normalize 成 v12 letter。
 */
export const V11_TO_V12_LETTER: Readonly<Record<string, string>> = {
  G: 'J',
  H: 'L',
  I: 'K',
};

/** 規範化字母：若是 v11 alias 自動轉 v12，否則原樣返回 */
export function normalizeLetter(letter: string): string {
  return V11_TO_V12_LETTER[letter] ?? letter;
}

/** 規範化整個陣列：去除 v11，去重保留順序 */
export function normalizeMatchedMethods(matched: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matched) {
    const n = normalizeLetter(m);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** 反轉軌字母（書本「抓底/反轉」型態）*/
export const REVERSAL_TRACK_LETTERS = ['D', 'F', 'N', 'O'] as const;

/** 戰法軌字母（朱家泓網路課程「三條均線戰法 MA3+10+24」）*/
export const SYSTEM_TRACK_LETTERS = ['Q'] as const;

/** 全部買法字母（A = 六條件池子本身，不算 Step 2 軌道）*/
export const ALL_BUY_METHOD_LETTERS = ['A', ...BULLISH_TRACK_LETTERS, ...REVERSAL_TRACK_LETTERS, ...SYSTEM_TRACK_LETTERS] as const;

/** Set 形式 — 給 has() 快速查詢 */
export const BULLISH_TRACK_SET: ReadonlySet<string> = new Set(BULLISH_TRACK_LETTERS);
/**
 * 多頭軌（含 v11 alias）— 給 Step 1 gate / filter-on-read 用
 * v11 G/H/I 仍可能出現在舊 scan 資料的 matchedMethods 裡，必須當作多頭軌過 Step 1
 */
export const BULLISH_TRACK_SET_WITH_V11: ReadonlySet<string> = new Set([
  ...BULLISH_TRACK_LETTERS,
  ...Object.keys(V11_TO_V12_LETTER),
]);
export const REVERSAL_TRACK_SET: ReadonlySet<string> = new Set(REVERSAL_TRACK_LETTERS);
export const SYSTEM_TRACK_SET: ReadonlySet<string> = new Set(SYSTEM_TRACK_LETTERS);

/** 反轉軌 ∪ 戰法軌（不過 Step 1 的字母集合）*/
export const REVERSAL_OR_SYSTEM_SET: ReadonlySet<string> = new Set([
  ...REVERSAL_TRACK_LETTERS,
  ...SYSTEM_TRACK_LETTERS,
]);

export type BullishLetter = typeof BULLISH_TRACK_LETTERS[number];
export type ReversalLetter = typeof REVERSAL_TRACK_LETTERS[number];
export type SystemLetter = typeof SYSTEM_TRACK_LETTERS[number];

/** 判斷某字母屬於哪個軌道 */
export function trackOf(letter: string): 'pool' | 'bullish' | 'reversal' | 'system' | 'unknown' {
  if (letter === 'A') return 'pool';
  if (BULLISH_TRACK_SET.has(letter)) return 'bullish';
  if (REVERSAL_TRACK_SET.has(letter)) return 'reversal';
  if (SYSTEM_TRACK_SET.has(letter)) return 'system';
  return 'unknown';
}

/** 該軌道是否須過 Step 1（六條件 + 戒律 + 淘汰法）池子？含 v11 alias G/H/I */
export function requiresStep1Pool(letter: string): boolean {
  return BULLISH_TRACK_SET_WITH_V11.has(letter);
}

// ── 字母 → 中文名稱（單一事實來源）─────────────────────────────────────────
//
// 對齊書本《活用技術分析寶典》Part 11-1 + 朱家泓網路課程命名。
// 之前散佈在 9+ 處且名字不統一（F: V 反轉/V 型反轉/V反轉；K: K線橫盤/K 線橫盤；
// L: 突破黑K/過大量黑 K；M: 軌道線突破/突破軌道線；Q: 三均線戰法/三條均線戰法），
// 導致同一檔股票在不同畫面顯示不同字串 — 用戶認知混淆。
//
// 改名請同時更新書本對照表 (docs/TECHNICAL_ANALYSIS_5STEPS.md) 跟記憶。

/** 字母 → 簡潔中文名（UI tab / chip / row 用，書本對齊）*/
export const LETTER_NAMES: Readonly<Record<string, string>> = {
  A: '六條件',
  // ── 多頭軌（8 種進場位置，書本 Part 11-1 + 寶典 p.694-699）──
  B: '回後買上漲',         // 寶典 Part 11-1 位置 2 / 5 步驟 p.40
  C: '盤整突破',           // 寶典 Part 11-1 位置 1 / 5 步驟 p.40
  E: '缺口',               // 寶典 Part 11-1 位置 4 / 5 步驟 p.40
  J: 'ABC 突破',           // 寶典 Part 11-1 位置 6 p.697
  K: 'K 線橫盤',           // 寶典 Part 11-1 位置 3 p.694
  L: '過大量黑 K',         // 寶典 Part 11-1 位置 8 p.699
  M: '突破軌道線',         // 寶典 p.387
  P: '高檔拉回',           // 寶典 Part 11-1 位置 5 等拉回
  // ── 反轉軌（書本「抓底/反轉」）──
  D: '一字底',             // 抓住飆股 25 型態 #9
  F: 'V 型反轉',           // 寶典 Part 12 祕笈圖 #1 + 抓住K線 第 7 篇
  N: '型態確認',           // 抓住飆股 25 型態
  O: '打底完成',           // 寶典 Part 11-1 位置 1（反轉解讀）
  // ── 戰法軌 ──
  Q: '三條均線戰法',       // 朱家泓網路課程 MA3+10+24
  // 注意：v11 G/H/I 字母不在 LETTER_NAMES 中。讀舊資料時應先 normalizeLetter() 轉成 v12。
};

/** 取字母中文名，找不到回原字母 */
export function nameOf(letter: string): string {
  return LETTER_NAMES[letter] ?? letter;
}
