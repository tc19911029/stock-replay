'use client';

import Link from 'next/link';
import { BacktestTrade } from '@/lib/backtest/BacktestEngine';
import { retColor, fmtRet, chipTooltip } from '../utils';

// ── Pure badge helpers ─────────────────────────────────────────────────────────

export function trendBadge(t: string) {
  const cls =
    t === '多頭' ? 'bg-red-900/60 text-bull-badge border-red-800' :
    t === '空頭' ? 'bg-green-900/60 text-bear-badge border-green-800' :
    'bg-muted/60 text-foreground/80 border-border';
  return (
    <span className={`inline-block whitespace-nowrap px-2 py-0.5 text-[11px] font-medium rounded-full border ${cls}`}>
      {t}
    </span>
  );
}

export function exitBadge(reason: string) {
  const map: Record<string, string> = {
    holdDays:     'bg-sky-900/50 text-sky-300',
    stopLoss:     'bg-green-900/50 text-green-300',
    takeProfit:   'bg-red-900/50 text-red-300',
    trailingStop: 'bg-amber-900/50 text-amber-300',
    dataEnd:      'bg-muted/50 text-muted-foreground',
  };
  const labels: Record<string, string> = {
    holdDays: '持滿', stopLoss: '停損', takeProfit: '停利', trailingStop: '移停', dataEnd: '缺資料',
  };
  const cls = map[reason] ?? map.holdDays;
  return (
    <span className={`inline-block whitespace-nowrap px-2 py-0.5 text-[10px] font-medium rounded-full ${cls}`}>
      {labels[reason] ?? reason}
    </span>
  );
}

