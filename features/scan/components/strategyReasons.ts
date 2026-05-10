import type { StockScanResult } from '@/lib/scanner/types';

export interface StrategyReasonRow {
  /** 用於 A 六條件子條件：true=pass、false=fail；其他策略不填 */
  pass?: boolean;
  /** 子標籤（例如「①趨勢」、「型態」、「目標價」），可選 */
  label?: string;
  /** 主要文字描述 */
  text: string;
  /** 強調色：'good' 綠 / 'bad' 紅 / 'warn' 黃 / undefined 預設 */
  tone?: 'good' | 'bad' | 'warn';
}

export interface StrategyReasonBlock {
  method: string;
  title: string;          // 中文策略名（例如「六條件」）
  summary?: string;       // 一行小結（例如 "5/6 通過"）
  rows: StrategyReasonRow[];
}

const METHOD_NAMES: Record<string, string> = {
  A: '六條件', B: '回後買上漲', C: '盤整突破',
  D: '一字底', E: '缺口', F: 'V 反轉',
  G: 'ABC 突破', H: '突破黑K', I: 'K 線橫盤',
  J: 'ABC 突破', K: 'K 線橫盤', L: '突破黑K',
  M: '軌道線突破', N: '型態確認', O: '打底完成',
  P: '高檔拉回', Q: '三均戰法',
};

const PATTERN_LABEL: Record<string, string> = {
  'head-shoulder': '頭肩底',
  'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底',
  'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底',
  'descending-wedge': '下降楔形',
  'double-bottom': '雙重底',
  'n-shape': 'N 字底',
  'head-shoulder-top': '頭肩頂',
  'triple-top': '三重頂',
  'double-top': '雙重頂',
};

/** 書本《抓飆股》Part 7 統計達成率（百分比，0-100） */
const PATTERN_ACHIEVEMENT_PCT: Record<string, number> = {
  'triple-bottom': 95,
  'descending-wedge': 90,
  'rounding-bottom': 85,
  'head-shoulder': 83,
  'complex-head-shoulder': 80,
  'falling-diamond': 80,
  'n-shape': 75,
  'double-bottom': 36,
  'head-shoulder-top': 83,
  'triple-top': 95,
  'double-top': 36,
};

/** 書本規則描述（無逐檔 detail 欄位的策略，先用靜態描述） */
const STATIC_BOOK_RULES: Record<string, string[]> = {
  B: [
    '多頭趨勢 + 曾跌破 MA5',
    '收盤站回 MA5（站回當日或隔 1-2 日內補量突破皆可，站回後不再跌破）',
    '紅 K 實體 ≥ 2%、量 ≥ 前日 × 1.3',
    '突破前一根 K 線高點',
  ],
  C: [
    '盤整 N 日（高低差 ≤ 7%）',
    '收盤突破盤整高點',
    '量能放大（≥ 前日 × 1.3）',
  ],
  E: [
    '今日 low > 昨日 high（向上跳空缺口）',
    '紅 K + 實體 ≥ 2%',
    '量能放大（≥ 前日 × 1.3）',
  ],
  J: [
    'ABC 三段結構（A 高 → B 低 → C）',
    'C 段突破 A 高',
    'C 段量增（≥ 前段量 × 1.3）',
  ],
  K: [
    'K 線橫盤 N 日（高低差 ≤ 5%）',
    '突破橫盤區間高點',
    '量能放大',
  ],
  L: [
    '前期出現過大量黑 K（量 ≥ 前日 × 2、黑體 ≥ 3%）',
    '後續紅 K 收盤站回黑 K 高點',
    '量能配合',
  ],
  M: [
    '下降切線（連接 2 個確認頭部）',
    '紅 K 突破切線',
    '量能放大',
  ],
  P: [
    '高位回測 MA10 / MA20 不破',
    '收盤站回均線',
    '紅 K 帶量',
  ],
  D: [
    '一字 K（高低差極小）+ 量縮',
    '後續放量紅 K 突破',
  ],
  O: [
    'detectTrend 確認盤整 → 多頭轉換',
    '完成打底結構',
  ],
  Q: [
    'MA3 / MA10 / MA24 三均多排',
    '收盤 > MA3',
    '紅 K 帶量',
  ],
  G: [
    'ABC 三段結構（A 高 → B 低 → C）',
    'C 段突破 A 高',
    'C 段量增',
  ],
  H: [
    '前期出現過大量黑 K',
    '後續紅 K 收盤站回黑 K 高點',
  ],
  I: [
    'K 線橫盤 N 日',
    '突破橫盤區間高點',
  ],
};

function buildSixConditions(r: StockScanResult): StrategyReasonBlock {
  const b = r.sixConditionsBreakdown;
  const score = r.sixConditionsScore ?? 0;
  const rows: StrategyReasonRow[] = [
    { pass: b?.trend, label: '①趨勢', text: '頭頭高底底高（多頭結構）' },
    { pass: b?.ma, label: '②均線', text: 'MA5/10/20 三線多排 + MA10/20 向上' },
    { pass: b?.position, label: '③位置', text: '收盤 > MA10 AND MA20' },
    { pass: b?.kbar, label: '④紅K', text: '紅 K 實體 ≥ 2% + 高收盤 + 上影 ≤ 實體' },
    { pass: b?.volume, label: '⑤量能', text: '當日量 ≥ 前日 × 1.3' },
    { pass: b?.indicator, label: '⑥指標', text: 'MACD 綠縮 / 紅延 + KD 金叉向上' },
  ];
  return {
    method: 'A',
    title: METHOD_NAMES.A,
    summary: `${score}/6 通過`,
    rows,
  };
}

