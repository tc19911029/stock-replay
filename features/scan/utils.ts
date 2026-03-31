/**
 * Scan page utility functions — pure, no hooks, no state
 */
import type { StockScanResult } from '@/lib/scanner/types';

// ── Color helpers ─────────────────────────────────────────────────────────────

// ── Cached color theme (avoids parsing localStorage on every render) ────────
let _cachedColorTheme: string | null = null;
let _cacheTimestamp = 0;
const THEME_CACHE_TTL = 5000; // 5 seconds

function getColorTheme(): string {
  const now = Date.now();
  if (_cachedColorTheme && now - _cacheTimestamp < THEME_CACHE_TTL) return _cachedColorTheme;
  try {
    if (typeof window !== 'undefined') {
      _cachedColorTheme = JSON.parse(localStorage.getItem('settings-v4') || '{}')?.state?.colorTheme ?? 'asia';
    } else {
      _cachedColorTheme = 'asia';
    }
  } catch {
    _cachedColorTheme = 'asia';
  }
  _cacheTimestamp = now;
  return _cachedColorTheme!;
}

/** Return/PnL color based on color theme (亞洲: 紅漲綠跌) */
export function retColor(v: number | null | undefined): string {
  if (v == null) return 'text-slate-500';
  const theme = getColorTheme();
  if (theme === 'western') {
    if (v > 0) return 'text-green-400';
    if (v < 0) return 'text-red-500';
  } else {
    if (v > 0) return 'text-red-400';
    if (v < 0) return 'text-green-500';
  }
  return 'text-slate-400';
}

/** Format return percentage with sign */
export function fmtRet(v: number | null | undefined): string {
  if (v == null) return '–';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** Surge score color class */
export function scoreColor(s: number): string {
  if (s >= 5) return 'text-amber-400 font-bold';
  if (s >= 4) return 'text-sky-400 font-semibold';
  return 'text-sky-400';
}

// ── Composite score ───────────────────────────────────────────────────────────

/**
 * Composite score — 直接使用 Scanner 的完整評分（含智慧資金、市場寬度等12+維度）。
 * 若 Scanner 未提供 compositeScore，fallback 到簡化公式。
 */
export function calcComposite(r: Pick<StockScanResult,
  'compositeScore' | 'sixConditionsScore' | 'surgeScore' | 'histWinRate' | 'trendPosition' | 'surgeComponents' | 'surgeFlags'
>): number {
  // 優先使用 Scanner 已計算的 compositeScore（包含智慧資金、板塊動能、壓力帶等完整分析）
  if (r.compositeScore != null) return r.compositeScore;

  // Fallback: 簡化公式（相容舊資料）
  const sixCon    = (r.sixConditionsScore / 6) * 100;
  const surge     = (r.surgeScore ?? 0);
  const winR      = r.histWinRate ?? 42;
  const posBonus  = r.trendPosition?.includes('起漲') ? 100
                  : r.trendPosition?.includes('主升') ? 70
                  : r.trendPosition?.includes('末升') ? 20 : 50;
  const volBonus  = (r.surgeComponents?.volume?.score ?? 50);
  const flags     = r.surgeFlags ?? [];
  const breakoutBonus = (
    (flags.includes('BB_SQUEEZE_BREAKOUT') ? 30 : 0) +
    (flags.includes('CONSOLIDATION_BREAKOUT') ? 30 : 0) +
    (flags.includes('NEW_60D_HIGH') ? 20 : 0) +
    (flags.includes('VOLUME_CLIMAX') ? 20 : 0)
  );
  const breakoutScore = Math.min(100, breakoutBonus);
  return Math.round((sixCon * 0.30 + surge * 0.20 + winR * 0.25 + posBonus * 0.10 + volBonus * 0.10 + breakoutScore * 0.05) * 10) / 10;
}

/** Chip tooltip text */
export function chipTooltip(r: {
  foreignBuy?: number; trustBuy?: number; dealerBuy?: number;
  marginNet?: number; shortNet?: number; dayTradeRatio?: number;
  largeTraderNet?: number; chipDetail?: string;
}): string {
  const parts: string[] = [];
  if (r.foreignBuy != null) parts.push(`外資: ${r.foreignBuy > 0 ? '+' : ''}${r.foreignBuy.toLocaleString()}張`);
  if (r.trustBuy != null)   parts.push(`投信: ${r.trustBuy > 0 ? '+' : ''}${r.trustBuy.toLocaleString()}張`);
  if (r.dealerBuy != null && r.dealerBuy !== 0) parts.push(`自營: ${r.dealerBuy > 0 ? '+' : ''}${r.dealerBuy.toLocaleString()}張`);
  if (r.marginNet != null && r.marginNet !== 0) parts.push(`融資: ${r.marginNet > 0 ? '+' : ''}${r.marginNet}張`);
  if (r.shortNet != null && r.shortNet !== 0) parts.push(`融券: ${r.shortNet > 0 ? '+' : ''}${r.shortNet}張`);
  if (r.dayTradeRatio != null && r.dayTradeRatio > 0) parts.push(`當沖: ${r.dayTradeRatio}%`);
  if (r.largeTraderNet != null && r.largeTraderNet !== 0) parts.push(`大戶: ${r.largeTraderNet > 0 ? '+' : ''}${r.largeTraderNet.toLocaleString()}張`);
  if (r.chipDetail) parts.push(`\n${r.chipDetail}`);
  return parts.join(' | ') || '無籌碼資料';
}

/** CSV export for backtest trades */
export function exportToCsv(
  trades: Array<{
    symbol: string; name: string; market: string; signalDate: string; signalScore: number;
    trendState: string; entryDate: string; entryPrice: number; exitDate: string;
    exitPrice: number; exitReason: string; holdDays: number; grossReturn: number;
    netReturn: number; totalCost: number; signalReasons: string[];
  }>,
  scanDate: string
): void {
  const headers = ['代號','名稱','市場','訊號日','評分','趨勢','進場日','進場價','出場日','出場價','出場原因','持有天數','毛報酬%','淨報酬%','交易成本','命中原因'];
  const rows = trades.map(t => [
    t.symbol, t.name, t.market, t.signalDate, t.signalScore, t.trendState,
    t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.exitReason, t.holdDays,
    t.grossReturn, t.netReturn, t.totalCost, t.signalReasons.join('|'),
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backtest_${scanDate}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
