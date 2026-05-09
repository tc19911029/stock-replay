'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBacktestStore } from '@/store/backtestStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import type { SelectedStock } from './ScanChartPanel';

interface ReentryCandidate {
  symbol: string;
  name: string;
  firstSeenDate: string;
  scanAppearances: number;
  price: number;
  ma5Distance: number;
  checks: {
    trendIntact: boolean;
    maReclaimed: boolean;
    volumeOk: boolean;
  };
}

interface ApiResponse {
  ok?: boolean;
  market?: string;
  direction?: string;
  lookbackDays?: number;
  sourceDates?: number;
  sourceSymbols?: number;
  candidates?: ReentryCandidate[];
  error?: string;
}

interface ReentryCandidatesPanelProps {
  onSelectStock?: (stock: SelectedStock) => void;
}

const LOOKBACK_DAYS = 14;

export function ReentryCandidatesPanel({ onSelectStock }: ReentryCandidatesPanelProps) {
  const { market, scanDirection } = useBacktestStore();
  const [candidates, setCandidates] = useState<ReentryCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const direction = scanDirection === 'short' ? 'short' : 'long';

  // 排除已持有 — 持倉中的股票不應出現在再進場候選名單
  const heldSymbols = usePortfolioStore((s) =>
    s.holdings.map((h) => h.symbol).join(','),
  );

  const fetchCandidates = useCallback(async () => {
    if (scanDirection === 'daban') return;  // 打板模式不適用
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        market,
        direction,
        lookbackDays: String(LOOKBACK_DAYS),
        ...(heldSymbols ? { excludeSymbols: heldSymbols } : {}),
      });
      const url = `/api/scanner/reentry-candidates?${params}`;
      const res = await fetch(url);
      const json = (await res.json()) as ApiResponse;
      if (!json.ok) {
        throw new Error(json.error ?? '查詢失敗');
      }
      setCandidates(json.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [market, direction, scanDirection, heldSymbols]);

  useEffect(() => {
    fetchCandidates();
  }, [fetchCandidates]);

  if (scanDirection === 'daban') return null;

  const count = candidates.length;
  const headerColor = count > 0 ? 'text-amber-500' : 'text-muted-foreground';

  // 沒任何候選時整個區塊不渲染（避免常駐空白 header 佔版面）
  // loading / error 時保留顯示
  if (!loading && !error && count === 0) {
    return null;
  }

  return (
    <div className="border-b border-border bg-background/50">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] hover:bg-muted/40 transition-colors"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5">
          <span className={`font-semibold ${headerColor}`}>再進場候選</span>
          <span className="text-[10px] font-mono bg-amber-700 text-amber-100 px-1.5 py-px rounded font-bold">
            {count} 檔
          </span>
          {loading && <span className="text-[9px] text-muted-foreground">載入中…</span>}
        </span>
        <span className="text-xs text-muted-foreground">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 text-xs">
          {error && (
            <div className="text-bear py-2">⚠ {error}</div>
          )}
          {!error && !loading && count === 0 && (
            <div className="text-muted-foreground py-2">
              目前沒有符合條件的股票。當以前掃出的股票跌破 MA5、現在又站回 MA5 且趨勢未破，會出現在這裡。
            </div>
          )}
          {!error && count > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border/50">
                  <tr>
                    <th className="text-left py-1 px-2">代號</th>
                    <th className="text-left py-1 px-2">名稱</th>
                    <th className="text-right py-1 px-2">現價</th>
                    <th className="text-right py-1 px-2">距 MA5</th>
                    <th className="text-center py-1 px-2">出現次</th>
                    <th className="text-center py-1 px-2">首次入選</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(c => (
                    <tr
                      key={c.symbol}
                      className="border-b border-border/30 hover:bg-muted/30 cursor-pointer"
                      onClick={() => onSelectStock?.({ symbol: c.symbol, name: c.name, market })}
                    >
                      <td className="py-1 px-2 font-mono">{c.symbol}</td>
                      <td className="py-1 px-2">{c.name}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{c.price.toFixed(2)}</td>
                      <td className="py-1 px-2 text-right tabular-nums text-bull">
                        +{c.ma5Distance.toFixed(2)}%
                      </td>
                      <td className="py-1 px-2 text-center">{c.scanAppearances}</td>
                      <td className="py-1 px-2 text-center text-muted-foreground">{c.firstSeenDate.slice(5)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-muted-foreground mt-2 leading-relaxed">
                <strong>判斷條件</strong>：曾經符合六條件入選掃描 + 後來跌破 MA5 + 今日趨勢仍多頭 + 站回 MA5 + 量能未崩塌
                <br />
                <strong>書本依據</strong>：戰法 1 波浪 / 戰法 4 二條均線 / 戰法 9 續勢 — 跌破 MA5 出場後，趨勢未破即可寬條件再進
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
