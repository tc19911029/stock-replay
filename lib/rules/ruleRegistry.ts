/**
 * Rule Registry — 規則分組註冊系統
 *
 * 把 100+ 條交易規則按「體系/作者」分成群組，
 * 讓策略可以選擇只啟用特定群組，避免不同體系互相干擾。
 *
 * 設計原則：
 * - 所有 *Rules.ts 檔案完全不動
 * - RuleRegistry 只是一個分組索引
 * - getRules() 不帶參數 = 全部規則（向後相容）
 * - getRules(activeGroups) = 只返回指定群組的規則
 */

import { TradingRule } from '@/types';

// ── 群組 ID 定義 ──────────────────────────────────────────────────────────────

export type RuleGroupId =
  | 'zhu-5steps'       // 朱家泓五步驟系統
  | 'zhu-kline'        // 朱家泓 K 線戰法（智慧K線 + K線組合 + K線交易法）
  | 'zhu-reversal'     // 朱家泓反轉型態（底部/頭部 + 2根/3根K線轉折）
  | 'zhu-ma-strategy'  // 朱家泓均線戰法（單線/雙線/三線 + 週線）
  | 'zhu-momentum'     // 朱家泓飆股/缺口
  | 'zhu-advanced'     // 朱家泓進階（轉折波 + 底部型態 + 進場錯誤）
  | 'zhu-soar-stock'   // 朱家泓《抓住飆股輕鬆賺》— 9種價量診斷、4階段循環、位置評估
  | 'lin-sop'          // 林穎走圖 SOP
  | 'granville'        // 葛蘭碧八大法則
  | 'bollinger'        // 布林通道
  | 'cond-2'           // 回測虛擬：六大條件≥2
  | 'cond-3'           // 回測虛擬：六大條件≥3
  | 'cond-4'           // 回測虛擬：六大條件≥4
  | 'cond-5'           // 回測虛擬：六大條件≥5
  | 'cond-6'           // 回測虛擬：六大條件=6
  | 'mkt-bull'         // 回測虛擬：大盤多頭才買
  | 'mkt-cond4'        // 回測虛擬：大盤多頭+六條件≥4
  | 'mkt-cond5'        // 回測虛擬：大盤多頭+六條件≥5
  | 'mkt-cond6'        // 回測虛擬：大盤多頭+六條件=6
  | 'sl-3pct'          // 回測虛擬：停損3%+MA5出場
  | 'sl-5pct'          // 回測虛擬：停損5%+MA5出場
  | 'sl-7pct'          // 回測虛擬：停損7%+MA5出場
  | 'mkt-sl3-c4'       // 回測虛擬：大盤多頭+停損3%+六條件≥4
  | 'mkt-sl5-c4'       // 回測虛擬：大盤多頭+停損5%+六條件≥4
  | 'mkt-sl3-c5'       // 回測虛擬：大盤多頭+停損3%+六條件≥5
  | 'mkt-sl5-c5'       // 回測虛擬：大盤多頭+停損5%+六條件≥5
  | 'zhu-long-term';   // 朱家泓長線操作SOP 8條

// ── 群組介面 ──────────────────────────────────────────────────────────────────

export interface RuleGroup {
  id: RuleGroupId;
  name: string;
  author: string;
  description: string;
  rules: TradingRule[];
}

// ── Registry 類別 ─────────────────────────────────────────────────────────────

export class RuleRegistry {
  private groups: Map<RuleGroupId, RuleGroup> = new Map();

  register(group: RuleGroup): void {
    this.groups.set(group.id, group);
  }

  /** 取得所有群組 */
  getGroups(): RuleGroup[] {
    return Array.from(this.groups.values());
  }

  /** 取得單一群組 */
  getGroup(id: RuleGroupId): RuleGroup | undefined {
    return this.groups.get(id);
  }

  /** 取得所有群組 ID */
  getGroupIds(): RuleGroupId[] {
    return Array.from(this.groups.keys());
  }

