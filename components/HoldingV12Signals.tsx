'use client';

/**
 * 持倉 v12 Step 3-5 訊號顯示元件
 *
 * 為單一持倉股票呼叫 /api/portfolio/v12-signals，顯示：
 * - Step 3 停損：當前 SL 價 + 距離
 * - Step 4 操作：對應均線 + K 線/MA 出場訊號 + 升級長線按鈕
 * - Step 5 停利：獲利目標進度 + K 棒反轉訊號
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePortfolioStore } from '@/store/portfolioStore';
import { PROFIT_TARGET_RULE_PCT, PROFIT_HIGH_TIER_PCT } from '@/lib/analysis/bookThresholds';
import { sopFor } from '@/lib/portfolio/letterSOP';
import { holdingVerdict, type VerdictLevel } from '@/lib/portfolio/holdingVerdict';

interface Props {
  holdingId: string;
  symbol: string;
  market: 'TW' | 'CN';
  entryPrice: number;
  buyDate: string;
  triggerSignal?: string;
  operationMode?: 'short' | 'long';
  enhancedDisciplineEnabled?: boolean;
  endPhaseTriggered?: boolean;
  recentHigh?: number;
  /** C 訊號盤整下緣（用於絕對停損 ⑥-1 跌破盤整區） */
  consolidationLow?: number;
  /** F 訊號 V 底（用於絕對停損 ⑥-5 跌破 V 底） */
  vBottom?: number;
  /** 進場時凍結的型態目標價（議題 C2）— 缺值時 backend fallback 即時計算 */
  patternTargetPrice?: number;
  /** 0513 M10：N 訊號型態結構失效價（頸線 × 0.97），用於 supportLevel + 絕對停損 */
  patternStopPrice?: number;
}