function buildPatternConfirm(r: StockScanResult): StrategyReasonBlock {
  const lw = r.lockWatchPayload;
  if (!lw?.patternType) {
    return {
      method: 'N',
      title: METHOD_NAMES.N,
      rows: [{ text: '型態確認觸發但無 lockWatch 細節' }],
    };
  }
  const name = PATTERN_LABEL[lw.patternType] ?? lw.patternType;
  const ratePct = lw.patternAchievementRate != null
    ? Math.round(lw.patternAchievementRate * 100)
    : PATTERN_ACHIEVEMENT_PCT[lw.patternType];
  const target = lw.patternTargetPrice;
  const trigger = lw.triggerPrice;
  const upsidePct = target != null
    ? ((target - r.price) / r.price) * 100
    : null;

  const rows: StrategyReasonRow[] = [
    { label: '型態', text: name, tone: 'good' },
  ];
  if (ratePct != null) {
    rows.push({
      label: '達成率',
      text: `${ratePct}%（書本《抓飆股》Part 7 歷史統計）`,
    });
  }
  if (trigger != null) {
    rows.push({ label: '頸線價', text: trigger.toFixed(2) });
  }
  if (target != null) {
    rows.push({ label: '目標價', text: target.toFixed(2) });
    if (upsidePct != null) {
      if (upsidePct > 0) {
        rows.push({
          label: '距現價',
          text: `+${upsidePct.toFixed(1)}% 空間（現價 ${r.price.toFixed(2)} → 目標 ${target.toFixed(2)}）`,
          tone: 'good',
        });
      } else {
        rows.push({
          label: '距現價',
          text: `目標已達標（現價超過目標 ${Math.abs(upsidePct).toFixed(1)}%）`,
          tone: 'warn',
        });
      }
    }
  }
  return { method: 'N', title: METHOD_NAMES.N, rows };
}

function buildVReversal(r: StockScanResult): StrategyReasonBlock {
  const lw = r.lockWatchPayload;
  const rows: StrategyReasonRow[] = [
    { text: '連跌（≥ 5 根、跌幅 ≥ 10%）+ 變盤線止跌' },
    { text: '紅 K 帶量（量 ≥ 前日 × 1.5）+ 突破前 K 高' },
  ];
  if (lw?.triggerPrice != null) {
    rows.push({
      label: '鎖定價',
      text: `${lw.triggerPrice.toFixed(2)}（V 底反彈起點 close）`,
      tone: 'good',
    });
  }
  if (lw?.vBottom != null) {
    rows.push({
      label: 'V 底',
      text: `${lw.vBottom.toFixed(2)}（變盤線 low，跌破 = 結構失效）`,
    });
  }
  return { method: 'F', title: METHOD_NAMES.F, rows };
}

function buildStaticBookRule(method: string, r: StockScanResult, activeBuyMethod?: string | null): StrategyReasonBlock {
  const rows: StrategyReasonRow[] = (STATIC_BOOK_RULES[method] ?? ['書本規則觸發']).map((t) => ({ text: t }));

  // 若是當前 active method，優先補上 triggeredRules[0].reason 提供的具體數字
  if (activeBuyMethod && method === activeBuyMethod) {
    const liveReason = r.triggeredRules?.[0]?.reason;
    if (liveReason && liveReason.trim().length > 0) {
      rows.push({ label: '本檔', text: liveReason, tone: 'good' });
    }
  }

  return {
    method,
    title: METHOD_NAMES[method] ?? method,
    rows,
  };
}

const V11_ALIAS_OF_V12: Record<string, string> = { G: 'J', H: 'L', I: 'K' };

/**
 * 產生整張卡的「符合策略原因」區塊。
 *
 * 順序：A 六條件（若命中）→ 其他字母按 matchedMethods 出現順序去重後列出。
 * v11 alias（G/H/I）合併到 v12 字母（J/L/K）。
 */
export function buildAllStrategyReasons(
  r: StockScanResult,
  activeBuyMethod?: string | null,
): StrategyReasonBlock[] {
  const matched = r.matchedMethods ?? [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of matched) {
    const canonical = V11_ALIAS_OF_V12[m] ?? m;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    ordered.push(canonical);
  }

  const blocks: StrategyReasonBlock[] = [];
  for (const m of ordered) {
    if (m === 'A') {
      blocks.push(buildSixConditions(r));
    } else if (m === 'N') {
      blocks.push(buildPatternConfirm(r));
    } else if (m === 'F') {
      blocks.push(buildVReversal(r));
    } else {
      blocks.push(buildStaticBookRule(m, r, activeBuyMethod));
    }
  }
  return blocks;
}
