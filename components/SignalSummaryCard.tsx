'use client';

/**
 * SignalSummaryCard.tsx — 訊號分頁整合卡（2026-05-10）
 *
 * 取代原訊號分頁 5 個重複面板：
 *   ConclusionCard / V12SignalAlerts / ProhibitionAlerts / WinnerPatternAlerts / RuleAlerts
 *
 * 結構（由上而下）：
 *   1. 持倉狀態列（強度色條 + 持股中/未持倉 + 現價/成本/PnL）
 *   2. 一句話結論（大字 + 一行根據）
 *   3. 數字行（停損 · 停利 · 操作均線 · 走勢偏向 +/− N）
 *   4. 為什麼？（進場/出場/戒律/V12 字母 命中分組，每條補白話說明）
 *   5. 假設今日進場 Step 3-5（未持倉時）
 *   6. 朱老師深度分析（ChartCoachAdvice，預設摺疊只顯示 verdict）
 *
 * 設計原則（用戶 feedback）：
 *   - feedback_ui_text_concise_over_redundant：最多 3 種語意，不重複
 *   - feedback_no_emoji_in_panels：左邊色條替代 emoji
 *   - 操作建議文字寫得清楚（每條訊號補一行白話「為什麼這條重要」）
 */

import { useEffect, useMemo, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { classifySignal, SignalSubtype } from '@/lib/rules/signalClassifier';
import { calcKLineStopLoss } from '@/lib/sell/v12StopLoss';
import { getOperationMA } from '@/lib/sell/v12Operation';
import { sopFor } from '@/lib/portfolio/letterSOP';
import { getTickSize } from '@/lib/utils/tickSize';
import { marketFromSymbol, formatSharesAsLots } from '@/lib/utils/shareUnits';
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectLetterN, detectTopPatterns, type TopPatternType } from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import { STOP_LOSS_PRICE_MULT, PROFIT_TARGET_PRICE_MULT } from '@/lib/analysis/bookThresholds';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { RuleSignal, CandleWithIndicators } from '@/types';
import ChartCoachAdvice from './ChartCoachAdvice';

// ── 訊號白話說明對照表 ────────────────────────────────────────────────────────
//
// label 命中時補一行「為什麼這條重要」。沒列入的訊號會 fallback 到原 description。
// 用書本根據而非技術指標白話。

const SIGNAL_EXPLAIN: Record<string, string> = {
  // 出場類
  '跌破MA10': '操作均線守不住，書本：跌破操作均線立即出場',
  '跌破MA5':  'MA5 是短線操作生命線，書本：守不住 MA5 視同短線出場',
  '跌破MA20': '月線跌破代表中期趨勢轉弱',
  '跌破MA60': '季線跌破，書本：「破季線是大空頭」需立即離場',
  '跌破前低': '波浪結構失敗（底底低），書本：明確空方訊號',
  'KD死叉':  '指標背離，動能轉弱訊號',
  'MACD死叉':'中期動能由多轉空',
  // 進場類（V12 字母也走這層）
  '紅K':     '紅K實體棒+量配合，書本：強勢進場訊號',
  'MA5上穿': '短線翻多，書本：突破 MA5 是短線進場時機',
  'MA20上穿':'中線翻多，書本：突破 MA20 是進場好位置',
  '突破前高': '波浪結構成立（頭頭高），書本：多方訊號',
  'KD金叉':  '指標翻多，動能加速訊號',
  'MACD金叉':'中期動能由空轉多',
};

/** 進場類字母（只有這 5 個會在訊號卡顯示，避免和持倉 letter 混淆）*/
type EntryLetter = 'M' | 'N' | 'O' | 'P' | 'Q';

// trackName 不含字母前綴（badge 已標 M/N/O/P/Q，避免顯示時 Q + Q 三均線戰法 + Q ... 三層重複）
const V12_TRACK_NAMES: Record<EntryLetter, string> = {
  M: '突破上升軌道（多頭續攻）',
  N: '型態確認突破頸線（25 種圖形）',
  O: '打底完成由空翻多',
  P: '高檔淺回 1-2 天後再上漲',
  Q: '三均線戰法（MA3+10+24）',
};

const V12_TRACK_BADGE: Record<EntryLetter, string> = {
  M: 'bg-red-700/70 text-red-100',
  N: 'bg-blue-700/70 text-blue-100',
  O: 'bg-blue-700/70 text-blue-100',
  P: 'bg-red-700/70 text-red-100',
  Q: 'bg-purple-700/70 text-purple-100',
};

const TOP_PATTERN_LABEL: Record<TopPatternType, string> = {
  'head-shoulder-top': '頭肩頂',
  'triple-top': '三重頂',
  'double-top': '雙重頂',
};

