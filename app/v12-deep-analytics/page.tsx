'use client';

/**
 * v12 深度分析儀表板（後驗研究）
 *
 * 對 production 14 字母歷史 scan 結果做四種深度分析：
 *
 * 1. **Ensemble**：多字母同時觸發時的勝率提升
 * 2. **Regime**：每字母在多頭/盤整/空頭三種大盤狀態的表現
 * 3. **Drawdown**：每字母 5 天最大回撤
 * 4. **Industry**：TW 字母在各產業的勝率
 *
 * Source: /api/v12/deep-analytics
 */

import { useEffect, useState } from 'react';

interface EnsembleStat {
  letters: string;
  hits: number;
  winRate: number;
  avgRet: number;
  vsBaseline: number;
}

interface RegimeBucket {
  hits: number;
  winRate: number | null;
  avgRet: number | null;
}

interface RegimeStat {
  letter: string;
  bullish: RegimeBucket;
  sideways: RegimeBucket;
  bearish: RegimeBucket;
}

interface DrawdownStat {
  letter: string;
  hits: number;
  avgMaxDD: number | null;
  worstDD: number | null;
}

interface IndustryStat {
  letter: string;
  industries: Array<{ industry: string; hits: number; winRate: number; avgRet: number }>;
}

interface DeepAnalyticsResponse {
  market: string;
  generatedAt: string;
  sampleSize: { totalHits: number; uniqueStockDays: number };
  ensemble: EnsembleStat[];
  regime: RegimeStat[];
  drawdown: DrawdownStat[];
  industry: IndustryStat[];
}

const LETTER_NAMES: Record<string, string> = {
  B: '回後買上漲', C: '盤整突破', D: '一字底', E: '缺口進場', F: 'V 反轉',
  J: 'ABC 突破', K: 'K 線橫盤', L: '突破黑K', M: '軌道線突破',
  N: '型態確認', O: '打底完成', P: '高檔拉回', Q: '三均線戰法',
};

const TRACK_BG: Record<string, string> = {
  B: 'bg-red-950/30', P: 'bg-red-950/30', C: 'bg-red-950/30', E: 'bg-red-950/30',
  J: 'bg-red-950/30', K: 'bg-red-950/30', L: 'bg-red-950/30', M: 'bg-red-950/30',
  D: 'bg-blue-950/30', F: 'bg-blue-950/30', N: 'bg-blue-950/30', O: 'bg-blue-950/30',
  Q: 'bg-purple-950/30',
};

function liftColor(lift: number | null): string {
  if (lift == null) return 'text-muted-foreground';
  if (lift >= 15) return 'text-emerald-400 font-bold';
  if (lift >= 5) return 'text-emerald-300';
  if (lift >= 0) return 'text-foreground';
  if (lift >= -5) return 'text-amber-300';
  return 'text-rose-400';
}

function winColor(rate: number | null): string {
  if (rate == null) return 'text-muted-foreground';
  if (rate >= 60) return 'text-emerald-400 font-bold';
  if (rate >= 50) return 'text-emerald-300';
  if (rate >= 40) return 'text-amber-300';
  return 'text-rose-300';
}

function retColor(val: number | null): string {
  if (val == null) return 'text-muted-foreground';
  if (val > 5) return 'text-emerald-400 font-bold';
  if (val > 0) return 'text-emerald-300';
  if (val < -5) return 'text-rose-400 font-bold';
  if (val < 0) return 'text-rose-300';
  return 'text-foreground';
}

function ddColor(val: number | null): string {
  if (val == null) return 'text-muted-foreground';
  if (val > -3) return 'text-emerald-300';
  if (val > -7) return 'text-amber-300';
  return 'text-rose-400 font-bold';
}

