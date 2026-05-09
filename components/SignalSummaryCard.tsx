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
): Verdict {
  const counts: Record<SignalSubtype, number> = {
    entry_strong: 0, entry_soft: 0, exit_strong: 0, exit_soft: 0, trend: 0, warn: 0,
  };
  for (const s of subtypes) counts[s]++;

  if (hasPosition) {
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

  // 未持倉
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
  const candleCount = allCandles.length;
  const v12Market: 'TW' | 'CN' = useMemo(
    () => /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW',
    [ticker],
  );

  useEffect(() => {
    let cancelled = false;
    if (!ticker || candleCount < 30 || currentIndex < 25) {
      setV12Hits([]);
      setTopPatternHit(null);
      return;
    }
    try {
      const m = detectLetterM(allCandles, currentIndex, v12Market, ticker);
      const n = detectLetterN(allCandles, currentIndex, v12Market, ticker);
      const o = detectLetterO(allCandles, currentIndex, v12Market, ticker);
      const p = detectLetterP(allCandles, currentIndex, v12Market, ticker);
      const q = detectLetterQ(allCandles, currentIndex, v12Market, ticker);
      const top = detectTopPatterns(allCandles, currentIndex);
      if (cancelled) return;
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
    }
    return () => { cancelled = true; };
  }, [ticker, v12Market, allCandles, currentIndex, candleCount]);

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

  const verdict = getVerdict(hasPosition, subtypes, {
    entry: entrySigs.map(s => s.label),
    exit: exitSigs.map(s => s.label),
  });

  // ── 停損 / 停利 ─────────────────────────────────────────────────────────
  const entryPrice = heldPosition?.costPrice ?? candle.close;
  const tickSize = getTickSize(entryPrice, market);
  const klineStop = calcKLineStopLoss(candle, tickSize);
  const absoluteFloor = entryPrice * 0.90;
  const stopLoss = Math.max(klineStop, absoluteFloor);
  const slPct = ((stopLoss - candle.close) / candle.close) * 100;
  const profitTarget = entryPrice * 1.10;
  const ptPct = ((profitTarget - candle.close) / candle.close) * 100;

  // 主訊號字母（V12 進場字母優先順序 Q > N > M > P > O；無命中時用持倉觸發字母）
  const PRIORITY: EntryLetter[] = ['Q', 'N', 'M', 'P', 'O'];
  const primaryV12 = PRIORITY.map(l => v12Hits.find(h => h.letter === l)).find(Boolean);
  const primaryLetter: V12Letter = primaryV12?.letter
    ?? (heldPosition?.triggerSignal as V12Letter | undefined)
    ?? 'B';
  const operatingMA = getOperationMA(primaryLetter, 'short');

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

          {/* ── 1. 持倉狀態列 ───────────────────────────── */}
          <div className="flex items-center justify-between text-xs">
            <span className={`font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
              {hasPosition ? '持股中' : '未持倉'}
              {hasPosition && heldPosition && (
                <span className="ml-1.5 text-muted-foreground font-normal">
                  · {formatSharesAsLots(heldPosition.shares, market)}
                </span>
              )}
            </span>
            <span className="font-mono text-foreground/80">
              {candle.close.toFixed(2)}
              {heldPosition?.costPrice != null && (
                <>
                  <span className="text-muted-foreground"> · 成本 </span>
                  {heldPosition.costPrice.toFixed(2)}
                  {pnlPct != null && (
                    <span className={`ml-1 ${pnlPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                    </span>
                  )}
                </>
              )}
            </span>
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
          <Reasons
            v12Hits={v12Hits}
            topPatternHit={hasPosition ? topPatternHit : null}
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

      {/* 戒律觸發（黃框警示，書本：禁止進場） */}
      {prohibitions.length > 0 && (
        <div className="rounded border border-amber-700/40 bg-amber-900/15 px-2 py-1.5">
          <p className="text-[10px] font-bold text-amber-300 mb-0.5">戒律觸發 — 書本：禁止進場做多</p>
          <ul className="space-y-0.5">
            {prohibitions.slice(0, 4).map((r, i) => (
              <li key={i} className="text-[10px] text-amber-200 leading-snug">· {r}</li>
            ))}
          </ul>
        </div>
      )}

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
          const explain = SIGNAL_EXPLAIN[s.label] ?? firstReasonLine(s.reason) ?? s.description;
          return (
            <div key={i} className={`rounded px-2 py-1 ${bgColor}`}>
              <div className="flex items-start gap-1.5">
                <span className={`text-[10px] font-bold shrink-0 ${color}`}>· {s.label}</span>
                <span className="text-[10px] text-foreground/80 leading-snug flex-1">{explain}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function firstReasonLine(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const lines = reason.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('【'));
  return lines[0];
}