interface SellSignalRow {
  type: string;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

interface V12SignalsResponse {
  ok: boolean;
  symbol: string;
  letter: string;
  todayPrice: number;
  profitPct: number;
  profitAmount: number;
  trendState: string;
  step3: {
    stopLossPrice: number;
    method: string;
    primaryMethod?: string;
    absoluteFloor: number;
    klineStop: number;
    trailingActivated?: boolean;
    slDistancePct: number;
    trailingMA?: 'MA3' | 'MA5' | 'MA10' | 'MA20' | null;
    fixedPct?: number;
    absoluteStopLoss?: { triggered: boolean; reason?: string; detail?: string };
  };
  step4: {
    operatingMA: string;
    operatingMAValue: number | null;
    klineExit: { shouldExit: boolean; reason?: string };
    maExit: { shouldExit: boolean; reason?: string };
    canUpgradeToLong: boolean;
    upgradeProfitPct: number;
    highDeviationOverride?: boolean;
  };
  step5: {
    takeProfit: {
      triggered: boolean;
      reason?: string;
      enhancedDisciplineEnabled?: boolean;
      modeRecommendation?: string | null;
      detail?: string;
    };
    kbarSignal: { triggered: boolean; signalType?: string; detail?: string };
    /** 議題 C1：書本 9+ 條出場訊號完整清單（detectSellSignals）*/
    triggeredSellSignals?: SellSignalRow[];
  };
  error?: string;
}

const STAGE_TINT: Record<string, string> = {
  good: 'bg-emerald-900/30 border-emerald-700/50',
  warn: 'bg-amber-900/30 border-amber-700/50',
  bad: 'bg-rose-900/40 border-rose-700/60',
  neutral: 'bg-secondary/40 border-border/50',
};

/** 主停損方法 → 人話（2026-05-13 從技術代號改用戶可懂） */
function primaryMethodLabel(method: string): string {
  switch (method) {
    case 'red-k-low':     return '跌破進場紅K低點就出';
    case 'pivot-low':     return '跌破前波低點就出';
    case 'support-level': return '跌破型態結構就出';
    case 'ma10':          return '跌破 MA10 就出';
    default:              return method;
  }
}

// 持倉 verdict 邏輯 0513 ABCDE B1 抽到 lib/portfolio/holdingVerdict.ts
// 單一事實 + 100% pure function + 35 unit tests 覆蓋每條 path
// 改 verdict 邏輯只動 holdingVerdict.ts + 跑 jest，不會悄悄破壞 UI

const VERDICT_STYLE: Record<VerdictLevel, string> = {
  good: 'bg-emerald-900/40 text-emerald-200 border border-emerald-700/60',
  warn: 'bg-amber-900/40 text-amber-200 border border-amber-700/60',
  bad: 'bg-rose-900/50 text-rose-100 border border-rose-700/70',
};

export function HoldingV12Signals({ holdingId, symbol, market, entryPrice, buyDate, triggerSignal, operationMode, enhancedDisciplineEnabled, endPhaseTriggered, recentHigh, consolidationLow, vBottom, patternTargetPrice, patternStopPrice }: Props) {
  const [data, setData] = useState<V12SignalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const updateHolding = usePortfolioStore((s) => s.update);
  // 0513 audit C2/C3 fix：用 AbortController ref 取代 inFlightRef
  // 新 fetch 來時先 abort 舊的，避免「切 mode/重試」時舊 fetch 完成把畫面覆寫成舊資料
  const abortRef = useRef<AbortController | null>(null);

  const fetchSignals = useCallback(async () => {
    // 取消上一輪在飛的 fetch（switchMode / 強制重載 / useEffect dep 抖動時關鍵）
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    // 0513 教訓：用戶反映「持倉訊號永遠載入中」— 加 15s timeout 上限
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const params = new URLSearchParams({
        symbol,
        market,
        entryPrice: String(entryPrice),
        buyDate,
        operationMode: operationMode ?? 'short',
        ...(triggerSignal ? { triggerSignal } : {}),
        ...(endPhaseTriggered ? { endPhaseTriggered: 'true' } : {}),
        ...(recentHigh != null ? { recentHigh: String(recentHigh) } : {}),
        // 絕對停損 ⑥-1 / ⑥-5 必要參數 — 若 holding 沒儲存則 backend 跳過該檢查
        ...(consolidationLow != null ? { consolidationLow: String(consolidationLow) } : {}),
        ...(vBottom != null ? { vBottom: String(vBottom) } : {}),
        // 議題 C2：進場時凍結的型態目標價（避免每日重算跳動）
        ...(patternTargetPrice != null ? { patternTargetPrice: String(patternTargetPrice) } : {}),
        ...(patternStopPrice != null ? { patternStopPrice: String(patternStopPrice) } : {}),
      });
      const res = await fetch(`/api/portfolio/v12-signals?${params.toString()}`, { signal: controller.signal });
      const json = (await res.json()) as V12SignalsResponse;
      if (!json.ok) {
        // backend 失敗（常見：K 線檔在 cache miss 瞬間沒拿到）→ 通常按「重試」就 OK
        setError(`${json.error ?? '無法載入訊號'}（HTTP ${res.status}，按重試通常可解）`);
      } else {
        setData(json);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setError(`載入逾時（>15s）— 該股 K 線下載慢，按「重試」再試一次`);
      } else {
        setError(`載入失敗：${err instanceof Error ? err.message : String(err)}（按「重試」再試）`);
      }
    } finally {
      clearTimeout(timeoutId);
      // 只有當前 controller 還是 abortRef 時才 setLoading(false)
      // — 若已被新的 fetch abort，舊的 finally 不該污染 loading state
      if (abortRef.current === controller) {
        setLoading(false);
        abortRef.current = null;
      }
    }
    // 末升段 / 進階紀律 toggle 後要重新拉資料；C/F 訊號的 consolidationLow / vBottom
    // 影響絕對停損 → 變動時也要 refetch
  }, [symbol, market, entryPrice, buyDate, triggerSignal, operationMode, endPhaseTriggered, recentHigh, consolidationLow, vBottom, patternTargetPrice, patternStopPrice]);

  // 0513 fix：useEffect dep 不再含 data/loading 避免 state 抖動觸發；只在 expanded 變或 fetchSignals 變時 fire
  // fetchSignals useCallback 已含所有關鍵 props，props 變動時會自動重 fetch
  useEffect(() => {
    if (!expanded) return;
    fetchSignals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, fetchSignals]);

  const upgradeToLong = useCallback(() => {
    updateHolding(holdingId, { operationMode: 'long' });
    setData(null);  // Force re-fetch
    fetchSignals();
  }, [holdingId, updateHolding, fetchSignals]);

  const switchMode = useCallback(
    (mode: 'short' | 'long') => {
      // 對齊書本：升級長線需獲利 ≥ 10%（寶典 Part 11-2 短線守則 #6）
      if (mode === 'long' && data && data.profitPct < PROFIT_TARGET_RULE_PCT) {
        const ok = confirm(
          `書本：升級長線守則需獲利 ≥ ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}%（目前 ${(data.profitPct * 100).toFixed(2)}%）\n\n強制切換可能違反書本停利規則。確定要切？`,
        );
        if (!ok) return;
      }
      updateHolding(holdingId, { operationMode: mode });
      setData(null);
      fetchSignals();
    },
    [data, holdingId, updateHolding, fetchSignals],
  );

