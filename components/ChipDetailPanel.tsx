'use client';

import { useState, useEffect } from 'react';

interface ChipInfo {
  symbol: string;
  name?: string;
  foreignBuy: number;
  trustBuy: number;
  dealerBuy: number;
  totalInstitutional: number;
  marginBalance: number;
  marginNet: number;
  shortBalance: number;
  shortNet: number;
  marginUtilRate: number;
  dayTradeVolume: number;
  dayTradeRatio: number;
  largeTraderBuy: number;
  largeTraderSell: number;
  largeTraderNet: number;
  lendingBalance: number;
  lendingNet: number;
  chipScore: number;
  chipGrade: string;
  chipSignal: string;
  chipDetail: string;
}

function formatVal(v: number, unit: 'M' | '張' | '%' | ''): string {
  if (unit === 'M') return (v > 0 ? '+' : '') + (v / 1e6).toFixed(1) + 'M';
  if (unit === '張') return (v > 0 ? '+' : '') + v.toLocaleString() + '張';
  if (unit === '%') return v.toFixed(1) + '%';
  return v.toLocaleString();
}

function ValColor({ v, reverse = false }: { v: number; reverse?: boolean }) {
  const pos = reverse ? v < 0 : v > 0;
  const neg = reverse ? v > 0 : v < 0;
  return (
    <span className={`font-mono font-bold ${pos ? 'text-red-400' : neg ? 'text-green-400' : 'text-slate-400'}`}>
      {v > 0 ? '+' : ''}{v === 0 ? '0' : v.toLocaleString()}張
    </span>
  );
}

