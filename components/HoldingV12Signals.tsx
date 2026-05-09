'use client';

/**
 * 持倉 v12 Step 3-5 訊號顯示元件
 *
 * 為單一持倉股票呼叫 /api/portfolio/v12-signals，顯示：
 * - Step 3 停損：當前 SL 價 + 距離
 * - Step 4 操作：對應均線 + K 線/MA 出場訊號 + 升級長線按鈕
 * - Step 5 停利：獲利目標進度 + K 棒反轉訊號
 */

import { useEffect, useState, useCallback } from 'react';
import { usePortfolioStore } from '@/store/portfolioStore';

interface Props {
  holdingId: string;
  symbol: string;
  market: 'TW' | 'CN';
  entryPrice: number;
  buyDate: string;
  triggerSignal?: string;
  operationMode?: 'short' | 'long' | 'wave';
  enhancedDisciplineEnabled?: boolean;
  endPhaseTriggered?: boolean;
  recentHigh?: number;
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
    absoluteFloor: number;
    klineStop: number;
    slDistancePct: number;
  };
  step4: {
    operatingMA: string;
    operatingMAValue: number | null;
    klineExit: { shouldExit: boolean; reason?: string };
    maExit: { shouldExit: boolean; reason?: string };
    canUpgradeToLong: boolean;
    upgradeProfitPct: number;
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
  };
  error?: string;
}

const STAGE_TINT: Record<string, string> = {
  good: 'bg-emerald-900/30 border-emerald-700/50',
  warn: 'bg-amber-900/30 border-amber-700/50',
  bad: 'bg-rose-900/40 border-rose-700/60',
  neutral: 'bg-secondary/40 border-border/50',
};

