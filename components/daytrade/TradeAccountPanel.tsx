'use client';

import { useState } from 'react';
import { useDaytradeStore } from '@/store/daytradeStore';

export function TradeAccountPanel() {
  const { session, position, latestPrice, paperBuy, paperSell, closeAll } = useDaytradeStore();
  const [shares, setShares] = useState(1000);

  return (
    <div className="space-y-3 p-1">
      {/* Account overview */}
      {session && (
        <div className="bg-slate-800/50 rounded-lg p-3 space-y-2">
          <div className="text-xs font-bold text-white">帳戶總覽</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><span className="text-slate-500">本金</span> <span className="text-white">{(session.initialCapital/10000).toFixed(0)}萬</span></div>
            <div><span className="text-slate-500">現金</span> <span className="text-white">{(session.currentCapital/10000).toFixed(1)}萬</span></div>
            <div><span className="text-slate-500">已實現</span>
              <span className={session.realizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                {session.realizedPnL >= 0 ? '+' : ''}{session.realizedPnL.toLocaleString()}
              </span>
            </div>
            <div><span className="text-slate-500">報酬</span>
              <span className={session.returnPct >= 0 ? 'text-red-400' : 'text-green-400'}>
                {session.returnPct >= 0 ? '+' : ''}{session.returnPct.toFixed(2)}%
              </span>
            </div>
            <div><span className="text-slate-500">勝/負</span> <span className="text-white">{session.winCount}/{session.lossCount}</span></div>
            <div><span className="text-slate-500">最大回撤</span> <span className="text-orange-400">{session.maxDrawdown.toFixed(2)}%</span></div>
          </div>
        </div>
      )}

      {/* Position */}
      {position && (
        <div className={`rounded-lg p-3 border ${position.unrealizedPnL >= 0 ? 'bg-red-950/20 border-red-800/40' : 'bg-green-950/20 border-green-800/40'}`}>
          <div className="text-xs font-bold text-white mb-1">持倉</div>
          <div className="grid grid-cols-2 gap-1 text-xs">
            <div><span className="text-slate-500">股數</span> <span className="text-white font-bold">{position.shares}</span></div>
            <div><span className="text-slate-500">均價</span> <span className="text-yellow-400 font-bold">{position.avgCost.toFixed(2)}</span></div>
            <div><span className="text-slate-500">現價</span> <span className="text-white">{latestPrice.toFixed(2)}</span></div>
            <div><span className="text-slate-500">損益</span>
              <span className={`font-bold ${position.unrealizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                {position.unrealizedPnL >= 0 ? '+' : ''}{position.unrealizedPnL.toLocaleString()}
                ({position.unrealizedPnLPct >= 0 ? '+' : ''}{position.unrealizedPnLPct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Trade buttons */}
      <div className="bg-slate-800/50 rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input type="number" className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white w-20 focus:border-sky-500 outline-none"
            value={shares} onChange={e => setShares(Number(e.target.value))} min={1} />
          <span className="text-xs text-slate-500">股</span>
        </div>
        <div className="text-center text-[10px] text-slate-400 mb-1">
          成交價: <span className="text-white font-bold">{latestPrice.toFixed(2)}</span>
          <span className="text-slate-600 ml-1">× {shares} = {(latestPrice * shares).toLocaleString()}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={() => paperBuy(shares)} className="flex-1 bg-red-700 hover:bg-red-600 text-white text-sm py-2 rounded font-bold">◀ 買進 {latestPrice.toFixed(0)}</button>
          <button onClick={() => paperSell(shares)} className="flex-1 bg-green-700 hover:bg-green-600 text-white text-sm py-2 rounded font-bold">賣出 {latestPrice.toFixed(0)} ▶</button>
        </div>
        <button onClick={closeAll} className="w-full bg-slate-700 hover:bg-slate-600 text-white text-xs py-1.5 rounded">全部平倉</button>
      </div>

      {/* Trade history */}
      {session && session.trades.length > 0 && (
        <div className="bg-slate-800/50 rounded-lg p-2">
          <div className="text-[10px] font-bold text-white mb-1">交易紀錄 ({session.trades.length})</div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {[...session.trades].reverse().map(t => (
              <div key={t.id} className="flex items-center gap-1.5 text-[10px] py-0.5 border-b border-slate-800/50">
                <span className={`font-bold ${t.action === 'BUY' ? 'text-red-400' : 'text-green-400'}`}>
                  {t.action === 'BUY' ? '買' : '賣'}
                </span>
                <span className="text-white">{t.price.toFixed(2)}</span>
                <span className="text-slate-500">×{t.shares}</span>
                <span className="ml-auto text-slate-600">{t.timestamp.split('T')[1]?.slice(0,5)}</span>
                {t.realizedPnL != null && (
                  <span className={t.realizedPnL >= 0 ? 'text-red-400' : 'text-green-400'}>
                    {t.realizedPnL >= 0 ? '+' : ''}{t.realizedPnL.toLocaleString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