/** V12 字母解釋（hover tooltip 顯示）— 用於「操作均線」行的字母 underline */
const V12_LETTER_DESC: Record<string, string> = {
  A: 'A 六條件 — 純結構過濾池',
  B: 'B 回後買上漲 — 多頭回檔站回 MA5',
  C: 'C 盤整突破',
  D: 'D 一字底（均線糾結）',
  E: 'E 跳空缺口進場',
  F: 'F V 形反轉（變盤線止跌）',
  G: 'G ABC 突破',
  H: 'H 過大量黑K高',
  I: 'I K 線橫盤突破',
  J: 'J ABC 突破（v12 多頭軌）',
  K: 'K K 線橫盤突破（v12 多頭軌）',
  L: 'L 過大量黑K（v12 多頭軌）',
  M: 'M 突破上升軌道線',
  N: 'N 型態確認（書本 25 種型態）',
  O: 'O 打底完成（空頭→多頭）',
  P: 'P 高檔拉回（淺回 1-2 天）',
  Q: 'Q 三條均線戰法（MA3+10+24）',
};

const PATTERN_LABEL: Record<string, string> = {
  'head-shoulder': '頭肩底', 'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底', 'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底', 'descending-wedge': '下降楔形',
  'double-bottom': '雙重底', 'n-shape': 'N 字底',
};

// ── 結論計算 ─────────────────────────────────────────────────────────────────

type StrengthLevel = 'good' | 'warn' | 'bad' | 'neutral';

interface Verdict {
  level: StrengthLevel;
  label: string;
  basis: string;
}

const STRENGTH_TEXT: Record<StrengthLevel, string> = {
  good:    'text-emerald-300',
  warn:    'text-amber-300',
  bad:     'text-rose-300',
  neutral: 'text-foreground/70',
};

const STRENGTH_BAR: Record<StrengthLevel, string> = {
  good:    'bg-emerald-500',
  warn:    'bg-amber-500',
  bad:     'bg-rose-500',
  neutral: 'bg-border',
};

/**
 * 議題 C3 + M8：判斷哪些戒律持股中也應該露。
 * 戒律 6 = 回檔底底低（多頭結構已破）
 * 戒律 7 = 趨勢轉盤整
 * 戒律 8 = 趨勢轉空頭
 * 戒律 9 = 連續急漲爆量長紅（高位過熱）— M8 補：持股中觸發 = 該停利
 * 其他戒律（量價背離/週線壓力等）持股中已不適用，照舊隱藏。
 *
 * 0513 ABCDE 整合：唯一定義在這（SignalSummaryCard）；如需跨檔共用搬到 lib/rules/criticalProhibitions.ts。
 */
function pickCriticalProhibitions(prohibitions: string[]): string[] {
  return prohibitions.filter((p) => /戒律[6789]/.test(p));
}

