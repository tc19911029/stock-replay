'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useDaytradeStore } from '@/store/daytradeStore';
import type { IntradayTimeframe, IntradaySignal } from '@/lib/daytrade/types';
import { PositionCalculator, TradeJournal } from '@/features/daytrade';

// ═══════════════════════════════════════════════════════════════════════════════
// Stock List (same as main page StockSelector)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_QUICK_STOCKS = [
  { symbol: '2330', name: '台積電' }, { symbol: '2317', name: '鴻海' },
  { symbol: '2454', name: '聯發科' }, { symbol: '2308', name: '台達電' },
  { symbol: '6770', name: '力積電' }, { symbol: '3008', name: '大立光' },
  { symbol: '2382', name: '廣達' },   { symbol: '2881', name: '富邦金' },
  { symbol: '2882', name: '國泰金' }, { symbol: '2412', name: '中華電' },
  { symbol: '2357', name: '華碩' },   { symbol: '2303', name: '聯電' },
  { symbol: '2886', name: '兆豐金' }, { symbol: '2891', name: '中信金' },
  { symbol: '2884', name: '玉山金' }, { symbol: '3034', name: '聯詠' },
  { symbol: '2345', name: '智邦' },   { symbol: '2618', name: '長榮航' },
  { symbol: '2609', name: '陽明' },   { symbol: '2615', name: '萬海' },
  { symbol: '2603', name: '長榮' },   { symbol: '3443', name: '創意' },
  { symbol: '6669', name: '緯穎' },   { symbol: '3037', name: '欣興' },
  { symbol: '2002', name: '中鋼' },   { symbol: '1301', name: '台塑' },
];

