'use client';

import { useState, useEffect } from 'react';

interface L2Status {
  status: 'fresh' | 'stale' | 'missing';
  quoteCount: number | null;
  ageSeconds: number | null;
  updatedAt: string | null;
}

interface MarketHealth {
  market: 'TW' | 'CN';
  reportDate: string | null;
  health: string;
  coverageRate: number | null;
  stocksWithGaps: number | null;
  stocksStale: number | null;
  downloadFailed: number | null;
  generatedAt: string | null;
  l2: L2Status;
}

interface DataHealthProps {
  market: 'TW' | 'CN';
}

export function DataHealthBadge({ market }: DataHealthProps) {
  const [health, setHealth] = useState<MarketHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/health/data?market=${market}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setHealth(data as MarketHealth);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [market]);

  if (loading) return null;
  if (!health) return null;

  const noReport = health.health === 'no_report';
  const l2 = health.l2;

  // L1 badge
  const l1ColorMap: Record<string, string> = {
    good: 'bg-green-900/50 text-green-300 border-green-700',
    warning: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    critical: 'bg-red-900/50 text-red-300 border-red-700',
    no_report: 'bg-zinc-800/50 text-zinc-400 border-zinc-600',
  };
  const l1Color = l1ColorMap[health.health] ?? l1ColorMap.warning;
  const l1Label = noReport ? '未校驗' : health.health === 'good' ? '正常' : health.health === 'warning' ? '警告' : '異常';
  const coverage = health.coverageRate != null ? `${(health.coverageRate * 100).toFixed(0)}%` : '?';

  // L2 badge
  const l2ColorMap: Record<string, string> = {
    fresh: 'bg-green-900/50 text-green-300 border-green-700',
    stale: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    missing: 'bg-red-900/50 text-red-300 border-red-700',
  };
  const l2Status = l2?.status ?? 'missing';
  const l2Color = l2ColorMap[l2Status];
  const l2Label = l2Status === 'fresh' ? '即時' : l2Status === 'stale' ? '過期' : '無數據';

  const l1Age = health.generatedAt ? formatAge(health.generatedAt) : '未知';
  const l2AgeText = l2?.ageSeconds != null ? formatSeconds(l2.ageSeconds) : '無';

  return (
    <div className="relative inline-flex gap-1">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l1Color} cursor-pointer`}
        title={`L1 數據 | 覆蓋率 ${coverage} | ${l1Age}`}
      >
        L1 {l1Label}
      </button>

      <button
        onClick={() => setExpanded(prev => !prev)}
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l2Color} cursor-pointer`}
        title={`L2 快照 | ${l2?.quoteCount ?? 0} 筆 | ${l2AgeText}`}
      >
        L2 {l2Label}
      </button>

      {expanded && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-popover border border-border rounded-md shadow-lg p-3 min-w-[220px] text-[11px]">
          <div className="font-semibold mb-2">{market} 數據健康報告</div>

          {/* L1 區塊 */}
          <div className="text-muted-foreground mb-2">
            <div className="font-medium text-foreground mb-1">L1 歷史K線</div>
            <div className="space-y-0.5 pl-2">
              <div>覆蓋率：<span className="text-foreground">{coverage}</span></div>
              <div>Gap 股票：<span className="text-foreground">{health.stocksWithGaps ?? '?'}</span> 支</div>
              <div>過期股票：<span className="text-foreground">{health.stocksStale ?? '?'}</span> 支</div>
              <div>下載失敗：<span className="text-foreground">{health.downloadFailed ?? '?'}</span> 支</div>
              <div>報告日期：<span className="text-foreground">{health.reportDate ?? '無'}</span></div>
              <div>校驗時間：<span className="text-foreground">{l1Age}</span></div>
            </div>
          </div>

          {/* L2 區塊 */}
          <div className="text-muted-foreground border-t border-border pt-2">
            <div className="font-medium text-foreground mb-1">L2 盤中快照</div>
            <div className="space-y-0.5 pl-2">
              <div>報價數量：<span className="text-foreground">{l2?.quoteCount ?? 0}</span> 筆</div>
              <div>快照年齡：<span className="text-foreground">{l2AgeText}</span></div>
              <div>狀態：<span className={`font-medium ${l2Status === 'fresh' ? 'text-green-400' : l2Status === 'stale' ? 'text-yellow-400' : 'text-red-400'}`}>
                {l2Label}
              </span></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatAge(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return `${Math.floor(diff / (1000 * 60))} 分鐘前`;
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  return `${Math.floor(sec / 3600)} 小時前`;
}