function ChipCard({ label, value, signal, unit = '' }: { label: string; value: number; signal?: string; unit?: string }) {
  const signalColor = signal === '買超' || signal === '增' || signal === '增加' ? 'text-red-400' :
    signal === '賣超' || signal === '減' || signal === '減少' ? 'text-green-400' :
    signal === '小買' ? 'text-red-300' : signal === '小賣' ? 'text-green-300' :
    signal === '中立' ? 'text-yellow-400' : 'text-slate-400';

  return (
    <div className="bg-slate-800/80 rounded-lg p-2.5 border border-slate-700/50">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[10px] text-slate-400">{label}</span>
        {signal && <span className={`text-[10px] font-bold ${signalColor}`}>{signal}</span>}
      </div>
      <div className={`text-base font-mono font-bold ${value > 0 ? 'text-red-400' : value < 0 ? 'text-green-400' : 'text-slate-400'}`}>
        {value > 0 ? '+' : ''}{Math.abs(value) >= 1e6 ? (value / 1e6).toFixed(0) : value.toLocaleString()}
        {unit && <span className="text-[10px] text-slate-500 ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}

function getSignalText(v: number, thresholdBig: number, thresholdSmall: number): string {
  if (v >= thresholdBig) return '買超';
  if (v >= thresholdSmall) return '小買';
  if (v <= -thresholdBig) return '賣超';
  if (v <= -thresholdSmall) return '小賣';
  return '中立';
}

function getMarginSignal(v: number): string {
  if (v > 200) return '增';
  if (v < -200) return '減';
  return '中立';
}

export default function ChipDetailPanel({ symbol, date }: { symbol: string; date?: string }) {
  const [data, setData] = useState<ChipInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cleanSym = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  useEffect(() => {
    if (!cleanSym) return;
    setLoading(true);
    setError(null);

    let chipDate = date || new Date().toISOString().slice(0, 10);
    const cd = new Date(chipDate + 'T00:00:00');
    if (cd.getDay() === 0) chipDate = new Date(cd.getTime() - 2 * 86400000).toISOString().slice(0, 10);
    else if (cd.getDay() === 6) chipDate = new Date(cd.getTime() - 1 * 86400000).toISOString().slice(0, 10);

    fetch(`/api/chip?date=${chipDate}&symbol=${cleanSym}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError('查無籌碼資料'); setData(null); }
        else setData(j);
      })
      .catch(() => setError('載入失敗'))
      .finally(() => setLoading(false));
  }, [cleanSym, date]);

  if (loading) return <div className="text-xs text-slate-500 py-4 text-center animate-pulse">載入籌碼資料中...</div>;
  if (error || !data) return <div className="text-xs text-slate-600 py-4 text-center">{error || '無資料'}</div>;

  const gradeColor = data.chipGrade === 'S' ? 'text-red-400 border-red-600' :
    data.chipGrade === 'A' ? 'text-orange-400 border-orange-600' :
    data.chipGrade === 'B' ? 'text-yellow-400 border-yellow-600' :
    data.chipGrade === 'C' ? 'text-slate-400 border-slate-600' : 'text-slate-500 border-slate-700';

  return (
    <div className="space-y-3">
      {/* 總覽 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">籌碼面評分</span>
          <span className={`text-lg font-bold border-2 rounded-lg px-2 py-0.5 ${gradeColor}`}>
            {data.chipGrade}
          </span>
          <span className="text-sm font-mono text-slate-300">{data.chipScore}</span>
        </div>
        <span className={`text-xs font-bold px-2 py-1 rounded ${
          data.chipSignal === '主力進場' ? 'bg-red-900/60 text-red-300' :
          data.chipSignal === '法人偏多' ? 'bg-orange-900/60 text-orange-300' :
          data.chipSignal === '大戶加碼' ? 'bg-yellow-900/60 text-yellow-300' :
          data.chipSignal === '主力出貨' ? 'bg-green-900/60 text-green-300' :
          data.chipSignal === '散戶追高' ? 'bg-amber-900/60 text-amber-300' :
          data.chipSignal === '法人偏空' ? 'bg-blue-900/60 text-blue-300' :
          'bg-slate-800 text-slate-400'
        }`}>{data.chipSignal}</span>
      </div>

      {/* 三大法人 */}
      <div>
        <div className="text-[10px] text-slate-500 mb-1.5 font-medium">三大法人</div>
        <div className="grid grid-cols-3 gap-1.5">
          <ChipCard label="外資" value={data.foreignBuy} signal={getSignalText(data.foreignBuy, 5000, 500)} unit="張" />
          <ChipCard label="投信" value={data.trustBuy} signal={getSignalText(data.trustBuy, 500, 50)} unit="張" />
          <ChipCard label="自營商" value={data.dealerBuy} signal={getSignalText(data.dealerBuy, 1000, 100)} unit="張" />
        </div>
        <div className="mt-1 bg-slate-800/60 rounded px-2 py-1 flex justify-between items-center">
          <span className="text-[10px] text-slate-500">法人合計</span>
          <ValColor v={data.totalInstitutional} />
        </div>
      </div>

      {/* 融資融券 */}
      <div>
        <div className="text-[10px] text-slate-500 mb-1.5 font-medium">融資融券</div>
        <div className="grid grid-cols-2 gap-1.5">
          <div className="bg-slate-800/80 rounded-lg p-2.5 border border-slate-700/50">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] text-slate-400">融資增減</span>
              <span className={`text-[10px] font-bold ${data.marginNet > 200 ? 'text-red-400' : data.marginNet < -200 ? 'text-green-400' : 'text-yellow-400'}`}>
                {getMarginSignal(data.marginNet)}
              </span>
            </div>
            <div className={`text-base font-mono font-bold ${data.marginNet > 0 ? 'text-red-400' : data.marginNet < 0 ? 'text-green-400' : 'text-slate-400'}`}>
              {data.marginNet > 0 ? '+' : ''}{data.marginNet.toLocaleString()}
              <span className="text-[10px] text-slate-500 ml-0.5">張</span>
            </div>
            <div className="text-[9px] text-slate-600 mt-0.5">餘額 {data.marginBalance.toLocaleString()} | 使用率 {data.marginUtilRate}%</div>
          </div>
          <div className="bg-slate-800/80 rounded-lg p-2.5 border border-slate-700/50">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] text-slate-400">融券增減</span>
              <span className={`text-[10px] font-bold ${data.shortNet > 0 ? 'text-red-400' : data.shortNet < 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                {data.shortNet > 50 ? '增' : data.shortNet < -50 ? '減' : '中立'}
              </span>
            </div>
            <div className={`text-base font-mono font-bold ${data.shortNet > 0 ? 'text-red-400' : data.shortNet < 0 ? 'text-green-400' : 'text-slate-400'}`}>
              {data.shortNet > 0 ? '+' : ''}{data.shortNet.toLocaleString()}
              <span className="text-[10px] text-slate-500 ml-0.5">張</span>
            </div>
            <div className="text-[9px] text-slate-600 mt-0.5">餘額 {data.shortBalance.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* 主力 + 當沖 */}
      <div>
        <div className="text-[10px] text-slate-500 mb-1.5 font-medium">主力動向</div>
        <div className="grid grid-cols-2 gap-1.5">
          <ChipCard label="大額交易人" value={data.largeTraderNet}
            signal={getSignalText(data.largeTraderNet, 50_000_000, 10_000_000)} />
          <div className="bg-slate-800/80 rounded-lg p-2.5 border border-slate-700/50">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] text-slate-400">當沖比例</span>
              <span className={`text-[10px] font-bold ${data.dayTradeRatio > 40 ? 'text-red-400' : data.dayTradeRatio > 25 ? 'text-yellow-400' : 'text-green-400'}`}>
                {data.dayTradeRatio > 40 ? '過高' : data.dayTradeRatio > 25 ? '偏高' : '正常'}
              </span>
            </div>
            <div className={`text-base font-mono font-bold ${data.dayTradeRatio > 40 ? 'text-red-400' : data.dayTradeRatio > 25 ? 'text-yellow-400' : 'text-slate-300'}`}>
              {data.dayTradeRatio}%
            </div>
          </div>
        </div>
      </div>

      {/* 摘要 */}
      {data.chipDetail && data.chipDetail !== '中性' && (
        <div className="text-[10px] text-slate-500 bg-slate-800/40 rounded px-2 py-1.5 border border-slate-700/30">
          {data.chipDetail}
        </div>
      )}
    </div>
  );
}