function getVerdict(
  hasPosition: boolean,
  subtypes: SignalSubtype[],
  signalLabels: { entry: string[]; exit: string[] },
  prohibitionCount: number,
  hasTopPattern: boolean = false,
  criticalProhibitions: string[] = [],
): Verdict {
  const counts: Record<SignalSubtype, number> = {
    entry_strong: 0, entry_soft: 0, exit_strong: 0, exit_soft: 0, trend: 0, warn: 0,
  };
  for (const s of subtypes) counts[s]++;

  if (hasPosition) {
    // 2026-05-10 補：頂部型態觸發（三重頂/頭肩頂/雙重頂跌破頸線）= 硬出場警示
    // 書本：見頂部型態跌破 = 立即出場，視同 exit_strong 級別
    if (hasTopPattern) {
      return {
        level: 'bad',
        label: '該出場',
        basis: '頂部型態跌破頸線（書本：見頂部型態+跌破頸線即出場）',
      };
    }
    if (counts.exit_strong > 0) {
      return {
        level: 'bad',
        label: '該出場',
        basis: `出現硬出場訊號（${signalLabels.exit.slice(0, 2).join('、') || '硬出場'}），書本要求立即出場`,
      };
    }
    if (counts.exit_soft >= 2) {
      return {
        level: 'warn',
        label: '減碼或緊盯',
        basis: `${counts.exit_soft} 條軟出場訊號（${signalLabels.exit.slice(0, 2).join('、')}），緊盯停損`,
      };
    }
    if (counts.exit_soft === 1 && counts.entry_strong > 0) {
      return { level: 'warn', label: '方向不明', basis: '進場+出場同時觸發，停損守好等明日確認' };
    }
    if (counts.exit_soft === 1) {
      return { level: 'warn', label: '緊盯停損', basis: signalLabels.exit[0] ?? '輕微減碼警示' };
    }
    // 議題 C3：結構轉變戒律觸發 → 即使無出場訊號也要警示「持股風險升高」
    if (criticalProhibitions.length > 0) {
      return {
        level: 'warn',
        label: '風險升高',
        basis: `結構轉變：${criticalProhibitions[0]}（多頭優勢縮減，緊盯停損）`,
      };
    }
    return { level: 'good', label: '繼續持有', basis: '多頭延續、無出場訊號，續抱跟均線走' };
  }

  // 未持倉 — 戒律觸發為硬性禁忌，書本：「即使其他條件全過，戒律觸發即不進場」
  if (prohibitionCount > 0) {
    return {
      level: 'bad',
      label: '不要進場',
      basis: `戒律觸發 ${prohibitionCount} 條 — 書本硬性禁忌，詳見「條件」分頁`,
    };
  }
  // 2026-05-10 補：未持倉 + 頂部型態觸發 → 該檔股票正在下跌，禁止進場
  // （對稱持股中頂部型態 = 出場警示；對未持倉就是「不要碰」）
  if (hasTopPattern) {
    return {
      level: 'bad',
      label: '不要進場',
      basis: '頂部型態跌破頸線 — 股票方向轉空，書本：禁止做多',
    };
  }

  if (counts.entry_strong > 0 && counts.exit_strong === 0 && counts.exit_soft === 0) {
    return {
      level: 'good',
      label: '可進場',
      basis: `進場訊號成立（${signalLabels.entry.slice(0, 2).join('、') || '硬進場'}），書本進場條件已過`,
    };
  }
  if (counts.entry_strong > 0 && (counts.exit_strong > 0 || counts.exit_soft > 0)) {
    return { level: 'warn', label: '不追高、等確認', basis: '進場+出場同時觸發，書本：方向不明先空手' };
  }
  if (counts.exit_strong > 0 || counts.exit_soft > 0) {
    return {
      level: 'bad',
      label: '空手觀望',
      basis: signalLabels.exit.slice(0, 2).join('、') || '轉弱訊號，勿逆勢進場',
    };
  }
  if (counts.entry_soft > 0) {
    return { level: 'warn', label: '觀察', basis: signalLabels.entry[0] ?? '軟進場訊號，等硬條件成立' };
  }
  return { level: 'neutral', label: '無明確訊號', basis: '今日無進出場訊號，續觀察' };
}

// ── V12 字母動態偵測 ──────────────────────────────────────────────────────────

interface V12Hit {
  letter: EntryLetter;
  trackName: string;
  detail: string;
  patternType?: string;
  patternTargetPrice?: number;
  achievementRate?: number;
  necklinePrice?: number;
}

/** 頂部型態命中（出場警示用，僅持股中時顯示）*/
interface TopPatternHit {
  patternType: TopPatternType;
  detail: string;
  necklinePrice?: number;
  patternTargetPrice?: number;
  achievementRate?: number;
}

// ── 主元件 ──────────────────────────────────────────────────────────────────