export function HoldingV12Signals({ holdingId, symbol, market, entryPrice, buyDate, triggerSignal, operationMode, enhancedDisciplineEnabled, endPhaseTriggered, recentHigh }: Props) {
  const [data, setData] = useState<V12SignalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const updateHolding = usePortfolioStore((s) => s.update);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        symbol,
        market,
        entryPrice: String(entryPrice),
        buyDate,
        operationMode: operationMode ?? 'short',
        ...(triggerSignal ? { triggerSignal } : {}),
      });
      const res = await fetch(`/api/portfolio/v12-signals?${params.toString()}`);
      const json = (await res.json()) as V12SignalsResponse;
      if (!json.ok) {
        setError(json.error ?? 'load failed');
      } else {
        setData(json);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol, market, entryPrice, buyDate, triggerSignal, operationMode]);

  useEffect(() => {
    if (expanded && !data && !loading) fetchSignals();
  }, [expanded, data, loading, fetchSignals]);

  const upgradeToLong = useCallback(() => {
    updateHolding(holdingId, { operationMode: 'long' });
    setData(null);  // Force re-fetch
    fetchSignals();
  }, [holdingId, updateHolding, fetchSignals]);

  const switchMode = useCallback(
    (mode: 'short' | 'long' | 'wave') => {
      updateHolding(holdingId, { operationMode: mode });
      setData(null);
      fetchSignals();
    },
    [holdingId, updateHolding, fetchSignals],
  );

  // Determine summary tint
  const tint = (() => {
    if (!data) return STAGE_TINT.neutral;
    if (data.step5.takeProfit.triggered || data.step5.kbarSignal.triggered) return STAGE_TINT.bad; // exit signal
    if (data.step4.klineExit.shouldExit || data.step4.maExit.shouldExit) return STAGE_TINT.bad;
    if (data.profitPct >= 0.10) return STAGE_TINT.good;
    if (data.profitPct < 0) return STAGE_TINT.warn;
    return STAGE_TINT.neutral;
  })();

  return (
    <div className={`mt-1 border-l-2 ${tint} text-[10px]`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 flex items-center justify-between hover:bg-muted/30"
        title="點擊展開 v12 Step 3-5 停損/操作/停利訊號"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-bold uppercase tracking-wider opacity-70 text-[8px]">v12</span>
          <span className="font-medium">Step 3-5 訊號</span>
          {data && (
            <span className="text-[9px] opacity-75">
              {data.letter}・{operationMode === 'long' ? '長線' : operationMode === 'wave' ? '波段' : '短線'}・損益 {data.profitPct >= 0 ? '+' : ''}{(data.profitPct * 100).toFixed(2)}%
            </span>
          )}
        </span>
        <span className="text-[10px]">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-1.5 space-y-1">
          {loading && <div className="text-muted-foreground py-1">載入中…</div>}
          {error && <div className="text-rose-400 py-1">⚠️ {error}</div>}
          {data && (
            <>
              {/* Step 3 停損 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-rose-300/90">📉 Step 3 停損</span>
                  <span className="font-mono text-rose-300">
                    {data.step3.stopLossPrice.toFixed(2)}
                    <span className="text-[9px] opacity-70 ml-1">(-{data.step3.slDistancePct.toFixed(1)}%)</span>
                  </span>
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">
                  K 線三段式 {data.step3.klineStop.toFixed(2)} · 10% 絕對下限 {data.step3.absoluteFloor.toFixed(2)}
                </div>
              </div>

              {/* Step 4 操作 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sky-300/90">🎯 Step 4 操作</span>
                  <span className="text-sky-300 font-mono">
                    {data.step4.operatingMA}
                    {data.step4.operatingMAValue != null && (
                      <span className="text-[9px] opacity-70 ml-1">@{data.step4.operatingMAValue.toFixed(2)}</span>
                    )}
                  </span>
                </div>
                {/* 智慧 K 線 */}
                {data.step4.klineExit.shouldExit && (
                  <div className="text-rose-300 mt-0.5">
                    ⚠️ {data.step4.klineExit.reason}
                  </div>
                )}
                {/* MA 出場 */}
                {data.step4.maExit.shouldExit && (
                  <div className="text-rose-300 mt-0.5">
                    ⚠️ {data.step4.maExit.reason}
                  </div>
                )}
                {!data.step4.klineExit.shouldExit && !data.step4.maExit.shouldExit && (
                  <div className="text-emerald-300/70 text-[9px] mt-0.5">✓ 續抱（未跌破均線/前低）</div>
                )}
                {/* 升級長線按鈕 */}
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-[9px] text-muted-foreground">操作模式：</span>
                  {(['short', 'long', 'wave'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => switchMode(m)}
                      className={`text-[9px] px-1.5 py-px rounded ${
                        (operationMode ?? 'short') === m
                          ? 'bg-sky-700 text-sky-100'
                          : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'
                      }`}
                    >
                      {m === 'short' ? '短線' : m === 'long' ? '長線' : '波段'}
                    </button>
                  ))}
                  {data.step4.canUpgradeToLong && operationMode !== 'long' && (
                    <button
                      onClick={upgradeToLong}
                      className="ml-auto text-[9px] px-1.5 py-px rounded bg-emerald-800 text-emerald-100 hover:bg-emerald-700 font-bold"
                      title="獲利 ≥ 10%，可手動升級長線"
                    >
                      ⬆ 升級長線
                    </button>
                  )}
                </div>
              </div>

              {/* Step 5 停利 */}
              <div className="border-t border-border/40 pt-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-300/90">💰 Step 5 停利</span>
                  <span className="text-[9px] text-muted-foreground">
                    {data.profitPct >= 0.20 ? '高檔' : data.profitPct >= 0.10 ? '達 10%' : data.profitPct >= 0 ? '輕微獲利' : '虧損中'}
                  </span>
                </div>
                {/* v12 議題 B 寶典 #5/#6 進階紀律 */}
                {enhancedDisciplineEnabled && (data.letter === 'B' || data.letter === 'P') && (
                  <div className="text-emerald-300 mt-0.5 text-[9px] bg-emerald-900/30 px-1 py-0.5 rounded">
                    🛡️ 寶典 #5/#6 進階紀律已啟用：&lt;10% 跌破 MA5 續抱、≥10% 才停利
                  </div>
                )}
                {/* v12 議題 13 末升段 trailing */}
                {endPhaseTriggered && (
                  <div className="text-rose-300 mt-0.5 text-[9px] bg-rose-900/30 px-1 py-0.5 rounded">
                    📛 末升段觸發（≥100% 起漲）— 切 trailing 3% (recentHigh × 0.97
                    {recentHigh != null ? ` = ${(recentHigh * 0.97).toFixed(2)}` : ''})
                  </div>
                )}
                {data.step5.takeProfit.detail && (
                  <div className={`mt-0.5 ${data.step5.takeProfit.triggered ? 'text-rose-300' : 'text-amber-300'}`}>
                    {data.step5.takeProfit.triggered ? '🚪' : 'ℹ️'} {data.step5.takeProfit.detail}
                  </div>
                )}
                {data.step5.kbarSignal.triggered && (
                  <div className="text-rose-300 mt-0.5">
                    🚪 K 棒訊號：{data.step5.kbarSignal.detail}
                  </div>
                )}
                {!data.step5.takeProfit.triggered && !data.step5.kbarSignal.triggered && data.profitPct < 0.10 && (
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    目標：獲利 ≥ 10% 啟用進階紀律 / 乖離 ≥ 15% 切 MA5
                  </div>
                )}
              </div>

              {/* v12 紀律切換 buttons */}
              <div className="border-t border-border/40 pt-1 flex flex-wrap gap-1">
                <span className="text-[9px] text-muted-foreground">手動切換：</span>
                <button
                  onClick={() => updateHolding(holdingId, { enhancedDisciplineEnabled: !enhancedDisciplineEnabled })}
                  className={`text-[9px] px-1.5 py-px rounded ${enhancedDisciplineEnabled ? 'bg-emerald-700 text-emerald-100' : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'}`}
                  title="B/P 寶典 #5/#6 進階紀律 — 達 10% 後切換"
                >
                  進階紀律 {enhancedDisciplineEnabled ? '✓' : '○'}
                </button>
                <button
                  onClick={() => updateHolding(holdingId, { endPhaseTriggered: !endPhaseTriggered, recentHigh: !endPhaseTriggered ? data.todayPrice : undefined })}
                  className={`text-[9px] px-1.5 py-px rounded ${endPhaseTriggered ? 'bg-rose-700 text-rose-100' : 'bg-secondary border border-border text-muted-foreground hover:bg-muted'}`}
                  title="議題 13：起漲 ≥100% 後切 trailing 3%"
                >
                  末升段 {endPhaseTriggered ? '✓' : '○'}
                </button>
              </div>

              {/* Refresh */}
              <button
                onClick={() => { setData(null); fetchSignals(); }}
                className="w-full text-[9px] text-muted-foreground hover:text-foreground py-0.5 mt-1 border-t border-border/40"
              >
                🔄 重新計算
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
