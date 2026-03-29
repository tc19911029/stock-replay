'use client';

import type { WalkForwardResult } from '@/store/backtestStore';
import { retColor, fmtRet } from '../utils';

function Kpi({ label, value, color, subtext }: {
  label: string; value: string; color: string; subtext?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold leading-tight ${color}`}>{value}</div>
      {subtext && <div className="text-[10px] text-slate-600 mt-0.5">{subtext}</div>}
    </div>
  );
}

interface WalkForwardPanelProps {
  result: WalkForwardResult | null;
  sessionCount: number;
  minRequired: number;
  isRunning: boolean;
  onRun: () => void;
  trainSize: number;
  testSize: number;
  stepSize: number;
  onTrainSize: (n: number) => void;
  onTestSize: (n: number) => void;
  onStepSize: (n: number) => void;
}

export function WalkForwardPanel({
  result, sessionCount, minRequired, isRunning, onRun,
  trainSize, testSize, stepSize,
  onTrainSize, onTestSize, onStepSize,
}: WalkForwardPanelProps) {
  const enough = sessionCount >= minRequired;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl px-5 py-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-4 rounded-full bg-violet-500" />
          <h3 className="text-sm font-semibold text-slate-100">步進式向前回測 (Walk-Forward)</h3>
          <span className="ml-auto text-xs text-slate-500">防止過度擬合的標準方法</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          將歷史 session 切分為滾動的訓練/測試窗口。穩健性分數越高、效率比越接近 1，代表策略在未見過的資料上仍然有效。
        </p>
        <div className="text-xs text-slate-500">
          目前 <span className={enough ? 'text-slate-200 font-medium' : 'text-amber-400 font-medium'}>{sessionCount}</span> 個歷史 session
          {!enough && <span className="text-amber-400">（需至少 {minRequired} 個才能執行）</span>}
        </div>
      </div>

      {/* Config + Run */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-800/30">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">窗口參數</h4>
        </div>
        <div className="p-5 flex flex-wrap items-end gap-4">
          {[
            { label: '訓練窗口', value: trainSize, min: 1, max: 10, onChange: onTrainSize, hint: '幾個 session 做訓練' },
            { label: '測試窗口', value: testSize,  min: 1, max: 5,  onChange: onTestSize,  hint: '幾個 session 做驗證' },
            { label: '步進大小', value: stepSize,  min: 1, max: 5,  onChange: onStepSize,  hint: '每次向前幾個 session' },
          ].map(({ label, value, min, max, onChange, hint }) => (
            <div key={label} className="space-y-1">
              <label className="text-xs text-slate-500 font-medium">{label}</label>
              <select
                value={value}
                onChange={e => onChange(+e.target.value)}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
              >
                {Array.from({ length: max - min + 1 }, (_, i) => i + min).map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <div className="text-[10px] text-slate-600">{hint}</div>
            </div>
          ))}
          <button
            onClick={onRun}
            disabled={!enough || isRunning}
            className="ml-auto px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            {isRunning ? '計算中…' : '執行 Walk-Forward'}
          </button>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-700/60 rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800 bg-slate-800/40">
              <div className="w-1.5 h-4 rounded-full bg-violet-500" />
              <h3 className="text-sm font-semibold text-slate-100">跨窗口聚合（Out-of-Sample）</h3>
              <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
                <span>{result.windows.length} 個窗口</span>
                <span className={`font-bold text-sm ${result.robustnessScore >= 60 ? 'text-red-400' : 'text-amber-400'}`}>
                  穩健性 {result.robustnessScore}%
                </span>
                {result.efficiencyRatio !== null && (
                  <span className={`font-bold text-sm ${result.efficiencyRatio >= 0.7 ? 'text-slate-200' : 'text-amber-400'}`}>
                    效率比 {result.efficiencyRatio.toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            {result.aggregateTestStats && (
              <div className="grid grid-cols-3 sm:grid-cols-6 divide-x divide-y divide-slate-800/60">
                <Kpi label="勝率"     value={`${result.aggregateTestStats.winRate}%`}     color={result.aggregateTestStats.winRate >= 50 ? 'text-red-400' : 'text-green-500'} />
                <Kpi label="均值報酬" value={fmtRet(result.aggregateTestStats.avgNetReturn)}  color={retColor(result.aggregateTestStats.avgNetReturn)} />
                <Kpi label="中位報酬" value={fmtRet(result.aggregateTestStats.medianReturn)}  color={retColor(result.aggregateTestStats.medianReturn)} />
                <Kpi label="MDD"      value={fmtRet(result.aggregateTestStats.maxDrawdown)}   color="text-green-500" subtext="峰谷最大回撤" />
                <Kpi label="Sharpe"   value={result.aggregateTestStats.sharpeRatio?.toFixed(2) ?? '–'} color={retColor(result.aggregateTestStats.sharpeRatio)} />
                <Kpi label="筆數"     value={String(result.aggregateTestStats.count)} color="text-slate-300" />
              </div>
            )}
            {result.robustnessScore < 70 && (
              <div className="px-5 py-2.5 bg-amber-950/40 border-t border-amber-800/40 flex items-center gap-2">
                <span className="text-amber-400 text-sm">!</span>
                <span className="text-[11px] text-amber-300/90">
                  穩健度 {result.robustnessScore}% 低於 70%，策略可能過度擬合歷史數據
                </span>
              </div>
            )}
            <div className="px-5 py-3 border-t border-slate-800 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>穩健性分數（測試窗口勝率 &gt; 50% 的比例）</span>
                <span className="font-bold text-slate-200">{result.robustnessScore}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    result.robustnessScore >= 70 ? 'bg-red-500' :
                    result.robustnessScore >= 50 ? 'bg-amber-500' : 'bg-green-600'
                  }`}
                  style={{ width: `${result.robustnessScore}%` }}
                />
              </div>
              {result.efficiencyRatio !== null && (
                <div className="text-[11px] text-slate-500 mt-1">
                  效率比 {result.efficiencyRatio.toFixed(2)}
                  <span className="ml-1.5 text-slate-600">（= 測試集平均報酬 ÷ 訓練集平均報酬）</span>
                </div>
              )}
            </div>
          </div>

          {/* Per-window table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-800 bg-slate-800/30">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">各窗口詳情</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-slate-500 uppercase tracking-wide border-b border-slate-700/80 bg-slate-800/60">
                    <th className="py-2.5 px-4 text-left">窗口</th>
                    <th className="py-2.5 px-3 text-left">訓練期</th>
                    <th className="py-2.5 px-3 text-center">訓練勝率</th>
                    <th className="py-2.5 px-3 text-center">訓練均值</th>
                    <th className="py-2.5 px-3 text-left">測試期</th>
                    <th className="py-2.5 px-3 text-center">測試勝率</th>
                    <th className="py-2.5 px-3 text-center">測試均值</th>
                    <th className="py-2.5 px-3 text-center">測試 MDD</th>
                    <th className="py-2.5 px-3 text-center">穩健</th>
                  </tr>
                </thead>
                <tbody>
                  {result.windows.map(w => {
                    const trainWR = w.trainStats?.winRate ?? null;
                    const testWR  = w.testStats?.winRate  ?? null;
                    const robust  = testWR !== null && testWR > 50;
                    return (
                      <tr key={w.windowIndex}
                        className={`border-t border-slate-700/40 hover:bg-slate-800/60 transition-colors ${robust ? '' : 'opacity-60'}`}>
                        <td className="py-2.5 px-4 text-slate-400 font-mono text-xs">#{w.windowIndex + 1}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-400">
                          {w.trainSessions[0]} ~ {w.trainSessions[w.trainSessions.length - 1]}
                          <div className="text-slate-600">{w.trainSessions.length} 個 session</div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {trainWR !== null
                            ? <span className={trainWR >= 50 ? 'text-red-400 font-bold' : 'text-green-500'}>{trainWR}%</span>
                            : <span className="text-slate-600">–</span>}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={retColor(w.trainStats?.avgNetReturn)}>{fmtRet(w.trainStats?.avgNetReturn)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-xs text-slate-300">
                          {w.testSessions[0]} ~ {w.testSessions[w.testSessions.length - 1]}
                          <div className="text-slate-600">{w.testSessions.length} 個 session</div>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          {testWR !== null
                            ? <span className={`font-bold ${testWR >= 50 ? 'text-red-400' : 'text-green-500'}`}>{testWR}%</span>
                            : <span className="text-slate-600">–</span>}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={retColor(w.testStats?.avgNetReturn)}>{fmtRet(w.testStats?.avgNetReturn)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className="text-green-500">{fmtRet(w.testStats?.maxDrawdown)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span className={robust ? 'text-red-400' : 'text-slate-500'}>{robust ? '✓' : '✗'}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {!result && !isRunning && (
        <div className="text-center py-16 text-slate-500 space-y-2">
          <div className="text-4xl">📈</div>
          <div className="text-sm font-medium text-slate-400">
            {enough
              ? '設定窗口參數後，點擊「執行 Walk-Forward」'
              : `需要至少 ${minRequired} 個歷史回測 session（目前 ${sessionCount} 個）`}
          </div>
          {!enough && (
            <div className="text-xs">先回到「回測參數設定」執行不同日期的回測，累積歷史 session</div>
          )}
        </div>
      )}
    </div>
  );
}
