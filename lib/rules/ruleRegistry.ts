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
  | 'rsi'              // RSI 進階
  | 'edwards-magee'    // Edwards & Magee 經典圖表型態
  | 'trend-ma'         // 趨勢/均線（通用基礎）
  | 'volume'           // 量價（通用基礎）
  | 'oscillator'       // MACD/KD（通用基礎）
  | 'consensus'        // 大師共識/共振
  | 'larry-williams'   // Larry Williams 短線交易秘訣
  | 'murphy'           // Murphy《金融市場技術分析》
  | 'resonance-2'      // 回測虛擬：2群組共振
  | 'resonance-3'      // 回測虛擬：3群組共振
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
  | 'mkt-sl5-c5';      // 回測虛擬：大盤多頭+停損5%+六條件≥5

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

// 朱家泓五步驟
import { ZHU_RULES } from './zhuRules';
// 朱家泓 K 線戰法
import {
  smartKLineBuy, smartKLineSell, candleMergeSignal,
  lowLongRedAttack, lowHammerAttack, lowCrossAttack, lowEngulfAttack, lowThreeRedAttack,
  highShootingStar, highCrossSell, highEngulfSell, highEveningStar,
} from './smartKLineRules';
import { KLINE_COMBO_RULES } from './klineComboRules';
import { KLINE_TRADING_RULES } from './klineTradingRules';
// 朱家泓反轉型態
import {
  flatBottomBreakout, higherBottomBreakout, falseBreakdownBreakout,
  flatTopBreakdown, lowerTopBreakdown, falseBreakoutBreakdown, consolidationBreakoutDirection,
} from './zhuReversalRules';
import { TWO_BAR_REVERSAL_RULES } from './twoBarReversalRules';
import { THREE_BAR_REVERSAL_RULES } from './threeBarReversalRules';
// 朱家泓均線戰法
import { singleMa20Buy, singleMa20Sell, tripleMaBuy, tripleMaSell, dualMaBuy, dualMaSell } from './maStrategyRules';
import { weeklyMa20Buy, weeklyMa20Sell, weeklyMa20Add } from './weeklyMaRules';
// 朱家泓飆股/缺口
import { surgeStockBreakout, surgeStockExit, momentumContinuationBuy, fibRetracementGrade } from './momentumRules';
import { GAP_TRADING_RULES } from './gapTradingRules';
// 朱家泓進階（寶典）
import { TURNING_WAVE_RULES } from './turningWaveRules';
import { BOTTOM_FORMATION_RULES } from './bottomFormationRules';
import { ENTRY_MISTAKE_RULES } from './entryMistakeRules';
// 朱家泓《抓住飆股輕鬆賺》
import { ZHU_SOAR_STOCK_RULES } from './zhuSoarStockRules';
// 林穎走圖 SOP
import {
  sopBullConfirmEntry, sopBullPullbackBuy, sopConsolidationBreakout,
  sopBearConfirmEntry, sopBearBounceSell, sopConsolidationBreakdown,
} from './chartWalkingSopRules';
import { sopHighReversalWarning, sopLowReversalSignal } from './reversalPatternRules';
// 葛蘭碧
import {
  granvilleBuy1, granvilleBuy2, granvilleBuy3, granvilleBuy4,
  granvilleSell5, granvilleSell6, granvilleSell7, granvilleSell8,
} from './granvilleRules';
// 布林
import { bollingerSqueezeUp, bollingerSqueezeDown } from './bollingerRules';
// RSI
import { rsiBullishFailureSwing, rsiBearishFailureSwing, rsiBullishDivergence, rsiBearishDivergence } from './rsiRules';
// Edwards & Magee
import { EDWARDS_MAGEE_RULES } from './edwardsMageeRules';
// 通用：趨勢/均線
import { bullishTrendConfirm, bearishTrendConfirm } from './trendRules';
import {
  bullishMAAlignment, bearishMAAlignment, maClusterBreakout,
  breakAboveMA20, breakAboveMA5, bullishPullbackBuy,
  breakBelowMA5, breakBelowMA20, breakBelowMA60,
} from './maRules';
// 通用：量價
import {
  volumeBreakoutHigh, highVolumeLongBlack, highVolumeLongRed, highDeviationWarning,
  piercingRedCandle, piercingBlackCandle, threeBlackCandles,
} from './volumeRules';
// 通用：MACD/KD
import {
  macdGoldenCross, macdDeathCross, macdBullishDivergence,
  kdOversoldBounce, kdOverboughtWarning, stopLossBreakMA5,
} from './oscillatorRules';
// 大師共識/共振
import { masterConsensusBreakout } from './consensusRules';
import { bullishResonance, bearishResonance } from './resonanceRules';
// Larry Williams《短線交易秘訣》
import { LARRY_WILLIAMS_RULES } from './larryWilliamsRules';
// Murphy《金融市場技術分析》
import { MURPHY_TREND_RULES } from './murphyTrendRules';
import { MURPHY_VOLUME_RULES } from './murphyVolumeRules';
import { MURPHY_OSCILLATOR_RULES } from './murphyOscillatorRules';
import { MURPHY_RETRACEMENT_RULES } from './murphyRetracementRules';
import { MURPHY_PATTERN_RULES } from './murphyPatternRules';
import { MURPHY_MARKET_RULES } from './murphyMarketRules';

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
    name: '朱家泓 K 線戰法',
    author: '朱家泓',
    description: '《抓住線圖》智慧K線 + K線組合(15種) + K線交易法(4條)',
    rules: [
      smartKLineBuy, smartKLineSell, candleMergeSignal,
      lowLongRedAttack, lowHammerAttack, lowCrossAttack, lowEngulfAttack, lowThreeRedAttack,
      highShootingStar, highCrossSell, highEngulfSell, highEveningStar,
      ...KLINE_COMBO_RULES,
      ...KLINE_TRADING_RULES,
    ],
  });

  registry.register({
    id: 'zhu-reversal',
    name: '朱家泓反轉型態',
    author: '朱家泓',
    description: '底部/頭部反轉型態 + 2根K線轉折(8條) + 3根K線轉折(6條)',
    rules: [
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
    name: '朱家泓飆股/缺口',
    author: '朱家泓',
    description: '飆股戰法 + 續勢戰法 + 缺口操作規則(5條)',
    rules: [
      surgeStockBreakout, surgeStockExit, momentumContinuationBuy, fibRetracementGrade,
      ...GAP_TRADING_RULES,
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
    id: 'zhu-soar-stock',
    name: '朱家泓《抓住飆股輕鬆賺》',
    author: '朱家泓',
    description: '9種價量關係診斷 + 市場循環4階段偵測 + 位置風險評估 + 巨量後觀察',
    rules: [...ZHU_SOAR_STOCK_RULES],
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
    author: 'Joseph Granville',
    description: '經典均線交易八大法則（4買4賣）',
    rules: [
      granvilleBuy1, granvilleBuy2, granvilleBuy3, granvilleBuy4,
      granvilleSell5, granvilleSell6, granvilleSell7, granvilleSell8,
    ],
  });

  registry.register({
    id: 'bollinger',
    name: '布林通道',
    author: 'John Bollinger',
    description: '布林帶壓縮突破信號',
    rules: [bollingerSqueezeUp, bollingerSqueezeDown],
  });

  registry.register({
    id: 'rsi',
    name: 'RSI 進階',
    author: 'J. Welles Wilder',
    description: 'RSI 失敗擺動 + 背離偵測',
    rules: [rsiBullishFailureSwing, rsiBearishFailureSwing, rsiBullishDivergence, rsiBearishDivergence],
  });

  registry.register({
    id: 'edwards-magee',
    name: 'Edwards & Magee 經典型態',
    author: 'Edwards & Magee',
    description: '《股市趨勢技術分析》經典圖表型態（16條）',
    rules: [...EDWARDS_MAGEE_RULES],
  });

  registry.register({
    id: 'trend-ma',
    name: '趨勢/均線（通用）',
    author: '系統內建',
    description: '趨勢確認 + 均線排列/突破/跌破（基礎建設，多數策略都需要）',
    rules: [
      bullishTrendConfirm, bearishTrendConfirm,
      bullishMAAlignment, bearishMAAlignment, maClusterBreakout,
      breakAboveMA20, breakAboveMA5, bullishPullbackBuy,
      breakBelowMA5, breakBelowMA20, breakBelowMA60,
    ],
  });

  registry.register({
    id: 'volume',
    name: '量價（通用）',
    author: '系統內建',
    description: '量能突破、量價異常偵測（基礎建設）',
    rules: [
      volumeBreakoutHigh, highVolumeLongBlack, highVolumeLongRed, highDeviationWarning,
      piercingRedCandle, piercingBlackCandle, threeBlackCandles,
    ],
  });

  registry.register({
    id: 'oscillator',
    name: 'MACD/KD（通用）',
    author: '系統內建',
    description: 'MACD 黃金/死亡交叉、KD 超賣/超買、背離（基礎建設）',
    rules: [
      macdGoldenCross, macdDeathCross, macdBullishDivergence,
      kdOversoldBounce, kdOverboughtWarning, stopLossBreakMA5,
    ],
  });

  registry.register({
    id: 'consensus',
    name: '大師共識/共振',
    author: '朱家泓 × 權證小哥 × 蔡森',
    description: '多師共識突破 + 多指標共振信號',
    rules: [masterConsensusBreakout, bullishResonance, bearishResonance],
  });

  registry.register({
    id: 'larry-williams',
    name: 'Larry Williams 短線交易秘訣',
    author: 'Larry Williams',
    description: '《短線交易秘訣》波動性突破(2條) + Oops反轉(2條) + TDW/TDM時間過濾(3條) + 失敗振盪(2條) + 大區間日(2條) + 三日波幅(1條)',
    rules: [...LARRY_WILLIAMS_RULES],
  });

  registry.register({
    id: 'murphy',
    name: 'Murphy《金融市場技術分析》',
    author: 'John Murphy',
    description: '趨勢結構(6條) + 量價驗證(5條) + 擺動指數(6條) + 費波納奇回撤(4條) + 補充型態(5條) + 市場結構(3條)',
    rules: [
      ...MURPHY_TREND_RULES,
      ...MURPHY_VOLUME_RULES,
      ...MURPHY_OSCILLATOR_RULES,
      ...MURPHY_RETRACEMENT_RULES,
      ...MURPHY_PATTERN_RULES,
      ...MURPHY_MARKET_RULES,
    ],
  });

  return registry;
}

/** 預設 Registry 單例 — 包含所有規則群組 */
export const DEFAULT_REGISTRY = createDefaultRegistry();
