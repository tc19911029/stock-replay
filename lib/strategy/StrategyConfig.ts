// lib/strategy/StrategyConfig.ts
/**
 * 策略版本管理系統
 *
 * 每一個策略版本都是一個結構化設定物件。
 * 掃描器和回測引擎都應該接受這個設定，而不是寫死數值。
 * 這樣可以做到：
 * - 多版本比較
 * - 回測結果綁定策略版本
 * - 使用者自訂策略
 */

export interface StrategyConditionToggles {
  trend:     boolean;  // 趨勢條件
  position:  boolean;  // 位置條件（不在末升段）
  kbar:      boolean;  // K棒條件（長紅突破前高）
  ma:        boolean;  // 均線條件（多頭排列）
  volume:    boolean;  // 量能條件（量增）
  indicator: boolean;  // 指標條件（MACD/KD）
}

export interface StrategyThresholds {
  // 均線條件
  maShortPeriod:   number;   // 短期均線（預設 5）
  maMidPeriod:     number;   // 中期均線（預設 10）
  maLongPeriod:    number;   // 長期均線（預設 20）

  // K棒條件
  kbarMinBodyPct:  number;   // K棒實體最小比例（預設 0.02 = 2%）
  upperShadowMax:  number;   // 上影線最大比例（預設 0.20 = 20%）

  // 量能條件
  volumeRatioMin:  number;   // 量比門檻（書上：前一日×1.3）

  // KD條件
  kdMaxEntry:      number;   // KD 進場上限（預設 88）

  // 乖離條件
  deviationMax:    number;   // MA20 乖離上限（預設 0.20 = 20%）

  // 進場門檻
  minScore:        number;   // 最低六大條件分數（預設 4）

  // 大盤過濾
  marketTrendFilter: boolean; // 是否啟用大盤趨勢過濾
  bullMinScore:    number;   // 多頭時最低分數（預設 4）
  sidewaysMinScore: number;  // 盤整時最低分數（預設 5）
  bearMinScore:    number;   // 空頭時最低分數（預設 6）

  // 長線保護短線（多時間框架過濾）
  multiTimeframeFilter: boolean;  // 是否啟用（預設 false）
  mtfWeeklyStrict: boolean;       // 週線嚴格模式：不通過=拒絕（預設 true）
  mtfMonthlyStrict: boolean;      // 月線嚴格模式：不通過=拒絕（預設 false，只扣分）
  mtfMinScore: number;            // MTF 最低通過分數 0-4（預設 2）

  // 短線輔助過濾（朱老師短線操作10條規則）
  kdDecliningFilter: boolean;     // 短線第9條：KD向下不買（預設 true）

  // 再進場分支（書本戰法 1/4/9：跌破均線出場後，趨勢未破即可放寬條件再進場）
  reentry?: ReentryConfig;
}

/**
 * 再進場分支設定（書本對齊）
 *
 * 朱家泓書本對「初次進場」與「出場後再進場」差別處理：
 *   - 初次進場：必須過完整六條件 + 戒律 + 淘汰法
 *   - 出場後再進場（戰法 1 波浪 / 戰法 4 二條均線）：
 *     若因「跌破 MA5/MA10」短線停利出場，且趨勢沒改變（沒頭頭低、MA 還上揚），
 *     重新站上均線即可再進場，不必重做六條件。
 *
 * 不啟用時（enabled=false 或欄位 undefined），行為與既有完全一致。
 */
export interface ReentryConfig {
  /** 是否啟用再進場分支 */
  enabled: boolean;
  /** 出場原因白名單：只在這些原因觸發後開啟再進場視窗 */
  triggerExitReasons: ReadonlyArray<'ma5StopLoss' | 'ma10StopLoss'>;
  /** 出場後 N 根 K 棒內有效，超過則重置（避免無限期掛單） */
  maxBarsAfterExit: number;
  /** 是否要求趨勢仍為多頭（findPivots/detectTrend 沒出現頭頭低） */
  requireTrendIntact: boolean;
  /** 是否要求收盤站回 MA5 且 MA5 上揚 */
  requireMaReclaimed: boolean;
  /** 是否要求量能未崩塌（當日量 ≥ 5 日均量 × 0.8） */
  requireVolumeOk: boolean;
}

