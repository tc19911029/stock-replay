/**
 * Scan page utility functions — pure, no hooks, no state
 */
import type { StockScanResult } from '@/lib/scanner/types';

// ── Color helpers ─────────────────────────────────────────────────────────────


/** Return/PnL color based on semantic bull/bear classes (CSS handles theme) */
export function retColor(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v > 0) return 'text-bull';
  if (v < 0) return 'text-bear';
  return 'text-muted-foreground';
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
 * Composite score — 台股回測結論：共振100%
 * 回測數據：1947支×244天，共振100% 10日均報+3.23% 勝率45.7%（6組最高）
 */
export function calcComposite(r: Pick<StockScanResult,
  'resonanceScore' | 'highWinRateScore' | 'compositeScore'
>): number {
  if (r.compositeScore != null) return r.compositeScore;
  return (r.resonanceScore ?? 0);
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
