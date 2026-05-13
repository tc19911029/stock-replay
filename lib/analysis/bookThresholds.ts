/**
 * 書本門檻單一事實來源（Single Source of Truth）
 *
 * 所有「使用者在 UI 看到的條件門檻」都從這裡讀，detector 內部的硬編常數也以此為對照。
 * 衝突時的優先順序：**書本（寶典 > 抓住飆股 > 5 步驟 > 高勝率）** > detector > Config > UI。
 *
 * 改這檔等於改使用者看到的字面值。改前必先回查書本頁碼。
 *
 * 引用慣例：
 * - 寶典 = 朱家泓《活用技術分析寶典》2024 版
 * - 5 步驟 = 朱家泓《做對 5 個實戰步驟》
 * - 抓住飆股 = 朱家泓《抓住飆股輕鬆賺》
 * - 寶典 Part X / p.YY = 書內章節 / 頁碼
 */

// ── 共用書本門檻 ──────────────────────────────────────────────────────────────

/** 紅 K 實體最低 %（寶典 p.55 ⑤、5 步驟 p.40）— 大量長紅 K 的「長」定義 */
export const BOOK_BODY_PCT_MIN = 2.0;

/** 攻擊量最低倍數 vs 前一日（寶典 p.54 ④）— 大量長紅 K 的「大量」定義 */
export const BOOK_VOL_RATIO_MIN = 1.3;

// ── F：V 形反轉（寶典 Part 12 祕笈圖 #1 + 抓住K線 第 7 篇）──────────────────

/** 連跌天數門檻：5 根中至少 3 根下跌 */
export const VREVERSAL_MIN_DOWN_DAYS = 3;
/** 連跌段累計跌幅 %（書本 ≥ 10%）*/
export const VREVERSAL_MIN_DROP_PCT = 10;
/** 反轉日量比 vs 前 5 日均量（書本：紅 K 帶量 ×1.5）*/
export const VREVERSAL_VOL_MULT = 1.5;

// ── D：一字底突破（抓住飆股 25 型態 #9）───────────────────────────────────

/** 底部盤整最低天數 */
export const FLATBOTTOM_MIN_CONSOL_DAYS = 40;
/** 突破日量比 vs 盤整期均量 */
export const FLATBOTTOM_BREAKOUT_VOL_MULT = 2.0;

// ── I / K：K 線橫盤突破（寶典 Part 11-1 位置 3 + Part 12-4 祕笈圖 #5）──────

/** 中長紅 K 錨點實體 %（寶典 Part 4-1「長紅」）*/
export const KLINE_CONSOL_ANCHOR_BODY_PCT = 3;
/** 橫盤天數區間 */
export const KLINE_CONSOL_MIN_DAYS = 4;
export const KLINE_CONSOL_MAX_DAYS = 15;
/** 橫盤狹幅（高低差 / 錨點高 %）*/
export const KLINE_CONSOL_MAX_RANGE_PCT = 5;

// ── H / L：突破大量黑 K（寶典 Part 11-1 位置 8 + Part 12-4 祕笈圖 #9）────────

/** 黑 K 實體最低 %（「大量長黑 K」之「長」門檻）*/
export const BLACKK_MIN_BODY_PCT = 1.5;
/** 黑 K 量比 vs 前日 */
export const BLACKK_MIN_VOL_RATIO = 1.3;
/** 突破時限：黑 K 後 N 日內紅 K 突破 */
export const BLACKK_MAX_DAYS_AFTER = 3;

// ── G / J：ABC 突破（寶典 Part 11-1 位置 6 + Part 12-4 祕笈圖 #16）───────────

export const ABC_MIN_PRIOR_RUN_PCT = 8;
export const ABC_MIN_CORRECTION_DROP_PCT = 3;
export const ABC_MIN_CORRECTION_SPAN_DAYS = 6;

// ── B：回後買上漲（寶典 Part 12-4 祕笈圖 #1）──────────────────────────────