import type { RuleGroupId } from '@/lib/rules/ruleRegistry';

/**
 * 策略類型（Phase 0，2026-04-20 並列買法架構）
 *
 * - 'trend'（預設）：趨勢跟隨體系，套用朱老師 10 大戒律
 * - 'kline-pattern'：K 線型態買法（V 形/缺口/一字底/突破），書本 Part 3 定位，不套戒律
 *
 * 未指定時視為 'trend'，維持舊行為。
 */
export type StrategyType = 'trend' | 'kline-pattern';

export interface StrategyConfig {
  id:          string;     // 唯一識別碼，e.g. 'zhu-v1'
  name:        string;     // 顯示名稱
  description: string;     // 說明
  version:     string;     // 版本號，e.g. '1.0.0'
  author:      string;     // 作者
  createdAt:   string;     // ISO 日期字串
  isBuiltIn:   boolean;    // 是否為內建策略（不可刪除）

  /** 策略類型；預設 'trend'（既有策略全部）。'kline-pattern' 自動 skip 戒律。 */
  strategyType?: StrategyType;

  /** 對應的買法代碼（並列買法架構用，如 'A'/'B'/'C'/'D'/'E'/'F'）；undefined 視為 'A'。
   * 2026-04-21 重整：B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉；G=變盤線（走圖輔助，無 detector） */
  buyMethod?: string;

  conditions:  StrategyConditionToggles;
  thresholds:  StrategyThresholds;

  /**
   * 啟用的規則群組。
   * undefined = 全部群組都啟用（向後相容）。
   * 指定後，只有列出的群組規則會被評估。
   */
  ruleGroups?: RuleGroupId[];
}

// ── 規則群組預設組合 ─────────────────────────────────────────────────────────

/** 通用基礎群組（趨勢/均線/量價/指標），多數策略都需要 */
const BASE_GROUPS: RuleGroupId[] = ['trend-ma', 'volume', 'oscillator'];

/** 朱家泓全部群組 */
const _ALL_ZHU_GROUPS: RuleGroupId[] = [
  'zhu-5steps', 'zhu-kline', 'zhu-reversal',
  'zhu-ma-strategy', 'zhu-momentum', 'zhu-advanced', 'zhu-soar-stock',
];

/** 朱家泓核心群組（不含進階寶典） */
const CORE_ZHU_GROUPS: RuleGroupId[] = [
  'zhu-5steps', 'zhu-kline', 'zhu-reversal',
  'zhu-ma-strategy', 'zhu-momentum',
];

// ── 內建策略 ──────────────────────────────────────────────────────────────────

export const BASE_THRESHOLDS: StrategyThresholds = {
  maShortPeriod:  5,
  maMidPeriod:    10,
  maLongPeriod:   20,
  kbarMinBodyPct: 0.02,
  upperShadowMax: 0.20,
  volumeRatioMin: 1.3,  // 書上p.54：攻擊量 ≥ 前一日 × 1.3
  kdMaxEntry:     88,
  deviationMax:   0.15,
  minScore:       4,    // 基本門檻 4 分
  marketTrendFilter: true,
  // 注意：scanOne() 中 isCoreReady 要求前5個核心條件全過（coreScore=5），
  // 因此 bullMinScore/sidewaysMinScore < 5 實際等於 5。
  // minScore = 6 才有額外效果（要求指標條件也過）。
  bullMinScore:   5,    // 多頭：核心5條件全過
  sidewaysMinScore: 5,  // 盤整：核心5條件全過
  bearMinScore:   6,    // 空頭嚴格：6條件全過（含指標）
  // 長線保護短線（預設關閉，由 UI 開關控制）
  multiTimeframeFilter: false,
  mtfWeeklyStrict:  true,   // 週線不通過=拒絕
  mtfMonthlyStrict: false,  // 月線不通過=只扣分
  mtfMinScore:      3,      // 至少3/4分

  // 短線輔助過濾（預設開啟，與書本一致）
  kdDecliningFilter: true,
};

