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
}

import type { RuleGroupId } from '@/lib/rules/ruleRegistry';

export interface StrategyConfig {
  id:          string;     // 唯一識別碼，e.g. 'zhu-v1'
  name:        string;     // 顯示名稱
  description: string;     // 說明
  version:     string;     // 版本號，e.g. '1.0.0'
  author:      string;     // 作者
  createdAt:   string;     // ISO 日期字串
  isBuiltIn:   boolean;    // 是否為內建策略（不可刪除）

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
const ALL_ZHU_GROUPS: RuleGroupId[] = [
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
  deviationMax:   0.20,
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

const ALL_CONDITIONS_ON: StrategyConditionToggles = {
  trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
};

/** 朱老師標準版（六大條件完整版） */
export const ZHU_V1: StrategyConfig = {
  id:          'zhu-v1',
  name:        '朱老師六大條件 v1',
  description: '朱家泓老師《學會走圖SOP》標準版，六大條件全開，KD≤88，量比≥1.8x，紅K突破前高',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2024-01-01T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  BASE_THRESHOLDS,
  ruleGroups:  [...CORE_ZHU_GROUPS, ...BASE_GROUPS],
};

/** 朱老師寬鬆版（適合盤整市） */
export const ZHU_V2: StrategyConfig = {
  id:          'zhu-v2',
  name:        '朱老師六大條件 v2（寬鬆）',
  description: '放寬量比門檻至1.3x，KD上限至92，適合量縮盤整市',
  version:     '2.0.0',
  author:      '朱家泓',
  createdAt:   '2024-06-01T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,
    kdMaxEntry:     92,
    minScore:       4,
  },
  ruleGroups:  [...CORE_ZHU_GROUPS, ...BASE_GROUPS],
};

/** 保守版（高分數才進場） */
export const ZHU_CONSERVATIVE: StrategyConfig = {
  id:          'zhu-conservative',
  name:        '朱老師精選版（保守）',
  description: '六大條件須全過（6/6分），配合嚴格量比2.0x，大幅降低假突破機率',
  version:     '1.0.0',
  author:      '系統內建',
  createdAt:   '2024-01-01T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 2.0,
    minScore:       6,
    upperShadowMax: 0.15,
  },
  ruleGroups:  [...CORE_ZHU_GROUPS, ...BASE_GROUPS],
};

/**
 * 多因子策略 v3 — 結合技術面、籌碼面代理、基本面代理
 *
 * 核心改進：
 * 1. 降低六大條件最低門檻至 3（靠 smart money + surge 來補足品質篩選）
 * 2. 放寬量比至 1.3x（配合 smart money OBV 分析，不再只依賴單日量能）
 * 3. KD 上限放寬至 90（高動能股票 KD 本來就高，由 surge grade 把關）
 * 4. 乖離上限放寬至 25%（由 composite score 綜合把關）
 *
 * 設計理念：「門檻放寬，排名收緊」
 * - 進場門檻適度放寬，讓更多候選股進入排名池
 * - 最終靠 compositeScore（含 smart money 30%）排名選出最優
 * - 搭配 adaptive exit rules：強信號長持、弱信號快出
 */
export const ZHU_V3_MULTIFACTOR: StrategyConfig = {
  id:          'zhu-v3-multifactor',
  name:        '多因子策略 v3（技術+籌碼+基本面）',
  description: '結合朱老師六大條件 + Smart Money 偵測 + 飆股潛力 + 歷史勝率的多因子排名策略',
  version:     '3.0.0',
  author:      '系統優化',
  createdAt:   '2026-03-29T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,    // 放寬：由 smart money OBV 補足
    kdMaxEntry:     90,     // 放寬：高動能股 KD 本來就高
    deviationMax:   0.25,   // 放寬：由 composite score 把關
    minScore:       3,      // 放寬：多因子排名會篩掉弱股
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,      // 多頭：核心5條件全過
    sidewaysMinScore: 5,    // 盤整：核心5條件全過
    bearMinScore:   6,      // 空頭嚴格
  },
  // 多因子策略：全開所有群組（不限制，靠排名篩選）
};

/**
 * 台股專用多因子策略
 * 針對台股特性優化：
 * - 台股量能單位為「張」，門檻不同
 * - 台股有 10% 漲跌停限制
 * - 法人買賣超資訊更透明（smart money 偵測更有效）
 */
export const ZHU_V3_TW: StrategyConfig = {
  id:          'zhu-v3-tw',
  name:        '台股多因子策略',
  description: '針對台股最佳化的多因子策略，強化法人籌碼面偵測',
  version:     '3.1.0',
  author:      '系統優化',
  createdAt:   '2026-03-29T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.4,    // 台股量比門檻稍高（法人大量進場更明顯）
    kdMaxEntry:     88,     // 台股 KD 超買較敏感
    deviationMax:   0.22,   // 台股乖離容忍度
    minScore:       3,
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,
    sidewaysMinScore: 5,
    bearMinScore:   6,
  },
  // 台股：全開所有群組
};