export default function V12DeepAnalyticsPage() {
  const [market, setMarket] = useState<'TW' | 'CN'>('TW');
  const [data, setData] = useState<DeepAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (m: 'TW' | 'CN') => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v12/deep-analytics?market=${m}`);
      const json = await res.json();
      setData(json.data ?? json);
    } catch (err) {
      console.error('load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(market); }, [market]);

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">v12 深度分析</h1>
            <p className="text-xs text-muted-foreground mt-1">
              組合勝率提升 / 大盤狀態細分 / 回撤分析 / 產業熱度
              {data && ` · ${data.sampleSize.totalHits.toLocaleString()} 筆觸發 · ${data.sampleSize.uniqueStockDays.toLocaleString()} 個股日 · 計算於 ${new Date(data.generatedAt).toLocaleString('zh-TW')}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-muted/40 rounded">
              <button
                onClick={() => setMarket('TW')}
                className={`px-3 py-1.5 text-xs rounded ${market === 'TW' ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >🇹🇼 TW</button>
              <button
                onClick={() => setMarket('CN')}
                className={`px-3 py-1.5 text-xs rounded ${market === 'CN' ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}
              >🇨🇳 CN</button>
            </div>
            <button
              onClick={() => load(market)}
              disabled={loading}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
            >
              {loading ? '計算中…' : '🔄 重算'}
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="text-xs text-muted-foreground py-8 text-center">計算中…（首次需要拉 5 天 forward 樣本，約 30-60 秒）</div>
        ) : data ? (
          <>
            {/* 1. Ensemble */}
            <Section title="🎯 多字母組合勝率提升（Ensemble）" subtitle="同一個股同一天有多個字母觸發時，勝率比平均單獨字母高多少 percentage points">
              {data.ensemble.length === 0 ? (
                <Empty msg="樣本不足（每組合需 ≥5 次同步觸發）" />
              ) : (
                <div className="bg-card border border-border rounded-lg overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left">組合</th>
                        <th className="px-2 py-1.5 text-right">命中</th>
                        <th className="px-2 py-1.5 text-right">勝率</th>
                        <th className="px-2 py-1.5 text-right">vs 單字母平均</th>
                        <th className="px-2 py-1.5 text-right">平均報酬 5d</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {data.ensemble.map((e) => (
                        <tr key={e.letters}>
                          <td className="px-2 py-1.5 font-bold font-mono">{e.letters}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{e.hits}</td>
                          <td className={`px-2 py-1.5 text-right font-mono ${winColor(e.winRate)}`}>{e.winRate}%</td>
                          <td className={`px-2 py-1.5 text-right font-mono ${liftColor(e.vsBaseline)}`}>
                            {e.vsBaseline >= 0 ? '+' : ''}{e.vsBaseline} pp
                          </td>
                          <td className={`px-2 py-1.5 text-right font-mono ${retColor(e.avgRet)}`}>
                            {e.avgRet >= 0 ? '+' : ''}{e.avgRet}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* 2. Regime */}
            <Section title="🌗 大盤狀態細分（Regime）" subtitle="每字母在多頭 / 盤整 / 空頭三種大盤狀態的勝率與平均報酬，看哪個字母「擇時敏感」哪個「全狀態適用」">
              <div className="bg-card border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th rowSpan={2} className="px-2 py-1.5 text-left align-bottom">字母</th>
                      <th rowSpan={2} className="px-2 py-1.5 text-left align-bottom">名稱</th>
                      <th colSpan={2} className="px-2 py-1 text-center text-emerald-300 border-l border-border/40">🟢 多頭</th>
                      <th colSpan={2} className="px-2 py-1 text-center text-amber-300 border-l border-border/40">🟡 盤整</th>
                      <th colSpan={2} className="px-2 py-1 text-center text-rose-300 border-l border-border/40">🔴 空頭</th>
                    </tr>
                    <tr className="text-[10px]">
                      <th className="px-1.5 py-1 text-right border-l border-border/40">勝率</th>
                      <th className="px-1.5 py-1 text-right">報酬</th>
                      <th className="px-1.5 py-1 text-right border-l border-border/40">勝率</th>
                      <th className="px-1.5 py-1 text-right">報酬</th>
                      <th className="px-1.5 py-1 text-right border-l border-border/40">勝率</th>
                      <th className="px-1.5 py-1 text-right">報酬</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {data.regime.map((r) => (
                      <tr key={r.letter} className={TRACK_BG[r.letter] ?? ''}>
                        <td className="px-2 py-1.5 font-bold">{r.letter}</td>
                        <td className="px-2 py-1.5 text-foreground/80">{LETTER_NAMES[r.letter] ?? r.letter}</td>
                        <RegimeCells b={r.bullish} />
                        <RegimeCells b={r.sideways} />
                        <RegimeCells b={r.bearish} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* 3. Drawdown */}
            <Section title="📉 回撤分析（Drawdown）" subtitle="進場後 5 天內最低點相對進場價的最大回撤；配合平均報酬看每字母的「risk/reward」">
              <div className="bg-card border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">字母</th>
                      <th className="px-2 py-1.5 text-left">名稱</th>
                      <th className="px-2 py-1.5 text-right">樣本</th>
                      <th className="px-2 py-1.5 text-right">平均最大回撤</th>
                      <th className="px-2 py-1.5 text-right">最深回撤</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {data.drawdown.map((d) => (
                      <tr key={d.letter} className={TRACK_BG[d.letter] ?? ''}>
                        <td className="px-2 py-1.5 font-bold">{d.letter}</td>
                        <td className="px-2 py-1.5 text-foreground/80">{LETTER_NAMES[d.letter] ?? d.letter}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{d.hits}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${ddColor(d.avgMaxDD)}`}>
                          {d.avgMaxDD != null ? `${d.avgMaxDD}%` : '—'}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-mono ${ddColor(d.worstDD)}`}>
                          {d.worstDD != null ? `${d.worstDD}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* 4. Industry — 已過濾「未分類」；letterCardCount=0 時整段不顯示 */}
            {data.industry.some((i) => i.industries.length > 0) && (
              <Section title="🏭 產業熱度（Industry）" subtitle="每字母在各產業的勝率排名（≥3 樣本，取前 5；已過濾「未分類」）">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {data.industry.filter((i) => i.industries.length > 0).map((i) => (
                    <div key={i.letter} className={`border border-border rounded-lg p-3 ${TRACK_BG[i.letter] ?? 'bg-card'}`}>
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="font-bold text-base">{i.letter}</span>
                        <span className="text-xs text-muted-foreground">{LETTER_NAMES[i.letter] ?? i.letter}</span>
                      </div>
                      <table className="w-full text-[11px]">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="text-left py-0.5">產業</th>
                            <th className="text-right py-0.5">命中</th>
                            <th className="text-right py-0.5">勝率</th>
                            <th className="text-right py-0.5">報酬</th>
                          </tr>
                        </thead>
                        <tbody>
                          {i.industries.map((ind) => (
                            <tr key={ind.industry}>
                              <td className="py-0.5 text-foreground/90">{ind.industry}</td>
                              <td className="py-0.5 text-right font-mono">{ind.hits}</td>
                              <td className={`py-0.5 text-right font-mono ${winColor(ind.winRate)}`}>{ind.winRate}%</td>
                              <td className={`py-0.5 text-right font-mono ${retColor(ind.avgRet)}`}>
                                {ind.avgRet >= 0 ? '+' : ''}{ind.avgRet}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 解讀說明 */}
            <div className="text-[10px] text-muted-foreground bg-muted/30 p-3 rounded space-y-1">
              <p className="font-bold">解讀說明</p>
              <ul className="space-y-0.5">
                <li>· <b>Ensemble vsBaseline</b>：≥+10pp 表示組合明顯比單獨字母強，可考慮設為「強訊號」進場標準</li>
                <li>· <b>Regime 多頭優勢</b>：若多頭勝率比空頭高 &gt;15pp 表示該字母是「擇時敏感」型，需嚴格 Step 0 大盤過濾</li>
                <li>· <b>Drawdown</b>：avgMaxDD 比平均報酬還深 → 該字母「下跌幅度大但能反彈」，不適合短線</li>
                <li>· <b>Industry</b>：勝率前段班可作為「該字母在哪個產業最有效」的參考；產業=「未分類」表 ETF/海外</li>
                <li>· 全部後驗、不含手續費／滑點，僅供研究</li>
              </ul>
            </div>
          </>
        ) : (
          <Empty msg="無資料" />
        )}
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-bold text-foreground mb-1">{title}</h2>
      <p className="text-[11px] text-muted-foreground mb-2">{subtitle}</p>
      {children}
    </section>
  );
}

function RegimeCells({ b }: { b: RegimeBucket }) {
  return (
    <>
      <td className={`px-1.5 py-1.5 text-right font-mono border-l border-border/40 ${winColor(b.winRate)}`}>
        {b.winRate != null ? `${b.winRate}%` : '—'}
        <span className="text-[9px] text-muted-foreground ml-1">({b.hits})</span>
      </td>
      <td className={`px-1.5 py-1.5 text-right font-mono ${retColor(b.avgRet)}`}>
        {b.avgRet != null ? `${b.avgRet >= 0 ? '+' : ''}${b.avgRet}%` : '—'}
      </td>
    </>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-xs text-muted-foreground py-4 text-center">{msg}</div>;
}