// 從 localStorage 讀取用戶自訂的快選股票
function loadCustomStocks(): typeof DEFAULT_QUICK_STOCKS {
  if (typeof window === 'undefined') return DEFAULT_QUICK_STOCKS;
  try {
    const saved = localStorage.getItem('daytrade_quick_stocks');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_QUICK_STOCKS;
}

function saveCustomStocks(stocks: typeof DEFAULT_QUICK_STOCKS) {
  try { localStorage.setItem('daytrade_quick_stocks', JSON.stringify(stocks)); } catch {}
}

const STOCK_NAME_MAP = new Map(DEFAULT_QUICK_STOCKS.map(s => [s.symbol, s.name]));

// ═══════════════════════════════════════════════════════════════════════════════
// Side Tabs
// ═══════════════════════════════════════════════════════════════════════════════

const SIDE_TABS = [
  { key: 'mtf',      label: '多週期' },
  { key: 'trade',    label: '交易/帳戶' },
  { key: 'signals',  label: '訊號' },
  { key: 'validate', label: '驗證' },
  { key: 'eod',      label: '結算' },
  { key: 'sigbt',    label: '訊號回測' },
  { key: 'optim',    label: '策略優化' },
  { key: 'posjnl',  label: '倉位/日誌' },
] as const;

type SideTabKey = typeof SIDE_TABS[number]['key'];

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-TF Panel
// ═══════════════════════════════════════════════════════════════════════════════

function MultiTFPanel() {
  const { mtfState } = useDaytradeStore();
  if (!mtfState) return <div className="text-xs text-slate-600 p-4 text-center">載入數據後顯示</div>;

  const tfs: IntradayTimeframe[] = ['60m', '15m', '5m', '1m'];
  const labels: Record<string, string> = { '60m': '大方向', '15m': '結構強弱', '5m': '進出節奏', '1m': '確認時機' };
  const biasColor = mtfState.overallBias === 'bullish' ? 'text-red-400 bg-red-900/40' :
                    mtfState.overallBias === 'bearish' ? 'text-green-400 bg-green-900/40' :
                    'text-yellow-400 bg-yellow-900/40';
  const biasLabel = mtfState.overallBias === 'bullish' ? '偏多' : mtfState.overallBias === 'bearish' ? '偏空' : '中性';

  return (
    <div className="space-y-3 p-1">
      {/* Overall */}
      <div className={`text-center py-2 rounded-lg border ${biasColor} border-current/20`}>
        <div className="text-lg font-black">{biasLabel}</div>
        <div className="text-xs opacity-70">共振分 {mtfState.confluenceScore}</div>
      </div>

      {/* Per timeframe */}
      {tfs.map(tf => {
        const s = mtfState.timeframes[tf];
        const icon = s.trend === 'bullish' ? '🟢' : s.trend === 'bearish' ? '🔴' : '🟡';
        const trendLabel = s.trend === 'bullish' ? '多頭' : s.trend === 'bearish' ? '空頭' : '盤整';
        const maLabel = s.maAlignment === 'bullish' ? 'MA多排' : s.maAlignment === 'bearish' ? 'MA空排' : 'MA混合';
        const vwapLabel = s.vwapRelation === 'above' ? 'VWAP上' : s.vwapRelation === 'below' ? 'VWAP下' : 'VWAP附近';
        return (
          <div key={tf} className="bg-slate-800/50 rounded-lg p-2.5 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-bold text-white">{tf}</span>
              <span>{icon}</span>
              <span className={s.trend === 'bullish' ? 'text-red-400' : s.trend === 'bearish' ? 'text-green-400' : 'text-yellow-400'}>
                {trendLabel}
              </span>
              <span className="ml-auto text-slate-500 text-[10px]">{labels[tf]}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                <div className={`h-full rounded-full transition-all ${
                  s.trend === 'bullish' ? 'bg-red-500' : s.trend === 'bearish' ? 'bg-green-500' : 'bg-yellow-500'
                }`} style={{ width: `${s.trendStrength}%` }} />
              </div>
              <span className="text-[10px] text-slate-500 w-6 text-right">{s.trendStrength}</span>
            </div>
            <div className="flex gap-2 text-[10px] text-slate-500">
              <span>{maLabel}</span>
              <span>{vwapLabel}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Trade & Account Panel
// ═══════════════════════════════════════════════════════════════════════════════

function TradeAccountPanel() {
  const { session, position, latestPrice, paperBuy, paperSell, closeAll } = useDaytradeStore();
  const [shares, setShares] = useState(1000);

  return (
    <div className="space-y-3 p-1">
      {/* Account overview */}
      {session && (
        <div className="bg-slate-800/50 rounded-lg p-3 space-y-2">
          <div className="text-xs font-bold text-white">帳戶總覽</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-slate-500">本金</span> <span className="text-white">{(session.initialCapital/10000).toFixed(0)}萬</span></div>
            <div><span className="text-slate-500">現金</span> <span className="text-white">{(session.currentCapital/10000).toFixed(1)}萬</span></div>
            <div><span className="text-slate-500">已實現</span>
              <span className={session.realizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                {session.realizedPnL >= 0 ? '+' : ''}{session.realizedPnL.toLocaleString()}
              </span>
            </div>
            <div><span className="text-slate-500">報酬</span>
              <span className={session.returnPct >= 0 ? 'text-red-400' : 'text-green-400'}>
                {session.returnPct >= 0 ? '+' : ''}{session.returnPct.toFixed(2)}%
              </span>
            </div>
            <div><span className="text-slate-500">勝/負</span> <span className="text-white">{session.winCount}/{session.lossCount}</span></div>
            <div><span className="text-slate-500">最大回撤</span> <span className="text-orange-400">{session.maxDrawdown.toFixed(2)}%</span></div>
          </div>
        </div>
      )}

      {/* Position */}
      {position && (
        <div className={`rounded-lg p-3 border ${position.unrealizedPnL >= 0 ? 'bg-red-950/20 border-red-800/40' : 'bg-green-950/20 border-green-800/40'}`}>
          <div className="text-xs font-bold text-white mb-1">持倉</div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            <div><span className="text-slate-500">股數</span> <span className="text-white font-bold">{position.shares}</span></div>
            <div><span className="text-slate-500">均價</span> <span className="text-yellow-400 font-bold">{position.avgCost.toFixed(2)}</span></div>
            <div><span className="text-slate-500">現價</span> <span className="text-white">{latestPrice.toFixed(2)}</span></div>
            <div><span className="text-slate-500">損益</span>
              <span className={`font-bold ${position.unrealizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                {position.unrealizedPnL >= 0 ? '+' : ''}{position.unrealizedPnL.toLocaleString()}
                ({position.unrealizedPnLPct >= 0 ? '+' : ''}{position.unrealizedPnLPct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Trade buttons */}
      <div className="bg-slate-800/50 rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input type="number" className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white w-20 focus:border-sky-500 outline-none"
            value={shares} onChange={e => setShares(Number(e.target.value))} min={1} />
          <span className="text-xs text-slate-500">股</span>
        </div>
        <div className="text-center text-[10px] text-slate-400 mb-1">
          成交價: <span className="text-white font-bold">{latestPrice.toFixed(2)}</span>
          <span className="text-slate-600 ml-1">× {shares} = {(latestPrice * shares).toLocaleString()}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => paperBuy(shares)} className="flex-1 bg-red-700 hover:bg-red-600 text-white text-sm py-2 rounded font-bold">◀ 買進 {latestPrice.toFixed(0)}</button>
          <button onClick={() => paperSell(shares)} className="flex-1 bg-green-700 hover:bg-green-600 text-white text-sm py-2 rounded font-bold">賣出 {latestPrice.toFixed(0)} ▶</button>
        </div>
        <button onClick={closeAll} className="w-full bg-slate-700 hover:bg-slate-600 text-white text-xs py-1.5 rounded">全部平倉</button>
      </div>

      {/* Trade history */}
      {session && session.trades.length > 0 && (
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-[10px] font-bold text-white mb-1">交易紀錄 ({session.trades.length})</div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {[...session.trades].reverse().map(t => (
              <div key={t.id} className="flex items-center gap-1.5 text-[10px] py-0.5 border-b border-slate-800/50">
                <span className={`font-bold ${t.action === 'BUY' ? 'text-red-400' : 'text-green-400'}`}>
                  {t.action === 'BUY' ? '買' : '賣'}
                </span>
                <span className="text-white">{t.price.toFixed(2)}</span>
                <span className="text-slate-500">×{t.shares}</span>
                <span className="ml-auto text-slate-600">{t.timestamp.split('T')[1]?.slice(0,5)}</span>
                {t.realizedPnL != null && (
                  <span className={t.realizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                    {t.realizedPnL >= 0 ? '+' : ''}{t.realizedPnL.toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Signal Panel
// ═══════════════════════════════════════════════════════════════════════════════

function SignalListPanel() {
  const { currentSignals, signalThreshold, setSignalThreshold } = useDaytradeStore();
  const filtered = currentSignals.filter(s => s.score >= signalThreshold);
  const recent = [...filtered].reverse().slice(0, 30);

  const typeColor: Record<string, string> = {
    BUY: 'border-l-red-500 bg-red-950/20', SELL: 'border-l-green-500 bg-green-950/20',
    ADD: 'border-l-orange-500 bg-orange-950/20', REDUCE: 'border-l-teal-500 bg-teal-950/20',
    STOP_LOSS: 'border-l-purple-500 bg-purple-950/20', RISK: 'border-l-yellow-500 bg-yellow-950/20',
    WATCH: 'border-l-slate-500 bg-slate-800/30',
  };

  return (
    <div className="space-y-1 p-1">
      <div className="flex items-center gap-2 px-1 mb-1">
        <span className="text-[10px] text-slate-500">共 {currentSignals.length} 個</span>
        <span className="text-[10px] text-slate-600">門檻:</span>
        {[0, 55, 65, 75].map(v => (
          <button key={v} onClick={() => setSignalThreshold(v)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${signalThreshold === v ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'}`}>
            {v === 0 ? '全部' : `≥${v}`}
          </button>
        ))}
        <span className="text-[10px] text-sky-400 ml-auto">{filtered.length} 筆</span>
      </div>
      {recent.length === 0 && <div className="text-xs text-slate-600 text-center py-8">無符合條件的訊號</div>}
      {recent.map(sig => (
        <div key={sig.id} className={`border-l-2 rounded-r-lg p-2 text-xs ${typeColor[sig.type] ?? typeColor.WATCH}`}>
          <div className="flex items-center gap-1.5">
            <span className={`font-black text-[10px] px-1 rounded ${
              sig.type === 'BUY' ? 'bg-red-700 text-white' :
              sig.type === 'SELL' ? 'bg-green-700 text-white' :
              'bg-slate-700 text-slate-300'
            }`}>{sig.type}</span>
            <span className="font-bold text-white">{sig.label}</span>
            <span className="text-slate-600 text-[10px]">{sig.timeframe}</span>
            <span className="ml-auto text-[10px] bg-slate-800 px-1 rounded">{sig.score}</span>
          </div>
          <div className="mt-1 text-slate-400 text-[11px]">{sig.reason}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-600 flex-wrap">
            <span>{sig.triggeredAt.split('T')[1]?.slice(0,5)} @ {sig.price.toFixed(2)}</span>
            {sig.metadata.stopLossPrice && (
              <span className="text-green-500">止損 {sig.metadata.stopLossPrice.toFixed(1)}</span>
            )}
            {sig.metadata.targetPrice && (
              <span className="text-red-400">目標 {sig.metadata.targetPrice.toFixed(1)}</span>
            )}
            {sig.metadata.riskRewardRatio != null && (
              <span className={`px-1 rounded ${sig.metadata.riskRewardRatio >= 1.5 ? 'bg-green-900/50 text-green-300' : sig.metadata.riskRewardRatio >= 1 ? 'bg-yellow-900/50 text-yellow-300' : 'bg-red-900/50 text-red-300'}`}>
                R:R {sig.metadata.riskRewardRatio.toFixed(1)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Validation Panel
// ═══════════════════════════════════════════════════════════════════════════════

function ValidationPanel() {
  const { validationStats, runValidation, allSignals } = useDaytradeStore();

  return (
    <div className="space-y-3 p-1">
      <button
        onClick={runValidation}
        disabled={allSignals.length === 0}
        className="w-full bg-violet-700 hover:bg-violet-600 disabled:bg-slate-800 text-white text-xs py-2 rounded font-medium"
      >
        📊 執行訊號驗證（{allSignals.length} 訊號）
      </button>

      {validationStats && validationStats.totalSignals > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <StatBox label="準確率" value={`${validationStats.accuracyRate}%`}
              color={validationStats.accuracyRate >= 55 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="總訊號" value={String(validationStats.totalSignals)} />
            <StatBox label="3根均報酬" value={`${validationStats.avgReturn3Bar.toFixed(2)}%`}
              color={validationStats.avgReturn3Bar >= 0 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="5根均報酬" value={`${validationStats.avgReturn5Bar.toFixed(2)}%`}
              color={validationStats.avgReturn5Bar >= 0 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="平均MFE" value={`+${validationStats.avgMFE}%`} color="text-red-400" />
            <StatBox label="平均MAE" value={`-${validationStats.avgMAE}%`} color="text-green-400" />
            {validationStats.profitFactor != null && (
              <StatBox label="Profit Factor" value={String(validationStats.profitFactor)}
                color={validationStats.profitFactor >= 1 ? 'text-red-400' : 'text-orange-400'} />
            )}
            {validationStats.medianReturn != null && (
              <StatBox label="中位數報酬" value={`${validationStats.medianReturn}%`}
                color={validationStats.medianReturn >= 0 ? 'text-red-400' : 'text-green-400'} />
            )}
          </div>
          <div className="space-y-1">
            <div className="text-[10px] text-slate-500">按類型</div>
            {Object.entries(validationStats.byType).map(([type, s]) => (
              <div key={type} className="flex items-center gap-2 text-[10px]">
                <span className="text-slate-400 w-12 font-bold">{type}</span>
                <span className="text-white w-5 text-right">{s.count}</span>
                <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                  <div className={`h-full rounded-full ${s.accuracyRate >= 50 ? 'bg-sky-500' : 'bg-orange-500'}`}
                    style={{ width: `${s.accuracyRate}%` }} />
                </div>
                <span className="text-slate-500 w-8 text-right">{s.accuracyRate}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StatBox({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-slate-800/50 rounded p-2">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Intraday Chart (Main K-line + Volume + KD + MACD)
// ═══════════════════════════════════════════════════════════════════════════════

function IntradayChartFull() {
  const mainRef = useRef<HTMLDivElement>(null);
  const kdRef   = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<any[]>([]);
  const { displayCandles, replayIndex, isReplaying, currentSignals, signalThreshold } = useDaytradeStore();

  useEffect(() => {
    if (!mainRef.current || displayCandles.length === 0) return;
    let cancelled = false;

    import('lightweight-charts').then(mod => {
      if (cancelled) return;
      const { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } = mod;

      // Cleanup
      chartsRef.current.forEach(c => { try { c.remove(); } catch {} });
      chartsRef.current = [];

      const visible = isReplaying ? displayCandles.slice(0, replayIndex + 1) : displayCandles;
      // 台灣時間 ISO string → Unix timestamp（lightweight-charts 用 UTC 渲染，所以直接用台灣時間當 UTC 傳入）
      const toTS = (t: string) => {
        // 把台灣時間當 UTC 解析，這樣圖表顯示的時間就是台灣時間
        const utcStr = t.endsWith('Z') ? t : t.split('+')[0] + 'Z';
        return Math.floor(new Date(utcStr).getTime() / 1000) as any;
      };

      const chartOpts = (el: HTMLElement, h: number) => createChart(el, {
        width: el.clientWidth, height: h,
        layout: { background: { color: '#0f172a' }, textColor: '#64748b', fontSize: 10 },
        grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
        crosshair: { mode: 0 },
        timeScale: { timeVisible: true, secondsVisible: false },
        rightPriceScale: { borderColor: '#1e293b' },
      });

      // ── Main chart ──
      const mainChart = chartOpts(mainRef.current!, mainRef.current!.clientHeight);
      chartsRef.current.push(mainChart);

      const candleSeries = mainChart.addSeries(CandlestickSeries, {
        upColor: '#ef4444', downColor: '#22c55e',
        borderUpColor: '#ef4444', borderDownColor: '#22c55e',
        wickUpColor: '#ef4444', wickDownColor: '#22c55e',
      });
      candleSeries.setData(visible.map(c => ({ time: toTS(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

      // Signal markers on chart using plugin
      const filteredSigs = currentSignals.filter(s => s.score >= signalThreshold && (s.type === 'BUY' || s.type === 'SELL' || s.type === 'ADD' || s.type === 'REDUCE'));
      const markers = filteredSigs
        .map(sig => {
          const idx = visible.findIndex(c => c.time === sig.triggeredAt);
          if (idx < 0) return null;
          const isBuy = sig.type === 'BUY' || sig.type === 'ADD';
          return {
            time: toTS(sig.triggeredAt),
            position: isBuy ? 'belowBar' as const : 'aboveBar' as const,
            color: isBuy ? '#ef4444' : '#22c55e',
            shape: isBuy ? 'arrowUp' as const : 'arrowDown' as const,
            text: `${sig.label}(${sig.score})`,
          };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.time - b.time);

      try {
        const markerPlugin = createSeriesMarkers(candleSeries, markers as any);
      } catch {
        // markers plugin may not be available
      }

      // Volume
      const volSeries = mainChart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
      volSeries.setData(visible.map(c => ({ time: toTS(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.4)' })));
      mainChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

      // MA lines
      const addLine = (data: any[], color: string) => {
        if (data.length < 2) return;
        const s = mainChart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        s.setData(data);
      };
      addLine(visible.filter(c => c.ma5 != null).map(c => ({ time: toTS(c.time), value: c.ma5! })), '#f59e0b');
      addLine(visible.filter(c => c.ma10 != null).map(c => ({ time: toTS(c.time), value: c.ma10! })), '#a855f7');
      addLine(visible.filter(c => c.ma20 != null).map(c => ({ time: toTS(c.time), value: c.ma20! })), '#06b6d4');

      // VWAP
      addLine(visible.filter(c => c.vwap != null).map(c => ({ time: toTS(c.time), value: c.vwap! })), '#818cf8');

      // Top info
      const last = visible[visible.length - 1];
      if (last.ma5 != null) {
        // Show MA info
      }

      mainChart.timeScale().fitContent();

      // ── KD chart ──
      if (kdRef.current) {
        const kdChart = chartOpts(kdRef.current, kdRef.current.clientHeight);
        chartsRef.current.push(kdChart);

        const kdK = visible.filter(c => c.kdK != null).map(c => ({ time: toTS(c.time), value: c.kdK! }));
        const kdD = visible.filter(c => c.kdD != null).map(c => ({ time: toTS(c.time), value: c.kdD! }));
        if (kdK.length > 1) {
          const kSeries = kdChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          kSeries.setData(kdK);
        }
        if (kdD.length > 1) {
          const dSeries = kdChart.addSeries(LineSeries, { color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          dSeries.setData(kdD);
        }
        kdChart.timeScale().fitContent();
      }

      // ── MACD chart ──
      if (macdRef.current) {
        const macdChart = chartOpts(macdRef.current, macdRef.current.clientHeight);
        chartsRef.current.push(macdChart);

        const oscData = visible.filter(c => c.macdOSC != null).map(c => ({
          time: toTS(c.time), value: c.macdOSC!,
          color: c.macdOSC! >= 0 ? 'rgba(239,68,68,0.6)' : 'rgba(34,197,94,0.6)',
        }));
        const difData = visible.filter(c => c.macdDIF != null).map(c => ({ time: toTS(c.time), value: c.macdDIF! }));
        const sigData = visible.filter(c => c.macdSignal != null).map(c => ({ time: toTS(c.time), value: c.macdSignal! }));

        if (oscData.length > 1) {
          const oscSeries = macdChart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
          oscSeries.setData(oscData);
        }
        if (difData.length > 1) {
          const difSeries = macdChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          difSeries.setData(difData);
        }
        if (sigData.length > 1) {
          const sigSeries = macdChart.addSeries(LineSeries, { color: '#06b6d4', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
          sigSeries.setData(sigData);
        }
        macdChart.timeScale().fitContent();
      }

      // Crosshair hover → update hoverCandle
      mainChart.subscribeCrosshairMove((param: any) => {
        if (!param || !param.time) {
          useDaytradeStore.getState().setHoverCandle(null);
          return;
        }
        const ts = param.time as number;
        const found = visible.find(c => toTS(c.time) === ts);
        if (found) {
          useDaytradeStore.getState().setHoverCandle(found);
        }
      });

      // Resize
      const ro = new ResizeObserver(() => {
        chartsRef.current.forEach((ch, i) => {
          const el = [mainRef.current, kdRef.current, macdRef.current][i];
          if (el) ch.applyOptions({ width: el.clientWidth });
        });
      });
      if (mainRef.current) ro.observe(mainRef.current);
    });

    return () => { cancelled = true; };
  }, [displayCandles, replayIndex, isReplaying]);

  return (
    <div className="flex flex-col h-full">
      <div ref={mainRef} className="flex-[5] min-h-0" />
      <div className="border-t border-slate-800 text-[10px] text-slate-500 px-2 py-0.5 flex items-center gap-3">
        <span>KD</span>
        <span className="text-amber-400">K9</span> <span className="text-cyan-400">D9</span>
      </div>
      <div ref={kdRef} className="flex-[1.5] min-h-0 border-t border-slate-800" />
      <div className="border-t border-slate-800 text-[10px] text-slate-500 px-2 py-0.5 flex items-center gap-3">
        <span>MACD</span>
        <span className="text-amber-400">DIF</span> <span className="text-cyan-400">Signal</span> <span>OSC</span>
      </div>
      <div ref={macdRef} className="flex-[1.5] min-h-0 border-t border-slate-800" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Page
// ═══════════════════════════════════════════════════════════════════════════════

export default function LiveDaytradePage() {
  const {
    symbol, setSymbol, date, setDate,
    selectedTimeframe, setTimeframe,
    stockName: storeStockName,
    latestPrice, openPrice, highPrice, lowPrice, dayVolume,
    priceChange, priceChangePct, displayCandles,
    isLoading, error, loadData,
    currentSignals, mtfState, hoverCandle,
    todayOnly, setTodayOnly, signalThreshold, setSignalThreshold,
    autoRefresh, toggleAutoRefresh,
    viewMode, setViewMode, newSignalAlert, clearAlert,
    autoTrade, setAutoTrade, eodReport, generateEODReport,
    lastUpdateTime,
    isReplaying, replayIndex, replaySpeed,
    startReplay, stopReplay, nextBar, setReplaySpeed,
  } = useDaytradeStore();

  const [sideTab, setSideTab] = useState<SideTabKey>('mtf');
  const [input, setInput] = useState(symbol);
  const [showDrop, setShowDrop] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const [quickStocks, setQuickStocks] = useState(DEFAULT_QUICK_STOCKS);
  const [addStockInput, setAddStockInput] = useState('');

  // 初始化時從 localStorage 載入自訂快選
  useEffect(() => { setQuickStocks(loadCustomStocks()); }, []);

  // Auto load + auto refresh on mount
  useEffect(() => {
    loadData();
    // Auto-start refresh in live mode
    if (viewMode === 'live' && !autoRefresh) {
      toggleAutoRefresh();
    }
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLoad = (sym?: string) => {
    const s = sym ?? input;
    setSymbol(s);
    setInput(s);
    setShowDrop(false);
    setTimeout(() => loadData(), 50);
  };

  const filteredStocks = input.length > 0
    ? quickStocks.filter(s => s.symbol.includes(input.toUpperCase()) || s.name.includes(input))
    : quickStocks;

  const stockName = storeStockName || STOCK_NAME_MAP.get(symbol) || '';
  // Display candle = hover or latest
  const displayC = hoverCandle ?? displayCandles[displayCandles.length - 1];
  const dispPrice = displayC?.close ?? latestPrice;
  const dispOpen  = displayC?.open ?? openPrice;
  const dispHigh  = displayC?.high ?? highPrice;
  const dispLow   = displayC?.low ?? lowPrice;
  const dispVol   = displayC?.volume ?? dayVolume;
  const dispTime  = displayC?.time ?? '';
  const dispChange = dispPrice - openPrice;
  const dispChangePct = openPrice > 0 ? (dispChange / openPrice) * 100 : 0;
  const isUp = dispChange >= 0;

  const tfGroups = [
    { label: '分鐘', items: ['1m','3m','5m','15m','30m','60m'] as IntradayTimeframe[] },
    { label: '日週月', items: ['1d','1wk','1mo'] as IntradayTimeframe[] },
  ];
  const total = displayCandles.length;
  const pct = total > 0 ? Math.round(((replayIndex + 1) / total) * 100) : 0;

  // Latest signal for alert
  const latestBuySell = currentSignals.filter(s => s.type === 'BUY' || s.type === 'SELL').slice(-1)[0];

  // Auto-clear alert after 5 seconds
  useEffect(() => {
    if (newSignalAlert) {
      const t = setTimeout(() => clearAlert(), 5000);
      return () => clearTimeout(t);
    }
  }, [newSignalAlert]);

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-white overflow-hidden">

      {/* ── Header ── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-3 py-1.5 flex items-center gap-2 min-w-0">
        <span className="text-sm font-bold text-violet-400 whitespace-nowrap shrink-0">⚡ 當沖助手</span>
        <span className="text-[9px] bg-amber-600 text-white px-1.5 py-0.5 rounded-full font-bold animate-pulse shrink-0">BETA</span>

        {/* Stock selector with dropdown */}
        <div ref={dropRef} className="relative shrink-0">
          <div className="flex items-center bg-slate-700 rounded border border-slate-600 focus-within:border-sky-500 overflow-hidden">
            <input
              type="text"
              value={input}
              onChange={e => { setInput(e.target.value); setShowDrop(true); }}
              onFocus={() => setShowDrop(true)}
              onKeyDown={e => { if (e.key === 'Enter' && input.trim()) handleLoad(input.trim()); }}
              placeholder="代號/名稱"
              className="w-28 bg-transparent px-2 py-1 text-xs text-white font-mono font-bold focus:outline-none"
            />
            {stockName && !showDrop && (
              <span className="text-[10px] text-slate-400 pr-2 truncate max-w-[60px]">{stockName}</span>
            )}
          </div>
          {showDrop && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-slate-700 border border-slate-600 rounded shadow-xl z-50 max-h-60 overflow-y-auto">
              {filteredStocks.map(s => (
                <div key={s.symbol} className="flex items-center hover:bg-slate-600 group">
                  <button
                    onClick={() => handleLoad(s.symbol)}
                    className="flex-1 text-left px-2 py-1.5 text-xs flex gap-2 items-center">
                    <span className="font-mono text-yellow-400 w-10 shrink-0">{s.symbol}</span>
                    <span className="text-slate-300 truncate">{s.name}</span>
                  </button>
                  {!DEFAULT_QUICK_STOCKS.some(d => d.symbol === s.symbol) && (
                    <button onClick={() => {
                      const next = quickStocks.filter(q => q.symbol !== s.symbol);
                      setQuickStocks(next); saveCustomStocks(next);
                    }} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 px-1.5 text-[10px]" title="移除">✕</button>
                  )}
                </div>
              ))}
              {/* 新增自訂股票 */}
              <div className="border-t border-slate-600 p-1.5 flex gap-1">
                <input type="text" placeholder="新增代號" value={addStockInput}
                  onChange={e => setAddStockInput(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && addStockInput.trim()) {
                      const sym = addStockInput.trim();
                      if (!quickStocks.some(s => s.symbol === sym)) {
                        const next = [...quickStocks, { symbol: sym, name: sym }];
                        setQuickStocks(next); saveCustomStocks(next);
                      }
                      setAddStockInput('');
                    }
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[10px] text-white outline-none focus:border-sky-500 w-16" />
                <button onClick={() => {
                  const sym = addStockInput.trim();
                  if (sym && !quickStocks.some(s => s.symbol === sym)) {
                    const next = [...quickStocks, { symbol: sym, name: sym }];
                    setQuickStocks(next); saveCustomStocks(next);
                  }
                  setAddStockInput('');
                }} className="text-[10px] bg-sky-700 hover:bg-sky-600 text-white px-2 py-0.5 rounded">+</button>
              </div>
            </div>
          )}
        </div>

        <input type="date" className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-xs text-white focus:border-sky-500 outline-none"
          value={date} onChange={e => setDate(e.target.value)} />
        <button onClick={() => handleLoad()} disabled={isLoading}
          className="bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white text-xs px-3 py-1 rounded font-bold">
          {isLoading ? '...' : '載入'}
        </button>

        {/* Timeframe switcher */}
        <span className="w-px h-4 bg-slate-700 mx-1" />
        {tfGroups.map((g, gi) => (
          <span key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <span className="text-slate-700 mx-0.5">|</span>}
            {g.items.map(tf => {
              const labels: Record<string, string> = { '1d': '日', '1wk': '週', '1mo': '月' };
              return (
                <button key={tf} onClick={() => setTimeframe(tf)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-bold transition ${
                    selectedTimeframe === tf ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'
                  }`}>
                  {labels[tf] ?? tf}
                </button>
              );
            })}
          </span>
        ))}

        {/* Today only + Auto refresh */}
        <span className="w-px h-4 bg-slate-700 mx-1" />
        <button onClick={() => setTodayOnly(!todayOnly)}
          className={`text-[10px] px-2 py-1 rounded font-bold ${
            todayOnly ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-500'
          }`}>
          {todayOnly ? '今日' : '多日'}
        </button>
        <button onClick={toggleAutoRefresh}
          className={`text-[10px] px-2 py-1 rounded font-bold flex items-center gap-1 ${
            autoRefresh ? 'bg-red-600 text-white animate-pulse' : 'bg-slate-800 text-slate-500 hover:text-white'
          }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-white' : 'bg-slate-600'}`} />
          {autoRefresh ? '自動刷新中' : '自動刷新'}
        </button>

        {/* Nav */}
        <nav className="flex items-center gap-0.5 ml-auto shrink-0">
          <Link href="/" className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-white transition">走圖</Link>
          <Link href="/scan" className="text-[11px] px-2 py-1 rounded text-slate-400 hover:bg-slate-700 hover:text-white transition">掃描選股</Link>
          <span className="text-[10px] font-bold text-violet-500 border border-violet-700/60 bg-violet-900/30 px-2 py-1 rounded cursor-default select-none">當沖</span>
        </nav>
      </header>

      {/* ── OHLCV Bar ── */}
      {latestPrice > 0 && (
        <div className="shrink-0 flex items-center gap-x-3 gap-y-0.5 px-3 py-1 border-b border-slate-800 text-xs font-mono flex-wrap">
          {stockName && <span className="text-white font-bold font-sans mr-1">{stockName}</span>}
          <span className={hoverCandle ? 'text-blue-400' : 'text-slate-400'}>
            {hoverCandle ? dispTime.split('T')[1]?.slice(0,5) ?? symbol : symbol}
          </span>
          <span className={`text-sm font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>{dispPrice.toFixed(2)}</span>
          <span className={`font-bold ${isUp ? 'text-red-400' : 'text-green-400'}`}>
            {isUp ? '▲' : '▼'}{Math.abs(dispChange).toFixed(2)} ({isUp ? '+' : ''}{dispChangePct.toFixed(2)}%)
          </span>
          <span className="text-slate-500">開<span className="text-white ml-0.5">{dispOpen.toFixed(2)}</span></span>
          <span className="text-slate-500">高<span className="text-red-400 ml-0.5">{dispHigh.toFixed(2)}</span></span>
          <span className="text-slate-500">低<span className="text-green-400 ml-0.5">{dispLow.toFixed(2)}</span></span>
          <span className="text-slate-500">量<span className="text-slate-300 ml-0.5">{dispVol > 1000 ? `${(dispVol/1000).toFixed(0)}K` : dispVol}</span></span>
          <span className="text-slate-500 ml-1">MA5 <span className="text-amber-400">{displayC?.ma5?.toFixed(2) ?? '—'}</span></span>
          <span className="text-slate-500">MA20 <span className="text-cyan-400">{displayC?.ma20?.toFixed(2) ?? '—'}</span></span>
          <span className="text-slate-500">VWAP <span className="text-indigo-400">{displayC?.vwap?.toFixed(2) ?? '—'}</span></span>

          {/* MTF badge */}
          {mtfState && (
            <span className={`ml-auto px-2 py-0.5 rounded text-[10px] font-bold ${
              mtfState.overallBias === 'bullish' ? 'bg-red-900/50 text-red-300' :
              mtfState.overallBias === 'bearish' ? 'bg-green-900/50 text-green-300' :
              'bg-yellow-900/50 text-yellow-300'
            }`}>
              {mtfState.overallBias === 'bullish' ? '偏多' : mtfState.overallBias === 'bearish' ? '偏空' : '中性'}
              {' '}{mtfState.confluenceScore}
            </span>
          )}

          {/* Latest signal alert */}
          {latestBuySell && (
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold animate-pulse ${
              latestBuySell.type === 'BUY' ? 'bg-red-800 text-white' : 'bg-green-800 text-white'
            }`}>
              {latestBuySell.type === 'BUY' ? '🔴 買進訊號' : '🟢 賣出訊號'} {latestBuySell.label}
            </span>
          )}
        </div>
      )}

      {error && <div className="shrink-0 mx-3 mt-1 bg-red-900/30 border border-red-700 text-red-300 text-xs rounded p-2">{error}</div>}

      {/* ── Main ── */}
      <div className="flex-1 flex gap-2 px-3 py-2 min-h-0 overflow-hidden">

        {/* Left: Charts */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 gap-1.5">
          <div className="relative flex flex-col rounded-xl border border-slate-700 overflow-hidden bg-slate-900"
            style={{ height: 'calc(100vh - 150px)' }}>
            {isLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/80">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <IntradayChartFull />
          </div>

          {/* Bottom bar: Live status or Replay controls */}
          <div className="shrink-0 bg-slate-800/60 rounded-lg border border-slate-700 px-2 py-1 flex items-center gap-2">

            {/* Mode toggle */}
            <div className="flex rounded overflow-hidden border border-slate-600 mr-1">
              <button onClick={() => setViewMode('live')}
                className={`text-[10px] px-2 py-1 font-bold ${viewMode === 'live' ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-500'}`}>
                即時
              </button>
              <button onClick={() => setViewMode('replay')}
                className={`text-[10px] px-2 py-1 font-bold ${viewMode === 'replay' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-500'}`}>
                回放
              </button>
            </div>

            {viewMode === 'live' ? (
              <>
                {/* Live status */}
                <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`} />
                <span className="text-[10px] text-slate-400">
                  {autoRefresh ? '即時監控中' : '已暫停'} {lastUpdateTime && `· 更新 ${lastUpdateTime}`}
                </span>
                <span className="text-[10px] text-slate-500">K棒 {total} 根</span>

                {/* Auto trade toggle */}
                <span className="w-px h-3 bg-slate-700 mx-1" />
                <button onClick={() => setAutoTrade(!autoTrade)}
                  className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                    autoTrade ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-500 hover:text-white'
                  }`}>
                  {autoTrade ? '自動交易 ON' : '自動交易'}
                </button>

                {/* EOD report button */}
                <button onClick={generateEODReport}
                  className="text-[10px] px-2 py-0.5 rounded bg-amber-700 text-amber-100 hover:bg-amber-600 font-bold ml-auto">
                  盤後結算
                </button>
              </>
            ) : (
              <>
                {/* Replay controls */}
                <button onClick={isReplaying ? stopReplay : startReplay}
                  className={`text-xs px-2 py-1 rounded font-medium ${isReplaying ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  {isReplaying ? '⏸ 暫停' : '▶ 播放'}
                </button>
                <button onClick={nextBar} disabled={isReplaying}
                  className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40">▶|</button>
                <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                  <div className="bg-sky-500 h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[10px] text-slate-500 w-14 text-right">{replayIndex+1}/{total}</span>
                {['慢','1x','快','極速'].map((label, i) => {
                  const speeds = [1000, 500, 200, 50];
                  return (
                    <button key={label} onClick={() => setReplaySpeed(speeds[i])}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${replaySpeed === speeds[i] ? 'bg-sky-600 text-white' : 'text-slate-500 hover:text-white'}`}>
                      {label}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* Right: Sidebar */}
        <div className="w-72 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Tab switcher */}
          <div className="shrink-0 flex rounded-lg overflow-hidden border border-slate-700 text-xs">
            {SIDE_TABS.map(t => (
              <button key={t.key} onClick={() => setSideTab(t.key)}
                className={`flex-1 py-1.5 font-medium transition-colors ${
                  sideTab === t.key ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
            {sideTab === 'mtf' && <MultiTFPanel />}
            {sideTab === 'trade' && <TradeAccountPanel />}
            {sideTab === 'signals' && <SignalListPanel />}
            {sideTab === 'validate' && <ValidationPanel />}
            {sideTab === 'eod' && <EODReportPanel />}
            {sideTab === 'sigbt' && <SignalBacktestPanel symbol={symbol} />}
            {sideTab === 'optim' && <StrategyOptimizerPanel symbol={symbol} />}
            {sideTab === 'posjnl' && (
              <div className="space-y-4 p-1">
                <PositionCalculator />
                <TradeJournal />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Signal Alert Toast */}
      {newSignalAlert && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-2xl border animate-bounce ${
          newSignalAlert.type === 'BUY' ? 'bg-red-900/95 border-red-600 text-red-100' : 'bg-green-900/95 border-green-600 text-green-100'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-2xl">{newSignalAlert.type === 'BUY' ? '🔴' : '🟢'}</span>
            <div>
              <div className="font-bold text-sm">{newSignalAlert.type === 'BUY' ? '買進訊號' : '賣出訊號'} — {newSignalAlert.label}</div>
              <div className="text-xs opacity-80">{newSignalAlert.reason}</div>
              <div className="text-xs opacity-60">分數 {newSignalAlert.score} · {newSignalAlert.triggeredAt.split('T')[1]?.slice(0,5)}</div>
            </div>
            <button onClick={clearAlert} className="text-white/50 hover:text-white ml-2">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EOD Report Panel
// ═══════════════════════════════════════════════════════════════════════════════

function EODReportPanel() {
  const { eodReport, generateEODReport } = useDaytradeStore();

  if (!eodReport) {
    return (
      <div className="p-3 text-center">
        <p className="text-xs text-slate-400 mb-3">收盤後點擊下方按鈕生成當日結算報表</p>
        <button onClick={generateEODReport}
          className="bg-amber-700 text-amber-100 hover:bg-amber-600 text-xs px-4 py-2 rounded-lg font-bold">
          生成盤後結算
        </button>
      </div>
    );
  }

  const r = eodReport;
  const isProfit = r.totalPnL >= 0;

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-amber-300">盤後結算報表</div>
      <div className="text-center text-slate-500 text-[10px]">{r.date} · {r.symbol} {r.stockName}</div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">初始本金</div>
          <div className="text-white font-mono font-bold">{(r.initialCapital / 10000).toFixed(1)}萬</div>
        </div>
        <div className={`rounded p-2 text-center ${isProfit ? 'bg-red-900/40' : 'bg-green-900/40'}`}>
          <div className="text-slate-400 text-[10px]">總損益</div>
          <div className={`font-mono font-bold ${isProfit ? 'text-red-400' : 'text-green-400'}`}>
            {isProfit ? '+' : ''}{r.totalPnL.toLocaleString()} ({isProfit ? '+' : ''}{r.returnPct.toFixed(2)}%)
          </div>
        </div>
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">交易次數</div>
          <div className="text-white font-mono font-bold">{r.totalTrades}</div>
        </div>
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">勝率</div>
          <div className={`font-mono font-bold ${r.winRate >= 60 ? 'text-amber-400' : 'text-slate-400'}`}>{r.winRate}%</div>
        </div>
      </div>

      {/* Trade list */}
      {r.trades.length > 0 && (
        <div>
          <div className="text-slate-400 mb-1 font-bold">交易明細</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {r.trades.map((t, i) => (
              <div key={i} className="flex items-center gap-2 bg-slate-800/60 rounded px-2 py-1 text-[10px]">
                <span className={`font-bold px-1 rounded ${t.action === 'BUY' ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
                  {t.action === 'BUY' ? '買' : '賣'}
                </span>
                <span className="text-slate-500">{t.time.split('T')[1]?.slice(0,5) ?? t.time}</span>
                <span className="text-white font-mono">${t.price.toFixed(2)}</span>
                <span className="text-slate-400">×{t.shares}</span>
                {t.pnl != null && t.pnl !== 0 && (
                  <span className={`ml-auto font-mono font-bold ${t.pnl > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {t.pnl > 0 ? '+' : ''}{t.pnl.toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {r.trades.length === 0 && (
        <div className="text-center text-slate-500 py-4">今日無交易記錄</div>
      )}

      {/* Re-generate */}
      <button onClick={generateEODReport}
        className="w-full bg-slate-700 text-slate-300 hover:bg-slate-600 text-xs px-3 py-1.5 rounded font-medium">
        重新結算
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Signal Backtest Panel — 按訊號買賣的歷史回測
// ═══════════════════════════════════════════════════════════════════════════════

function SignalBacktestPanel({ symbol }: { symbol: string }) {
  const [days, setDays] = useState(10);
  const [tf, setTf] = useState('5m');
  const [stopLoss, setStopLoss] = useState(-2);
  const [takeProfit, setTakeProfit] = useState(3);
  const [capital] = useState(1000000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [showTrades, setShowTrades] = useState(false);

  const runBacktest = async (overrideDays?: number) => {
    const d = overrideDays ?? days;
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await fetch(
        `/api/daytrade/signal-backtest?symbol=${symbol}&days=${d}&timeframe=${tf}&capital=${capital}&stopLoss=${stopLoss}&takeProfit=${takeProfit}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'API Error');
      setResult(json);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const retCls = (v: number) => v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-sky-300">訊號交易回測</div>
      <div className="text-center text-[10px] text-slate-500">按系統訊號自動買賣，看歷史勝率</div>

      {/* Config */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-slate-500 text-[10px]">回測天數</label>
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={1}>今日</option>
            <option value={5}>5天</option>
            <option value={10}>10天</option>
            <option value={20}>20天</option>
            <option value={30}>30天</option>
            <option value={60}>60天</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">K線週期</label>
          <select value={tf} onChange={e => setTf(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value="1m">1分</option>
            <option value="5m">5分</option>
            <option value="15m">15分</option>
            <option value="60m">60分</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">停損%</label>
          <select value={stopLoss} onChange={e => setStopLoss(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={-1}>-1%</option>
            <option value={-1.5}>-1.5%</option>
            <option value={-2}>-2%</option>
            <option value={-3}>-3%</option>
            <option value={-5}>-5%</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">停利%</label>
          <select value={takeProfit} onChange={e => setTakeProfit(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={1}>+1%</option>
            <option value={2}>+2%</option>
            <option value={3}>+3%</option>
            <option value={5}>+5%</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => { setDays(1); runBacktest(1); }} disabled={loading}
          className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white py-2 rounded font-bold">
          {loading && days === 1 ? '...' : '回測今日'}
        </button>
        <button onClick={() => runBacktest()} disabled={loading}
          className="flex-1 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white py-2 rounded font-bold">
          {loading ? '回測中...' : `近${days}天`}
        </button>
      </div>

      {error && <div className="text-red-400 text-center">{error}</div>}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <div className="text-center text-slate-400 text-[10px]">
            {result.stockName} · {result.timeframe} · {result.daysCount}天
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-2 gap-2">
            <div className={`rounded p-2 text-center ${result.winRate >= 50 ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
              <div className="text-slate-400 text-[10px]">勝率</div>
              <div className={`text-lg font-black ${result.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>
                {result.winRate}%
              </div>
              <div className="text-[10px] text-slate-500">{result.winCount}勝 {result.lossCount}敗</div>
            </div>
            <div className={`rounded p-2 text-center ${result.totalPnL >= 0 ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
              <div className="text-slate-400 text-[10px]">總損益</div>
              <div className={`text-lg font-black ${retCls(result.totalPnL)}`}>
                {result.totalPnL >= 0 ? '+' : ''}{Math.round(result.totalPnL).toLocaleString()}
              </div>
              <div className={`text-[10px] ${retCls(result.totalReturnPct)}`}>{fmt(result.totalReturnPct)}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">總交易</div>
              <div className="text-white font-bold">{result.totalTrades}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">日均交易</div>
              <div className="text-white font-bold">{result.avgTradesPerDay.toFixed(1)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">盈虧比</div>
              <div className={`font-bold ${result.profitFactor >= 1 ? 'text-red-400' : 'text-green-400'}`}>
                {result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}
              </div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均報酬</div>
              <div className={`font-bold font-mono ${retCls(result.avgTradeReturn)}`}>{fmt(result.avgTradeReturn)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均獲利</div>
              <div className="font-bold font-mono text-red-400">{fmt(result.avgWin)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均虧損</div>
              <div className="font-bold font-mono text-green-400">{fmt(result.avgLoss)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">最大獲利</div>
              <div className="font-bold font-mono text-red-400">{fmt(result.maxWin)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">最大虧損</div>
              <div className="font-bold font-mono text-green-400">{fmt(result.maxLoss)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">Sharpe</div>
              <div className={`font-bold ${result.sharpeApprox >= 0 ? 'text-sky-400' : 'text-orange-400'}`}>
                {result.sharpeApprox.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Best / Worst day */}
          {result.bestDay && result.worstDay && (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-red-900/20 border border-red-800/30 rounded p-1.5">
                <div className="text-[9px] text-slate-500">最佳日</div>
                <div className="text-red-400 font-bold text-[11px]">{result.bestDay.date}</div>
                <div className="text-red-300 font-mono">{fmt(result.bestDay.returnPct)}</div>
              </div>
              <div className="bg-green-900/20 border border-green-800/30 rounded p-1.5">
                <div className="text-[9px] text-slate-500">最差日</div>
                <div className="text-green-400 font-bold text-[11px]">{result.worstDay.date}</div>
                <div className="text-green-300 font-mono">{fmt(result.worstDay.returnPct)}</div>
              </div>
            </div>
          )}

          {/* Daily breakdown */}
          <div>
            <div className="text-slate-400 font-bold mb-1">每日損益</div>
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {result.dailyResults.map((d: any) => (
                <div key={d.date} className="flex items-center gap-2 text-[10px] bg-slate-800/40 rounded px-2 py-0.5">
                  <span className="text-slate-500 w-20">{d.date}</span>
                  <span className={`font-mono font-bold flex-1 ${retCls(d.totalPnL)}`}>
                    {d.totalPnL >= 0 ? '+' : ''}{Math.round(d.totalPnL).toLocaleString()}
                  </span>
                  <span className="text-slate-500">{d.trades.length}筆</span>
                  <span className={`w-8 text-right ${d.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>{d.winRate}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Trade list toggle */}
          <button onClick={() => setShowTrades(!showTrades)}
            className="w-full bg-slate-700 text-slate-300 hover:bg-slate-600 py-1 rounded text-[10px]">
            {showTrades ? '隱藏交易明細' : `展開全部 ${result.totalTrades} 筆交易`}
          </button>

          {showTrades && (
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {result.allTrades.map((t: any, i: number) => (
                <div key={i} className="bg-slate-800/40 rounded px-2 py-1 text-[10px]">
                  <div className="flex items-center gap-1">
                    <span className="text-slate-500">{t.entryTime.split('T')[1]?.slice(0,5)}</span>
                    <span className="text-white">→</span>
                    <span className="text-slate-500">{t.exitTime.split('T')[1]?.slice(0,5)}</span>
                    <span className={`ml-auto font-mono font-bold ${retCls(t.returnPct)}`}>{fmt(t.returnPct)}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[9px] text-slate-500">
                    <span>進:{t.entryPrice.toFixed(1)}</span>
                    <span>出:{t.exitPrice.toFixed(1)}</span>
                    <span>×{t.shares}</span>
                    <span className="ml-auto">{t.entrySignal}</span>
                    <span className="text-slate-600">|</span>
                    <span>{t.exitReason}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Strategy Optimizer Panel
// ═══════════════════════════════════════════════════════════════════════════════

function StrategyOptimizerPanel({ symbol }: { symbol: string }) {
  const [days, setDays] = useState(30);
  const [rounds, setRounds] = useState(3);
  const [tf, setTf] = useState('5m');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [diagResult, setDiagResult] = useState<any>(null);
  const [error, setError] = useState('');

  const retCls = (v: number) => v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';

  const runIterate = async () => {
    setLoading(true); setError(''); setResult(null); setDiagResult(null);
    try {
      const res = await fetch(`/api/daytrade/optimize?action=iterate&symbol=${symbol}&days=${days}&timeframe=${tf}&rounds=${rounds}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error');
      setResult(json);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const runSingle = async () => {
    setLoading(true); setError(''); setDiagResult(null);
    try {
      const res = await fetch(`/api/daytrade/optimize?action=run&symbol=${symbol}&days=${days}&timeframe=${tf}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error');
      setDiagResult(json);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-violet-300">策略自動優化</div>
      <div className="text-center text-[10px] text-slate-500">回測→診斷→優化→再回測</div>

      <div className="grid grid-cols-3 gap-1.5">
        <div>
          <label className="text-slate-500 text-[9px]">天數</label>
          <select value={days} onChange={e => setDays(+e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value={10}>10天</option><option value={20}>20天</option><option value={30}>30天</option><option value={60}>60天</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[9px]">週期</label>
          <select value={tf} onChange={e => setTf(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value="1m">1分</option><option value="5m">5分</option><option value="15m">15分</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[9px]">輪數</label>
          <select value={rounds} onChange={e => setRounds(+e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded px-1 py-1 text-white text-[10px]">
            <option value={1}>1</option><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={runSingle} disabled={loading}
          className="flex-1 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white py-2 rounded font-bold text-[11px]">
          {loading ? '...' : '單輪診斷'}
        </button>
        <button onClick={runIterate} disabled={loading}
          className="flex-1 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 text-white py-2 rounded font-bold text-[11px]">
          {loading ? '優化中...' : `迭代${rounds}輪`}
        </button>
      </div>

      {error && <div className="text-red-400 text-center text-[10px]">{error}</div>}

      {/* Single diagnostics */}
      {diagResult?.diagnostics && (() => {
        const d = diagResult.diagnostics;
        const m = d.overallMetrics;
        return (
          <div className="space-y-2">
            <div className="text-center text-slate-400 font-bold">診斷 {diagResult.version?.id}</div>
            <div className="grid grid-cols-3 gap-1">
              {[
                ['勝率', `${m.winRate}%`, m.winRate >= 50],
                ['盈虧比', m.profitFactor.toFixed(2), m.profitFactor >= 1],
                ['停損率', `${m.stopLossRate}%`, m.stopLossRate < 40],
              ].map(([label, val, good]) => (
                <div key={String(label)} className="bg-slate-800 rounded p-1 text-center">
                  <div className="text-[8px] text-slate-500">{label}</div>
                  <div className={`font-bold ${good ? 'text-red-400' : 'text-green-400'}`}>{val}</div>
                </div>
              ))}
            </div>

            {d.issues.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">問題 ({d.issues.length})</div>
                <div className="space-y-0.5 max-h-20 overflow-y-auto">
                  {d.issues.map((issue: any, i: number) => (
                    <div key={i} className={`text-[10px] px-2 py-0.5 rounded ${
                      issue.severity === 'critical' ? 'bg-red-900/30 text-red-300' :
                      issue.severity === 'warning' ? 'bg-orange-900/30 text-orange-300' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {issue.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.ruleAnalysis.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">規則品質</div>
                <div className="space-y-0.5 max-h-20 overflow-y-auto">
                  {d.ruleAnalysis.map((r: any) => (
                    <div key={r.ruleId} className="flex items-center gap-1 text-[10px] bg-slate-800/40 rounded px-1.5 py-0.5">
                      <span className={`w-3 font-black ${
                        r.grade === 'A' ? 'text-green-400' : r.grade === 'B' ? 'text-sky-400' :
                        r.grade === 'C' ? 'text-yellow-400' : r.grade === 'D' ? 'text-orange-400' : 'text-red-400'
                      }`}>{r.grade}</span>
                      <span className="text-slate-300 flex-1 truncate">{r.ruleId}</span>
                      <span className={`font-mono ${retCls(r.avgReturn)}`}>{r.avgReturn.toFixed(2)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.suggestions.length > 0 && (
              <div>
                <div className="text-slate-400 font-bold mb-1">優化建議</div>
                {d.suggestions.slice(0, 3).map((s: any) => (
                  <div key={s.id} className={`text-[10px] px-2 py-1 rounded border mb-1 ${
                    s.priority === 'high' ? 'bg-violet-900/20 border-violet-700/50 text-violet-200' : 'bg-slate-800/60 border-slate-700 text-slate-300'
                  }`}>
                    <div className="font-bold">{s.priority === 'high' ? '⚡' : '💡'} {s.description}</div>
                    <div className="text-[9px] text-slate-500">{s.expectedImpact}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Multi-round results */}
      {result && (
        <div className="space-y-2">
          <div className="text-center text-violet-300 font-bold">迭代結果 ({result.totalRounds}輪)</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {result.iterations.map((it: any) => (
              <div key={it.round} className="bg-slate-800/60 rounded p-1.5">
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="bg-violet-700 text-white px-1 py-0.5 rounded-full font-bold text-[8px]">R{it.round}</span>
                  <span className="text-white font-bold">{it.version.id}</span>
                  {it.metrics && <>
                    <span className={`${it.metrics.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>{it.metrics.winRate}%</span>
                    <span className={`${it.metrics.profitFactor >= 1 ? 'text-red-400' : 'text-green-400'}`}>PF{it.metrics.profitFactor.toFixed(1)}</span>
                  </>}
                </div>
                <div className="text-[9px] text-slate-500 truncate">{it.topSuggestion}</div>
              </div>
            ))}
          </div>
          <div className="text-center text-[10px] text-slate-500">
            最終：<span className="text-violet-400 font-bold">{result.finalVersion}</span>
          </div>
        </div>
      )}
    </div>
  );
}
