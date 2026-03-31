'use client';

import { useState } from 'react';

interface BacktestTradeResult {
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  entrySignal: string;
  exitReason: string;
  pnl: number;
  returnPct: number;
}

interface BacktestDailyRow {
  date: string;
  totalPnL: number;
  winRate: number;
  trades: BacktestTradeResult[];
}

interface BacktestDaySummary {
  date: string;
  returnPct: number;
}

interface BacktestResult {
  stockName: string;
  timeframe: string;
  daysCount: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  totalPnL: number;
  totalReturnPct: number;
  totalTrades: number;
  avgTradesPerDay: number;
  profitFactor: number;
  avgTradeReturn: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  sharpeApprox: number;
  bestDay: BacktestDaySummary | null;
  worstDay: BacktestDaySummary | null;
  dailyResults: BacktestDailyRow[];
  allTrades: BacktestTradeResult[];
}

export function SignalBacktestPanel({ symbol }: { symbol: string }) {
  const [days, setDays] = useState(10);
  const [tf, setTf] = useState('5m');
  const [stopLoss, setStopLoss] = useState(-2);
  const [takeProfit, setTakeProfit] = useState(3);
  const [capital] = useState(1000000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState('');
  const [showTrades, setShowTrades] = useState(false);

  const runBacktest = async (overrideDays?: number) => {
    const d = overrideDays ?? days;
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await fetch(
        `/api/daytrade/signal-backtest?symbol=${symbol}&days=${d}&timeframe=${tf}&capital=${capital}&stopLoss=${stopLoss}&takeProfit=${takeProfit}`
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'API Error');
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const retCls = (v: number) => v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-slate-400';
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-sky-300">訊號交易回測</div>
      <div className="text-center text-[10px] text-slate-500">按系統訊號自動買賣，看歷史勝率</div>

      {/* Config */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-slate-500 text-[10px]">回測天數</label>
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={1}>今日</option>
            <option value={5}>5天</option>
            <option value={10}>10天</option>
            <option value={20}>20天</option>
            <option value={30}>30天</option>
            <option value={60}>60天</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">K線週期</label>
          <select value={tf} onChange={e => setTf(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value="1m">1分</option>
            <option value="5m">5分</option>
            <option value="15m">15分</option>
            <option value="60m">60分</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">停損%</label>
          <select value={stopLoss} onChange={e => setStopLoss(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={-1}>-1%</option>
            <option value={-1.5}>-1.5%</option>
            <option value={-2}>-2%</option>
            <option value={-3}>-3%</option>
            <option value={-5}>-5%</option>
          </select>
        </div>
        <div>
          <label className="text-slate-500 text-[10px]">停利%</label>
          <select value={takeProfit} onChange={e => setTakeProfit(+e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white">
            <option value={1}>+1%</option>
            <option value={2}>+2%</option>
            <option value={3}>+3%</option>
            <option value={5}>+5%</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => { setDays(1); runBacktest(1); }} disabled={loading}
          className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white py-2 rounded font-bold">
          {loading && days === 1 ? '...' : '回測今日'}
        </button>
        <button onClick={() => runBacktest()} disabled={loading}
          className="flex-1 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white py-2 rounded font-bold">
          {loading ? '回測中...' : `近${days}天`}
        </button>
      </div>

      {error && <div className="text-red-400 text-center">{error}</div>}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <div className="text-center text-slate-400 text-[10px]">
            {result.stockName} · {result.timeframe} · {result.daysCount}天
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-2 gap-2">
            <div className={`rounded p-2 text-center ${result.winRate >= 50 ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
              <div className="text-slate-400 text-[10px]">勝率</div>
              <div className={`text-lg font-black ${result.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>
                {result.winRate}%
              </div>
              <div className="text-[10px] text-slate-500">{result.winCount}勝 {result.lossCount}敗</div>
            </div>
            <div className={`rounded p-2 text-center ${result.totalPnL >= 0 ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
              <div className="text-slate-400 text-[10px]">總損益</div>
              <div className={`text-lg font-black ${retCls(result.totalPnL)}`}>
                {result.totalPnL >= 0 ? '+' : ''}{Math.round(result.totalPnL).toLocaleString()}
              </div>
              <div className={`text-[10px] ${retCls(result.totalReturnPct)}`}>{fmt(result.totalReturnPct)}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">總交易</div>
              <div className="text-white font-bold">{result.totalTrades}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">日均交易</div>
              <div className="text-white font-bold">{result.avgTradesPerDay.toFixed(1)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">盈虧比</div>
              <div className={`font-bold ${result.profitFactor >= 1 ? 'text-red-400' : 'text-green-400'}`}>
                {result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}
              </div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均報酬</div>
              <div className={`font-bold font-mono ${retCls(result.avgTradeReturn)}`}>{fmt(result.avgTradeReturn)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均獲利</div>
              <div className="font-bold font-mono text-red-400">{fmt(result.avgWin)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">均虧損</div>
              <div className="font-bold font-mono text-green-400">{fmt(result.avgLoss)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">最大獲利</div>
              <div className="font-bold font-mono text-red-400">{fmt(result.maxWin)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">最大虧損</div>
              <div className="font-bold font-mono text-green-400">{fmt(result.maxLoss)}</div>
            </div>
            <div className="bg-slate-800 rounded p-1.5 text-center">
              <div className="text-[9px] text-slate-500">Sharpe</div>
              <div className={`font-bold ${result.sharpeApprox >= 0 ? 'text-sky-400' : 'text-orange-400'}`}>
                {result.sharpeApprox.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Best / Worst day */}
          {result.bestDay && result.worstDay && (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-red-900/20 border border-red-800/30 rounded p-1.5">
                <div className="text-[9px] text-slate-500">最佳日</div>
                <div className="text-red-400 font-bold text-[11px]">{result.bestDay.date}</div>
                <div className="text-red-300 font-mono">{fmt(result.bestDay.returnPct)}</div>
              </div>
              <div className="bg-green-900/20 border border-green-800/30 rounded p-1.5">
                <div className="text-[9px] text-slate-500">最差日</div>
                <div className="text-green-400 font-bold text-[11px]">{result.worstDay.date}</div>
                <div className="text-green-300 font-mono">{fmt(result.worstDay.returnPct)}</div>
              </div>
            </div>
          )}

          {/* Daily breakdown */}
          <div>
            <div className="text-slate-400 font-bold mb-1">每日損益</div>
            <div className="space-y-0.5 max-h-32 overflow-y-auto">
              {result.dailyResults.map((d: BacktestDailyRow) => (
                <div key={d.date} className="flex items-center gap-2 text-[10px] bg-slate-800/40 rounded px-2 py-0.5">
                  <span className="text-slate-500 w-20">{d.date}</span>
                  <span className={`font-mono font-bold flex-1 ${retCls(d.totalPnL)}`}>
                    {d.totalPnL >= 0 ? '+' : ''}{Math.round(d.totalPnL).toLocaleString()}
                  </span>
                  <span className="text-slate-500">{d.trades.length}筆</span>
                  <span className={`w-8 text-right ${d.winRate >= 50 ? 'text-red-400' : 'text-green-400'}`}>{d.winRate}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Trade list toggle */}
          <button onClick={() => setShowTrades(!showTrades)}
            className="w-full bg-slate-700 text-slate-300 hover:bg-slate-600 py-1 rounded text-[10px]">
            {showTrades ? '隱藏交易明細' : `展開全部 ${result.totalTrades} 筆交易`}
          </button>

          {showTrades && (
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {result.allTrades.map((t: BacktestTradeResult, i: number) => (
                <div key={i} className="bg-slate-800/40 rounded px-2 py-1 text-[10px]">
                  <div className="flex items-center gap-1">
                    <span className="text-slate-500">{t.entryTime.split('T')[1]?.slice(0,5)}</span>
                    <span className="text-white">→</span>
                    <span className="text-slate-500">{t.exitTime.split('T')[1]?.slice(0,5)}</span>
                    <span className={`ml-auto font-mono font-bold ${retCls(t.returnPct)}`}>{fmt(t.returnPct)}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[9px] text-slate-500">
                    <span>進:{t.entryPrice.toFixed(1)}</span>
                    <span>出:{t.exitPrice.toFixed(1)}</span>
                    <span>×{t.shares}</span>
                    <span className="ml-auto">{t.entrySignal}</span>
                    <span className="text-slate-600">|</span>
                    <span>{t.exitReason}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
