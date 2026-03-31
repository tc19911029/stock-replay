'use client';

import { useDaytradeStore } from '@/store/daytradeStore';

function StatBox({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-slate-800/50 rounded p-2">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

export function ValidationPanel() {
  const { validationStats, runValidation, allSignals } = useDaytradeStore();

  return (
    <div className="space-y-3 p-1">
      <button
        onClick={runValidation}
        disabled={allSignals.length === 0}
        className="w-full bg-violet-700 hover:bg-violet-600 disabled:bg-slate-800 text-white text-xs py-2 rounded font-medium"
      >
        📊 執行訊號驗證（{allSignals.length} 訊號）
      </button>

      {validationStats && validationStats.totalSignals > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <StatBox label="準確率" value={`${validationStats.accuracyRate}%`}
              color={validationStats.accuracyRate >= 55 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="總訊號" value={String(validationStats.totalSignals)} />
            <StatBox label="3根均報酬" value={`${validationStats.avgReturn3Bar.toFixed(2)}%`}
              color={validationStats.avgReturn3Bar >= 0 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="5根均報酬" value={`${validationStats.avgReturn5Bar.toFixed(2)}%`}
              color={validationStats.avgReturn5Bar >= 0 ? 'text-red-400' : 'text-green-400'} />
            <StatBox label="平均MFE" value={`+${validationStats.avgMFE}%`} color="text-red-400" />
            <StatBox label="平均MAE" value={`-${validationStats.avgMAE}%`} color="text-green-400" />
            {validationStats.profitFactor != null && (
              <StatBox label="Profit Factor" value={String(validationStats.profitFactor)}
                color={validationStats.profitFactor >= 1 ? 'text-red-400' : 'text-orange-400'} />
            )}
            {validationStats.medianReturn != null && (
              <StatBox label="中位數報酬" value={`${validationStats.medianReturn}%`}
                color={validationStats.medianReturn >= 0 ? 'text-red-400' : 'text-green-400'} />
            )}
          </div>
          <div className="space-y-1">
            <div className="text-[10px] text-slate-500">按類型</div>
            {Object.entries(validationStats.byType).map(([type, s]) => (
              <div key={type} className="flex items-center gap-2 text-[10px]">
                <span className="text-slate-400 w-12 font-bold">{type}</span>
                <span className="text-white w-5 text-right">{s.count}</span>
                <div className="flex-1 bg-slate-900 rounded-full h-1.5">
                  <div className={`h-full rounded-full ${s.accuracyRate >= 50 ? 'bg-sky-500' : 'bg-orange-500'}`}
                    style={{ width: `${s.accuracyRate}%` }} />
                </div>
                <span className="text-slate-500 w-8 text-right">{s.accuracyRate}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
