'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useBacktestStore, BacktestHorizon } from '@/store/backtestStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { calcComposite, chipTooltip, retColor, fmtRet, exportToCsv } from '../utils';
import { chipBadge, TradeRow, calcTradeComposite } from './TradeRow';
import { HorizonCard } from './HorizonCard';
import { BacktestStatsPanel } from './BacktestStatsPanel';
import { CapitalPanel } from './CapitalPanel';
import { WalkForwardPanel } from './WalkForwardPanel';

export function BacktestSection() {
  const {
    scanResults,
    scanDate,
    market,
    trades,
    stats,
    performance,
    sessions,
    useCapitalMode,
    capitalConstraints,
    finalCapital,
    capitalReturn,
    skippedByCapital,
    walkForwardConfig,
    walkForwardResult,
    isRunningWF,
    computeWalkForward,
    setWalkForwardConfig,
    scanOnly,
  } = useBacktestStore();

  const [tab, setTab] = useState<'strict' | 'horizon' | 'walkforward'>('strict');
  const [activeHorizon, setHorizon] = useState<BacktestHorizon>('d5');
  const [sortBy, setSortBy] = useState<'composite' | 'netReturn' | 'signalScore' | 'surgeScore' | 'histWinRate' | 'holdDays'>('composite');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [scanSort, setScanSort] = useState<'composite' | 'score' | 'grade' | 'potential' | 'winRate' | 'price' | 'change'>('composite');
  const [scanSortDir, setScanSortDir] = useState<'asc' | 'desc'>('desc');

  const horizonLabels: { key: BacktestHorizon; label: string }[] = [
    { key: 'open', label: '隔日開' }, { key: 'd1', label: '1日' },
    { key: 'd2', label: '2日' },     { key: 'd3', label: '3日' },
    { key: 'd4', label: '4日' },     { key: 'd5', label: '5日' },
    { key: 'd10', label: '10日' },   { key: 'd20', label: '20日' },
  ];

  const perfMap = useMemo(() => new Map(performance.map(p => [p.symbol, p])), [performance]);

  const sortedTrades = [...trades].sort((a, b) => {
    const dir = sortDir === 'desc' ? 1 : -1;
    if (sortBy === 'composite')    return dir * (calcTradeComposite(b, scanResults) - calcTradeComposite(a, scanResults));
    if (sortBy === 'netReturn')    return dir * (b.netReturn - a.netReturn);
    if (sortBy === 'signalScore')  return dir * (b.signalScore - a.signalScore);
    if (sortBy === 'surgeScore')   return dir * ((b.surgeScore ?? 0) - (a.surgeScore ?? 0));
    if (sortBy === 'histWinRate')  return dir * ((b.histWinRate ?? 0) - (a.histWinRate ?? 0));
    if (sortBy === 'holdDays')     return dir * (a.holdDays - b.holdDays);
    return 0;
  });

  const sortedScanResults = [...scanResults].sort((a, b) => {
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

  if (scanOnly) return null;

  return (
    <>
      <div className="flex items-center gap-1 border-b border-slate-800">
        {([
          { key: 'strict',      label: '嚴謹回測',    icon: '🔬' },
          { key: 'horizon',     label: '時間視角',    icon: '📊' },
          { key: 'walkforward', label: 'Walk-Forward', icon: '🔁' },
        ] as const).map(({ key, label, icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-sky-500 text-sky-300'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}>
            <span>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Tab descriptions */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-lg px-4 py-2.5 text-xs text-slate-500">
        {tab === 'strict' && '🔬 嚴謹回測：模擬真實交易（含手續費0.1425%、證交稅0.3%、滑點），計算每筆交易的淨報酬。可設定止損/止盈/持有天數。'}
        {tab === 'horizon' && '📊 時間視角：檢視信號發出後 1/5/10/20 天的報酬率分佈，了解不同持有期間的表現差異。'}
        {tab === 'walkforward' && '🔁 Walk-Forward：將數據分成多個訓練/測試窗口，在訓練期優化策略後在測試期驗證，確保策略不是過度擬合。這是最嚴格的驗證方法。'}
      </div>

      {/* ── Tab: Strict ── */}
      {tab === 'strict' && (
        <div className="space-y-4">
          {stats && <BacktestStatsPanel stats={stats} tradesCount={trades.length} trades={trades} />}
          {useCapitalMode && trades.length > 0 && (
            <CapitalPanel
              trades={trades}
              constraints={capitalConstraints}
              finalCapital={finalCapital}
              capitalReturn={capitalReturn}
              skippedByCapital={skippedByCapital}
            />
          )}

          <div className="flex items-center justify-end mb-2">
            <button
              onClick={() => exportToCsv(sortedTrades, scanDate)}
              disabled={sortedTrades.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded-lg text-[11px] text-slate-300 hover:text-white transition-colors"
            >
              匯出 CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  <th className="text-left py-1.5 px-2">代號</th>
                  <th className="text-left py-1.5 px-2">名稱</th>
                  <th className="text-left py-1.5 px-2">概念</th>
                  {([
                    { key: 'composite' as const, label: '綜合', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%\n越高代表多維度共振越強' },
                    { key: 'signalScore' as const, label: '評分', tooltip: '六大條件評分 (0-6)\n1.趨勢 2.位置 3.K棒\n4.均線 5.量能 6.指標\n≥4分才列入選股' },
                    { key: 'surgeScore' as const, label: '等級', tooltip: '飆股潛力等級\nS(80+) A(65-79) B(50-64)\nC(35-49) D(<35)' },
                    { key: 'surgeScore' as const, label: '潛力', tooltip: '飆股潛力分 (0-100)\n9大維度加權：動能18% 量能15%\n突破15% 趨勢15% 波動12%\n長線10% 位置5% K棒5% 共振5%' },
                    { key: 'histWinRate' as const, label: '勝率', tooltip: '歷史勝率\n過去120天同類信號\n隔日開盤買→持有5日賣\n有多少次是賺錢的' },
                  ]).map(({ key, label, tooltip }) => (
                    <th key={label}
                      title={tooltip || undefined}
                      className="text-center py-1.5 px-1 cursor-pointer hover:text-white select-none"
                      onClick={() => {
                        if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                        else { setSortBy(key); setSortDir('desc'); }
                      }}>
                      {label}{tooltip && <span className="text-[8px] text-slate-600 ml-0.5">ⓘ</span>}
                      {sortBy === key && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                    </th>
                  ))}
                  <th className="text-right py-1.5 px-2 whitespace-nowrap">進場價</th>
                  <th className="text-center py-1.5 px-2 whitespace-nowrap">趨勢</th>
                  <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
                  <th className="text-center py-1.5 px-2 whitespace-nowrap" title="籌碼面評分 (0-100)\nS(80+)=主力強力買超\nA(65-79)=法人偏多\nB(50-64)=中性\nC(35-49)=法人偏空\nD(<35)=主力出貨\n\n依據：三大法人買賣超+融資融券+大額交易人+當沖比例">籌碼ⓘ</th>
                  <th className="text-right py-1.5 px-2 whitespace-nowrap">出場價</th>
                  <th className="text-center py-1.5 px-2 whitespace-nowrap cursor-pointer hover:text-white select-none"
                    onClick={() => {
                      if (sortBy === 'holdDays') setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                      else { setSortBy('holdDays'); setSortDir('desc'); }
                    }}>
                    持有{sortBy === 'holdDays' && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                  </th>
                  <th className="text-right py-1.5 px-2 whitespace-nowrap cursor-pointer hover:text-white select-none"
                    onClick={() => {
                      if (sortBy === 'netReturn') setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                      else { setSortBy('netReturn'); setSortDir('desc'); }
                    }}>
                    淨報酬{sortBy === 'netReturn' && <span className="ml-0.5 text-sky-400">{sortDir === 'desc' ? '▼' : '▲'}</span>}
                  </th>
                  <th className="text-center py-1.5 px-1">出場</th>
                  <th className="text-center py-1.5 px-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedTrades.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-center py-10 text-slate-500">
                      <div className="text-2xl mb-2">📭</div>
                      <div className="text-sm">目前無回測交易紀錄</div>
                      <div className="text-xs mt-1 text-slate-600">
                        若掃描日期為今日或近期，需等待後續交易日的開盤資料才能回測。
                        建議改用過去日期重新掃描。
                      </div>
                    </td>
                  </tr>
                ) : sortedTrades.map(t => {
                  const sym = t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                  const sr = scanResults.find(r => r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === sym);
                  const chip = sr?.chipScore != null ? { chipScore: sr.chipScore!, chipGrade: sr.chipGrade!, chipSignal: sr.chipSignal!, foreignBuy: sr.foreignBuy ?? 0, trustBuy: sr.trustBuy ?? 0, marginNet: sr.marginNet ?? 0 } : undefined;
                  return <TradeRow key={t.symbol + t.entryDate} t={t} chip={chip} composite={calcTradeComposite(t, scanResults)} />;
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab: Horizon ── */}
      {tab === 'horizon' && performance.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
            {horizonLabels.map(({ key, label }) => (
              <HorizonCard key={key} label={label} horizon={key} performance={performance} />
            ))}
          </div>

          <div className="overflow-x-auto">
            <div className="flex gap-1 mb-2">
              {horizonLabels.map(({ key, label }) => (
                <button key={key} onClick={() => setHorizon(key)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    activeHorizon === key ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400">
                  <th className="text-left py-1.5 px-2">代號</th>
                  <th className="text-left py-1.5 px-2">名稱</th>
                  <th className="text-left py-1.5 px-2">概念</th>
                  {([
                    { key: 'composite' as const, label: '綜合', tooltip: '綜合評分 (0-100)\n六條件35% + 潛力25% + 勝率20%\n+ 位置10% + 量能10%' },
                    { key: 'score' as const, label: '評分', tooltip: '六大條件評分 (0-6)\n1.趨勢 2.位置 3.K棒\n4.均線 5.量能 6.指標' },
                    { key: 'grade' as const, label: '等級', tooltip: '飆股潛力等級\nS(80+) A(65-79) B(50-64)\nC(35-49) D(<35)' },
                    { key: 'potential' as const, label: '潛力', tooltip: '飆股潛力分 (0-100)\n9大維度加權計算' },
                    { key: 'winRate' as const, label: '勝率', tooltip: '過去120天同類信號的歷史勝率' },
                    { key: 'price' as const, label: '價格', tooltip: '' },
                    { key: 'change' as const, label: '漲跌%', tooltip: '' },
                  ]).map(({ key, label, tooltip }) => (
                    <th key={key}
                      title={tooltip || undefined}
                      className={`${key === 'price' || key === 'change' ? 'text-right' : 'text-center'} py-1.5 px-1 cursor-pointer hover:text-white select-none`}
                      onClick={() => {
                        if (scanSort === key) setScanSortDir(d => d === 'desc' ? 'asc' : 'desc');
                        else { setScanSort(key); setScanSortDir('desc'); }
                      }}>
                      {label}{tooltip && <span className="text-[8px] text-slate-600 ml-0.5">ⓘ</span>}
                      {scanSort === key && <span className="ml-0.5 text-sky-400">{scanSortDir === 'desc' ? '▼' : '▲'}</span>}
                    </th>
                  ))}
                  <th className="text-left py-1.5 px-2 whitespace-nowrap">趨勢</th>
                  <th className="text-left py-1.5 px-2 whitespace-nowrap">位置</th>
                  <th className="text-center py-1.5 px-2 whitespace-nowrap" title="籌碼面評分 (0-100)\nS(80+)=主力強力買超\nA(65-79)=法人偏多\nB(50-64)=中性\nC(35-49)=法人偏空\nD(<35)=主力出貨\n\n依據：三大法人買賣超+融資融券+大額交易人+當沖比例">籌碼ⓘ</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">隔日開</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">1日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">2日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">3日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">4日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">5日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">10日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">20日</th>
                  <th className="text-right py-1.5 px-1.5 whitespace-nowrap">最高/最低</th>
                  <th className="text-center py-1.5 px-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedScanResults.map(r => {
                  const p = perfMap.get(r.symbol);
                  const sym = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                  return (
                    <tr key={r.symbol} className="border-b border-slate-800/50 hover:bg-slate-800/40">
                      <td className="py-1.5 px-2 font-mono font-bold text-white">{sym}</td>
                      <td className="py-1.5 px-2">
                        <div className="text-slate-300">{r.name}</div>
                        <div className="flex gap-0.5 mt-0.5">
                          {[
                            { pass: r.sixConditionsBreakdown.trend, label: '趨' },
                            { pass: r.sixConditionsBreakdown.position, label: '位' },
                            { pass: r.sixConditionsBreakdown.kbar, label: 'K' },
                            { pass: r.sixConditionsBreakdown.ma, label: '均' },
                            { pass: r.sixConditionsBreakdown.volume, label: '量' },
                            { pass: r.sixConditionsBreakdown.indicator, label: '指' },
                          ].map(({ pass, label }) => (
                            <span key={label} className={`text-[8px] w-3.5 h-3.5 flex items-center justify-center rounded-sm ${pass ? 'bg-sky-800/80 text-sky-300' : 'bg-slate-800/50 text-slate-600'}`}>{label}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-1.5 px-1 text-[10px] text-slate-500 max-w-[60px] truncate" title={r.industry}>{r.industry ?? '—'}</td>
                      <td className="py-1.5 px-1 text-center">
                        {(() => { const cs = calcComposite(r); return <span className={`font-bold text-[11px] ${cs >= 70 ? 'text-sky-400' : cs >= 55 ? 'text-slate-200' : 'text-slate-500'}`}>{cs.toFixed(1)}</span>; })()}
                      </td>
                      <td className="py-1.5 px-1 text-center">
                        <span className={`font-bold ${r.sixConditionsScore >= 5 ? 'text-red-400' : r.sixConditionsScore >= 4 ? 'text-orange-400' : 'text-yellow-400'}`}>
                          {r.sixConditionsScore}/6
                        </span>
                      </td>
                      <td className="py-1.5 px-1 text-center">
                        {r.surgeGrade && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            r.surgeGrade === 'S' ? 'bg-red-600 text-white' :
                            r.surgeGrade === 'A' ? 'bg-orange-500 text-white' :
                            r.surgeGrade === 'B' ? 'bg-yellow-500 text-black' :
                            'bg-slate-600 text-slate-300'
                          }`}>{r.surgeGrade}</span>
                        )}
                      </td>
                      <td className="py-1.5 px-1 text-center font-mono text-slate-300">{r.surgeScore ?? '—'}</td>
                      <td className="py-1.5 px-1 text-center">
                        {r.histWinRate != null && (
                          <span className={`text-[10px] px-1 rounded ${r.histWinRate >= 60 ? 'bg-green-900/60 text-green-300' : r.histWinRate >= 50 ? 'bg-yellow-900/60 text-yellow-300' : 'bg-red-900/60 text-red-300'}`}>
                            {r.histWinRate}%<span className="text-[8px] opacity-60">({r.histSignalCount ?? '?'})</span>
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-white">{r.price.toFixed(2)}</td>
                      <td className={`py-1.5 px-2 text-right font-mono font-bold ${r.changePercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                      </td>
                      <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendState}</td>
                      <td className="py-1.5 px-2 text-[10px] text-slate-400 whitespace-nowrap">{r.trendPosition}</td>
                      <td className="py-1.5 px-2 text-center whitespace-nowrap">
                        {chipBadge(r.chipScore, r.chipGrade, r.chipSignal, chipTooltip(r))}
                      </td>
                      {p ? (
                        <>
                          {[p.openReturn, p.d1Return, p.d2Return, p.d3Return, p.d4Return, p.d5Return, p.d10Return, p.d20Return].map((v, i) => (
                            <td key={i} className={`py-1.5 px-1 text-right font-mono ${retColor(v)}`}>{fmtRet(v)}</td>
                          ))}
                          <td className="py-1.5 px-1 text-right whitespace-nowrap">
                            <span className="text-red-400">+{p.maxGain.toFixed(1)}%</span>
                            <span className="text-slate-600">/</span>
                            <span className="text-green-500">{p.maxLoss.toFixed(1)}%</span>
                          </td>
                        </>
                      ) : (
                        <td colSpan={9} className="py-1.5 text-center text-slate-600">—</td>
                      )}
                      <td className="py-1.5 px-2 text-center whitespace-nowrap">
                        <Link href={`/?load=${sym}&date=${scanDate}`}
                          className="text-[10px] text-sky-400 hover:text-sky-300 px-1.5 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30 mr-1">走圖</Link>
                        <Link href={`/analysis/${r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                          className="text-[10px] text-violet-400 hover:text-violet-300 px-1.5 py-0.5 rounded border border-violet-700/50 hover:bg-violet-900/30 mr-1">AI分析</Link>
                        <button onClick={() => { useWatchlistStore.getState().add(r.symbol, r.name); }}
                          className="text-[10px] text-amber-400 hover:text-amber-300 px-1.5 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                          {useWatchlistStore.getState().has(r.symbol) ? '✓ 已加' : '+自選'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tab: Walk-Forward ── */}
      {tab === 'walkforward' && (
        <WalkForwardPanel
          result={walkForwardResult}
          sessionCount={sessions.filter(s => s.market === market).length}
          minRequired={walkForwardConfig.trainSize + walkForwardConfig.testSize}
          isRunning={isRunningWF}
          onRun={computeWalkForward}
          trainSize={walkForwardConfig.trainSize}
          testSize={walkForwardConfig.testSize}
          stepSize={walkForwardConfig.stepSize}
          onTrainSize={n => setWalkForwardConfig({ trainSize: n })}
          onTestSize={n  => setWalkForwardConfig({ testSize: n })}
          onStepSize={n  => setWalkForwardConfig({ stepSize: n })}
        />
      )}
    </>
  );
}