/**
 * B「站回 MA5」回看天數窗（含今日）— 過去 N 根 K 棒任一天 close 由跌破 → 站回 MA5
 * 書本《寶典》Part 12-4：站回 MA5 後不一定當日突破，第 1-2 日內補量突破亦可。
 * 視窗用閉區間：detectPullbackBuy 內部用 BOOK_RECLAIM_LOOKBACK - 1 當 offset。
 */
export const BOOK_RECLAIM_LOOKBACK = 3;

// ── M：突破軌道線（v12 寶典 p.387）──────────────────────────────────────────

/** 真突破緩衝 %（抓飆股 p.338 真突破 ×3%）*/
export const TRUE_BREAKOUT_PCT = 0.03;
/** 兩 pivot low 之間最少間隔天數（避免軌道線太陡）*/
export const CHANNEL_MIN_PIVOT_GAP_DAYS = 5;

// ── 均線糾結/盤整 tightness（書本未量化 — 自創）────────────────────────────
//
// 朱家泓「均線糾結突破」（Part 4 p.299-303）+「狹幅盤整 5-6 天」（Part 4 p.299）
// 書本都只用「狹幅 / 糾結 / 緊密」等模糊詞，沒給具體 %。下列常數為實作合理上界，
// 改動會影響選股鬆緊，但不違反書本本意。
//
// ⚠️ 自創 — 0513 ABCDE D-medium 集中管理。

/** 三線聚合最大 spread (max(MA5,10,20)-min) / close 上限（自創 3%）*/
export const MA_CLUSTER_MAX_SPREAD = 0.03;
/** 區間盤整（C/E 一字底/range breakout）狹幅 tightness 上限（自創 15%）*/
export const CONSOL_MAX_TIGHTNESS = 0.15;
/** C 盤整突破：上頸線不大幅上揚（新高 ≤ 舊高 × ratio，自創 1.05）*/
export const C_NECKLINE_MAX_UPWARD_RATIO = 1.05;
/** D 一字底盤整回看最大天數（自創 120）*/
export const FLATBOTTOM_MAX_LOOKBACK = 120;
/** MA20 乖離警示 %（自創 12%，書本 p.568「盡量避免追高」未量化）*/
export const MA20_WARN_DEVIATION_PCT = 0.12;

// ── N：25 型態確認（抓住飆股）─────────────────────────────────────────────

/** 三重底/三重頂價位容差 % */
export const TRIPLE_PATTERN_TOLERANCE_PCT = 0.05;
/** 雙重底/雙重頂價位容差 % */
export const DOUBLE_PATTERN_TOLERANCE_PCT = 0.05;
/** 楔形收斂比率 */
export const WEDGE_CONVERGENCE_RATIO = 1.2;
/** 真跌破緩衝 %（鏡像 TRUE_BREAKOUT_PCT）*/
export const TRUE_BREAKDOWN_PCT = 0.03;

// ── O：打底完成（高勝率位置 1）─────────────────────────────────────────────

export const BASE_COMPLETION_MIN_DAYS = 10;
export const BASE_COMPLETION_MAX_LOOKBACK = 60;
/** 打底期「大量」門檻 vs 過去 5 日均量 */
export const BASE_HIGH_VOL_RATIO = 1.5;

// ── P：高檔淺回（高勝率位置 3「等拉回」）──────────────────────────────────

/** 淺回上限（議題 5「等拉回」≤ N 天）*/
export const PULLBACK_MAX_DAYS = 2;
/** 拉回前需有的最低漲幅 % */
export const PULLBACK_MIN_PRIOR_RUN_PCT = 5;

// ── Q：三均戰法（朱家泓網路課程 MA3/MA10/MA24）────────────────────────────
// Q 沒有量價門檻，純均線結構，無常數需要 export。

// ── 書本短線守則（停損 / 停利）─────────────────────────────────────────────
//
// 朱家泓「短線守則」p.41 + 寶典 Part 2：停損 7%、獲利達 10% 啟用進階紀律。
// 這是書本明確規則，UI 任何停損/停利顯示都應讀這兩個常數。