/** 再進場：書本明文支援的預設設定（戰法 1/4/9） */
const BOOK_REENTRY: ReentryConfig = {
  enabled: true,
  triggerExitReasons: ['ma5StopLoss', 'ma10StopLoss'],
  maxBarsAfterExit: 10,
  requireTrendIntact: true,
  requireMaReclaimed: true,
  requireVolumeOk: true,
};

const ALL_CONDITIONS_ON: StrategyConditionToggles = {
  trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
};

/**
 * 朱家泓純書本版（對照基準）
 *
 * 參數只寫《活用技術分析寶典》p.54 短線做多 SOP 明確記載的數字；
 * 書本沒寫具體值的（KD 上限、乖離上限、上影線）一律放寬到不限。
 * 目的：提供 100% 書本對照，用來檢驗演算法是否忠實實作書本邏輯。
 *
 * 書本明寫：
 * - 量比 ≥ 前一日 × 1.3（p.54 ④）
 * - 紅 K 實體 ≥ 2%（p.54 ⑤）
 * - 六條件 1~5 為必要（5 分通過 = 進場）
 * - 空頭不做多（bearMinScore=6 實質禁入）
 * - KD 向下不買（短線規則第 9 條）
 */
export const ZHU_PURE_BOOK: StrategyConfig = {
  id:          'zhu-pure-book',
  name:        '朱家泓純書本版（對照基準）',
  description: '寶典 p.54 100% 對齊，只寫書本明確記載的門檻，其餘全放寬',
  version:     '1.0.0',
  author:      '朱家泓（對照基準）',
  createdAt:   '2026-04-18T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin:   1.3,   // 書本 p.54 ④ 明寫
    kbarMinBodyPct:   0.02,  // 書本 p.54 ⑤ 明寫
    kdMaxEntry:       100,   // 書本沒寫 → 不限
    deviationMax:     0.15,  // 用戶設定：乖離 >15% 篩除（2026-04-22）
    upperShadowMax:   1.0,   // 書本沒寫 → 不限
    minScore:         5,
    bullMinScore:     5,     // 書本 1~5 必要
    sidewaysMinScore: 5,
    bearMinScore:     6,     // 實質禁空頭進場
    marketTrendFilter:  true,
    kdDecliningFilter:  true,
    multiTimeframeFilter: false,
    reentry: BOOK_REENTRY,   // 戰法 1 波浪：跌破 MA5 出場後再站上即可再進場
  },
  ruleGroups:  [...CORE_ZHU_GROUPS, ...BASE_GROUPS],
};

/**
 * D 一字底突破策略（並列買法架構，Phase 1，2026-04-20）
 *
 * 朱家泓《抓住飆股》25種型態 #9 + 寶典高勝率位置 ④：
 *   底部盤整≥40天 + MA5/10/20 糾結 + 量縮 → 大量長紅突破
 *
 * 此策略不套戒律（strategyType='kline-pattern'），書本 Part 3 定位為 K 線型態買法。
 * 底層偵測用 lib/analysis/highWinRateEntry.ts 的 detectStrategyE()。
 * 2026-04-21 rename：買法字母 E→D。
 */
export const ZHU_FLAT_BOTTOM: StrategyConfig = {
  id:          'zhu-flat-bottom',
  name:        '一字底突破（D）',
  description: '朱家泓《抓住飆股》型態 #9：底部盤整≥40天+均線糾結+量縮→大量長紅突破',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-04-20T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'D',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    // 一字底有自己的偵測邏輯，下列門檻僅當 fallback
    volumeRatioMin: 2.0,   // 突破日量 ≥ 盤整期平均 × 2（detector 內部已檢查）
    kbarMinBodyPct: 0.02,  // 書本 p.54 ⑤
    minScore:       0,     // 不靠六條件分數，靠 detectStrategyE() 布林
    marketTrendFilter: false,  // 一字底本身就是底部反轉，不限大盤趨勢
  },
};