  // Determine summary tint
  const tint = (() => {
    if (!data) return STAGE_TINT.neutral;
    if (data.step5.takeProfit.triggered || data.step5.kbarSignal.triggered) return STAGE_TINT.bad; // exit signal
    if (data.step4.klineExit.shouldExit || data.step4.maExit.shouldExit) return STAGE_TINT.bad;
    if (data.profitPct >= PROFIT_TARGET_RULE_PCT) return STAGE_TINT.good;
    if (data.profitPct < 0) return STAGE_TINT.warn;
    return STAGE_TINT.neutral;
  })();

  return (
    <div className={`mt-1 border-l-2 ${tint} text-[10px]`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 flex items-center justify-between hover:bg-muted/30"
        title="點擊展開停損/操作/停利訊號"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-medium">持倉訊號</span>
          {data && (
            <span className="text-[9px] opacity-75">
              {data.letter} {sopFor(data.letter).name}・{operationMode === 'long' ? '長線' : '短線'}・損益 {data.profitPct >= 0 ? '+' : ''}{(data.profitPct * 100).toFixed(2)}%
            </span>
          )}
        </span>
        <span className="text-[10px]">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-1.5 space-y-1">
          {loading && (
            <div className="py-1 px-2 rounded bg-secondary/40 flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-[10px]">載入中…（最多 15 秒）</span>
              <button
                onClick={() => { setData(null); fetchSignals(); }}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted"
                title="如果一直載入不出來，點這個強制重新載入"
              >
                強制重載
              </button>
            </div>
          )}
          {error && (
            <div className="py-1 px-2 rounded bg-rose-900/30 border border-rose-700/50 text-rose-300 text-[10px]">
              <div>{error}</div>
              <button
                onClick={() => { setError(null); setData(null); fetchSignals(); }}
                className="mt-1 px-2 py-0.5 rounded bg-rose-700/60 hover:bg-rose-600/80 text-rose-100 font-bold text-[10px]"
              >
                重試
              </button>
            </div>
          )}
          {data && (
            <>
              {/* 結論：把散在 Step 3/4/5 的判斷壓成一行（最重要的資訊放最上面） */}
              {(() => {
                const v = holdingVerdict(data);
                return (
                  <div className={`px-2 py-1.5 rounded ${VERDICT_STYLE[v.level]}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] font-bold">{v.label}</span>
                      <span className="text-[10px] opacity-90">{v.reason}</span>
                    </div>
                  </div>
                );
              })()}

              {/* 進場依據 — 書本「為何進這支」對齊 */}
              <div className="text-[10px] px-1 py-1 bg-secondary/40 rounded border-l-2 border-sky-700/50">
                <span className="text-muted-foreground">進場依據：</span>
                <span className="font-bold text-sky-300">{data.letter} {sopFor(data.letter).name}</span>
                <span className="text-muted-foreground"> · 買入 {buyDate}@</span>
                <span className="font-mono">{entryPrice.toFixed(2)}</span>
              </div>

              {/* 停損守線 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-rose-300/90">停損守線</span>
                  <span className="font-mono text-rose-300">
                    {data.step3.stopLossPrice.toFixed(2)}
                    <span className="text-[9px] opacity-70 ml-1">(-{data.step3.slDistancePct.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="text-[10px] text-foreground/80 mt-0.5">
                  跌破 <span className="font-mono font-bold">{data.step3.stopLossPrice.toFixed(2)}</span> 就出場
                  {data.step3.primaryMethod && ` — ${primaryMethodLabel(data.step3.primaryMethod)}`}
                </div>
                {data.step3.absoluteStopLoss?.triggered && (
                  <div className="mt-1 px-1 py-0.5 rounded bg-red-900/60 text-red-200 font-bold text-[10px]">
                    強制出場：{data.step3.absoluteStopLoss.detail}
                  </div>
                )}
                <details className="text-[9px] text-muted-foreground mt-1 cursor-pointer">
                  <summary className="hover:text-foreground/70 select-none">進階細節</summary>
                  <div className="mt-0.5 pl-2 space-y-0.5">
                    {data.step3.trailingMA && <div>跟隨均線：{data.step3.trailingMA}</div>}
                    {data.step3.fixedPct != null && <div>停損上限：{(data.step3.fixedPct * 100).toFixed(0)}%</div>}
                    <div>{data.step3.method}</div>
                    <div>K 線三段式 {data.step3.klineStop.toFixed(2)} · 10% 絕對下限 {data.step3.absoluteFloor.toFixed(2)}</div>
                    {data.step3.trailingActivated && <div className="text-rose-400 font-bold">末升段 trailing 啟用</div>}
                  </div>
                </details>
              </div>

              {/* 操作均線 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sky-300/90">操作均線</span>
                  <span className="text-sky-300 font-mono">
                    {data.step4.operatingMA}
                    {data.step4.operatingMAValue != null && (
                      <span className="text-[9px] opacity-70 ml-1">@{data.step4.operatingMAValue.toFixed(2)}</span>
                    )}
                  </span>
                </div>
                <div className="text-[10px] text-foreground/80 mt-0.5">
                  跟 <span className="font-bold">{data.step4.operatingMA}</span> 走，跌破就出場
                </div>
                {data.step4.highDeviationOverride && (
                  <div className="mt-0.5 text-[9px] text-amber-300 bg-amber-900/30 px-1 py-0.5 rounded">
                    乖離 ≥15% — 自動切 MA5 跟隨（書本進階紀律 ②）
                  </div>
                )}
                {data.step4.klineExit.shouldExit && (
                  <div className="text-rose-300 mt-0.5">{data.step4.klineExit.reason}</div>
                )}
                {data.step4.maExit.shouldExit && (
                  <div className="text-rose-300 mt-0.5">{data.step4.maExit.reason}</div>
                )}
                {!data.step4.klineExit.shouldExit && !data.step4.maExit.shouldExit && (
                  <div className="text-emerald-300/70 text-[9px] mt-0.5">續抱（未跌破均線/前低）</div>
                )}
                {/* 升級長線按鈕（mobile flex-wrap + 24px tap target）*/}
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  <span className="text-[9px] text-muted-foreground">操作模式：</span>
                  {/* M7：拿掉 wave（書本沒明寫，UI 留著只是 fall-through 跟 short 一樣，誤導用戶）*/}
                  {(['short', 'long'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => switchMode(m)}
                      className={`text-[9px] sm:text-[10px] px-2 py-0.5 rounded min-h-[24px] ${
                        (operationMode ?? 'short') === m
                          ? 'bg-sky-700 text-sky-100'
                          : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {m === 'short' ? '短線' : '長線'}
                    </button>
                  ))}
                  {data.step4.canUpgradeToLong && operationMode !== 'long' && (
                    <button
                      onClick={upgradeToLong}
                      className="ml-auto text-[9px] sm:text-[10px] px-2 py-0.5 rounded min-h-[24px] bg-emerald-800 text-emerald-100 hover:bg-emerald-700 font-bold"
                      title="獲利 ≥ 10%，可手動升級長線"
                    >
                      升級長線
                    </button>
                  )}
                </div>
              </div>

              {/* 停利目標 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-300/90">停利目標</span>
                  <span className="text-[9px] text-muted-foreground">
                    {data.profitPct >= PROFIT_HIGH_TIER_PCT ? '已達高檔' : data.profitPct >= PROFIT_TARGET_RULE_PCT ? `已達 ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}%` : data.profitPct >= 0 ? '輕微獲利' : '虧損中'}
                  </span>
                </div>
                {enhancedDisciplineEnabled && sopFor(data.letter).enhancedDiscipline && (
                  <div className="text-emerald-300 mt-0.5 text-[9px] bg-emerald-900/30 px-1 py-0.5 rounded">
                    進階紀律已啟用：&lt;10% 跌破 MA5 續抱、≥10% 才停利（寶典 #5/#6）
                  </div>
                )}
                {endPhaseTriggered && (
                  <div className="text-rose-300 mt-0.5 text-[9px] bg-rose-900/30 px-1 py-0.5 rounded">
                    末升段觸發（≥100% 起漲）— 切 trailing 3% (recentHigh × 0.97
                    {recentHigh != null ? ` = ${(recentHigh * 0.97).toFixed(2)}` : ''})
                  </div>
                )}
                {data.step5.takeProfit.detail && (
                  <div className={`mt-0.5 ${data.step5.takeProfit.triggered ? 'text-rose-300 font-bold' : 'text-amber-300'}`}>
                    {data.step5.takeProfit.detail}
                  </div>
                )}
                {data.step5.kbarSignal.triggered && (
                  <div className="text-rose-300 mt-0.5 font-bold">
                    K 棒訊號：{data.step5.kbarSignal.detail}
                  </div>
                )}
                {!data.step5.takeProfit.triggered && !data.step5.kbarSignal.triggered && data.profitPct < 0.10 && (
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    書本：{sopFor(data.letter).takeProfitHint}
                  </div>
                )}
                {/* H2：N 字母守目標價但缺 entryPattern → 用 10% 紀律 fallback，提示用戶 */}
                {data.letter === 'N' && patternTargetPrice == null && (
                  <div className="mt-0.5 text-[9px] text-amber-300/90 bg-amber-900/20 px-1 py-0.5 rounded">
                    ⚠ 此持倉缺進場型態快照（舊資料），停利目標暫用 10% 紀律 fallback。
                    重新從鎖股名單進場可凍結型態目標價。
                  </div>
                )}

                {/* 書本出場訊號清單 — 跟訊號分頁共用 detectSellSignals */}
                {data.step5.triggeredSellSignals && data.step5.triggeredSellSignals.length > 0 && (
                  <div className="mt-1 pt-1 border-t border-border/40 space-y-0.5">
                    <div className="text-[9px] text-rose-300/80 font-semibold">
                      書本出場訊號觸發 ({data.step5.triggeredSellSignals.length})
                    </div>
                    {data.step5.triggeredSellSignals.map((s, i) => (
                      <div
                        key={`${s.type}-${i}`}
                        className={`text-[10px] px-1 py-0.5 rounded ${
                          s.severity === 'high'
                            ? 'bg-rose-900/50 text-rose-200'
                            : s.severity === 'medium'
                              ? 'bg-amber-900/40 text-amber-200'
                              : 'bg-secondary/50 text-muted-foreground'
                        }`}
                        title={s.detail}
                      >
                        <span className="font-bold mr-1">{s.label}</span>
                        <span className="opacity-80 font-normal">— {s.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* v12 紀律切換 buttons — 對齊書本：
                  進階紀律只有 B/P 適用 + 獲利 ≥ 10%；
                  末升段需「起漲 ≥ 100%」（書本議題 13），跟獲利 10% 不同概念 — 任何字母達 ≥100% 才給切換 */}
              {(sopFor(data.letter).enhancedDiscipline || data.profitPct >= 1.0) && (
                <div className="border-t border-border/40 pt-1 flex flex-wrap gap-1">
                  <span className="text-[9px] text-muted-foreground">手動切換：</span>
                  {sopFor(data.letter).enhancedDiscipline && (
                    <button
                      onClick={() => {
                        if (!enhancedDisciplineEnabled && data.profitPct < PROFIT_TARGET_RULE_PCT) {
                          alert(`書本：B/P 進階紀律須獲利 ≥ ${(PROFIT_TARGET_RULE_PCT * 100).toFixed(0)}% 後啟用（目前 ${(data.profitPct * 100).toFixed(2)}%）`);
                          return;
                        }
                        updateHolding(holdingId, { enhancedDisciplineEnabled: !enhancedDisciplineEnabled });
                      }}
                      className={`text-[9px] sm:text-[10px] px-2 py-0.5 rounded min-h-[24px] ${enhancedDisciplineEnabled ? 'bg-emerald-700 text-emerald-100' : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'}`}
                      title="B/P 寶典 #5/#6 進階紀律 — 達 10% 後可切換"
                    >
                      進階紀律 {enhancedDisciplineEnabled ? '✓' : '○'}
                    </button>
                  )}
                  {/* 末升段：書本議題 13 起漲 ≥100%，profitPct ≥ 1.0 才顯示 */}
                  {data.profitPct >= 1.0 && (
                    <button
                      onClick={() => updateHolding(holdingId, { endPhaseTriggered: !endPhaseTriggered, recentHigh: !endPhaseTriggered ? data.todayPrice : undefined })}
                      className={`text-[9px] sm:text-[10px] px-2 py-0.5 rounded min-h-[24px] ${endPhaseTriggered ? 'bg-rose-700 text-rose-100' : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'}`}
                      title="議題 13：起漲 ≥100% 後切 trailing 3%"
                    >
                      末升段 {endPhaseTriggered ? '✓' : '○'}
                    </button>
                  )}
                </div>
              )}

              {/* Refresh */}
              <button
                onClick={() => { setData(null); fetchSignals(); }}
                className="w-full text-[9px] text-muted-foreground hover:text-foreground py-0.5 mt-1 border-t border-border/40"
              >
                重新計算
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
