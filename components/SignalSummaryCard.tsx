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
import { getTickSize } from '@/lib/utils/tickSize';
import { marketFromSymbol, formatSharesAsLots } from '@/lib/utils/shareUnits';
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectLetterN, detectTopPatterns, type TopPatternType } from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { RuleSignal } from '@/types';
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

const V12_TRACK_NAMES: Record<EntryLetter, string> = {
  M: '多頭軌·軌道線突破',
  N: '轉折軌·型態確認',
  O: '轉折軌·打底完成',
  P: '多頭軌·高檔拉回',
  Q: '戰法軌·三均線',
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

function getVerdict(
  hasPosition: boolean,
  subtypes: SignalSubtype[],
  signalLabels: { entry: string[]; exit: string[] },
  prohibitionCount: number,
  hasTopPattern: boolean = false,
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

  const verdict = getVerdict(
    hasPosition,
    subtypes,
    { entry: entrySigs.map(s => s.label), exit: exitSigs.map(s => s.label) },
    longProhibitions?.reasons?.length ?? 0,
    topPatternHit !== null,  // 頂部型態觸發（持股 → 該出場；未持倉 → 不要進場）
  );

  // 主訊號字母（V12 進場字母優先順序 Q > N > M > P > O；無命中時用持倉觸發字母）
  const PRIORITY: EntryLetter[] = ['Q', 'N', 'M', 'P', 'O'];
  const primaryV12 = PRIORITY.map(l => v12Hits.find(h => h.letter === l)).find(Boolean);
  const primaryLetter: V12Letter = primaryV12?.letter
    ?? (heldPosition?.triggerSignal as V12Letter | undefined)
    ?? 'B';
  const operatingMA = getOperationMA(primaryLetter, 'short');

  // ── 停損 / 停利 ─────────────────────────────────────────────────────────
  const entryPrice = heldPosition?.costPrice ?? candle.close;
  const tickSize = getTickSize(entryPrice, market);
  const klineStop = calcKLineStopLoss(candle, tickSize);
  const absoluteFloor = entryPrice * 0.90;
  const stopLoss = Math.max(klineStop, absoluteFloor);
  const slPct = ((stopLoss - candle.close) / candle.close) * 100;
  // 停利優先順序：N 型態目標價（書本明寫）> 成本 ×1.10（書本進階紀律）
  // 規避舊 V12SignalAlerts 把型態目標價納入 Step 5 預估的 regression
  const patternTarget = primaryV12?.patternTargetPrice;
  const profitTarget = patternTarget ?? entryPrice * 1.10;
  const ptPct = ((profitTarget - candle.close) / candle.close) * 100;
  const profitTargetSource: 'pattern' | 'rule' = patternTarget != null ? 'pattern' : 'rule';

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

          {/* ── 1. 持倉狀態（雙行版面：身分 / 報價對照） ───────────────── */}
          <div className="space-y-1">
            {/* 第一行：身分標籤 + 數量 */}
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
                {hasPosition ? '持股中' : '未持倉'}
              </span>
              {hasPosition && heldPosition && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatSharesAsLots(heldPosition.shares, market)}
                </span>
              )}
            </div>
            {/* 第二行：現價 + 成本 + PnL（持股才顯示成本對照） */}
            <div className="flex items-center justify-between font-mono text-xs">
              <span>
                <span className="text-muted-foreground/70 text-[10px]">現價</span>
                <span className="ml-1 text-foreground font-bold">{candle.close.toFixed(2)}</span>
              </span>
              {heldPosition?.costPrice != null && (
                <span>
                  <span className="text-muted-foreground/70 text-[10px]">成本</span>
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

          {/* ── 2. 一句話結論 ───────────────────────────── */}
          <div>
            <p className={`text-lg font-bold leading-tight ${STRENGTH_TEXT[verdict.level]}`}>
              {verdict.label}
            </p>
            {verdict.basis && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{verdict.basis}</p>
            )}
          </div>

          {/* ── 3. 數字行：停損 · 停利 · 操作均線 · 走勢偏向 ── */}
          <div className="border-t border-border/40 pt-2 space-y-1">
            {!hasPosition && (
              <p className="text-[10px] text-muted-foreground/80">若今日進場 {candle.close.toFixed(2)}：</p>
            )}
            <p className="text-xs font-mono">
              <span className="text-rose-300">停損 {stopLoss.toFixed(2)}</span>
              <span className="text-[10px] opacity-70 ml-0.5">({slPct.toFixed(1)}%)</span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-emerald-300">停利 {profitTarget.toFixed(2)}</span>
              <span className="text-[10px] opacity-70 ml-0.5">({ptPct >= 0 ? '+' : ''}{ptPct.toFixed(1)}%)</span>
              <span className="text-[9px] text-muted-foreground/70 ml-0.5">
                {profitTargetSource === 'pattern' ? '·型態目標' : '·10%紀律'}
              </span>
              {operatingMA && (
                <>
                  <span className="text-muted-foreground"> · </span>
                  <span className="text-foreground/80">{primaryLetter} 跟 {operatingMA}</span>
                </>
              )}
            </p>
            <p className="text-[10px]">
              <span className="text-muted-foreground">走勢偏向：</span>
              <span className={`font-bold ${trendBiasColor}`}>{trendBiasLabel}</span>
              {(bullCount > 0 || bearCount > 0) && (
                <span className="text-muted-foreground/70 ml-1">
                  （33 圖像 · 多 {bullCount} / 空 {bearCount}）
                </span>
              )}
            </p>
          </div>

          {/* ── 4. 為什麼？分組 ───────────────────────────── */}
          {/* topPatternHit 不論持倉都傳，跟 verdict 邏輯對稱（持股=該出場、未持倉=不要進場）*/}
          <Reasons
            v12Hits={v12Hits}
            topPatternHit={topPatternHit}
            entrySigs={entrySigs}
            exitSigs={exitSigs}
            warnSigs={warnSigs}
            prohibitions={longProhibitions?.reasons ?? []}
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

// ── 子元件：為什麼？分組 ──────────────────────────────────────────────────

function Reasons({
  v12Hits, topPatternHit, entrySigs, exitSigs, warnSigs, prohibitions, todayClose,
}: {
  v12Hits: V12Hit[];
  topPatternHit: TopPatternHit | null;
  entrySigs: RuleSignal[];
  exitSigs: RuleSignal[];
  warnSigs: RuleSignal[];
  prohibitions: string[];
  todayClose: number;
}) {
  const empty = v12Hits.length === 0 && !topPatternHit && entrySigs.length === 0
    && exitSigs.length === 0 && warnSigs.length === 0 && prohibitions.length === 0;

  if (empty) {
    return (
      <p className="text-xs text-muted-foreground/70 border-t border-border/40 pt-2">
        為什麼？ — 今日無觸發訊號
      </p>
    );
  }

  return (
    <div className="border-t border-border/40 pt-2 space-y-2">
      <p className="text-xs font-semibold text-foreground/80">為什麼？</p>

      {/* V12 字母進場訊號（多頭軌/轉折軌/戰法軌）*/}
      {v12Hits.length > 0 && (
        <div className="space-y-1">
          {v12Hits.map(h => (
            <div key={h.letter} className="flex items-start gap-1.5 text-[11px]">
              <span className={`font-bold px-1.5 py-px rounded shrink-0 text-[10px] ${V12_TRACK_BADGE[h.letter]}`}>
                {h.letter}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-foreground/90">{h.trackName}</div>
                <div className="text-[10px] text-muted-foreground leading-tight">{h.detail}</div>
                {h.patternType && h.patternTargetPrice && h.necklinePrice && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] flex-wrap">
                    <span className="text-indigo-300 font-bold">{PATTERN_LABEL[h.patternType] ?? h.patternType}</span>
                    {h.achievementRate != null && (
                      <span className="text-amber-300">{(h.achievementRate * 100).toFixed(0)}%</span>
                    )}
                    <span className="text-muted-foreground">頸線 {h.necklinePrice.toFixed(2)}</span>
                    <span className="text-emerald-400">
                      → {h.patternTargetPrice.toFixed(2)}（{((h.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}% 空間）
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 進場訊號 */}
      {entrySigs.length > 0 && (
        <ReasonGroup
          title="進場理由"
          color="text-rose-300"
          bgColor="bg-rose-900/15"
          signals={entrySigs.slice(0, 4)}
        />
      )}

      {/* 出場訊號 */}
      {exitSigs.length > 0 && (
        <ReasonGroup
          title="出場理由"
          color="text-emerald-300"
          bgColor="bg-emerald-900/15"
          signals={exitSigs.slice(0, 4)}
        />
      )}

      {/* 頂部型態警示（持股中才顯示）— 書本：見頂部型態 + 跌破頸線 → 出場 */}
      {topPatternHit && (
        <div className="rounded border border-emerald-700/40 bg-emerald-900/15 px-2 py-1.5">
          <p className="text-[10px] font-bold text-emerald-300 mb-0.5">頂部型態警示 — 書本：跌破頸線立即出場</p>
          <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
            <span className="text-emerald-300 font-bold">{TOP_PATTERN_LABEL[topPatternHit.patternType]}</span>
            {topPatternHit.achievementRate != null && (
              <span className="text-amber-300">{(topPatternHit.achievementRate * 100).toFixed(0)}%</span>
            )}
            {topPatternHit.necklinePrice != null && (
              <span className="text-muted-foreground">頸線 {topPatternHit.necklinePrice.toFixed(2)}</span>
            )}
            {topPatternHit.patternTargetPrice != null && (
              <span className="text-rose-300">
                ↓ {topPatternHit.patternTargetPrice.toFixed(2)}（{((topPatternHit.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}%）
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/80 leading-snug mt-0.5">{topPatternHit.detail}</p>
        </div>
      )}

      {/* 戒律：訊號分頁不顯示，verdict 已表達且詳情在「條件」分頁 */}

      {/* 警示訊號（非進出場，但需注意）*/}
      {warnSigs.length > 0 && (
        <ReasonGroup
          title="警示"
          color="text-yellow-300"
          bgColor="bg-yellow-900/15"
          signals={warnSigs.slice(0, 3)}
        />
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
      <p className={`text-[10px] font-bold mb-1 ${color}`}>{title}</p>
      <div className="space-y-1">
        {signals.map((s, i) => {
          const override = SIGNAL_EXPLAIN[s.label];
          // 優先級：手寫白話覆寫 > 訊號 description（含書本意圖）+ reason 第一行
          const mainText = override ?? s.description ?? '';
          const bookRef = override ? undefined : extractBookRef(s.reason);
          const operationHint = override ? undefined : extractOperationHint(s.reason);
          return (
            <div key={i} className={`rounded px-2 py-1.5 ${bgColor}`}>
              <div className="flex items-start gap-1.5">
                <span className={`text-[10px] font-bold shrink-0 ${color}`}>· {s.label}</span>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <p className="text-[10px] text-foreground/85 leading-snug">{mainText}</p>
                  {operationHint && (
                    <p className="text-[10px] text-foreground/60 leading-snug">{operationHint}</p>
                  )}
                  {bookRef && (
                    <p className="text-[9px] text-muted-foreground/70 leading-snug">{bookRef}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
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
