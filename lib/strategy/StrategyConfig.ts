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
  volumeRatioMin:  number;   // 量比門檻（預設 1.5x）

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
}

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
}

// ── 內建策略 ──────────────────────────────────────────────────────────────────

export const BASE_THRESHOLDS: StrategyThresholds = {
  maShortPeriod:  5,
  maMidPeriod:    10,
  maLongPeriod:   20,
  kbarMinBodyPct: 0.02,
  upperShadowMax: 0.20,
  volumeRatioMin: 1.8,  // 朱老師核心：帶量突破，1.5x太鬆
  kdMaxEntry:     88,
  deviationMax:   0.20,
  minScore:       4,    // 基本門檻 4 分
  marketTrendFilter: true,
  bullMinScore:   4,    // 多頭正常篩選
  sidewaysMinScore: 4,  // 盤整也用 4（靠其他條件過濾品質）
  bearMinScore:   5,    // 空頭嚴格
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
    bullMinScore:   3,      // 多頭時更寬鬆（靠排名篩選）
    sidewaysMinScore: 4,    // 盤整時維持
    bearMinScore:   5,      // 空頭時嚴格
  },
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
    bullMinScore:   3,
    sidewaysMinScore: 4,
    bearMinScore:   5,
  },
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
    bullMinScore:   3,
    sidewaysMinScore: 4,
    bearMinScore:   6,      // A 股空頭更危險，門檻更嚴
  },
};

export const BUILT_IN_STRATEGIES: StrategyConfig[] = [
  ZHU_V1, ZHU_V2, ZHU_CONSERVATIVE,
  ZHU_V3_MULTIFACTOR, ZHU_V3_TW, ZHU_V3_CN,
];