  /**
   * 取得規則列表
   * @param activeGroups - 指定要啟用的群組。undefined = 全部啟用（向後相容）
   */
  getRules(activeGroups?: RuleGroupId[]): TradingRule[] {
    const groups = activeGroups
      ? activeGroups.map(id => this.groups.get(id)).filter(Boolean) as RuleGroup[]
      : Array.from(this.groups.values());

    const rules: TradingRule[] = [];
    for (const group of groups) {
      rules.push(...group.rules);
    }
    return rules;
  }

  /**
   * 建立 ruleId → groupId 的反查表
   * 用於 evaluateDetailed() 標注每個信號來自哪個群組
   */
  buildRuleToGroupMap(): Map<string, { groupId: RuleGroupId; groupName: string }> {
    const map = new Map<string, { groupId: RuleGroupId; groupName: string }>();
    for (const group of this.groups.values()) {
      for (const rule of group.rules) {
        map.set(rule.id, { groupId: group.id, groupName: group.name });
      }
    }
    return map;
  }
}

// ── 建立預設 Registry（從現有規則檔案匯入）──────────────────────────────────
// 僅保留 6 本書的規則：朱家泓 5 本 + 林穎 1 本（2026-04-21 用戶決定）

// 朱家泓五步驟
import { ZHU_RULES } from './zhuRules';
// 朱家泓 K 線戰法（《抓住K線》+ 《抓住線圖》）
import {
  smartKLineBuy, smartKLineSell, candleMergeSignal,
  lowLongRedAttack, lowHammerAttack, lowCrossAttack, lowEngulfAttack, lowThreeRedAttack,
  highShootingStar, highCrossSell, highEngulfSell, highEveningStar,
} from './smartKLineRules';
import { KLINE_COMBO_RULES } from './klineComboRules';
import { KLINE_TRADING_RULES } from './klineTradingRules';
// 朱家泓反轉型態（合併進 zhu-kline，避免 K 線型態重複計算共振）
import {
  flatBottomBreakout, higherBottomBreakout, falseBreakdownBreakout,
  flatTopBreakdown, lowerTopBreakdown, falseBreakoutBreakdown, consolidationBreakoutDirection,
} from './zhuReversalRules';
import { TWO_BAR_REVERSAL_RULES } from './twoBarReversalRules';
import { THREE_BAR_REVERSAL_RULES } from './threeBarReversalRules';
// 朱家泓均線戰法
import { singleMa20Buy, singleMa20Sell, tripleMaBuy, tripleMaSell, dualMaBuy, dualMaSell } from './maStrategyRules';
import { weeklyMa20Buy, weeklyMa20Sell, weeklyMa20Add } from './weeklyMaRules';
// 朱家泓飆股/缺口（《抓住飆股》）
import { surgeStockBreakout, surgeStockExit, momentumContinuationBuy, fibRetracementGrade } from './momentumRules';
import { GAP_TRADING_RULES } from './gapTradingRules';
// 朱家泓進階（寶典）
import { TURNING_WAVE_RULES } from './turningWaveRules';
import { BOTTOM_FORMATION_RULES } from './bottomFormationRules';
import { ENTRY_MISTAKE_RULES } from './entryMistakeRules';
// 朱家泓《抓住飆股輕鬆賺》（合併進 zhu-momentum，飆股動能觀點統一）
import { ZHU_SOAR_STOCK_RULES } from './zhuSoarStockRules';
// 朱家泓長線操作 SOP 8 條
import { LONG_TERM_SOP_RULES } from './longTermSopRules';
// 林穎走圖 SOP
import {
  sopBullConfirmEntry, sopBullPullbackBuy, sopConsolidationBreakout,
  sopBearConfirmEntry, sopBearBounceSell, sopConsolidationBreakdown,
} from './chartWalkingSopRules';
import { sopHighReversalWarning, sopLowReversalSignal } from './reversalPatternRules';
// 葛蘭碧八大法則（朱家泓《抓住飆股》）+ 布林通道（朱家泓寶典 Part 8）
import { GRANVILLE_RULES } from './granvilleRules';
import { BOLLINGER_RULES } from './bollingerRules';

// ── 註冊所有群組 ──────────────────────────────────────────────────────────────