export function chipBadge(score: number | undefined, grade: string | undefined, signal: string | undefined, tooltip: string) {
  if (score == null) return <span className="text-[10px] text-muted-foreground/60">—</span>;
  const colorClass = score >= 70 ? 'bg-green-900/60 text-green-300' : score >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300';
  const icon = signal === '主力進場' ? '🟢' : signal === '法人偏多' ? '🔵' : signal === '大戶加碼' ? '🟡' : signal === '主力出貨' ? '🔴' : signal === '散戶追高' ? '⚠️' : signal === '法人偏空' ? '🟠' : '';
  const gradeDesc = grade === 'S' ? 'S(80+)主力強力買超' : grade === 'A' ? 'A(65-79)法人偏多' : grade === 'B' ? 'B(50-64)中性' : grade === 'C' ? 'C(35-49)法人偏空' : 'D(<35)主力出貨';
  const fullTooltip = `籌碼評分 ${score}分 ${gradeDesc}\n信號：${signal || '中性'}\n\n${tooltip}`;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colorClass}`} title={fullTooltip}>{icon}{grade}</span>;
}

// ── calcTradeComposite ─────────────────────────────────────────────────────────

type ScanRow = {
  symbol: string;
  sixConditionsScore: number;
  surgeScore?: number;
  histWinRate?: number;
  trendPosition?: string;
  surgeComponents?: { volume?: { score: number } };
  surgeFlags?: string[];
};

export function calcTradeComposite(t: BacktestTrade, scanResults?: ScanRow[]): number {
  const sym = t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const sr = scanResults?.find(r => r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === sym);
  if (sr) {
    const sixCon = (sr.sixConditionsScore / 6) * 100;
    const surge  = sr.surgeScore ?? 0;
    const winR   = sr.histWinRate ?? 50;
    const posBonus = sr.trendPosition?.includes('起漲') ? 100
                   : sr.trendPosition?.includes('主升') ? 70
                   : sr.trendPosition?.includes('末升') ? 20 : 50;
    const volBonus = sr.surgeComponents?.volume?.score ?? 50;
    const flags = sr.surgeFlags ?? [];
    const breakoutBonus = (
      (flags.includes('BB_SQUEEZE_BREAKOUT') ? 30 : 0) +
      (flags.includes('CONSOLIDATION_BREAKOUT') ? 30 : 0) +
      (flags.includes('NEW_60D_HIGH') ? 20 : 0) +
      (flags.includes('VOLUME_CLIMAX') ? 20 : 0)
    );
    return Math.round((sixCon * 0.30 + surge * 0.20 + winR * 0.25 + posBonus * 0.10 + volBonus * 0.10 + Math.min(100, breakoutBonus) * 0.05) * 10) / 10;
  }
  const sixCon = (t.signalScore / 6) * 100;
  const winR   = t.histWinRate ?? 50;
  const posBonus = t.trendPosition?.includes('起漲') ? 100
                 : t.trendPosition?.includes('主升') ? 70
                 : t.trendPosition?.includes('末升') ? 20 : 50;
  return Math.round((sixCon * 0.40 + winR * 0.30 + posBonus * 0.15 + 50 * 0.10 + 0 * 0.05) * 10) / 10;
}

// ── TradeRow Component ─────────────────────────────────────────────────────────

interface ChipData {
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  foreignBuy: number;
  trustBuy: number;
  marginNet: number;
  chipDetail?: string;
  dayTradeRatio?: number;
  largeTraderNet?: number;
}

export function TradeRow({ t, chip, composite }: { t: BacktestTrade; chip?: ChipData; composite?: number }) {
  const sym = t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  return (
    <tr className="border-b border-border/50 hover:bg-muted/40">
      <td className="py-1.5 px-2 font-mono font-bold text-foreground">{sym}</td>
      <td className="py-1.5 px-2">
        <div className="text-foreground/80">{t.name}</div>
        <div className="flex gap-0.5 mt-0.5">
          {t.signalReasons.slice(0, 6).map(r => (
            <span key={r} className="text-[8px] px-1 py-0.5 bg-sky-800/80 text-sky-300 rounded-sm">{r.replace(/條件|多頭|放大|長紅|多排|配合/g, '').slice(0, 2)}</span>
          ))}
        </div>
      </td>
      <td className="py-1.5 px-1 text-[10px] text-muted-foreground max-w-[60px] truncate" title={t.industry}>{t.industry ?? '—'}</td>
      <td className="py-1.5 px-1 text-center">
        {(() => { const cs = composite ?? 0; return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-foreground' : 'text-muted-foreground'}`}>{cs.toFixed(1)}</span>; })()}
      </td>
      <td className="py-1.5 px-1 text-center">
        <span className={`font-bold ${t.signalScore >= 5 ? 'text-bull' : t.signalScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
          {t.signalScore}/6
        </span>
      </td>
      <td className="py-1.5 px-1 text-center font-mono text-foreground/80">—</td>
      <td className="py-1.5 px-1 text-center font-mono text-foreground/80">—</td>
      <td className="py-1.5 px-1 text-center">
        {t.histWinRate != null && (
          <span className={`text-[10px] px-1 rounded ${t.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : t.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
            {t.histWinRate}%
          </span>
        )}
      </td>
      <td className="py-1.5 px-2 text-right font-mono text-foreground whitespace-nowrap">{t.entryPrice.toFixed(2)}</td>
      <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{trendBadge(t.trendState)}</td>
      <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{t.trendPosition}</td>
      <td className="py-1.5 px-2 text-center whitespace-nowrap">
        {chipBadge(chip?.chipScore, chip?.chipGrade, chip?.chipSignal, chip ? chipTooltip(chip) : '')}
      </td>
      <td className="py-1.5 px-2 text-right font-mono text-muted-foreground whitespace-nowrap">{t.exitPrice.toFixed(2)}</td>
      <td className="py-1.5 px-1 text-center text-muted-foreground">{t.holdDays}日</td>
      <td className={`py-1.5 px-1 text-right font-mono font-bold ${retColor(t.netReturn)}`}>{fmtRet(t.netReturn)}</td>
      <td className="py-1.5 px-1 text-center">{exitBadge(t.exitReason)}</td>
      <td className="py-1.5 px-2 text-center whitespace-nowrap">
        <Link href={`/?load=${sym}&date=${t.signalDate}`}
          className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">走圖
        </Link>
      </td>
    </tr>
  );
}