export default function SignalSummaryCard() {
  const {
    currentSignals, allCandles, currentIndex, currentStock,
    longProhibitions, winnerPatterns,
  } = useReplayStore();
  const { holdings } = usePortfolioStore();

  const candle = allCandles[currentIndex];
  const ticker = currentStock?.ticker ?? '';
  const market = marketFromSymbol(ticker);

  // V12 字母偵測（M/N/O/P/Q）+ 頂部型態（持股中才顯示）
  const [v12Hits, setV12Hits] = useState<V12Hit[]>([]);
  const [topPatternHit, setTopPatternHit] = useState<TopPatternHit | null>(null);
  const v12Market: 'TW' | 'CN' = useMemo(
    () => /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW',
    [ticker],
  );

  useEffect(() => {
    if (!ticker || allCandles.length < 30 || currentIndex < 25) {
      setV12Hits([]);
      setTopPatternHit(null);
      return;
    }
    // 同步偵測（detector 為純函式無 await）— 不需要 cancellation flag
    try {
      const m = detectLetterM(allCandles, currentIndex, v12Market, ticker);
      const n = detectLetterN(allCandles, currentIndex, v12Market, ticker);
      const o = detectLetterO(allCandles, currentIndex, v12Market, ticker);
      const p = detectLetterP(allCandles, currentIndex, v12Market, ticker);
      const q = detectLetterQ(allCandles, currentIndex, v12Market, ticker);
      const top = detectTopPatterns(allCandles, currentIndex);
      const hits: V12Hit[] = [];
      if (m.triggered) hits.push({ letter: 'M', trackName: V12_TRACK_NAMES.M, detail: m.detail });
      if (n.triggered && n.patternType) {
        hits.push({
          letter: 'N',
          trackName: V12_TRACK_NAMES.N,
          detail: n.detail,
          patternType: n.patternType,
          patternTargetPrice: n.patternTargetPrice,
          achievementRate: n.achievementRate ? n.achievementRate / 100 : undefined,
          necklinePrice: n.necklinePrice,
        });
      }
      if (o.triggered) hits.push({ letter: 'O', trackName: V12_TRACK_NAMES.O, detail: o.detail });
      if (p.triggered) hits.push({ letter: 'P', trackName: V12_TRACK_NAMES.P, detail: p.detail });
      if (q.triggered) hits.push({ letter: 'Q', trackName: V12_TRACK_NAMES.Q, detail: q.detail });
      setV12Hits(hits);
      setTopPatternHit(top.triggered && top.patternType ? {
        patternType: top.patternType,
        detail: top.detail,
        necklinePrice: top.necklinePrice,
        patternTargetPrice: top.patternTargetPrice,
        achievementRate: top.achievementRate ? top.achievementRate / 100 : undefined,
      } : null);
    } catch (err) {
      console.error('[SignalSummaryCard] v12 detect error', err);
      // 異常時清空避免顯示前次股票的殘留 hit
      setV12Hits([]);
      setTopPatternHit(null);
    }
  }, [ticker, v12Market, allCandles, currentIndex]);

  if (!candle || !ticker) return null;

  const currentSymbol = ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const heldPosition = holdings.find(h => h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === currentSymbol);
  const hasPosition = !!heldPosition;

  // ── 訊號分類 ────────────────────────────────────────────────────────────
  const subtypes = currentSignals.map(s => s.subtype ?? classifySignal(s));
  const entrySigs = currentSignals.filter(s => {
    const t = s.subtype ?? classifySignal(s);
    return t === 'entry_strong' || t === 'entry_soft' || t === 'trend';
  });
  const exitSigs = currentSignals.filter(s => {
    const t = s.subtype ?? classifySignal(s);
    return t === 'exit_strong' || t === 'exit_soft';
  });
  const warnSigs = currentSignals.filter(s => (s.subtype ?? classifySignal(s)) === 'warn');

  const criticalProhibitions = pickCriticalProhibitions(longProhibitions?.reasons ?? []);
  const verdict = getVerdict(
    hasPosition,
    subtypes,
    { entry: entrySigs.map(s => s.label), exit: exitSigs.map(s => s.label) },
    longProhibitions?.reasons?.length ?? 0,
    topPatternHit !== null,  // 頂部型態觸發（持股 → 該出場；未持倉 → 不要進場）
    criticalProhibitions,
  );

  // 主訊號字母（V12 進場字母優先順序 Q > N > M > P > O；無命中時用持倉觸發字母）
  const PRIORITY: EntryLetter[] = ['Q', 'N', 'M', 'P', 'O'];
  const primaryV12 = PRIORITY.map(l => v12Hits.find(h => h.letter === l)).find(Boolean);
  const primaryLetter: V12Letter = primaryV12?.letter
    ?? (heldPosition?.triggerSignal as V12Letter | undefined)
    ?? 'B';
  // 0513 ABCDE C1：用 letterSOP 取代 getOperationMA 散落定義；對 'short' mode 兩者必須等價
  // (cross-source consistency test 在 __tests__/letterSOP.test.ts 強制驗)
  const operatingMA = sopFor(primaryLetter).operatingMA;
  // 0513 ABCDE E：super-long / wave 已砍；getOperationMA 仍保留處理 'long' upgrade
  void getOperationMA;

  // ── 停損 / 停利 ─────────────────────────────────────────────────────────
  // 持股中 vs 未持倉 兩條計算徹底分流，不再共用 entryPrice
  // 規避舊 V12SignalAlerts 把型態目標價納入 Step 5 預估的 regression
  const patternTarget = primaryV12?.patternTargetPrice;

  // 持倉中（書本：跟著操作均線走 + 10% 紀律停利）
  const profitLine = hasPosition && heldPosition?.costPrice != null
    ? (patternTarget ?? heldPosition.costPrice * PROFIT_TARGET_PRICE_MULT)
    : null;
  const profitLineReached = profitLine != null && candle.close >= profitLine;
  const profitLineSource: 'pattern' | 'rule' = patternTarget != null ? 'pattern' : 'rule';

  // 未持倉（若今日進場 試算）：進場=今收、停損=K線最低 vs 7% floor、停利=今收×1.10 或型態目標
  const projEntry = candle.close;
  const tickSize = getTickSize(projEntry, market);
  const projKlineStop = calcKLineStopLoss(candle, tickSize);
  const projStopLoss = Math.max(projKlineStop, projEntry * STOP_LOSS_PRICE_MULT);  // 書本守則：停損 7% 上限
  const projSlPct = ((projStopLoss - projEntry) / projEntry) * 100;
  const projProfit = patternTarget ?? projEntry * PROFIT_TARGET_PRICE_MULT;
  const projPtPct = ((projProfit - projEntry) / projEntry) * 100;
  const projProfitSource: 'pattern' | 'rule' = patternTarget != null ? 'pattern' : 'rule';

  // ── 走勢偏向（33 圖像 compositeAdjust 抽成一行）────────────────────────────
  const adjust = winnerPatterns?.compositeAdjust ?? 0;
  const bullCount = winnerPatterns?.bullishPatterns.length ?? 0;
  const bearCount = winnerPatterns?.bearishPatterns.length ?? 0;
  const trendBiasLabel = adjust > 0
    ? `偏多 +${adjust}`
    : adjust < 0
      ? `偏空 ${adjust}`
      : '中性';
  const trendBiasColor = adjust > 0
    ? 'text-rose-300'
    : adjust < 0
      ? 'text-emerald-300'
      : 'text-muted-foreground';

  // ── 持倉損益 ────────────────────────────────────────────────────────────
  const pnlPct = (heldPosition?.costPrice && candle.close)
    ? ((candle.close - heldPosition.costPrice) / heldPosition.costPrice) * 100
    : null;

  return (
    <div className="bg-card border border-border/60 rounded-lg overflow-hidden">
      <div className="flex">
        {/* 左邊強度色條 */}
        <div className={`w-1 shrink-0 ${STRENGTH_BAR[verdict.level]}`} />
        <div className="flex-1 p-3 space-y-3">

          {/* 字體系統（3 級）：
                Heading: text-base font-bold（一句話結論「該出場」「可進場」）
                Body:    text-xs（一般文字 / 數字 / 描述）
                Small:   text-[11px]（label / 書本根據 tag / 細節）
              避免 9px / 10px / lg 混用 */}

          {/* ── 1. 持倉狀態（雙行版面：身分 / 報價對照） ───────────────── */}
          <div className="space-y-1">
            {/* 第一行：身分標籤 + 數量 */}
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
                {hasPosition ? '持股中' : '未持倉'}
              </span>
              {hasPosition && heldPosition && (
                <span className="text-[11px] text-muted-foreground font-mono">
                  {formatSharesAsLots(heldPosition.shares, market)}
                </span>
              )}
            </div>
            {/* 第二行：現價 + 成本 + PnL（持股才顯示成本對照） */}
            <div className="flex items-center justify-between font-mono text-xs">
              <span>
                <span className="text-muted-foreground/70 text-[11px]">現價</span>
                <span className="ml-1 text-foreground font-bold">{candle.close.toFixed(2)}</span>
              </span>
              {heldPosition?.costPrice != null && (
                <span>
                  <span className="text-muted-foreground/70 text-[11px]">成本</span>
                  <span className="ml-1 text-foreground/80">{heldPosition.costPrice.toFixed(2)}</span>
                  {pnlPct != null && (
                    <span className={`ml-1.5 font-bold ${pnlPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* ── 2. 一句話結論（Heading 級） ───────────────────────────── */}
          <div>
            <p className={`text-base font-bold leading-tight ${STRENGTH_TEXT[verdict.level]}`}>
              {verdict.label}
            </p>
            {verdict.basis && (
              <p className="text-xs text-muted-foreground mt-1 leading-snug">{verdict.basis}</p>
            )}
          </div>

          {/* ── 3. 金額區 + 風向 ──
                持股中 → 持倉診斷（動態停損 + 10% 紀律停利）
                未持倉 → 若今日進場（試算進場/停損/停利）
                兩種模式互斥，避免持股者誤以為叫他加碼 */}
          <div className="border-t border-border/40 pt-2 space-y-3">
            {hasPosition ? (
              <HoldingDiscipline
                candle={candle}
                operatingMA={operatingMA}
                profitLine={profitLine}
                profitLineReached={profitLineReached}
                profitLineSource={profitLineSource}
              />
            ) : (
              <EntryProjection
                projEntry={projEntry}
                projStopLoss={projStopLoss}
                projSlPct={projSlPct}
                projProfit={projProfit}
                projPtPct={projPtPct}
                projProfitSource={projProfitSource}
              />
            )}

            {/* 風向（走勢偏向）— 主訊息一行、明細獨立下一行 */}
            <div className="pt-2 border-t border-border/20 space-y-0.5">
              <p className="text-[11px] leading-relaxed">
                <span className="text-muted-foreground" title="33 種 K 棒型態（書本《抓住線圖》附錄）綜合得分。+ 偏多、− 偏空、0 中性">走勢偏向</span>
                <span className={`ml-2 font-bold ${trendBiasColor}`}>{trendBiasLabel}</span>
              </p>
              {(bullCount > 0 || bearCount > 0) && (
                <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
                  （33 種 K 棒型態：多頭 {bullCount}／空頭 {bearCount}）
                </p>
              )}
            </div>
          </div>

          {/* ── 4. 為什麼？分組 ───────────────────────────── */}
          {/* topPatternHit 不論持倉都傳，跟 verdict 邏輯對稱（持股=該出場、未持倉=不要進場）
              hasPosition 決定要不要顯示「進場依據」（持股中隱藏，避免暗示加碼）*/}
          <Reasons
            hasPosition={hasPosition}
            v12Hits={v12Hits}
            topPatternHit={topPatternHit}
            entrySigs={entrySigs}
            exitSigs={exitSigs}
            warnSigs={warnSigs}
            prohibitions={longProhibitions?.reasons ?? []}
            criticalProhibitions={criticalProhibitions}
            todayClose={candle.close}
          />
        </div>
      </div>

      {/* ── 5. 朱老師深度分析（底部，預設摺疊） ─────────────── */}
      <div className="border-t border-border/60 bg-secondary/30 p-3">
        <ChartCoachAdvice defaultCollapsed />
      </div>
    </div>
  );
}

// ── 子元件：持倉診斷（持股中模式）─────────────────────────────────────────
// 動態停損（跟著操作均線走）+ 10% 紀律停利線
// 不顯示「進場價/停損」這兩個試算行 — 持股者不需要被叫去加碼

function HoldingDiscipline({
  candle, operatingMA, profitLine, profitLineReached, profitLineSource,
}: {
  candle: CandleWithIndicators;
  operatingMA: string | null;
  profitLine: number | null;
  profitLineReached: boolean;
  profitLineSource: 'pattern' | 'rule';
}) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      <p className="text-[11px] text-muted-foreground/80">持倉中守則：</p>

      {/* 動態停損 — 跌破操作均線出場 */}
      {operatingMA && (() => {
        const maKey = operatingMA.toLowerCase() as 'ma5' | 'ma10' | 'ma20' | 'ma60' | 'ma240';
        const maVal = (candle as unknown as Record<string, number | undefined>)[maKey];
        if (maVal == null) return null;
        const maPct = ((maVal - candle.close) / candle.close) * 100;
        return (
          <p className="text-emerald-300">
            <span
              className="font-bold"
              title="進場後持倉期間，跌破此均線才出場（書本：跟著均線走，動態跟蹤停損）"
            >動態停損</span>
            <span className="ml-2">跌破 {operatingMA}</span>
            <span className="ml-1.5 font-mono font-bold">{maVal.toFixed(2)}</span>
            <span className="ml-1.5 font-mono text-muted-foreground/70">({maPct.toFixed(1)}%)</span>
            <span className="ml-1.5 text-muted-foreground/70">出場</span>
          </p>
        );
      })()}

      {/* 10% 紀律停利線（或型態目標）*/}
      {profitLine != null && (
        <p className="text-rose-300">
          <span className="font-bold">停利線</span>
          <span className="ml-2 font-mono font-bold">{profitLine.toFixed(2)}</span>
          <span className="ml-1.5 font-mono text-muted-foreground/70">
            ({((profitLine - candle.close) / candle.close * 100).toFixed(1)}%)
          </span>
          <span className="ml-2 text-[11px] text-muted-foreground/60">
            {profitLineSource === 'pattern' ? '型態目標' : '10%紀律'}
          </span>
          {profitLineReached && (
            <span className="ml-2 text-[11px] font-bold text-amber-300">
              ✓ 已達 — 緊盯動態停損
            </span>
          )}
        </p>
      )}
    </div>
  );
}

// ── 子元件：若今日進場（試算，未持倉模式）─────────────────────────────────
// 試算進場/停損/停利 — 給「該不該進場」的決策用

function EntryProjection({
  projEntry, projStopLoss, projSlPct, projProfit, projPtPct, projProfitSource,
}: {
  projEntry: number;
  projStopLoss: number;
  projSlPct: number;
  projProfit: number;
  projPtPct: number;
  projProfitSource: 'pattern' | 'rule';
}) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      <p className="text-[11px] text-muted-foreground/80">若今日進場（試算）：</p>

      {/* 進場 */}
      <p>
        <span className="text-foreground/80 font-bold">進場</span>
        <span className="ml-2 font-mono font-bold text-foreground">{projEntry.toFixed(2)}</span>
      </p>
      {/* 停損（綠 = 跌）*/}
      <p>
        <span className="text-emerald-300 font-bold">停損</span>
        <span className="ml-2 font-mono text-emerald-300 font-bold">{projStopLoss.toFixed(2)}</span>
        <span className="ml-1.5 font-mono text-muted-foreground/70">({projSlPct.toFixed(1)}%)</span>
      </p>
      {/* 停利（紅 = 漲）*/}
      <p>
        <span className="text-rose-300 font-bold">停利</span>
        <span className="ml-2 font-mono text-rose-300 font-bold">{projProfit.toFixed(2)}</span>
        <span className="ml-1.5 font-mono text-muted-foreground/70">
          ({projPtPct >= 0 ? '+' : ''}{projPtPct.toFixed(1)}%)
        </span>
        <span className="ml-2 text-[11px] text-muted-foreground/60">
          {projProfitSource === 'pattern' ? '型態目標' : '10%紀律'}
        </span>
      </p>
    </div>
  );
}

// ── 子元件：為什麼？分組 ──────────────────────────────────────────────────

function Reasons({
  hasPosition, v12Hits, topPatternHit, entrySigs, exitSigs, warnSigs, prohibitions, criticalProhibitions, todayClose,
}: {
  hasPosition: boolean;
  v12Hits: V12Hit[];
  topPatternHit: TopPatternHit | null;
  entrySigs: RuleSignal[];
  exitSigs: RuleSignal[];
  warnSigs: RuleSignal[];
  prohibitions: string[];
  criticalProhibitions: string[];
  todayClose: number;
}) {
  // 持股中：不顯示「進場依據」（避免暗示加碼）；只顯示出場 + 注意事項 + 結構轉變戒律
  // 未持倉：不顯示「一般出場訊號」（沒倉位談何出場），但頂部型態仍顯示為「不要進場」依據
  const showEntry = !hasPosition && (v12Hits.length > 0 || entrySigs.length > 0);
  const showExit = hasPosition ? (exitSigs.length > 0 || topPatternHit != null) : (topPatternHit != null);
  const showWarn = warnSigs.length > 0;
  // 議題 C3：持股中露結構轉變戒律（戒律 6/7/8）— 趨勢已轉，再不謹慎會被套
  const showCriticalProhibitions = hasPosition && criticalProhibitions.length > 0;

  const empty = !showEntry && !showExit && !showWarn && !showCriticalProhibitions && prohibitions.length === 0;

  if (empty) {
    return (
      <p className="text-xs text-muted-foreground/70 border-t border-border/40 pt-2">
        分析 — 今日無觸發訊號
      </p>
    );
  }

  const hasEntry = showEntry;
  const hasExit = showExit;

  return (
    <div className="border-t border-border/40 pt-2 space-y-2">
      <p className="text-xs font-semibold text-foreground/80">分析</p>

      {/* 進場依據（V12 字母 + 朱家泓書本規則合併）*/}
      {hasEntry && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-rose-300">進場依據</p>
          <div className="space-y-1.5">
            {/* V12 字母卡片（M/N/O/P/Q）— 用戶 PS 喜好：trackName 一整行不拆 */}
            {v12Hits.map(h => (
              <div key={h.letter} className="rounded px-2.5 py-2 bg-secondary/30">
                <p className="text-sm font-bold text-foreground/90">{h.trackName}</p>
                <p className="text-[11px] text-foreground/75 leading-relaxed mt-1">{h.detail.replace(/^[A-Z]\s+/, '')}</p>
                {h.patternType && h.patternTargetPrice && h.necklinePrice && (
                  <div className="mt-1.5 pt-1.5 border-t border-border/30 space-y-0.5 text-[11px]">
                    <div className="flex items-baseline justify-between">
                      <span className="text-indigo-300 font-bold">{PATTERN_LABEL[h.patternType] ?? h.patternType}</span>
                      {h.achievementRate != null && (
                        <span className="text-amber-300">達成率 {(h.achievementRate * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    <div className="flex items-baseline justify-between text-muted-foreground">
                      <span>頸線</span>
                      <span className="font-mono">{h.necklinePrice.toFixed(2)}</span>
                    </div>
                    <div className="flex items-baseline justify-between text-emerald-400">
                      <span>目標價</span>
                      <span className="font-mono">
                        {h.patternTargetPrice.toFixed(2)} ({((h.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* 朱家泓書本進場規則（朱SOP / 回檔再上漲 / 均線撐漲 / 下缺回補等）— 用戶 PS 喜好：暗紅紫底區分書本規則 */}
            {entrySigs.slice(0, 4).map((s, i) => (
              <ReasonRow key={`entry-${i}`} signal={s} bgColor="bg-rose-900/15" />
            ))}
          </div>
        </div>
      )}

      {/* 出場警示（持股中=該出場理由；未持倉=只顯示頂部型態作為「不要進場」依據）*/}
      {hasExit && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-emerald-300">
            {hasPosition ? '出場警示' : '禁止做多依據'}
          </p>
          <div className="space-y-1.5">
            {/* 頂部型態（持股=該出場、未持倉=不要進場）*/}
            {topPatternHit && (
              <div className="rounded px-2.5 py-2 bg-rose-900/15">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-xs font-bold text-rose-300">{TOP_PATTERN_LABEL[topPatternHit.patternType]}</span>
                  {topPatternHit.achievementRate != null && (
                    <span className="text-[11px] text-amber-300">達成率 {(topPatternHit.achievementRate * 100).toFixed(0)}%</span>
                  )}
                </div>
                <div className="space-y-0.5 text-[11px]">
                  {topPatternHit.necklinePrice != null && (
                    <div className="flex items-baseline justify-between text-muted-foreground">
                      <span>頸線</span>
                      <span className="font-mono">{topPatternHit.necklinePrice.toFixed(2)}</span>
                    </div>
                  )}
                  {topPatternHit.patternTargetPrice != null && (
                    <div className="flex items-baseline justify-between text-rose-300">
                      <span>目標價（下跌）</span>
                      <span className="font-mono">
                        {topPatternHit.patternTargetPrice.toFixed(2)} ({((topPatternHit.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}%)
                      </span>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-foreground/70 leading-relaxed mt-1.5 pt-1.5 border-t border-rose-700/30">
                  {topPatternHit.detail}
                </p>
                <p className="text-[11px] text-muted-foreground/60 mt-1">書本：見頂部型態+跌破頸線即出場</p>
              </div>
            )}
            {/* 一般出場訊號 — 只在持股中顯示 */}
            {hasPosition && exitSigs.slice(0, 4).map((s, i) => (
              <ReasonRow key={`exit-${i}`} signal={s} bgColor="bg-emerald-900/15" />
            ))}
          </div>
        </div>
      )}

      {/* 議題 C3：結構轉變戒律 — 持股中才顯示（戒律 6/7/8），其餘戒律詳見「條件」分頁 */}
      {showCriticalProhibitions && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-amber-300">結構轉變警示</p>
          <div className="space-y-0.5">
            {criticalProhibitions.slice(0, 3).map((p, i) => (
              <div
                key={`crit-${i}`}
                className="text-[11px] px-2 py-1 rounded bg-amber-900/25 text-amber-200/90 leading-relaxed"
              >
                {p}
              </div>
            ))}
            {criticalProhibitions.length > 3 && (
              <p className="text-[10px] text-muted-foreground/70 italic">
                （顯示前 3 條，共 {criticalProhibitions.length} 條 — 完整清單見「條件」分頁）
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed pt-0.5">
              書本：結構轉變（戒律 6/7/8）/ 高位過熱（戒律 9）— 已持股應緊盯停損或考慮停利。
            </p>
          </div>
        </div>
      )}

      {/* 注意事項（非進出場，但需注意）*/}
      {warnSigs.length > 0 && (
        <ReasonGroup
          title="注意事項"
          color="text-yellow-300"
          bgColor="bg-yellow-900/15"
          signals={warnSigs.slice(0, 3)}
        />
      )}
    </div>
  );
}

function ReasonRow({ signal: s, bgColor }: { signal: RuleSignal; bgColor: string }) {
  const override = SIGNAL_EXPLAIN[s.label];
  const mainText = override ?? s.description ?? '';
  const bookRef = override ? undefined : extractBookRef(s.reason);
  const operationHint = override ? undefined : extractOperationHint(s.reason);
  return (
    <div className={`rounded px-2.5 py-2 ${bgColor}`}>
      <p className="text-sm font-bold text-foreground/90">{s.label}</p>
      {mainText && (
        <p className="text-[11px] text-foreground/85 leading-snug mt-1 break-words">
          {mainText}
        </p>
      )}
      {operationHint && (
        <p className="text-[11px] text-foreground/70 leading-snug mt-1 break-words">
          {operationHint}
        </p>
      )}
      {bookRef && (
        <p className="text-[11px] text-muted-foreground/60 leading-snug mt-1 break-words">
          {bookRef}
        </p>
      )}
    </div>
  );
}

function ReasonGroup({
  title, color, bgColor, signals,
}: {
  title: string;
  color: string;
  bgColor: string;
  signals: RuleSignal[];
}) {
  return (
    <div>
      <p className={`text-[11px] font-bold mb-1 ${color}`}>{title}</p>
      <div className="space-y-1.5">
        {signals.map((s, i) => <ReasonRow key={i} signal={s} bgColor={bgColor} />)}
      </div>
    </div>
  );
}

/** 從 reason 抓【...】書本根據（保留括號）— 顯示在最末行 */
function extractBookRef(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const m = reason.match(/【[^】]+】/);
  return m?.[0];
}

/** 從 reason 抓「操作：...」實戰建議 — 顯示在描述底下 */
function extractOperationHint(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  // 匹配「操作：」或「策略：」開頭的 1-2 句
  const m = reason.match(/(?:操作|策略|建議)[：:]\s*([^\n。]+(?:。[^\n。]{0,40})?)/);
  return m?.[1] ? `操作：${m[1].trim()}` : undefined;
}
