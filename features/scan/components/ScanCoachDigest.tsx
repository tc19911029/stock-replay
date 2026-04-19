'use client';

import { useEffect, useRef, useState } from 'react';
import type { StockScanResult } from '@/lib/scanner/types';

interface DigestPick {
  rank: number;
  symbol: string;
  reason: string;
}

interface DigestResponse {
  overview: string;
  topPicks: DigestPick[];
  watchOut: DigestPick[];
  sectorHint?: string;
  marketCaveat?: string;
  cached?: boolean;
}

interface ScanCoachDigestProps {
  market: 'TW' | 'CN';
  scanDate: string;
  direction: 'long' | 'short' | 'daban';
  marketTrend: string;
  results: StockScanResult[];
}

/** LLM 可能會回傳 "2345" 或 "2345.TW"，兩種都能對上 results */
function nameOf(symbol: string, results: StockScanResult[]): string {
  const bare = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const hit = results.find(r => r.symbol === symbol)
    ?? results.find(r => r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === bare);
  return hit?.name ?? '';
}

/** 顯示時去掉 .TW/.TWO/.SS/.SZ 後綴，比較乾淨 */
function displaySymbol(symbol: string): string {
  return symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

function buildRequestBody(props: ScanCoachDigestProps) {
  // 只丟前 30 檔給 LLM，減少 token 成本並聚焦
  const candidates = props.results.slice(0, 30).map((r, idx) => ({
    rank: idx + 1,
    symbol: r.symbol,
    name: r.name,
    industry: r.industry,
    price: r.price,
    changePercent: r.changePercent,
    sixCond: r.sixConditionsScore,
    sixCondBreakdown: r.sixConditionsBreakdown,
    trendState: r.trendState,
    trendPosition: r.trendPosition,
    mtfScore: r.mtfScore,
    highWinRateTypes: r.highWinRateTypes,
    winnerBullish: r.winnerBullishPatterns,
    winnerBearish: r.winnerBearishPatterns,
    elimination: r.eliminationReasons,
    prohibitions: r.entryProhibitionReasons,
    turnoverRank: r.turnoverRank,
    histWinRate: r.histWinRate,
  }));
  return {
    market: props.market,
    scanDate: props.scanDate,
    direction: props.direction,
    marketTrend: props.marketTrend,
    candidates,
  };
}

export function ScanCoachDigest(props: ScanCoachDigestProps) {
  const [data, setData] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aborted = useRef(false);

  // 切換日期/市場/方向時清空狀態（使用者重按才重新問）
  useEffect(() => {
    aborted.current = false;
    setData(null);
    setError(null);
    setLoading(false);
    return () => {
      aborted.current = true;
    };
  }, [props.market, props.scanDate, props.direction]);

  const ask = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/coach/scan-digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildRequestBody(props)),
      });
      const body = await res.json();
      if (aborted.current) return;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as DigestResponse);
    } catch (err) {
      if (aborted.current) return;
      setError(err instanceof Error ? err.message : 'digest failed');
    } finally {
      if (!aborted.current) setLoading(false);
    }
  };

  // 沒結果可分析
  if (props.results.length === 0) return null;

  // 初始：按鈕
  if (!data && !loading && !error) {
    return (
      <button
        onClick={ask}
        className="w-full mb-2 px-3 py-2 rounded-lg border border-purple-500/40 bg-gradient-to-r from-purple-500/15 to-indigo-500/15 hover:from-purple-500/25 hover:to-indigo-500/25 text-[12px] font-semibold text-purple-100 transition-all flex items-center justify-center gap-2"
      >
        <span>💬</span>
        <span>問朱老師怎麼看這 {Math.min(props.results.length, 30)} 檔</span>
      </button>
    );
  }

  if (loading) {
    return (
      <div className="w-full mb-2 px-3 py-3 rounded-lg border border-purple-500/30 bg-purple-500/5 text-center text-[11px] text-purple-200 animate-pulse">
        💬 老師分析中…（通常 3~6 秒）
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full mb-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-[11px] text-red-300 flex items-center justify-between gap-2">
        <span>💬 老師回覆異常</span>
        <button
          onClick={ask}
          className="text-[11px] text-red-200 hover:text-red-100 px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30"
        >重試</button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="w-full mb-2 rounded-lg border border-purple-500/40 bg-gradient-to-br from-purple-500/10 via-card to-indigo-500/5 p-3 space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-purple-200 flex items-center gap-1.5">
          <span>💬 朱老師的話</span>
          {data.cached && (
            <span className="text-[9px] text-muted-foreground font-normal">（cached）</span>
          )}
        </div>
        <button
          onClick={ask}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
          title="重新分析"
        >🔄</button>
      </div>

      {data.overview && (
        <div className="text-foreground leading-relaxed">{data.overview}</div>
      )}

      {data.marketCaveat && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200">
          ⚠️ {data.marketCaveat}
        </div>
      )}

      {data.topPicks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-emerald-300">🏆 老師認為最穩的：</div>
          {data.topPicks.map((p, i) => {
            const name = nameOf(p.symbol, props.results);
            return (
              <div key={`${p.symbol}-${i}`} className="pl-2 border-l-2 border-emerald-500/50">
                <div className="font-semibold text-emerald-200">
                  #{p.rank} {displaySymbol(p.symbol)}{name && ` ${name}`}
                </div>
                <div className="text-muted-foreground leading-snug">{p.reason}</div>
              </div>
            );
          })}
        </div>
      )}

      {data.watchOut.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-amber-300">⚠️ 這幾檔要小心：</div>
          {data.watchOut.map((p, i) => {
            const name = nameOf(p.symbol, props.results);
            return (
              <div key={`${p.symbol}-${i}`} className="pl-2 border-l-2 border-amber-500/50">
                <div className="font-semibold text-amber-200">
                  #{p.rank} {displaySymbol(p.symbol)}{name && ` ${name}`}
                </div>
                <div className="text-muted-foreground leading-snug">{p.reason}</div>
              </div>
            );
          })}
        </div>
      )}

      {data.sectorHint && (
        <div className="rounded border border-sky-500/30 bg-sky-500/5 px-2 py-1.5 text-sky-200">
          🏭 {data.sectorHint}
        </div>
      )}
    </div>
  );
}
