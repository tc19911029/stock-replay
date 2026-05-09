'use client';

/**
 * 大盤狀態 Banner
 *
 * 書本依據：寶典 p.687「進場做多的前提：大盤站上月線多頭」
 *
 * 即時呼叫 /api/scanner/market-trend 取得純 detectTrend 結果（與走圖左上、
 * 條件面板趨勢條件保持一致，不依賴 saved scan session 寫入的舊值）。
 *
 * - 多頭：綠 banner，可正常做多
 * - 空頭：紅 banner，警告停止做多
 * - 盤整：黃 banner，提示謹慎進場
 * - null：灰 banner，資料載入中
 */

import { useEffect, useState } from 'react';
import type { TrendState } from '@/lib/analysis/trendAnalysis';

interface MarketTrendBannerProps {
  market: 'TW' | 'CN';
  /** 當有 saved session 時可以傳入做為初始值，避免閃爍；最終以 API 即時值為準 */
  marketTrend?: TrendState | null;
  scanDate: string | null;
}

interface BannerStyle {
  bg: string;
  text: string;
  label: string;
  hint: string;
}

// 不同趨勢用左邊邊框顏色 + 文字色區分（不用 emoji）
const TREND_STYLE: Record<TrendState, BannerStyle> = {
  多頭: {
    bg: 'bg-emerald-900/40 border-emerald-500',
    text: 'text-emerald-200',
    label: '多頭',
    hint: '可正常做多',
  },
  空頭: {
    bg: 'bg-rose-900/40 border-rose-500',
    text: 'text-rose-200',
    label: '空頭',
    hint: '停止做多（書本：站不上月線不進場）',
  },
  盤整: {
    bg: 'bg-amber-900/30 border-amber-500',
    text: 'text-amber-200',
    label: '盤整',
    hint: '可選擇性做多（盤整不是多頭，謹慎進場）',
  },
};

const NEUTRAL_STYLE: BannerStyle = {
  bg: 'bg-slate-800/40 border-slate-500',
  text: 'text-slate-300',
  label: '未載入',
  hint: '大盤資料載入中…',
};

const INDEX_NAME: Record<'TW' | 'CN', string> = {
  TW: '加權指數',
  CN: '上證指數',
};

export function MarketTrendBanner({ market, marketTrend: initialTrend, scanDate }: MarketTrendBannerProps) {
  // 即時 fetch 純 detectTrend 結果；用 prop 當 fallback 避免初始閃爍
  const [trend, setTrend] = useState<TrendState | null>(initialTrend ?? null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ market });
    if (scanDate) params.set('date', scanDate);
    fetch(`/api/scanner/market-trend?${params}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; trend?: TrendState }) => {
        if (!cancelled && j.ok && j.trend) setTrend(j.trend);
      })
      .catch(() => { /* keep prop fallback */ });
    return () => { cancelled = true; };
  }, [market, scanDate]);

  const style = trend ? TREND_STYLE[trend] : NEUTRAL_STYLE;
  const indexName = INDEX_NAME[market];

  return (
    <div
      className={`flex items-center gap-2 px-2.5 py-2 border-b border-l-4 text-[11px] font-medium ${style.bg} ${style.text}`}
      title="大盤趨勢：進場做多的最高前提（寶典 p.687）"
    >
      <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
        <span className="font-bold shrink-0 text-[10px] opacity-70 tracking-wider">大盤</span>
        <span className="font-semibold shrink-0">{indexName}</span>
        <span className="font-mono shrink-0 font-bold">{style.label}</span>
        <span className="opacity-80 truncate">{style.hint}</span>
      </div>
      {scanDate && (
        <span className="font-mono text-[10px] opacity-70 shrink-0">{scanDate.slice(5)}</span>
      )}
    </div>
  );
}
