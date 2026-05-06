/**
 * 個股診斷頁：/diagnose/{TW|CN}/{symbol}/{YYYY-MM-DD}
 *
 * 給定股票+日期，重算六條件並顯示：
 *   - 六條件每條 pass/fail + detail
 *   - findPivots 抓到的波浪（帶波幅%）
 *   - 戒律檢查（做多 10 戒）
 *   - 淘汰法 8 條
 *
 * 用途：當用戶覺得某支股票判錯，直接打開這頁看為什麼。
 */

import { notFound } from 'next/navigation';
import { loadLocalCandlesForDate } from '@/lib/datasource/LocalCandleStore';
import {
  evaluateSixConditions,
  detectTrend,
  findPivots,
} from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';

interface PageProps {
  params: Promise<{ market: string; symbol: string; date: string }>;
}

export default async function DiagnosePage({ params }: PageProps) {
  const { market: marketRaw, symbol: symbolRaw, date } = await params;
  const market = marketRaw.toUpperCase() as 'TW' | 'CN';
  const symbol = decodeURIComponent(symbolRaw);

  if (market !== 'TW' && market !== 'CN') notFound();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const candles = await loadLocalCandlesForDate(symbol, market, date);
  if (!candles) {
    return (
      <main className="p-6 max-w-3xl mx-auto">
        <h1 className="text-xl font-semibold mb-2">{symbol} @ {date}</h1>
        <p className="text-red-600">
          找不到 {market} / {symbol} 在 {date} 之前的 K 線資料（L1 未涵蓋）。
        </p>
      </main>
    );
  }

  const idx = candles.findIndex((k) => k.date === date);
  if (idx < 0) {
    return (
      <main className="p-6 max-w-3xl mx-auto">
        <h1 className="text-xl font-semibold mb-2">{symbol} @ {date}</h1>
        <p className="text-red-600">
          K 線裡沒有 {date} 這天（非交易日或資料缺漏）。lastDate =
          {' '}{candles[candles.length - 1]?.date}
        </p>
      </main>
    );
  }

  const today = candles[idx];
  const six = evaluateSixConditions(candles, idx, ZHU_PURE_BOOK.thresholds);
  const trend = detectTrend(candles, idx);
  const pivots = findPivots(candles, idx, 8);
  const prohibitions = checkLongProhibitions(candles, idx);
  const elimination = evaluateElimination(candles, idx);

  const rows: Array<{ key: string; label: string; pass: boolean; detail: string }> = [
    { key: 'trend',     label: '① 趨勢',     pass: six.trend.pass,     detail: six.trend.detail },
    { key: 'ma',        label: '② 均線',     pass: six.ma.pass,        detail: six.ma.detail },
    { key: 'position',  label: '③ 位置',     pass: six.position.pass,  detail: six.position.detail },
    { key: 'volume',    label: '④ 成交量',   pass: six.volume.pass,    detail: six.volume.detail },
    { key: 'kbar',      label: '⑤ K棒',      pass: six.kbar.pass,      detail: six.kbar.detail },
    { key: 'indicator', label: '⑥ 指標',     pass: six.indicator.pass, detail: six.indicator.detail },
  ];

  return (
    <main className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">
          {market} / {symbol} @ {date}
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          收盤 <b>{today.close}</b>　開 {today.open}　高 {today.high}　低 {today.low}
          　量 {today.volume.toLocaleString()}
        </p>
        <p className="text-sm mt-1">
          六條件總分：<b>{six.totalScore}/6</b>　（核心 {six.coreScore}/5，
          {six.isCoreReady ? '✅ 核心全過' : '⚠️ 核心未齊'}）
          趨勢：<b>{trend}</b>
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-2">六條件 breakdown</h2>
        <table className="w-full text-sm border">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 text-left w-20">條件</th>
              <th className="p-2 text-left w-16">結果</th>
              <th className="p-2 text-left">說明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-2 font-medium">{r.label}</td>
                <td className="p-2">
                  {r.pass ? (
                    <span className="text-green-600 font-bold">通過</span>
                  ) : (
                    <span className="text-red-600 font-bold">不過</span>
                  )}
                </td>
                <td className="p-2 text-gray-700">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">波浪結構（findPivots 最近 8 個）</h2>
        {pivots.length < 2 ? (
          <p className="text-sm text-gray-600">資料不足，未取得 ≥2 個確認的 pivot（MA5 分段轉折波，書本 p.21-22）。</p>
        ) : (
          <table className="w-full text-sm border">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 text-left">日期</th>
                <th className="p-2 text-left">類型</th>
                <th className="p-2 text-left">收盤</th>
                <th className="p-2 text-left">距前一個 pivot 波幅</th>
              </tr>
            </thead>
            <tbody>
              {pivots.map((p, i) => {
                const nextPivot = pivots[i + 1];
                const swing = nextPivot
                  ? `${(((p.price - nextPivot.price) / nextPivot.price) * 100).toFixed(2)}%`
                  : '—';
                return (
                  <tr key={`${p.index}-${p.type}`} className="border-t">
                    <td className="p-2">{candles[p.index]?.date}</td>
                    <td className="p-2">
                      {p.type === 'high' ? (
                        <span className="text-red-600">頭</span>
                      ) : (
                        <span className="text-green-600">底</span>
                      )}
                    </td>
                    <td className="p-2">{p.price}</td>
                    <td className="p-2 text-gray-700">{swing}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-xs text-gray-500 mt-1">
          列表由新到舊。頭頭高=上面兩個頭價格遞減（越新越高）；底底高=上面兩個底價格遞減（越新越高）。
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">做多 10 戒律</h2>
        {prohibitions.reasons.length === 0 ? (
          <p className="text-sm text-green-600">✅ 無戒律觸發</p>
        ) : (
          <ul className="text-sm list-disc pl-5 space-y-1">
            {prohibitions.reasons.map((p, i) => (
              <li key={i} className="text-red-600">{p}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">淘汰法 8 條</h2>
        {elimination.reasons.length === 0 ? (
          <p className="text-sm text-green-600">✅ 無淘汰條件觸發</p>
        ) : (
          <>
            <p className="text-sm mb-2">
              扣分：<b className="text-red-600">-{elimination.penalty}</b>
            </p>
            <ul className="text-sm list-disc pl-5 space-y-1">
              {elimination.reasons.map((r, i) => (
                <li key={i} className="text-orange-700">{r}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <footer className="text-xs text-gray-500 pt-4 border-t">
        策略門檻：ZHU_PURE_BOOK（量比 {ZHU_PURE_BOOK.thresholds.volumeRatioMin}x）。
        改動 findPivots / detectTrend 後回到此頁可立即看到結果變化。
      </footer>
    </main>
  );
}
