'use client';

import { useDaytradeStore } from '@/store/daytradeStore';

export function EODReportPanel() {
  const { eodReport, generateEODReport } = useDaytradeStore();

  if (!eodReport) {
    return (
      <div className="p-3 text-center">
        <p className="text-xs text-slate-400 mb-3">收盤後點擊下方按鈕生成當日結算報表</p>
        <button onClick={generateEODReport}
          className="bg-amber-700 text-amber-100 hover:bg-amber-600 text-xs px-4 py-2 rounded-lg font-bold">
          生成盤後結算
        </button>
      </div>
    );
  }

  const r = eodReport;
  const isProfit = r.totalPnL >= 0;

  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="text-center font-bold text-sm text-amber-300">盤後結算報表</div>
      <div className="text-center text-slate-500 text-[10px]">{r.date} · {r.symbol} {r.stockName}</div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">初始本金</div>
          <div className="text-white font-mono font-bold">{(r.initialCapital / 10000).toFixed(1)}萬</div>
        </div>
        <div className={`rounded p-2 text-center ${isProfit ? 'bg-red-900/40' : 'bg-green-900/40'}`}>
          <div className="text-slate-400 text-[10px]">總損益</div>
          <div className={`font-mono font-bold ${isProfit ? 'text-red-400' : 'text-green-400'}`}>
            {isProfit ? '+' : ''}{r.totalPnL.toLocaleString()} ({isProfit ? '+' : ''}{r.returnPct.toFixed(2)}%)
          </div>
        </div>
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">交易次數</div>
          <div className="text-white font-mono font-bold">{r.totalTrades}</div>
        </div>
        <div className="bg-slate-800 rounded p-2 text-center">
          <div className="text-slate-500 text-[10px]">勝率</div>
          <div className={`font-mono font-bold ${r.winRate >= 60 ? 'text-amber-400' : 'text-slate-400'}`}>{r.winRate}%</div>
        </div>
      </div>

      {/* Trade list */}
      {r.trades.length > 0 && (
        <div>
          <div className="text-slate-400 mb-1 font-bold">交易明細</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {r.trades.map((t, i) => (
              <div key={i} className="flex items-center gap-2 bg-slate-800/60 rounded px-2 py-1 text-[10px]">
                <span className={`font-bold px-1 rounded ${t.action === 'BUY' ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
                  {t.action === 'BUY' ? '買' : '賣'}
                </span>
                <span className="text-slate-500">{t.time.split('T')[1]?.slice(0,5) ?? t.time}</span>
                <span className="text-white font-mono">${t.price.toFixed(2)}</span>
                <span className="text-slate-400">×{t.shares}</span>
                {t.pnl != null && t.pnl !== 0 && (
                  <span className={`ml-auto font-mono font-bold ${t.pnl > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {t.pnl > 0 ? '+' : ''}{t.pnl.toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {r.trades.length === 0 && (
        <div className="text-center text-slate-500 py-4">今日無交易記錄</div>
      )}

      {/* Re-generate */}
      <button onClick={generateEODReport}
        className="w-full bg-slate-700 text-slate-300 hover:bg-slate-600 text-xs px-3 py-1.5 rounded font-medium">
        重新結算
      </button>
    </div>
  );
}
