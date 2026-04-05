'use client';

import type { Candle } from '@/types';

interface MaToggles { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma240: boolean }
interface Indicators { macd: boolean; kd: boolean; volume: boolean; rsi: boolean }

interface ChartToolbarProps {
  candle: Candle;
  prevCandle?: Candle | null;
  isHover: boolean;
  stockName?: string;
  maToggles: MaToggles;
  onMaToggle: (key: keyof MaToggles) => void;
  showBollinger: boolean;
  onBollingerToggle: () => void;
  indicators: Indicators;
  onIndicatorToggle: (key: keyof Indicators) => void;
  showMarkers: boolean;
  onMarkersToggle: () => void;
  signalStrengthMin: number;
  onSignalStrengthChange: (v: number) => void;
  avgCost?: number;
  shares?: number;
  onPrev?: () => void;
  onNext?: () => void;
  onReset?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
}

const MA_CONFIGS = [
  { key: 'ma5' as const, label: 'MA5' },
  { key: 'ma10' as const, label: 'MA10' },
  { key: 'ma20' as const, label: 'MA20' },
  { key: 'ma60' as const, label: 'MA60' },
  { key: 'ma240' as const, label: 'MA240' },
];

const INDICATOR_CONFIGS = [
  { key: 'volume' as const, label: '量' },
  { key: 'kd' as const, label: 'KD' },
  { key: 'rsi' as const, label: 'RSI' },
  { key: 'macd' as const, label: 'MACD' },
];

export default function ChartToolbar({
  candle, prevCandle, isHover, stockName,
  maToggles, onMaToggle,
  showBollinger, onBollingerToggle,
  indicators, onIndicatorToggle,
  showMarkers, onMarkersToggle,
  signalStrengthMin, onSignalStrengthChange,
  avgCost, shares,
  onPrev, onNext, onReset,
  canPrev = true, canNext = true,
}: ChartToolbarProps) {
  const chg = prevCandle ? candle.close - prevCandle.close : 0;
  const chgPct = prevCandle ? (chg / prevCandle.close) * 100 : 0;
  const isUp = chg >= 0;

  const unrealizedPct = shares && shares > 0 && avgCost && avgCost > 0
    ? ((candle.close - avgCost) / avgCost) * 100
    : null;

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 px-2 sm:px-3 py-1 sm:py-1.5 border-b border-border text-[10px] sm:text-xs font-mono">
      {stockName && (
        <span className="text-foreground font-bold font-sans mr-1">{stockName}</span>
      )}
      <span className={isHover ? 'text-blue-400' : 'text-muted-foreground'}>{candle.date}</span>
      <span className={`text-sm font-bold ${isUp ? 'text-bull' : 'text-bear'}`}>
        {candle.close.toFixed(2)}
      </span>
      <span className={`font-bold ${isUp ? 'text-bull' : 'text-bear'}`}>
        {isUp ? '▲' : '▼'}{Math.abs(chg).toFixed(2)} ({Math.abs(chgPct).toFixed(2)}%)
      </span>
      <span className="text-muted-foreground">開<span className="text-foreground ml-0.5">{candle.open.toFixed(2)}</span></span>
      <span className="text-muted-foreground">高<span className="text-bull ml-0.5">{candle.high.toFixed(2)}</span></span>
      <span className="text-muted-foreground">低<span className="text-bear ml-0.5">{candle.low.toFixed(2)}</span></span>
      <span className="text-muted-foreground">量<span className="text-foreground/80 ml-0.5">{candle.volume.toLocaleString()}</span></span>

      {/* Toolbar: MA toggles + BB + indicators + signals */}
      <div className="ml-auto flex items-center gap-1 shrink-0 flex-wrap">
        {MA_CONFIGS.map(({ key, label }) => (
          <button key={key}
            onClick={() => onMaToggle(key)}
            aria-pressed={maToggles[key]}
            aria-label={`${maToggles[key] ? '隱藏' : '顯示'} ${label}`}
            className={`min-w-[2rem] min-h-[1.5rem] px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
              maToggles[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/60'
            }`}
            title={`顯示/隱藏 ${label}`}
          >{label}</button>
        ))}
        <span className="w-px h-3 bg-border mx-0.5" />
        <button
          onClick={onBollingerToggle}
          aria-pressed={showBollinger}
          aria-label={`${showBollinger ? '隱藏' : '顯示'}布林通道`}
          className={`min-w-[2rem] min-h-[1.5rem] px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
            showBollinger ? 'bg-emerald-700/60 text-emerald-200' : 'bg-secondary text-muted-foreground/60'
          }`}
          title="布林通道 (20, 2)"
        >BB</button>
        {INDICATOR_CONFIGS.map(({ key, label }) => (
          <button key={key}
            onClick={() => onIndicatorToggle(key)}
            aria-pressed={indicators[key]}
            aria-label={`${indicators[key] ? '隱藏' : '顯示'} ${label} 指標`}
            className={`min-w-[2rem] min-h-[1.5rem] px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
              indicators[key] ? 'bg-sky-700/60 text-sky-200' : 'bg-secondary text-muted-foreground/60'
            }`}
          >{label}</button>
        ))}
        <span className="w-px h-3 bg-border mx-0.5" />
        <button
          onClick={onMarkersToggle}
          aria-pressed={showMarkers}
          aria-label={`${showMarkers ? '隱藏' : '顯示'}買賣訊號標記`}
          className={`min-w-[2rem] min-h-[1.5rem] px-1.5 py-0.5 rounded text-[9px] font-medium transition ${
            showMarkers ? 'bg-blue-600/60 text-blue-200' : 'bg-secondary text-muted-foreground/60'
          }`}
          title="顯示/隱藏買賣訊號標記"
        >訊號</button>
        {showMarkers && (
          <select
            value={signalStrengthMin}
            onChange={e => onSignalStrengthChange(Number(e.target.value))}
            aria-label="信號共振強度過濾"
            className="px-1 py-0.5 rounded text-[9px] font-medium bg-secondary text-foreground/80 border border-border outline-none"
            title="信號共振強度過濾"
          >
            <option value={1}>全部</option>
            <option value={2}>共振≥2</option>
            <option value={3}>強≥3</option>
          </select>
        )}
        {onPrev && onNext && (
          <>
            <span className="w-px h-3 bg-border mx-0.5" />
            <button onClick={onPrev} disabled={!canPrev} title="上一根 K 棒 (←)"
              className="min-w-[1.5rem] min-h-[1.5rem] px-1 py-0.5 rounded text-[9px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">◀</button>
            <button onClick={onNext} disabled={!canNext} title="下一根 K 棒 (→)"
              className="min-w-[1.5rem] min-h-[1.5rem] px-1 py-0.5 rounded text-[9px] font-bold transition bg-muted hover:bg-muted/80 text-foreground/80 disabled:opacity-30">▶</button>
            {onReset && (
              <button onClick={onReset} title="重置走圖（回到第一根）"
                className="min-w-[1.5rem] min-h-[1.5rem] px-1 py-0.5 rounded text-[9px] font-medium transition bg-muted hover:bg-red-900/60 text-muted-foreground hover:text-red-300">↺</button>
            )}
          </>
        )}
      </div>

      {unrealizedPct !== null && (
        <span className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground">
            均價<span className="text-yellow-400 font-bold ml-0.5">{avgCost!.toFixed(2)}</span>
          </span>
          <span className={`font-bold text-xs ${unrealizedPct >= 0 ? 'text-bull' : 'text-bear'}`}>
            {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
          </span>
        </span>
      )}
    </div>
  );
}
