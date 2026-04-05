'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useBacktestStore } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { calcComposite, chipTooltip } from '../utils';
import { chipBadge } from './TradeRow';
import { POLLING } from '@/lib/config';
import { fetchInstitutionalBatch, type InstitutionalSummary } from '@/lib/datasource/useInstitutionalSummary';
import { Button } from '@/components/ui/button';

export function ScanResultsTable() {
  const {
    scanResults,
    scanDate,
    market,
    marketTrend,
    scanOnly,
  } = useBacktestStore();

  const [expandedStock, setExpandedStock] = useState<string | null>(null);
  const [newsCache, setNewsCache] = useState<Record<string, { sentiment: number; summary: string; hasNews: boolean; loading: boolean }>>({});
  const [instData, setInstData] = useState<Map<string, InstitutionalSummary | null>>(new Map());
  const [realtimePrices, setRealtimePrices] = useState<Map<string, { price: number; changePct: number; time: string }>>(new Map());
  const [conceptFilter, setConceptFilter] = useState<string>('all');
  const [scanSort, setScanSort] = useState<'composite' | 'score' | 'grade' | 'potential' | 'winRate' | 'price' | 'change'>('composite');
  const [scanSortDir, setScanSortDir] = useState<'asc' | 'desc'>('desc');
  const [heatmapMode, setHeatmapMode] = useState(false);

  // ── 盤中即時價格更新（每 30 秒，僅台股+掃描選股模式）────────────────────
  useEffect(() => {
    if (market !== 'TW' || scanResults.length === 0 || !scanOnly) return;

    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const isMarketHour = (h >= 9 && (h < 13 || (h === 13 && m <= 30)));
    if (!isMarketHour) return;

    const fetchRealtime = async () => {
      try {
        const symbols = scanResults.slice(0, 50).map(r => r.symbol).join(',');
        const res = await fetch(`/api/realtime?symbols=${symbols}`);
        const json = await res.json();
        if (json.quotes) {
          const map = new Map<string, { price: number; changePct: number; time: string }>();
          for (const q of json.quotes) {
            if (q.price > 0) map.set(q.symbol, { price: q.price, changePct: q.changePct, time: q.time });
          }
          setRealtimePrices(map);
        }
      } catch { /* silent */ }
    };

    fetchRealtime();
    const timer = setInterval(fetchRealtime, POLLING.QUOTE_INTERVAL);
    return () => clearInterval(timer);
  }, [market, scanResults.length, scanOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch FinMind historical institutional summaries when TW scan results appear
  useEffect(() => {
    if (market !== 'TW' || scanResults.length === 0) return;
    const tickers = scanResults.map(r => r.symbol.replace(/\.(TW|TWO)$/i, ''));
    fetchInstitutionalBatch(tickers).then(setInstData).catch(() => {});
  }, [market, scanResults]);

  // Fetch news sentiment on-demand when a scan row is expanded
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!expandedStock) return;
    const ticker = expandedStock.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    if (newsCache[ticker]) return;
    setNewsCache(c => ({ ...c, [ticker]: { sentiment: 0, summary: '', hasNews: false, loading: true } }));
    fetch(`/api/news/${ticker}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((d: { aggregateSentiment?: number; summary?: string; hasNews?: boolean }) => {
        setNewsCache(c => ({
          ...c,
          [ticker]: {
            sentiment: d.aggregateSentiment ?? 0,
            summary: d.summary ?? '',
            hasNews: d.hasNews ?? false,
            loading: false,
          },
        }));
      })
      .catch(() => {
        setNewsCache(c => ({ ...c, [ticker]: { sentiment: 0, summary: '無法取得', hasNews: false, loading: false } }));
      });
  }, [expandedStock]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  const availableConcepts = [...new Set(scanResults.map(r => r.industry).filter(Boolean))] as string[];

  const filteredScanResults = conceptFilter === 'all'
    ? scanResults
    : scanResults.filter(r => r.industry === conceptFilter);

  const sortedScanResults = [...filteredScanResults].sort((a, b) => {
    const dir = scanSortDir === 'desc' ? 1 : -1;
    switch (scanSort) {
      case 'composite':  return dir * (calcComposite(b) - calcComposite(a));
      case 'score':     return dir * ((b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0));
      case 'grade': {
        const gradeOrder: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1 };
        return dir * ((gradeOrder[b.surgeGrade ?? ''] ?? 0) - (gradeOrder[a.surgeGrade ?? ''] ?? 0));
      }
      case 'potential':  return dir * ((b.surgeScore ?? 0) - (a.surgeScore ?? 0));
      case 'winRate':    return dir * ((b.histWinRate ?? 0) - (a.histWinRate ?? 0));
      case 'price':      return dir * ((b.price ?? 0) - (a.price ?? 0));
      case 'change':     return dir * ((b.changePercent ?? 0) - (a.changePercent ?? 0));
      default:           return 0;
    }
  });

  // ── 三層分級：強烈推薦 / 值得關注 / 一般符合 ──
  const tierOf = (r: typeof scanResults[number]) => {
    const composite = calcComposite(r);
    if (r.sixConditionsScore >= 5 && composite >= 65) return 'top';
    if (r.sixConditionsScore >= 4 && composite >= 45) return 'watch';
    return 'normal';
  };

  const topCount = sortedScanResults.filter(r => tierOf(r) === 'top').length;
  const watchCount = sortedScanResults.filter(r => tierOf(r) === 'watch').length;

  // Heatmap cell background: value 0-max → opacity 0-40% of given color
  function heatBg(value: number, max: number, color: 'sky' | 'green' | 'orange'): string {
    if (!heatmapMode) return '';
    const t = Math.min(Math.max(value / max, 0), 1);
    const opacity = Math.round(t * 45);
    const colors = { sky: `rgba(56,189,248,${opacity / 100})`, green: `rgba(74,222,128,${opacity / 100})`, orange: `rgba(251,146,60,${opacity / 100})` };
    return colors[color];
  }

  if (!scanOnly) return null;

  if (scanResults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-3xl mb-3">🔍</p>
        <p className="text-sm font-medium text-muted-foreground">尚無掃描結果</p>
        <p className="text-xs text-muted-foreground/70 mt-1">選擇市場與策略後，點擊「開始掃描」即可查看結果</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span className="font-bold text-foreground">掃描結果</span>
        <span className="text-muted-foreground">{scanResults.length} 檔符合條件</span>
        <span className="text-[10px] text-muted-foreground/60" title="掃描的歷史資料日期">資料日期：{scanDate}</span>
        {marketTrend && (
          <span title={`大盤趨勢：${marketTrend}｜多頭＝大盤上漲，選股勝率較高｜盤整＝方向不明，需謹慎｜空頭＝大盤下跌，風險較大`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
            marketTrend === '多頭' ? 'bg-red-900/50 text-red-300' :
            marketTrend === '空頭' ? 'bg-green-900/50 text-green-300' :
            'bg-yellow-900/50 text-yellow-300'
          }`}>{String(marketTrend)}</span>
        )}
        {topCount > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-900/50 text-red-300">TOP {topCount}</span>}
        {watchCount > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-900/40 text-orange-300">關注 {watchCount}</span>}
        <Button
          onClick={() => setHeatmapMode(v => !v)}
          variant="outline"
          size="sm"
          title="熱力圖模式：數值越高顏色越深，快速辨別強弱"
          className={`text-[11px] px-2.5 py-1 h-auto bg-transparent ${heatmapMode ? 'border-amber-500/60 text-amber-400 bg-amber-900/20' : 'border-border text-muted-foreground hover:text-foreground'}`}
        >
          熱力圖
        </Button>
        <Button
          onClick={() => {
            const headers = ['代號','名稱','概念','評分','等級','潛力','勝率','信號次數','價格','漲跌%','趨勢','位置'];
            const rows = sortedScanResults.map(r => [
              r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''), r.name, r.industry ?? '',
              r.sixConditionsScore, r.surgeGrade ?? '', r.surgeScore ?? '',
              r.histWinRate != null ? `${r.histWinRate}%` : '', r.histSignalCount ?? '',
              r.price.toFixed(2), `${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(2)}%`,
              r.trendState, r.trendPosition,
            ]);
            const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `scan_${scanDate}_${market}.csv`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }}
          variant="outline"
          size="sm"
          className="ml-auto text-[11px] text-sky-400 hover:text-sky-300 px-2.5 py-1 h-auto border-sky-700/50 hover:bg-sky-900/30 bg-transparent"
        >
          匯出 CSV
        </Button>
      </div>
      {/* 概念篩選器 */}
      {availableConcepts.length > 1 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-muted-foreground mr-1">篩選：</span>
          <Button onClick={() => setConceptFilter('all')}
            variant={conceptFilter === 'all' ? 'default' : 'secondary'}
            size="sm"
            className={`text-[10px] px-2 py-0.5 h-auto rounded-full ${conceptFilter === 'all' ? 'bg-sky-700 hover:bg-sky-600' : ''}`}>
            全部 ({scanResults.length})
          </Button>
          {availableConcepts.sort().slice(0, 20).map(c => {
            const count = scanResults.filter(r => r.industry === c).length;
            return (
              <Button key={c} onClick={() => setConceptFilter(c)}
                variant={conceptFilter === c ? 'default' : 'secondary'}
                size="sm"
                className={`text-[10px] px-2 py-0.5 h-auto rounded-full ${conceptFilter === c ? 'bg-sky-700 hover:bg-sky-600' : ''}`}>
                {c} ({count})
              </Button>
            );
          })}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-1.5 px-2">代號</th>
              <th className="text-left py-1.5 px-2">名稱</th>
              <th className="text-left py-1.5 px-2">概念</th>
              {([
                { key: 'composite' as const, label: '綜合', align: 'text-center', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%\n越高代表多維度共振越強' },
                { key: 'score' as const, label: '評分', align: 'text-center', tooltip: '六大條件評分 (0-6)\n1.趨勢：頭頭高底底高+MA排列\n2.位置：MA20乖離0-12%或回踩MA10\n3.K棒：紅棒≥2%收上半部\n4.均線：MA5>MA10>MA20多頭排列\n5.量能：成交量≥5日均量×1.5倍\n6.指標：MACD紅柱或KD黃金交叉' },
                { key: 'grade' as const, label: '等級', align: 'text-center', tooltip: '飆股潛力等級\nS級(80+)：極強飆股特徵\nA級(65-79)：強勢股\nB級(50-64)：中等潛力\nC級(35-49)：偏弱\nD級(<35)：不具飆股特徵' },
                { key: 'potential' as const, label: '潛力', align: 'text-center', tooltip: '飆股潛力分數 (0-100)\n動能(18%)+波動率(12%)+量能(15%)\n+突破(15%)+趨勢品質(15%)\n+價格位置(5%)+K棒強度(5%)\n+指標共振(5%)+長期品質(10%)' },
                { key: 'winRate' as const, label: '勝率', align: 'text-center', tooltip: '歷史勝率：過去同類信號\n在相同策略參數下的獲利比率\n基於回測歷史交易計算' },
                { key: 'price' as const, label: '價格', align: 'text-right', tooltip: '' },
                { key: 'change' as const, label: '漲跌%', align: 'text-right', tooltip: '' },
              ]).map(({ key, label, align, tooltip }) => (
                <th key={key}
                  title={tooltip || undefined}
                  className={`${align} py-1.5 px-1 cursor-pointer hover:text-foreground select-none`}
                  onClick={() => {
                    if (scanSort === key) setScanSortDir(d => d === 'desc' ? 'asc' : 'desc');
                    else { setScanSort(key); setScanSortDir('desc'); }
                  }}>
                  {label}{tooltip && <span className="text-[8px] text-muted-foreground/60 ml-0.5">ⓘ</span>}
                  {scanSort === key && <span className="ml-0.5 text-sky-400">{scanSortDir === 'desc' ? '▼' : '▲'}</span>}
                </th>
              ))}
              <th className="text-left py-1.5 px-2 whitespace-nowrap">趨勢</th>
              <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
              <th className="text-center py-1.5 px-2 whitespace-nowrap"
                title="籌碼面評分 (0-100)\nS(80+)=主力強力買超\nA(65-79)=法人偏多\nB(50-64)=中性\nC(35-49)=法人偏空\nD(<35)=主力出貨\n\n依據：三大法人買賣超+融資融券+大額交易人+當沖比例">籌碼ⓘ</th>
              <th className="text-center py-1.5 px-2 whitespace-nowrap" title="FinMind: 外資近5日淨買超（張）">外資5日</th>
              <th className="text-center py-1.5 px-2 whitespace-nowrap" title="FinMind: 外資連續買超天數">連買</th>
              <th className="text-center py-1.5 px-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedScanResults.slice(0, 50).map((r) => (<Fragment key={r.symbol}>
              <tr className={`border-b border-border/50 hover:bg-secondary/40 cursor-pointer ${expandedStock === r.symbol ? 'bg-secondary/60' : ''}`}
                onClick={() => setExpandedStock(expandedStock === r.symbol ? null : r.symbol)}>
                <td className="py-1.5 px-2 font-mono font-bold text-foreground">
                  <div className="flex items-center gap-1">
                    {r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}
                    {tierOf(r) === 'top' && <span className="text-[8px] px-1 py-0 rounded bg-red-600 text-white font-bold leading-tight">TOP</span>}
                    {tierOf(r) === 'watch' && <span className="text-[8px] px-1 py-0 rounded bg-orange-600/80 text-white font-bold leading-tight">!</span>}
                  </div>
                </td>
                <td className="py-1.5 px-2">
                  <div className="text-foreground/80">{r.name}</div>
                  <div className="flex gap-0.5 mt-0.5">
                    {[
                      { pass: r.sixConditionsBreakdown.trend, label: '趨' },
                      { pass: r.sixConditionsBreakdown.position, label: '位' },
                      { pass: r.sixConditionsBreakdown.kbar, label: 'K' },
                      { pass: r.sixConditionsBreakdown.ma, label: '均' },
                      { pass: r.sixConditionsBreakdown.volume, label: '量' },
                      { pass: r.sixConditionsBreakdown.indicator, label: '指' },
                    ].map(({ pass, label }) => (
                      <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-secondary/50 text-muted-foreground/60'}`}>{label}</span>
                    ))}
                  </div>
                </td>
                <td className="py-1.5 px-1 text-[10px] text-muted-foreground max-w-[60px] truncate" title={r.industry}>{r.industry ?? '—'}</td>
                <td className="py-1.5 px-1 text-center" style={{ background: heatBg(calcComposite(r), 100, 'sky') }}>
                  {(() => {
                    const cs = calcComposite(r);
                    return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-foreground' : 'text-muted-foreground'}`}>{cs.toFixed(1)}</span>;
                  })()}
                </td>
                <td className="py-1.5 px-1 text-center" style={{ background: heatBg(r.sixConditionsScore, 6, 'green') }}>
                  <span className={`font-bold ${r.sixConditionsScore >= 5 ? 'text-bull' : r.sixConditionsScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
                    {r.sixConditionsScore}/6
                  </span>
                </td>
                <td className="py-1.5 px-1 text-center">
                  {r.surgeGrade && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      r.surgeGrade === 'S' ? 'bg-red-600 text-foreground' :
                      r.surgeGrade === 'A' ? 'bg-orange-500 text-foreground' :
                      r.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
                      'bg-muted text-foreground/80'
                    }`}>{r.surgeGrade}</span>
                  )}
                </td>
                <td className="py-1.5 px-1 text-center font-mono text-foreground/80" style={{ background: heatBg(r.surgeScore ?? 0, 100, 'orange') }}>{r.surgeScore ?? '—'}</td>
                <td className="py-1.5 px-1 text-center" style={{ background: heatBg(r.histWinRate ?? 0, 100, 'green') }}>
                  {r.histWinRate != null && (
                    <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}
                      title={`基於過去 ${r.histSignalCount ?? '?'} 次同類信號的歷史勝率`}>
                      {r.histWinRate}%<span className="text-[8px] opacity-60">({r.histSignalCount ?? '?'})</span>
                    </span>
                  )}
                </td>
                {(() => {
                  const sym = r.symbol.replace(/\.(TW|TWO)$/i, '');
                  const rt = realtimePrices.get(sym);
                  const price = rt?.price ?? r.price;
                  const chgPct = rt?.changePct ?? r.changePercent;
                  return (<>
                    <td className="py-1.5 px-2 text-right font-mono text-foreground" title={rt ? `即時 ${rt.time}` : '掃描時價格'}>
                      {price.toFixed(2)}
                      {rt && <span className="text-[8px] text-sky-500 ml-0.5">⚡</span>}
                    </td>
                    <td className={`py-1.5 px-2 text-right font-mono font-bold ${chgPct >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%
                    </td>
                  </>);
                })()}
                <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{r.trendState}</td>
                <td className="py-1.5 px-2 text-[10px] text-muted-foreground whitespace-nowrap">{r.trendPosition}</td>
                <td className="py-1.5 px-2 text-center whitespace-nowrap">
                  {chipBadge(r.chipScore, r.chipGrade, r.chipSignal, chipTooltip(r))}
                </td>
                <td className="py-1.5 px-2 text-center whitespace-nowrap font-mono text-xs">
                  {(() => {
                    const inst = instData.get(r.symbol.replace(/\.(TW|TWO)$/i, ''));
                    if (!inst) return <span className="text-muted-foreground/60">—</span>;
                    const v = inst.foreignNet5d;
                    return <span className={v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-muted-foreground'}>
                      {v > 0 ? '+' : ''}{v.toLocaleString()}
                    </span>;
                  })()}
                </td>
                <td className="py-1.5 px-2 text-center whitespace-nowrap text-xs">
                  {(() => {
                    const inst = instData.get(r.symbol.replace(/\.(TW|TWO)$/i, ''));
                    if (!inst || inst.consecutiveForeignBuy === 0) return <span className="text-muted-foreground/60">—</span>;
                    return <span className={`font-bold ${inst.consecutiveForeignBuy >= 3 ? 'text-bull' : 'text-foreground/80'}`}>
                      {inst.consecutiveForeignBuy}日
                    </span>;
                  })()}
                </td>
                <td className="py-1.5 px-2 text-center whitespace-nowrap">
                  <Link href={`/?load=${r.symbol}&date=${scanDate}`}
                    className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">
                    走圖
                  </Link>
                  <Button
                    onClick={(e) => {
                      useWatchlistStore.getState().add(r.symbol, r.name);
                      const btn = e.currentTarget;
                      btn.textContent = '✓ 已加';
                      setTimeout(() => { btn.textContent = '+自選'; }, 1200);
                    }}
                    variant="outline"
                    size="sm"
                    className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 h-auto border-amber-700/50 hover:bg-amber-900/30 bg-transparent">
                    {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                  </Button>
                </td>
              </tr>
              {expandedStock === r.symbol && (
                <tr className="bg-card/80">
                  <td colSpan={13} className="px-4 py-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[11px]">
                      {/* 飆股組件分數 */}
                      {r.surgeComponents && (
                        <div className="space-y-1.5">
                          <div className="text-muted-foreground font-medium">飆股潛力分解</div>
                          {([
                            { key: 'momentum', label: '動能', w: '18%' },
                            { key: 'volatility', label: '波動', w: '12%' },
                            { key: 'volume', label: '量能', w: '15%' },
                            { key: 'breakout', label: '突破', w: '15%' },
                            { key: 'trendQuality', label: '趨勢', w: '15%' },
                            { key: 'pricePosition', label: '位置', w: '5%' },
                            { key: 'kbarStrength', label: 'K棒', w: '5%' },
                            { key: 'indicatorConfluence', label: '指標', w: '5%' },
                            { key: 'longTermQuality', label: '長期', w: '10%' },
                          ] as const).map(({ key, label, w }) => {
                            const comp = r.surgeComponents![key];
                            return (
                              <div key={key} className="flex items-center gap-2">
                                <span className="w-8 text-muted-foreground">{label}</span>
                                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${comp.score >= 70 ? 'bg-red-500' : comp.score >= 40 ? 'bg-amber-500' : 'bg-muted'}`}
                                    style={{ width: `${comp.score}%` }} />
                                </div>
                                <span className="w-6 text-right text-muted-foreground">{comp.score}</span>
                                <span className="text-[9px] text-muted-foreground/60">({w})</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* 飆股特徵標籤 */}
                      <div className="space-y-1.5">
                        <div className="text-muted-foreground font-medium">技術特徵</div>
                        <div className="flex flex-wrap gap-1">
                          {(r.surgeFlags ?? []).map(f => (
                            <span key={f} className="px-1.5 py-0.5 bg-sky-900/40 text-sky-300 rounded text-[10px]">{f}</span>
                          ))}
                          {(r.surgeFlags ?? []).length === 0 && <span className="text-muted-foreground/60">無明顯飆股特徵</span>}
                        </div>
                        <div className="text-muted-foreground font-medium mt-2">趨勢摘要</div>
                        <div className="text-foreground/80 text-[10px] space-y-0.5">
                          <div>趨勢：{r.trendState} · {r.trendPosition}</div>
                          <div>價格：{r.price.toFixed(2)} · 漲跌：{r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%</div>
                          <div>成交量：{(r.volume / 1000).toFixed(0)}K</div>
                        </div>
                      </div>
                      {/* 觸發規則 */}
                      <div className="space-y-1.5">
                        <div className="text-muted-foreground font-medium">觸發的交易規則</div>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {r.triggeredRules.slice(0, 8).map((rule, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-[10px]">
                              <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${rule.signalType === 'BUY' ? 'bg-bull' : 'bg-bear'}`} />
                              <span className="text-muted-foreground">{rule.reason}</span>
                            </div>
                          ))}
                          {r.triggeredRules.length === 0 && <span className="text-muted-foreground/60 text-[10px]">無觸發規則</span>}
                        </div>
                        {/* 高勝率進場位置 */}
                        {(r.highWinRateDetails ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="text-amber-400 font-medium text-[10px] mb-0.5">高勝率進場</div>
                            {r.highWinRateDetails!.map((d, i) => (
                              <div key={i} className="text-[10px] text-amber-300/80">{d}</div>
                            ))}
                          </div>
                        )}
                        {/* 贏家圖像 */}
                        {((r.winnerBullishPatterns ?? []).length > 0 || (r.winnerBearishPatterns ?? []).length > 0) && (
                          <div className="mt-2">
                            <div className="text-muted-foreground font-medium text-[10px] mb-0.5">贏家圖像</div>
                            {(r.winnerBullishPatterns ?? []).map((p, i) => (
                              <div key={`b${i}`} className="text-[10px] text-red-300">+ {p}</div>
                            ))}
                            {(r.winnerBearishPatterns ?? []).map((p, i) => (
                              <div key={`s${i}`} className="text-[10px] text-green-300">- {p}</div>
                            ))}
                          </div>
                        )}
                        {/* 淘汰法警示 */}
                        {(r.eliminationReasons ?? []).length > 0 && (
                          <div className="mt-2">
                            <div className="text-orange-400 font-medium text-[10px] mb-0.5">風險提示 (-{r.eliminationPenalty ?? 0}分)</div>
                            {r.eliminationReasons!.map((reason, i) => (
                              <div key={i} className="text-[10px] text-orange-300/70">{reason}</div>
                            ))}
                          </div>
                        )}
                        {/* 切線突破 */}
                        {(r.trendlineBreakAbove || r.trendlineBreakBelow) && (
                          <div className="mt-2">
                            <div className="text-muted-foreground font-medium text-[10px] mb-0.5">切線分析</div>
                            {r.trendlineBreakAbove && <div className="text-[10px] text-red-300">突破下降切線（多方轉強）</div>}
                            {r.trendlineBreakBelow && <div className="text-[10px] text-green-300">跌破上升切線（多頭轉弱）</div>}
                          </div>
                        )}
                      </div>
                      {/* 新聞情緒（on-demand） */}
                      {(() => {
                        const tk = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                        const nd = newsCache[tk];
                        if (!nd) return null;
                        return (
                          <div className="space-y-1.5">
                            <div className="text-muted-foreground font-medium">新聞情緒</div>
                            {nd.loading ? (
                              <span className="text-[10px] text-muted-foreground animate-pulse">載入中…</span>
                            ) : nd.hasNews ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                    nd.sentiment > 0.1  ? 'bg-red-900/50 text-red-300' :
                                    nd.sentiment < -0.1 ? 'bg-green-900/50 text-green-300' :
                                                           'bg-muted/50 text-muted-foreground'
                                  }`}>
                                    {nd.sentiment > 0.1 ? '偏多' : nd.sentiment < -0.1 ? '偏空' : '中性'}
                                    <span className="ml-1 opacity-60 font-normal">({nd.sentiment.toFixed(2)})</span>
                                  </span>
                                </div>
                                <p className="text-[10px] text-muted-foreground leading-relaxed">{nd.summary}</p>
                              </>
                            ) : (
                              <span className="text-[10px] text-muted-foreground/60">近期無相關新聞</span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {scanResults.length > 50 && (
        <div className="text-xs text-muted-foreground text-center space-y-0.5">
          <div>顯示前 50 檔（共 {filteredScanResults.length}{conceptFilter !== 'all' ? `/${scanResults.length}` : ''} 檔）</div>
          <div className="text-[10px] text-muted-foreground/60">數據來源：Yahoo Finance · TWSE/TPEx/東方財富 · 掃描日期 {scanDate}</div>
        </div>
      )}
    </div>
  );
}