/**
 * 陸股專用多因子策略
 * 針對 A 股特性優化：
 * - A 股散戶多，均值回歸效應強
 * - 波動率較大，需更寬鬆的技術指標
 * - 北向資金（smart money proxy）影響力大
 */
export const ZHU_V3_CN: StrategyConfig = {
  id:          'zhu-v3-cn',
  name:        '陸股多因子策略',
  description: '針對 A 股最佳化的多因子策略，適應高波動散戶市場',
  version:     '3.2.0',
  author:      '系統優化',
  createdAt:   '2026-03-29T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.2,    // A 股量能波動大，門檻放低
    kdMaxEntry:     92,     // A 股波動大，KD 容忍度更高
    deviationMax:   0.28,   // A 股乖離容忍度更高
    minScore:       3,
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,
    sidewaysMinScore: 5,
    bearMinScore:   6,      // A 股空頭更危險，門檻更嚴
  },
  // 陸股：全開所有群組
};

/**
 * 大師共識突破選股法
 *
 * 綜合朱家泓、權證小哥、蔡森三位大師核心共識：
 * - 均線多頭排列（close > MA5 > MA20 > MA60）
 * - 20日新高突破
 * - 帶量突破 1.5 倍
 * - KD黃金交叉
 *
 * 出場：停利 15% / 停損 -7% / 跌破 MA20 / 時間停損 20 天
 */
export const MASTER_CONSENSUS: StrategyConfig = {
  id:          'master-consensus',
  name:        '大師共識突破（朱×小哥×蔡森）',
  description: '三大師共識因子：四線多頭(含MA60) + 20日新高 + 量增1.5x + KD黃金交叉，最高勝率組合',
  version:     '1.0.0',
  author:      '朱家泓 × 權證小哥 × 蔡森',
  createdAt:   '2026-03-30T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    maShortPeriod:  5,
    maMidPeriod:    20,     // 跳過 MA10，直接用 MA20（大師共識用 5/20/60）
    maLongPeriod:   20,
    volumeRatioMin: 1.5,    // 三位大師共識：帶量突破 1.5 倍
    kdMaxEntry:     100,    // 不限制 KD 上限（突破常在中高檔發生）
    deviationMax:   0.25,   // 放寬乖離（突破時可能偏離較大）
    minScore:       4,      // 基本門檻
    marketTrendFilter: true,
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,
    sidewaysMinScore: 5,
    bearMinScore:   6,
  },
  ruleGroups:  ['consensus', 'granville', ...BASE_GROUPS],
};

/**
 * 朱家泓《做對5個實戰步驟》完整策略
 *
 * 書中核心：選股→進場→停損→操作→停利 五步驟循環
 * 特色：
 * - 選股SOP 7項條件全檢查
 * - 做多6位置 + 做空6位置精確進場
 * - 4種停損方法 + 10%停損上限
 * - 長線趨勢操作 + 短線轉折操作 + 均線操作 + 綜合操作
 * - 3大類停利（紀律/目標/特定條件）
 * - 乖離>15%動態切換停利均線
 */
export const ZHU_5STEPS: StrategyConfig = {
  id:          'zhu-5steps',
  name:        '朱家泓五步驟實戰法',
  description: '《做對5個實戰步驟》完整交易系統：選股SOP+6進場位+4停損法+10種操作法+3類停利',
  version:     '1.0.0',
  author:      '朱家泓',
  createdAt:   '2026-03-31T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    volumeRatioMin: 1.3,    // 朱家泓 p.54：攻擊量 ≥ 前一日 × 1.3（2 倍更強）
    kdMaxEntry:     88,     // 書中：KD不宜過高進場
    deviationMax:   0.15,   // 書中：乖離15%要注意停利
    minScore:       4,      // 基本門檻
    marketTrendFilter: true,
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,      // 順勢操作：核心5條件全過
    sidewaysMinScore: 5,    // 盤整加嚴
    bearMinScore:   6,      // 逆勢操作勝率僅10%，極嚴格
  },
  ruleGroups:  [...ALL_ZHU_GROUPS, ...BASE_GROUPS],
};

/**
 * 林穎走圖SOP策略
 *
 * 《學會走圖SOP 讓技術分析養我一輩子》核心交易系統
 * 特色：
 * - 多單3種進場：多頭確認 / 回後買上漲 / 盤整突破
 * - 空單3種進場：空頭確認 / 彈後空下跌 / 盤整跌破
 * - 6大條件 checklist（趨勢、位置、K棒、均線、成交量、指標）
 * - KD(5,3,3) + MACD(10,20,10) 雙指標只要1個符合
 * - 空頭操作不需特別考慮成交量（與多單不同）
 * - 停利3條件：未達10% / 達10% / 超過20%
 * - 停損5方法：進場K棒高低點 / 轉折點 / 固定比例 / 絕對停損 / 趨勢不對立刻出場
 * - 高檔/低檔變盤線偵測（T字、倒T、天劍、蜻蜓、紡錘、十字）
 * - 漲幅1倍＝高檔警示 / 跌幅50%＝低檔警示
 */