function createDefaultRegistry(): RuleRegistry {
  const registry = new RuleRegistry();

  registry.register({
    id: 'zhu-5steps',
    name: '朱家泓五步驟',
    author: '朱家泓',
    description: '《做對5個實戰步驟》完整交易系統：選股→進場→停損→操作→停利',
    rules: [...ZHU_RULES],
  });

  registry.register({
    id: 'zhu-kline',
    name: '朱家泓 K 線與反轉型態',
    author: '朱家泓',
    description: '《抓住K線》智慧K線 + K線組合(15種) + K線交易法 + 底/頭反轉型態 + 2根/3根K線轉折',
    rules: [
      smartKLineBuy, smartKLineSell, candleMergeSignal,
      lowLongRedAttack, lowHammerAttack, lowCrossAttack, lowEngulfAttack, lowThreeRedAttack,
      highShootingStar, highCrossSell, highEngulfSell, highEveningStar,
      ...KLINE_COMBO_RULES,
      ...KLINE_TRADING_RULES,
      flatBottomBreakout, higherBottomBreakout, falseBreakdownBreakout,
      flatTopBreakdown, lowerTopBreakdown, falseBreakoutBreakdown, consolidationBreakoutDirection,
      ...TWO_BAR_REVERSAL_RULES,
      ...THREE_BAR_REVERSAL_RULES,
    ],
  });

  registry.register({
    id: 'zhu-ma-strategy',
    name: '朱家泓均線戰法',
    author: '朱家泓',
    description: '一條均線(MA20) + 三條均線(MA3/10/24) + 二條均線(MA10/24) + 20週均線',
    rules: [
      singleMa20Buy, singleMa20Sell,
      tripleMaBuy, tripleMaSell,
      dualMaBuy, dualMaSell,
      weeklyMa20Buy, weeklyMa20Sell, weeklyMa20Add,
    ],
  });

  registry.register({
    id: 'zhu-momentum',
    name: '朱家泓飆股/缺口/動能',
    author: '朱家泓',
    description: '《抓住飆股》飆股戰法 + 缺口5條 + 《抓住飆股輕鬆賺》9種價量診斷 + 飆股8條件',
    rules: [
      surgeStockBreakout, surgeStockExit, momentumContinuationBuy, fibRetracementGrade,
      ...GAP_TRADING_RULES,
      ...ZHU_SOAR_STOCK_RULES,
    ],
  });

  registry.register({
    id: 'zhu-advanced',
    name: '朱家泓進階（寶典）',
    author: '朱家泓',
    description: '《活用技術分析寶典》轉折波系統(8條) + 底部型態(4條) + 進場錯誤(7條)',
    rules: [
      ...TURNING_WAVE_RULES,
      ...BOTTOM_FORMATION_RULES,
      ...ENTRY_MISTAKE_RULES,
    ],
  });

  registry.register({
    id: 'zhu-long-term',
    name: '朱家泓長線操作SOP',
    author: '朱家泓',
    description: '長線8條：選股3條(月/週/日線) + 操作5條(進場/停損/頭頭低/停利/第2波)',
    rules: [...LONG_TERM_SOP_RULES],
  });

  registry.register({
    id: 'lin-sop',
    name: '林穎走圖 SOP',
    author: '林穎',
    description: '《學會走圖SOP》多空各3種進場 + 高低檔變盤偵測',
    rules: [
      sopBullConfirmEntry, sopBullPullbackBuy, sopConsolidationBreakout,
      sopBearConfirmEntry, sopBearBounceSell, sopConsolidationBreakdown,
      sopHighReversalWarning, sopLowReversalSignal,
    ],
  });

  registry.register({
    id: 'granville',
    name: '葛蘭碧八大法則',
    author: '朱家泓《抓住飆股》',
    description: '8 條 MA20 進出場法則：4 買 + 4 賣（突破/拉回/急漲/急跌）',
    rules: [...GRANVILLE_RULES],
  });

  registry.register({
    id: 'bollinger',
    name: '布林通道',
    author: '朱家泓寶典 Part 8',
    description: '帶寬擠壓後的方向性突破：向上突破 + 向下跌破',
    rules: [...BOLLINGER_RULES],
  });

  return registry;
}

/** 預設 Registry 單例 — 包含所有規則群組 */
export const DEFAULT_REGISTRY = createDefaultRegistry();