/**
 * E 缺口進場策略（並列買法架構，Phase 2，2026-04-20）
 *
 * 朱家泓《做對5個實戰步驟》p.40 做多位置 4「跳空上漲」：
 *   向上跳空缺口 + 量≥1.3 + 紅K實體≥2%
 *
 * 不套戒律（strategyType='kline-pattern'），不限大盤趨勢。
 * 底層偵測用 lib/analysis/gapEntry.ts 的 detectStrategyD()（保留原函數名，alias 相容）。
 * 2026-04-21 rename：買法字母 D→E。
 * 2026-05-04：紅K實體 2.5% → 2%，對齊《活用技術分析寶典》2024 短線做多 SOP（衝突取寶典）。
 */
export const ZHU_GAP: StrategyConfig = {
  id:          'zhu-gap',
  name:        '缺口進場（E）',
  description: '《5步驟》位置 4 跳空上漲：開盤>前日最高+量比≥1.3+紅K實體≥2%',
  version:     '1.1.0',
  author:      '朱家泓',
  createdAt:   '2026-04-20T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'E',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤：紅K實體 > 2%
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * C 盤整突破策略（2026-04-21 從 B 拆出）
 *
 * 《5步驟》位置 1：前置盤整（detectTrend==='盤整'）+ 大量長紅突破上頸線
 * 底層偵測用 lib/analysis/breakoutEntry.ts 的 detectConsolidationBreakout()。
 * 不套戒律（strategyType='kline-pattern'）。
 * 2026-05-04：紅K實體 2.5% → 2%，對齊寶典 2024 短線做多 SOP。
 */
export const ZHU_CONSOLIDATION_BREAKOUT: StrategyConfig = {
  id:          'zhu-consolidation-breakout',
  name:        '盤整突破（C）',
  description: '《5步驟》位置1：盤整期（detectTrend=盤整）+大量長紅突破上頸線，停損盤整低點',
  version:     '1.1.0',
  author:      '朱家泓',
  createdAt:   '2026-04-21T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'C',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤：紅K實體 > 2%
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * B 回後買上漲策略（2026-04-21 重命名，原 B 的 pullback 部分獨立）
 *
 * 《5步驟》位置 2：多頭趨勢 + 昨日<MA5 + 今日站回MA5 + 大量長紅突破前K高
 * 底層偵測用 lib/analysis/breakoutEntry.ts 的 detectBreakoutEntry()。
 * 不套戒律（strategyType='kline-pattern'）。
 * 2026-05-04：紅K實體 2.5% → 2%，對齊寶典 2024 短線做多 SOP。
 */
export const ZHU_BREAKOUT: StrategyConfig = {
  id:          'zhu-breakout',
  name:        '回後買上漲（B）',
  description: '《5步驟》位置2：多頭回檔+昨日<MA5+今日站回MA5+大量長紅突破前K高，停損回檔低點',
  version:     '1.1.0',
  author:      '朱家泓',
  createdAt:   '2026-04-20T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'B',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤：紅K實體 > 2%
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * F V 形反轉策略（Phase 4，2026-04-20）
 *
 * 《5步驟》位置 6 反轉向上 + 寶典 Part 12 祕笈圖 #1「低檔大量長紅 K 反轉」：
 *   前段連跌 ≥5 根黑 K + 當日量 ≥ 前 5 日均量 × 2 + 紅 K 實體 ≥ 2% + 收盤突破前日最高
 *
 * 2026-04-21 rename：買法字母 C→F。
 */
export const ZHU_V_REVERSAL: StrategyConfig = {
  id:          'zhu-v-reversal',
  name:        'V 形反轉（F）',
  description: '寶典祕笈圖#1：連跌後低檔大量長紅突破前日最高，一日反轉',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-04-20T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'F',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 2.0,   // 反轉量更嚴，≥ 5 日均量 × 2
    kbarMinBodyPct: 0.02,
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * G ABC 突破策略（並列買法架構，2026-05-04）
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 6：等 ABC 突破」（p.697）
 * + 寶典 Part 12-4 18 祕笈圖第 16 圖「突破 ABC 上漲圖」（p.815）
 *
 * 多頭上漲一波後，ABC 3 波修正形成短空，反彈大量紅 K 突破下降切線 + 站上 MA20 → 做多。
 *
 * 用戶 Step 2 第 3 條「ABC 突破」直接源頭。
 * 底層偵測用 lib/analysis/abcBreakoutEntry.ts 的 detectABCBreakout()。
 * 不套戒律（strategyType='kline-pattern'）。
 */
export const ZHU_ABC_BREAKOUT: StrategyConfig = {
  id:          'zhu-abc-breakout',
  name:        'ABC 突破（G）',
  description: '寶典 Part 11-1 位置 6：多頭一波後 ABC 修正→反彈大量紅 K 突破下降切線+站上 MA20',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-05-04T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'G',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * H 突破大量黑 K 策略（並列買法架構，2026-05-04）
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 8：等突破大量黑 K」（p.699）
 * + 寶典 Part 12-4 18 祕笈圖第 9 圖「突破大量黑 K 買進」（p.806）
 *
 * 多頭一波後出大量黑 K（跌破前低或 MA5），3 日內紅 K 突破大量黑 K 最高 → 做多。
 *
 * 用戶 Step 2 第 5 條「過大量黑 K 高」直接源頭。
 * 底層偵測用 lib/analysis/blackKBreakoutEntry.ts 的 detectBlackKBreakout()。
 * 不套戒律（strategyType='kline-pattern'）。
 */
export const ZHU_BLACK_K_BREAKOUT: StrategyConfig = {
  id:          'zhu-black-k-breakout',
  name:        '突破大量黑 K（H）',
  description: '寶典 Part 11-1 位置 8：多頭中大量黑 K 跌破前低/MA5，3 日內紅 K 突破黑 K 最高',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-05-04T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'H',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤
    minScore:       0,
    marketTrendFilter: false,
  },
};

/**
 * I K 線橫盤突破策略（並列買法架構，2026-05-04）
 *
 * 朱家泓《活用技術分析寶典》Part 11-1 8 種進場位置「位置 3：等 K 線橫盤突破」（p.694）
 * + 寶典 Part 12-4 18 祕笈圖第 5 圖「K 線橫盤突破」（p.802）
 *
 * 多頭中長紅 K（≥3%）上漲後，股價在錨點之上狹幅橫盤 5-15 天，
 * 大量紅 K 突破橫盤最高 → 做多。
 *
 * 用戶 Step 2 第 4 條「K 線橫盤突破」直接源頭。
 * 底層偵測用 lib/analysis/klineConsolidationBreakout.ts 的 detectKlineConsolidationBreakout()。
 * 不套戒律（strategyType='kline-pattern'）。
 */
export const ZHU_KLINE_HSP_BREAKOUT: StrategyConfig = {
  id:          'zhu-kline-hsp-breakout',
  name:        'K 線橫盤突破（I）',
  description: '寶典 Part 11-1 位置 3：中長紅 K 上方狹幅橫盤 5-15 天，紅 K 突破橫盤最高點',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-05-04T00:00:00.000Z',
  isBuiltIn:   true,
  strategyType: 'kline-pattern',
  buyMethod:    'I',
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kbarMinBodyPct: 0.02,   // 寶典 2024 短線做多 SOP p.55 ⑤
    minScore:       0,
    marketTrendFilter: false,
  },
};

export const BUILT_IN_STRATEGIES: StrategyConfig[] = [
  ZHU_PURE_BOOK,              // 純書本版（A = long-daily 六條件的 thresholds）
  ZHU_FLAT_BOTTOM,            // D：一字底突破（2026-04-21 rename from E）
  ZHU_GAP,                    // E：缺口進場（2026-04-21 rename from D）
  ZHU_CONSOLIDATION_BREAKOUT, // C：盤整突破（2026-04-21 從 B 拆出）
  ZHU_BREAKOUT,               // B：回後買上漲（2026-04-21 rename）
  ZHU_V_REVERSAL,             // F：V 形反轉（2026-04-21 rename from C）
  ZHU_ABC_BREAKOUT,           // G：ABC 突破（2026-05-04 新增，寶典 Part 11-1 位置 6）
  ZHU_BLACK_K_BREAKOUT,       // H：突破大量黑 K（2026-05-04 新增，寶典 Part 11-1 位置 8）
  ZHU_KLINE_HSP_BREAKOUT,     // I：K 線橫盤突破（2026-05-04 新增，寶典 Part 11-1 位置 3）
];

// ── P0-3: 策略參數邊界驗證 ──────────────────────────────────────────────────────

/** 策略閾值合理範圍定義（reentry 為物件，不在數值邊界範疇內，故用 Partial） */
export const THRESHOLD_BOUNDS: Partial<Record<keyof StrategyThresholds, { min: number; max: number; label: string }>> = {
  maShortPeriod:     { min: 2,    max: 30,   label: '短期均線' },
  maMidPeriod:       { min: 5,    max: 60,   label: '中期均線' },
  maLongPeriod:      { min: 10,   max: 120,  label: '長期均線' },
  kbarMinBodyPct:    { min: 0,    max: 0.10, label: 'K棒實體最小比例' },
  upperShadowMax:    { min: 0.05, max: 1.0,  label: '上影線最大比例' },
  volumeRatioMin:    { min: 0.5,  max: 5.0,  label: '量比門檻' },
  kdMaxEntry:        { min: 20,   max: 100,  label: 'KD 進場上限' },
  deviationMax:      { min: 0.02, max: 1.0,  label: 'MA20 乖離上限' },
  minScore:          { min: 0,    max: 6,    label: '最低條件分數' },
  marketTrendFilter: { min: 0,    max: 1,    label: '大盤過濾開關' },
  bullMinScore:      { min: 0,    max: 6,    label: '多頭最低分數' },
  sidewaysMinScore:  { min: 0,    max: 6,    label: '盤整最低分數' },
  bearMinScore:      { min: 0,    max: 6,    label: '空頭最低分數' },
  // 長線保護短線
  multiTimeframeFilter: { min: 0, max: 1,    label: '長線保護開關' },
  mtfWeeklyStrict:      { min: 0, max: 1,    label: '週線嚴格模式' },
  mtfMonthlyStrict:     { min: 0, max: 1,    label: '月線嚴格模式' },
  mtfMinScore:          { min: 0, max: 4,    label: 'MTF 最低分數' },
  // 短線輔助過濾
  kdDecliningFilter:    { min: 0, max: 1,    label: 'KD向下不買開關' },
};

export interface ThresholdValidationError {
  field: keyof StrategyThresholds;
  label: string;
  value: number;
  min: number;
  max: number;
}

/**
 * 驗證策略閾值是否在合理範圍內。
 * 回傳空陣列表示全部通過。
 */
export function validateThresholds(
  thresholds: StrategyThresholds,
): ThresholdValidationError[] {
  const errors: ThresholdValidationError[] = [];
  for (const [key, bounds] of Object.entries(THRESHOLD_BOUNDS)) {
    if (!bounds) continue;
    const field = key as keyof StrategyThresholds;
    const value = Number(thresholds[field]);
    if (isNaN(value) || value < bounds.min || value > bounds.max) {
      errors.push({ field, label: bounds.label, value, min: bounds.min, max: bounds.max });
    }
  }
  return errors;
}

/**
 * 將閾值鉗制（clamp）到合理範圍。
 * 用於自動修正不合理的值。
 */
export function clampThresholds(
  thresholds: StrategyThresholds,
): StrategyThresholds {
  const result = { ...thresholds };
  for (const [key, bounds] of Object.entries(THRESHOLD_BOUNDS)) {
    if (!bounds) continue;
    const field = key as keyof StrategyThresholds;
    const current = result[field];
    if (typeof current === 'boolean' || typeof current === 'object') continue;
    const value = Number(current);
    (result as unknown as Record<string, number>)[field] = Math.max(bounds.min, Math.min(bounds.max, isNaN(value) ? bounds.min : value));
  }
  return result;
}
