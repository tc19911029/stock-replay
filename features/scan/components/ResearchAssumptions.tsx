'use client';

import { useState } from 'react';

interface ResearchAssumptionsProps {
  market: string;
  strategy: {
    holdDays: number;
    stopLoss: number | null;
    takeProfit: number | null;
    entryType: string;
    trailingActivate?: number | null;
    trailingStop?: number | null;
  };
}

export function ResearchAssumptions({ market, strategy }: ResearchAssumptionsProps) {
  const [open, setOpen] = useState(false);
  const poolDesc = market === 'TW'
    ? '台股全市場（上市+上櫃，約 1700+ 支，TWSE/TPEx API 動態取得）'
    : '陸股全市場（滬深主板+創業板+科創板，約 5000+ 支，東方財富 API 動態取得）';

  return (
    <div className="border border-amber-800/50 bg-amber-950/20 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-900/10 transition-colors"
        aria-expanded={open}
      >
        <span className="text-amber-400 text-sm">⚠</span>
        <span className="text-amber-300 text-sm font-medium">研究假設與偏誤說明</span>
        <span className="ml-auto text-slate-500 text-xs">{open ? '收起 ▲' : '展開 ▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 grid sm:grid-cols-2 gap-4 text-xs text-slate-300">
          <div>
            <div className="text-slate-400 font-semibold mb-1.5 uppercase tracking-wide text-[10px]">進出場規則</div>
            <ul className="space-y-1 text-slate-400">
              <li>• 訊號時間：<span className="text-slate-200">收盤後評分，不含未來資訊</span></li>
              <li>• 進場方式：<span className="text-slate-200">訊號日隔日開盤價</span>（{strategy.entryType}）</li>
              <li>• 持有天數：<span className="text-slate-200">{strategy.holdDays} 個交易日後以收盤出場</span></li>
              <li>• 停損：<span className="text-slate-200">{strategy.stopLoss == null ? '未設定' : `${(strategy.stopLoss * 100).toFixed(0)}%`}</span></li>
              <li>• 停利：<span className="text-slate-200">{strategy.takeProfit == null ? '未設定' : `+${(strategy.takeProfit * 100).toFixed(0)}%`}</span></li>
              <li>• 移動停利：<span className="text-slate-200">漲到 +{((strategy.trailingActivate ?? 0.05) * 100)}% 啟動，回撤 {((strategy.trailingStop ?? 0.03) * 100)}%</span></li>
            </ul>
          </div>
          <div>
            <div className="text-slate-400 font-semibold mb-1.5 uppercase tracking-wide text-[10px]">掃描池定義（關鍵偏誤）</div>
            <ul className="space-y-1 text-slate-400">
              <li>• 掃描池：<span className="text-amber-300">{poolDesc}</span></li>
              <li>• 數據源：Yahoo Finance（歷史K線）+ TWSE/東方財富（股票清單）</li>
            </ul>
          </div>
          <div className="sm:col-span-2 pt-1 border-t border-slate-800 text-slate-500">
            回測結果代表「全市場股票中，符合六大條件者的後續表現」。歷史回測績效僅供研究參考，過去績效不代表未來結果。
          </div>
        </div>
      )}
    </div>
  );
}