/** 停損守則：書本「停損 7%」上限 — 進場價 × (1 - 0.07) */
export const STOP_LOSS_RULE_PCT = 0.07;
/** 停損價係數：1 - STOP_LOSS_RULE_PCT = 0.93（給 UI 直接乘） */
export const STOP_LOSS_PRICE_MULT = 1 - STOP_LOSS_RULE_PCT;
/** 停利守則：書本「達 10% 啟用進階紀律」 */
export const PROFIT_TARGET_RULE_PCT = 0.10;
/** 停利價係數：1 + PROFIT_TARGET_RULE_PCT = 1.10（給 UI 直接乘） */
export const PROFIT_TARGET_PRICE_MULT = 1 + PROFIT_TARGET_RULE_PCT;
/** 高乖離切 MA5：書本「乖離 ≥ 15% 改用 MA5 跟隨」 */
export const HIGH_DEVIATION_PCT = 0.15;
/** 獲利分級：高檔（書本「獲利 ≥ 20% 屬高檔」）*/
export const PROFIT_HIGH_TIER_PCT = 0.20;

// ── 六大條件分數色階 / 門檻（純顯示用）────────────────────────────────────

/** 核心 5 條件最低門檻（書本「3 線多排」必過）— SixConditionsPanel 顯示用 */
export const CORE_SCORE_MIN = 3;
/** 六條件分數顯示色階：金（建議進場）*/
export const SCORE_COLOR_GOLD = 5;
/** 六條件分數顯示色階：藍（候選）*/
export const SCORE_COLOR_BLUE = 4;

// ── MTF (multi-timeframe) 分數色階（純顯示用，UI ScanResultsTable）───────────

export const MTF_SCORE_STRONG = 4;  // ≥ 4 強
export const MTF_SCORE_OK     = 3;  // ≥ 3 可

// ── AI 信心分級（純顯示用，store backtestStore）────────────────────────────

export const AI_CONFIDENCE_HIGH   = 80;
export const AI_CONFIDENCE_MEDIUM = 50;

// ── 勝率色階（純顯示用，BacktestSection）──────────────────────────────────

export const WIN_RATE_STRONG = 60;
export const WIN_RATE_MEDIUM = 50;

// ── 綜合評分色階（純顯示用，BacktestSection）──────────────────────────────

export const COMPOSITE_STRONG = 70;
export const COMPOSITE_OK     = 55;

// ── 籌碼分級（純顯示用，BacktestSection / TradeRow）──────────────────────

export const CHIP_SCORE_STRONG = 70;
export const CHIP_SCORE_MEDIUM = 50;
/** 籌碼等級門檻：S/A/B/C/D */
export const CHIP_GRADE_S = 80;
export const CHIP_GRADE_A = 65;
export const CHIP_GRADE_B = 50;
export const CHIP_GRADE_C = 35;

// ── 當沖比門檻（純顯示用，ChipDetailPanel）─────────────────────────────────

export const DAY_TRADE_RATIO_HIGH = 40;
export const DAY_TRADE_RATIO_WARN = 25;

// ── KD 指標超買/超賣（純顯示用，IndicatorCharts）──────────────────────────

export const KD_OVERBOUGHT = 80;
export const KD_OVERSOLD   = 20;

// ── 9:25 集合競價進場門檻（DABAN/打板策略，純顯示用）────────────────────

/** 開盤 ≥ 收盤 × (1 + AUCTION_ENTRY_PREMIUM) 才進場 */
export const AUCTION_ENTRY_PREMIUM = 0.02;

// ── Composite Score 加權公式（features/scan/components/TradeRow）──────────
//
// 用於掃描結果列表的綜合評分（顯示用，不影響選股）。
// 權重總和應 ≈ 1.0；改動會直接影響使用者看到的排名。

export const COMPOSITE_WEIGHTS = {
  sixCon:      0.30,
  surge:       0.20,
  winRate:     0.25,
  position:    0.10,
  volume:      0.10,
  breakout:    0.05,
} as const;
