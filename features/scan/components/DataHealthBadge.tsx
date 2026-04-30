'use client';

import { useState, useEffect, useLayoutEffect, useRef } from 'react';

interface L2Status {
  status: 'fresh' | 'stale' | 'missing';
  quoteCount: number | null;
  ageSeconds: number | null;
  updatedAt: string | null;
}

interface DataSourceStatus {
  source: string;
  success: boolean;
  quoteCount: number;
  errorMessage?: string;
  responseTimeMs: number;
  timestamp: string;
}

interface L2SourceInfo {
  sources: DataSourceStatus[];
  consecutiveEmptyCount: number;
  isTradingDay: boolean;
  alertLevel: 'none' | 'warning' | 'critical';
}

interface L4Status {
  lastScanDate: string | null;
  lastScanCount: number;
  lastScanTime: string | null;
  totalDatesAvailable: number;
  todayHasIntraday: boolean;
  ageSeconds: number | null;
  status: 'fresh' | 'stale' | 'missing';
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
  l2Sources?: L2SourceInfo;
  l4?: L4Status;
}

interface DataHealthProps {
  market: 'TW' | 'CN';
  /** 強制向下展開且寬度對齊父容器 */
  forceDown?: boolean;
}

// ── 共用色表 ──────────────────────────────────────────────────────────────

const statusColorMap: Record<string, string> = {
  fresh: 'bg-green-950/60 text-green-300 border-green-800/50',
  closed: 'bg-blue-950/60 text-blue-300 border-blue-800/50',
  stale: 'bg-yellow-950/60 text-yellow-300 border-yellow-800/50',
  missing: 'bg-red-950/60 text-red-300 border-red-800/50',
  good: 'bg-green-950/60 text-green-300 border-green-800/50',
  warning: 'bg-yellow-950/60 text-yellow-300 border-yellow-800/50',
  critical: 'bg-red-950/60 text-red-300 border-red-800/50',
  no_report: 'bg-zinc-900/60 text-zinc-400 border-zinc-700/50',
};

const dotColorMap: Record<string, string> = {
  fresh: 'bg-green-400', closed: 'bg-blue-400', stale: 'bg-yellow-400',
  missing: 'bg-red-400', good: 'bg-green-400', warning: 'bg-yellow-400',
  critical: 'bg-red-400', no_report: 'bg-zinc-500',
};

const statusLabelMap: Record<string, string> = {
  fresh: '即時', closed: '收盤', stale: '過期', missing: '無數據',
  good: '正常', warning: '警告', critical: '異常', no_report: '未校驗',
};

// ── 元件 ──────────────────────────────────────────────────────────────────

