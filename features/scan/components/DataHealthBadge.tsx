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
}

// ── 共用色表 ──────────────────────────────────────────────────────────────

const statusColorMap: Record<string, string> = {
  fresh: 'bg-green-900/50 text-green-300 border-green-700',
  closed: 'bg-blue-900/50 text-blue-300 border-blue-700',
  stale: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  missing: 'bg-red-900/50 text-red-300 border-red-700',
  good: 'bg-green-900/50 text-green-300 border-green-700',
  warning: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  critical: 'bg-red-900/50 text-red-300 border-red-700',
  no_report: 'bg-zinc-800/50 text-zinc-400 border-zinc-600',
};

const statusLabelMap: Record<string, string> = {
  fresh: '即時', closed: '收盤', stale: '過期', missing: '無數據',
  good: '正常', warning: '警告', critical: '異常', no_report: '未校驗',
};

// ── 元件 ──────────────────────────────────────────────────────────────────

export function DataHealthBadge({ market }: DataHealthProps) {
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
  }, [expanded]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/health/data?market=${market}`)
      .then(r => r.json())
      .then(data => { if (data.ok) setHealth(data as MarketHealth); })
      .catch(() => {})
      .finally(() => setLoading(false));
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
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l1Color} cursor-pointer`}
        title={`L1 歷史K線 | 覆蓋率 ${coverage} | ${l1TimeText}`}
      >
        L1 {l1Label}
      </button>

      {/* L2 */}
      <button onClick={toggle}
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l2Color} cursor-pointer ${showL2Alert ? 'animate-pulse' : ''}`}
        title={`L2 快照 | ${l2?.quoteCount ?? 0} 筆 | ${l2TimeText}`}
      >
        L2 {l2Label}{showL2Alert ? ' !' : ''}
      </button>

      {/* L3 */}
      <button onClick={toggle}
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l3Color} cursor-pointer`}
        title={`L3 即時報價 | 依賴 L2`}
      >
        L3 {l3Label}
      </button>

      {/* L4 */}
      <button onClick={toggle}
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${l4Color} cursor-pointer`}
        title={`L4 掃描 | ${l4?.lastScanCount ?? 0} 檔 | ${l4TimeText}`}
      >
        L4 {l4Label}
      </button>

      {/* 展開詳情面板 */}
      {expanded && (
        <div ref={panelRef} style={panelStyle} className="z-[9999] bg-popover border border-border rounded-md shadow-lg p-3 min-w-[240px] text-[11px] overflow-y-auto">
          <div className="font-semibold mb-2">{market} 數據健康報告</div>

          {/* L1 */}
          <div className="text-muted-foreground mb-2">
            <div className="font-medium text-foreground mb-1">L1 歷史K線</div>
            <div className="space-y-0.5 pl-2">
              <Row label="狀態"><StatusSpan status={health.health}>{l1Label}</StatusSpan></Row>
              <Row label="覆蓋率">{coverage}</Row>
              <Row label="Gap 股票">{health.stocksWithGaps ?? '?'} 支</Row>
              <Row label="過期股票">{health.stocksStale ?? '?'} 支</Row>
              <Row label="下載失敗">{health.downloadFailed ?? '?'} 支</Row>
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