export const CHART_WALKING_SOP: StrategyConfig = {
  id:          'chart-walking-sop',
  name:        '走圖SOP（林穎）',
  description: '林穎《學會走圖SOP》完整進出場邏輯：多空各3種進場模式＋6大條件＋雙指標＋變盤線偵測',
  version:     '1.0.0',
  author:      '林穎（朱家泓門下）',
  createdAt:   '2026-03-31T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    kbarMinBodyPct: 0.02,     // 書中：實體 > 2% 才有攻擊力道
    volumeRatioMin: 1.3,      // 書中：量 > 前日1.3~1.5倍
    kdMaxEntry:     100,      // 不用KD值上限篩選（改用方向/排列判斷）
    deviationMax:   1.0,      // 書中：漲幅1倍＝高檔，由規則內部判斷
    minScore:       4,        // 至少4/6條件通過
    marketTrendFilter: true,
    // 注意：isCoreReady 門檻使實際最低為 5（見 BASE_THRESHOLDS 說明）
    bullMinScore:   5,
    sidewaysMinScore: 5,
    bearMinScore:   5,        // 空頭操作門檻（書中空頭不需量能，條件較寬）
  },
  ruleGroups:  ['lin-sop', ...BASE_GROUPS],
};

/**
 * 回測驗證最佳策略（2024-2026 台股 200 股回測結果）
 *
 * 回測結論：
 * - 大盤多頭 + 六條件≥5 + 停損 3% + MA5 出場 → PF 1.11, Sharpe 0.20（唯一正 Sharpe 停損策略）
 * - 大盤多頭 + 六條件=6 → 排名第一（10D報酬 +1.27%, 20D報酬 +3.48%）
 * - 共振信號≥2 作為圖表預設過濾，大幅降噪
 *
 * 設計：進場嚴格（五條件以上），停損果斷（3% 硬停損 + 黑K跌破MA5）
 */
export const ZHU_OPTIMIZED: StrategyConfig = {
  id:          'zhu-optimized',
  name:        '回測驗證版（台股最佳）',
  description: '大盤多頭+六條件≥5+停損3%+MA5出場，2024-2026台股200股回測驗證的最高Sharpe策略',
  version:     '1.0.0',
  author:      '回測優化',
  createdAt:   '2026-03-31T00:00:00.000Z',
  isBuiltIn:   true,
  conditions:  ALL_CONDITIONS_ON,
  thresholds:  {
    ...BASE_THRESHOLDS,
    // 書本朱家泓 p.54 是 1.3，但 2025-04~2026-04 一年期 TW 回測顯示
    // 1.5 門檻 +236% vs 1.3 門檻 -43%，勝率相近但 1.5 過濾掉大量低品質信號。
    // OPTIMIZED 策略選回測最佳的 1.5；書本忠實版請見 ZHU_5STEPS（1.3）
    volumeRatioMin: 1.5,
    kdMaxEntry:     88,
    deviationMax:   0.15,     // 嚴格：乖離 >15% 不追高
    minScore:       5,        // 核心：六條件至少過 5 關
    marketTrendFilter: true,  // 核心：大盤多頭才買
    bullMinScore:   5,        // 即使大盤多頭也要 5 分
    sidewaysMinScore: 6,      // 盤整要 6/6 全過
    bearMinScore:   6,        // 空頭不進場（設 6 等於幾乎不會觸發）
  },
  ruleGroups:  [...ALL_ZHU_GROUPS, 'lin-sop', 'bollinger', ...BASE_GROUPS],
};

export const BUILT_IN_STRATEGIES: StrategyConfig[] = [
  ZHU_OPTIMIZED,   // 回測驗證最佳，放第一個
  ZHU_V1, ZHU_V2, ZHU_CONSERVATIVE,
  ZHU_V3_MULTIFACTOR, ZHU_V3_TW, ZHU_V3_CN,
  MASTER_CONSENSUS, ZHU_5STEPS, CHART_WALKING_SOP,
];

// ── P0-3: 策略參數邊界驗證 ──────────────────────────────────────────────────────

/** 策略閾值合理範圍定義 */
export const THRESHOLD_BOUNDS: Record<keyof StrategyThresholds, { min: number; max: number; label: string }> = {
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
    const field = key as keyof StrategyThresholds;
    const value = Number(result[field]);
    if (typeof result[field] === 'boolean') continue;
    (result as Record<string, number | boolean>)[field] = Math.max(bounds.min, Math.min(bounds.max, isNaN(value) ? bounds.min : value));
  }
  return result;
}
