'use client';

/**
 * Step 0 大盤狀態 Banner（v12 議題 69）
 *
 * 書本依據：寶典 p.687「進場做多的前提：大盤站上月線多頭」
 *
 * 顯示當前大盤趨勢，提醒「能不能做多」這個 v12 最高前提。
 * - 多頭：綠 banner，可正常做多
 * - 空頭：紅 banner，警告停止做多
 * - 盤整：黃 banner，提示謹慎進場
 * - null：灰 banner，資料載入中
 */

import type { TrendState } from '@/lib/analysis/trendAnalysis';

interface MarketTrendBannerProps {
  market: 'TW' | 'CN';
  marketTrend: TrendState | null;
  scanDate: string | null;
}

interface BannerStyle {
  bg: string;
  text: string;
  icon: string;
  label: string;
  hint: string;
}

const TREND_STYLE: Record<TrendState, BannerStyle> = {
  多頭: {
    bg: 'bg-emerald-900/40 border-emerald-700/60',
    text: 'text-emerald-200',
    icon: '🟢',
    label: '多頭',
    hint: '可正常做多',
  },
  空頭: {
    bg: 'bg-rose-900/40 border-rose-700/60',
    text: 'text-rose-200',
    icon: '🔴',
    label: '空頭',
    hint: '停止做多（書本：站不上月線不進場）',
  },
  盤整: {
    bg: 'bg-amber-900/30 border-amber-700/50',
    text: 'text-amber-200',
    icon: '🟡',
    label: '盤整',
    hint: '可選擇性做多（盤整不是多頭，謹慎進場）',
  },
};

const NEUTRAL_STYLE: BannerStyle = {
  bg: 'bg-slate-800/40 border-slate-700/50',
  text: 'text-slate-300',
  icon: '⚪',
  label: '未載入',
  hint: '大盤資料載入中…',
};

const INDEX_NAME: Record<'TW' | 'CN', string> = {
  TW: '加權指數',
  CN: '上證指數',
};

export function MarketTrendBanner({ market, marketTrend, scanDate }: MarketTrendBannerProps) {
  const style = marketTrend ? TREND_STYLE[marketTrend] : NEUTRAL_STYLE;
  const indexName = INDEX_NAME[market];

  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-1.5 border-b text-[10px] ${style.bg} ${style.text}`}
      title="Step 0 大盤過濾：進場做多的最高前提（寶典 p.687）"
    >
      <span className="text-sm leading-none">{style.icon}</span>
      <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
        <span className="font-semibold shrink-0">{indexName}</span>
        <span className="font-mono shrink-0">{style.label}</span>
        <span className="opacity-75 truncate">{style.hint}</span>
      </div>
      {scanDate && (
        <span className="font-mono text-[9px] opacity-60 shrink-0">{scanDate.slice(5)}</span>
      )}
    </div>
  );
}
