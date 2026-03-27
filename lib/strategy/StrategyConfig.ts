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

const BASE_THRESHOLDS: StrategyThresholds = {
  maShortPeriod:  5,
  maMidPeriod:    10,
  maLongPeriod:   20,
  kbarMinBodyPct: 0.02,
  upperShadowMax: 0.20,
  volumeRatioMin: 1.5,
  kdMaxEntry:     88,
  deviationMax:   0.20,
  minScore:       4,
  marketTrendFilter: true,
  bullMinScore:   4,
  sidewaysMinScore: 4,  // 盤整市也用4分門檻（飆股常在盤整市冒出）
  bearMinScore:   5,    // 空頭從6降到5（避免完全無結果）
};

const ALL_CONDITIONS_ON: StrategyConditionToggles = {
  trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true,
};

/** 朱老師標準版（六大條件完整版） */
export const ZHU_V1: StrategyConfig = {
  id:          'zhu-v1',
  name:        '朱老師六大條件 v1',
  description: '朱家泓老師《學會走圖SOP》標準版，六大條件全開，KD≤88，量比≥1.5x',
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

export const BUILT_IN_STRATEGIES: StrategyConfig[] = [ZHU_V1, ZHU_V2, ZHU_CONSERVATIVE];