export function DataHealthBadge({ market, forceDown }: DataHealthProps) {
  const [health, setHealth] = useState<MarketHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  // 點擊外部關閉面板
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setExpanded(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [expanded]);

  // 展開時用 fixed 定位，動態計算面板位置（避免被 overflow:hidden 截斷）
  useLayoutEffect(() => {
    if (!expanded || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const panelH = 440; // 估計面板高度
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;

    // forceDown: prefer downward expansion aligned to parent, but fall back to upward if no space
    if (forceDown) {
      const parentRect = containerRef.current.parentElement?.getBoundingClientRect();
      const w = parentRect ? parentRect.width : undefined;
      const l = parentRect ? parentRect.left : rect.left;
      if (spaceBelow >= 120) {
        setPanelStyle({ position: 'fixed', top: rect.bottom + 4, left: l, maxHeight: spaceBelow, width: w });
      } else {
        // Not enough space below — expand upward
        setPanelStyle({ position: 'fixed', bottom: window.innerHeight - rect.top + 4, left: l, maxHeight: spaceAbove, width: w });
      }
      return;
    }

    if (spaceBelow >= panelH) {
      // 向下展開
      setPanelStyle({ position: 'fixed', top: rect.bottom + 4, left: rect.left, maxHeight: spaceBelow });
    } else if (spaceAbove >= panelH) {
      // 向上展開
      setPanelStyle({ position: 'fixed', bottom: window.innerHeight - rect.top + 4, left: rect.left, maxHeight: spaceAbove });
    } else {
      // 空間都不夠，取較大的那邊
      const bigger = spaceBelow >= spaceAbove ? 'below' : 'above';
      if (bigger === 'below') {
        setPanelStyle({ position: 'fixed', top: rect.bottom + 4, left: rect.left, maxHeight: spaceBelow });
      } else {
        setPanelStyle({ position: 'fixed', bottom: window.innerHeight - rect.top + 4, left: rect.left, maxHeight: spaceAbove });
      }
    }
  }, [expanded, forceDown]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切換 market 時切換 loading + 清舊 health
    setLoading(true);
    setHealth(null); // 清除舊市場資料，避免顯示上個市場的 badge
    const controller = new AbortController();
    fetch(`/api/health/data?market=${market}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => { if (data.ok) setHealth(data as MarketHealth); })
      .catch(err => { if (err.name !== 'AbortError') {} })
      .finally(() => setLoading(false));
    return () => controller.abort(); // 切換市場時取消上一次的 fetch
  }, [market]);

  if (loading || !health) return null;

  const noReport = health.health === 'no_report';
  const l2 = health.l2;
  const l4 = health.l4;

  // ── L1 ──
  const l1Color = statusColorMap[health.health] ?? statusColorMap.warning;
  const l1Label = statusLabelMap[health.health] ?? '未知';
  const coverage = health.coverageRate != null ? `${(health.coverageRate * 100).toFixed(0)}%` : '?';
  const l1TimeText = health.generatedAt ? formatAbsoluteTime(health.generatedAt) : '未知';

  // ── L2 ──
  const l2Status = l2?.status ?? 'missing';
  const isAfterHours = l2Status === 'fresh' && l2?.ageSeconds != null && l2.ageSeconds > 30 * 60;
  const l2DisplayStatus = isAfterHours ? 'closed' : l2Status;
  const l2Color = statusColorMap[l2DisplayStatus];
  const l2Label = statusLabelMap[l2DisplayStatus];
  const l2TimeText = l2?.updatedAt ? formatAbsoluteTime(l2.updatedAt) : '無';

  // L2 告警
  const l2Alert = health.l2Sources?.alertLevel ?? 'none';
  const l2EmptyCount = health.l2Sources?.consecutiveEmptyCount ?? 0;
  const l2IsTradingDay = health.l2Sources?.isTradingDay ?? false;
  const showL2Alert = l2Alert !== 'none' || (l2IsTradingDay && l2Status === 'missing');

  // ── L3（依賴 L2） ──
  const l3DisplayStatus = l2DisplayStatus === 'fresh' ? 'fresh'
    : l2DisplayStatus === 'closed' ? 'closed'
    : l2DisplayStatus === 'stale' ? 'stale' : 'missing';
  const l3Color = statusColorMap[l3DisplayStatus];
  const l3Label = statusLabelMap[l3DisplayStatus];

  // ── L4 ──
  const l4Status = l4?.status ?? 'missing';
  const l4IsAfterHours = l4Status === 'fresh' && l4?.ageSeconds != null && l4.ageSeconds > 30 * 60;
  const l4DisplayStatus = l4IsAfterHours ? 'closed' : l4Status;
  const l4Color = statusColorMap[l4DisplayStatus];
  const l4Label = statusLabelMap[l4DisplayStatus];
  const l4TimeText = l4?.lastScanTime ? formatAbsoluteTime(l4.lastScanTime) : '無';

  const toggle = () => setExpanded(prev => !prev);

  return (
    <div ref={containerRef} className="relative inline-flex gap-1">
      {/* L1 */}
      <button onClick={toggle}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border ${l1Color} cursor-pointer transition-colors hover:brightness-110`}
        title={`L1 歷史K線 | 覆蓋率 ${coverage} | ${l1TimeText}`}
      >
        L1 {l1Label}
      </button>

      {/* L2 */}
      <button onClick={toggle}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border ${l2Color} cursor-pointer transition-colors hover:brightness-110 ${showL2Alert ? 'animate-pulse' : ''}`}
        title={`L2 快照 | ${l2?.quoteCount ?? 0} 筆 | ${l2TimeText}`}
      >
        L2 {l2Label}
      </button>

      {/* L3 */}
      <button onClick={toggle}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border ${l3Color} cursor-pointer transition-colors hover:brightness-110`}
        title={`L3 即時報價 | 依賴 L2`}
      >
        L3 {l3Label}
      </button>

      {/* L4 */}
      <button onClick={toggle}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border ${l4Color} cursor-pointer transition-colors hover:brightness-110`}
        title={`L4 掃描 | ${l4?.lastScanCount ?? 0} 檔 | ${l4TimeText}`}
      >
        L4 {l4Label}
      </button>

      {/* 展開詳情面板 */}
      {expanded && (
        <div ref={panelRef} style={panelStyle} className="z-[9999] glass-panel rounded-lg p-3 min-w-[260px] text-[11px] overflow-y-auto">
          <div className="font-semibold mb-2">{market} 數據健康報告</div>

          {/* L1 */}
          <div className="text-muted-foreground mb-2">
            <div className="font-medium text-foreground mb-1">L1 歷史K線</div>
            <div className="space-y-0.5 pl-2">
              <Row label="狀態"><StatusSpan status={health.health}>{l1Label}</StatusSpan></Row>
              <Row label="L1 覆蓋率">
                <span className={health.coverageRate != null && health.coverageRate >= 0.99 ? 'text-green-400 font-medium' : 'text-yellow-400'}>
                  {coverage}
                </span>
                <span className="text-[10px] text-muted-foreground/70 ml-1">（本地有資料的比例）</span>
              </Row>
              <Row label="歷史 Gap">
                {health.stocksWithGaps ?? '?'} 支
                <span className="text-[10px] text-muted-foreground/70 ml-1">（多為停牌/上市前）</span>
              </Row>
              <Row label="近 3 日落後">
                <span className={(health.stocksStale ?? 0) > 5 ? 'text-yellow-400' : 'text-foreground'}>
                  {health.stocksStale ?? '?'} 支
                </span>
              </Row>
              <Row label="當次抓取失敗">
                <span className="text-muted-foreground">{health.downloadFailed ?? '?'} 支</span>
                <span className="text-[10px] text-muted-foreground/70 ml-1">
                  {health.coverageRate != null && health.coverageRate >= 0.99
                    ? '（不影響覆蓋率，L1 已有舊資料）'
                    : '（含未補回的股票）'}
                </span>
              </Row>
              <Row label="校驗時間">{l1TimeText}</Row>
            </div>
          </div>

          {/* L2 */}
          <div className="text-muted-foreground border-t border-border pt-2 mb-2">
            <div className="font-medium text-foreground mb-1">L2 盤中快照</div>
            <div className="space-y-0.5 pl-2">
              <Row label="狀態"><StatusSpan status={l2DisplayStatus}>{l2Label}</StatusSpan></Row>
              <Row label="報價數量">{l2?.quoteCount ?? 0} 筆</Row>
              <Row label="快照時間">{l2TimeText}</Row>
            </div>

            {showL2Alert && (
              <div className={`mt-1.5 px-2 py-1 rounded text-[10px] ${l2Alert === 'critical' ? 'bg-red-900/60 text-red-200 border border-red-600' : 'bg-yellow-900/60 text-yellow-200 border border-yellow-600'}`}>
                {l2IsTradingDay && l2Status === 'missing'
                  ? '交易日但 L2 無數據 — API 可能故障，非休市'
                  : `數據源連續失敗 ${l2EmptyCount} 次`}
              </div>
            )}
          </div>

          {/* L3 */}
          <div className="text-muted-foreground border-t border-border pt-2 mb-2">
            <div className="font-medium text-foreground mb-1">L3 即時報價</div>
            <div className="space-y-0.5 pl-2">
              <Row label="狀態"><StatusSpan status={l3DisplayStatus}>{l3Label}</StatusSpan></Row>
              <div className="text-[10px] text-muted-foreground">依賴 L2 快照 + 即時 API fallback</div>
            </div>
          </div>

          {/* L4 */}
          <div className="text-muted-foreground border-t border-border pt-2">
            <div className="font-medium text-foreground mb-1">L4 掃描結果</div>
            <div className="space-y-0.5 pl-2">
              <Row label="狀態"><StatusSpan status={l4DisplayStatus}>{l4Label}</StatusSpan></Row>
              <Row label="今日盤中"><span className={`font-medium ${l4?.todayHasIntraday ? 'text-green-400' : 'text-red-400'}`}>{l4?.todayHasIntraday ? '有' : '無'}</span></Row>
              <Row label="結果數">{l4?.lastScanCount ?? 0} 檔</Row>
              <Row label="歷史天數">{l4?.totalDatesAvailable ?? 0}/20</Row>
              <Row label="掃描時間">{l4TimeText}</Row>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 展開面板子元件 ──────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label}：<span className="text-foreground">{children}</span>
    </div>
  );
}

const statusSpanColor: Record<string, string> = {
  fresh: 'text-green-400', good: 'text-green-400',
  closed: 'text-blue-400',
  stale: 'text-yellow-400', warning: 'text-yellow-400',
  missing: 'text-red-400', critical: 'text-red-400',
};

function StatusSpan({ status, children }: { status: string; children: React.ReactNode }) {
  return <span className={`font-medium ${statusSpanColor[status] ?? 'text-foreground'}`}>{children}</span>;
}

/** ISO 時間字串 → 台灣時間 "MM/DD HH:mm" */
function formatAbsoluteTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '無';
  }
}
