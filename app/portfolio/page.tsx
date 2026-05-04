'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePortfolioStore, PortfolioHolding } from '@/store/portfolioStore';
import { PageShell } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { classifyMarket } from '@/lib/market/classify';
import { calcNetPnL, formatPrice } from '@/lib/portfolio/fees';
import { formatSharesAsLots, marketFromSymbol } from '@/lib/utils/shareUnits';

interface PriceData {
  price: number;
  changePercent: number;
  name?: string;
  surgeScore?: number;
  surgeGrade?: string;
  loading?: boolean;
  error?: string;
}

const EMPTY_FORM = { symbol: '', name: '', shares: '', costPrice: '', buyDate: new Date().toISOString().split('T')[0] };


export default function PortfolioPage() {
  const { holdings, add, remove, update } = usePortfolioStore();
  const [prices, setPrices] = useState<Record<string, PriceData>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  async function refreshAllPrices(list: typeof holdings) {
    if (list.length === 0) return;
    const symbols = list.map(h => h.symbol);
    setPrices(prev => {
      const next = { ...prev };
      for (const s of symbols) next[s] = { ...next[s], loading: true } as PriceData;
      return next;
    });
    try {
      const res = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!res.ok) throw new Error('quotes failed');
      const json = await res.json();
      const quotes: Array<{ symbol: string; price: number; changePercent: number; name?: string }> = json.quotes ?? [];
      setPrices(prev => {
        const next = { ...prev };
        for (const s of symbols) {
          const q = quotes.find(q => q.symbol === s);
          if (q && q.price > 0) {
            next[s] = { price: q.price, changePercent: q.changePercent, loading: false, ...(q.name ? { name: q.name } : {}) };
          } else {
            next[s] = { price: 0, changePercent: 0, loading: false, error: '無報價' };
          }
        }
        return next;
      });
    } catch {
      setPrices(prev => {
        const next = { ...prev };
        for (const s of symbols) next[s] = { price: 0, changePercent: 0, loading: false, error: '更新失敗' };
        return next;
      });
    }
  }

  // 持倉 symbol 列表變動時刷新報價（用 join 出來的字串當穩定 key，避免 holdings 物件每次重建）
  const symbolsKey = holdings.map(h => h.symbol).join(',');
  useEffect(() => {
    refreshAllPrices(holdings);
    // refreshAllPrices/holdings 物件身份頻繁改變，這裡只追 symbol 字串變化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey]);

  function openEdit(h: PortfolioHolding) {
    setEditId(h.id);
    setForm({ symbol: h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, ''), name: h.name, shares: String(h.shares), costPrice: String(h.costPrice), buyDate: h.buyDate });
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditId(null);
    setForm({ ...EMPTY_FORM, buyDate: new Date().toISOString().split('T')[0] });
  }

  async function handleAdd() {
    if (!form.symbol || !form.shares || !form.costPrice) return;
    setFormLoading(true);
    try {
      if (editId) {
        // Edit existing holding
        update(editId, { shares: Number(form.shares), costPrice: Number(form.costPrice), buyDate: form.buyDate, name: form.name || undefined });
        setEditId(null);
        setForm({ ...EMPTY_FORM, buyDate: new Date().toISOString().split('T')[0] });
        setShowForm(false);
        return;
      }
      // Fast path: lightweight quotes API resolves symbol + name without 1-year candle fetch
      // (avoids timeout when providers are down)
      const sym = form.symbol.trim();
      const isBareDigits = /^\d+$/.test(sym);
      const candidates = isBareDigits ? [sym] : [sym.toUpperCase()];
      let resolvedSymbol = sym.toUpperCase();
      let resolvedName = sym;
      let resolvedPrice = 0;
      let resolvedChangePct = 0;

      for (const candidate of candidates) {
        try {
          const qRes = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(candidate)}`);
          if (!qRes.ok) continue;
          const qJson = await qRes.json();
          const q = (qJson.quotes ?? []).find((x: { price: number }) => x.price > 0);
          if (q) {
            // Quote endpoint preserves original input as `symbol`, but we want the resolved (with suffix) form
            // for storage consistency — re-derive it
            const code = candidate.replace(/\D/g, '');
            if (/^\d{6}$/.test(code)) {
              resolvedSymbol = `${code}.${code[0] === '6' || code[0] === '9' ? 'SS' : 'SZ'}`;
            } else if (/^\d{4,5}$/.test(code)) {
              // Try .TW first, retry as .TWO is handled inside quotes route — assume .TW
              resolvedSymbol = `${code}.TW`;
            } else {
              resolvedSymbol = q.symbol ?? candidate;
            }
            resolvedName = q.name || sym;
            resolvedPrice = q.price;
            resolvedChangePct = q.changePercent ?? 0;
            break;
          }
        } catch { continue; }
      }

      add({ symbol: resolvedSymbol, name: resolvedName, shares: Number(form.shares), costPrice: Number(form.costPrice), buyDate: form.buyDate });
      if (resolvedPrice > 0) setPrices(prev => ({ ...prev, [resolvedSymbol]: { price: resolvedPrice, changePercent: resolvedChangePct, loading: false } }));
      setForm({ ...EMPTY_FORM, buyDate: new Date().toISOString().split('T')[0] });
      setShowForm(false);
    } finally {
      setFormLoading(false);
    }
  }

  // Portfolio summary — 台股 (TWD) 與陸股 (CNY) 分開，各自扣本市場手續費+稅
  function calcSummary(list: typeof holdings) {
    return list.reduce((acc, h) => {
      const p = prices[h.symbol];
      const currentPrice = p?.price ?? 0;
      const currentValue = h.shares * currentPrice;
      const costValue = h.shares * h.costPrice;
      const { pnl } = calcNetPnL(h.symbol, h.shares, h.costPrice, currentPrice);
      acc.totalCost += costValue;
      acc.totalValue += currentPrice > 0 ? currentValue : costValue;
      acc.totalPnL += pnl;
      return acc;
    }, { totalCost: 0, totalValue: 0, totalPnL: 0 });
  }

  const twHoldings = holdings.filter(h => classifyMarket(h.symbol) === 'TW');
  const cnHoldings = holdings.filter(h => classifyMarket(h.symbol) === 'CN');
  const twSummary = calcSummary(twHoldings);
  const cnSummary = calcSummary(cnHoldings);
  const twReturn = twSummary.totalCost > 0 ? (twSummary.totalPnL / twSummary.totalCost) * 100 : 0;
  const cnReturn = cnSummary.totalCost > 0 ? (cnSummary.totalPnL / cnSummary.totalCost) * 100 : 0;

  function exportCSV() {
    if (holdings.length === 0) return;
    const rows = [
      ['股票代號', '名稱', '股數', '成本價', '買入日期', '現價', '損益(元)', '損益(%)'],
      ...holdings.map(h => {
        const p = prices[h.symbol];
        const currentPrice = p?.price ?? 0;
        const { pnl, pnlPct } = calcNetPnL(h.symbol, h.shares, h.costPrice, currentPrice);
        return [
          h.symbol,
          h.name,
          h.shares,
          h.costPrice.toFixed(4),
          h.buyDate,
          currentPrice > 0 ? currentPrice.toFixed(2) : '',
          currentPrice > 0 ? pnl.toFixed(0) : '',
          currentPrice > 0 ? pnlPct.toFixed(2) + '%' : '',
        ];
      }),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const portfolioHeader = (
    <div className="flex items-center gap-2 text-xs">
      <Link href="/" className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="返回主頁">
        ←
      </Link>
      <span className="font-bold text-sm whitespace-nowrap">💼 持倉</span>
      <Button variant="secondary" size="sm" onClick={() => usePortfolioStore.getState().exportJSON()}
        title="匯出備份 JSON">匯出</Button>
      <Button variant="secondary" size="sm" onClick={exportCSV} title="匯出 CSV（含損益，可用於報稅）">CSV</Button>
      <label className="px-2 py-1 bg-muted hover:bg-muted/80 rounded transition cursor-pointer" title="匯入備份">
        匯入
        <input type="file" accept=".json" className="hidden" onChange={e => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const ok = usePortfolioStore.getState().importJSON(reader.result as string);
            if (!ok) alert('匯入失敗：檔案格式不正確');
          };
          reader.readAsText(file);
          e.target.value = '';
        }} />
      </label>
      <Button size="sm" onClick={() => { cancelForm(); setShowForm(v => !v); }}
        className="bg-blue-600 hover:bg-blue-500 font-bold">
        + 新增
      </Button>
    </div>
  );

  return (
    <PageShell headerSlot={portfolioHeader}>
      <div className="p-4 max-w-3xl mx-auto space-y-4">

        {/* Summary — TWD / CNY 分開顯示，損益已扣買賣手續費+交易稅 */}
        {holdings.length > 0 && (
          <div className="space-y-3">
            {twHoldings.length > 0 && (
              <MarketSummaryRow label="台股" currency="TWD" summary={twSummary} returnPct={twReturn} />
            )}
            {cnHoldings.length > 0 && (
              <MarketSummaryRow label="陸股" currency="CNY" summary={cnSummary} returnPct={cnReturn} />
            )}
            <p className="text-[9px] text-muted-foreground/60 text-center">
              損益已扣手續費+交易稅（台股 0.1425%×2 + 0.3% / 陸股 0.03%×2 + 0.05%）
            </p>
          </div>
        )}

        {/* Add / Edit form */}
        {showForm && (
          <div className="bg-secondary border border-border rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-bold text-foreground/90">{editId ? '編輯持倉' : '新增持倉'}</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">股票代號</label>
                <Input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
                  placeholder="2330 / AAPL"
                  disabled={!!editId}
                  className="bg-muted border-border focus:border-blue-500 disabled:opacity-60" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">加入日期</label>
                <Input type="date" value={form.buyDate} onChange={e => setForm(f => ({ ...f, buyDate: e.target.value }))}
                  className="bg-muted border-border focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">持股數</label>
                <Input type="number" value={form.shares} onChange={e => setForm(f => ({ ...f, shares: e.target.value }))}
                  placeholder="1000"
                  className="bg-muted border-border focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">成本價（買進均價）</label>
                <Input type="number" step="0.0001" value={form.costPrice} onChange={e => setForm(f => ({ ...f, costPrice: e.target.value }))}
                  placeholder="150.0000（陸股均價常為 4 位小數）"
                  className="bg-muted border-border focus:border-blue-500" />
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleAdd} disabled={formLoading || !form.symbol || !form.shares || !form.costPrice}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 font-bold">
                {formLoading ? '載入中...' : editId ? '儲存變更' : '確認新增'}
              </Button>
              <Button variant="secondary" onClick={cancelForm}>取消</Button>
            </div>
          </div>
        )}

        {holdings.length === 0 && !showForm && (
          <div className="text-center py-12 text-muted-foreground space-y-4">
            <p className="text-4xl">💼</p>
            <p className="text-sm font-medium text-muted-foreground">尚未新增任何持倉</p>
            <p className="text-xs text-muted-foreground/60">追蹤你的持股，即時查看損益、停損/停利提醒</p>
            <div className="flex justify-center gap-3 mt-2">
              <Button size="sm" onClick={() => setShowForm(true)}
                className="bg-sky-600 hover:bg-sky-500 font-medium">
                + 新增第一筆持倉
              </Button>
              <Link href="/scanner"
                className="text-xs px-4 py-2 bg-secondary hover:bg-muted text-foreground/80 rounded-lg transition border border-border">
                去掃描選股
              </Link>
            </div>
            <p className="text-[10px] text-muted-foreground/60">* 資料存於本機瀏覽器，僅供學習參考</p>
          </div>
        )}

        {/* Holdings list */}
        <div className="space-y-2">
          {holdings.map(h => {
            const p = prices[h.symbol];
            const currentPrice = p?.price ?? 0;
            const { pnl, pnlPct } = calcNetPnL(h.symbol, h.shares, h.costPrice, currentPrice);
            const pnlPos = pnl >= 0;
            const ma5StopLoss = currentPrice * 0.95; // simplified
            const costStopLoss = h.costPrice * 0.93;
            // Use the tighter (higher) stop, but never above current price
            const stopLoss = Math.min(Math.max(ma5StopLoss, costStopLoss), currentPrice * 0.999);

            return (
              <div key={h.id} className="bg-secondary border border-border rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">{h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                      <span className="text-xs text-muted-foreground truncate">{p?.name || h.name || h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatSharesAsLots(h.shares, marketFromSymbol(h.symbol))} · 均價 <span className="text-yellow-400 font-mono">${formatPrice(h.costPrice)}</span>
                      · 買進 {h.buyDate}
                    </div>
                  </div>

                  {/* Current price */}
                  <div className="text-right shrink-0">
                    {p?.loading ? (
                      <span className="text-xs text-muted-foreground animate-pulse">載入中</span>
                    ) : p?.error ? (
                      <span className="text-xs text-red-400">{p.error}</span>
                    ) : currentPrice > 0 ? (
                      <>
                        <div className="font-mono font-bold text-foreground">${currentPrice.toFixed(2)}</div>
                        <div className={`text-xs font-mono ${p?.changePercent >= 0 ? 'text-bull' : 'text-bear'}`}>
                          {(p?.changePercent ?? 0) >= 0 ? '+' : ''}{(p?.changePercent ?? 0).toFixed(2)}%
                        </div>
                      </>
                    ) : null}
                  </div>

                  {/* P&L */}
                  {currentPrice > 0 && (
                    <div className={`text-right shrink-0 text-xs font-bold font-mono ${pnlPos ? 'text-bull' : 'text-bear'}`}>
                      <div>{pnlPos ? '+' : ''}${Math.abs(pnl).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</div>
                      <div>{pnlPos ? '+' : ''}{pnlPct.toFixed(2)}%</div>
                    </div>
                  )}

                  <div className="flex gap-1 shrink-0">
                    <Link href={`/?load=${h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '')}`}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold transition">走圖</Link>
                    <Button variant="secondary" size="sm" onClick={() => openEdit(h)}>編輯</Button>
                    <Button variant="destructive" size="sm" onClick={() => remove(h.id)}>刪除</Button>
                  </div>
                </div>

                {/* Sell signal alerts */}
                {currentPrice > 0 && (() => {
                  const alerts: Array<{ level: 'danger' | 'warning' | 'profit'; text: string }> = [];

                  // 止損警報（含具體建議動作）
                  if (pnlPct <= -7) alerts.push({ level: 'danger', text: `虧損 ${pnlPct.toFixed(1)}% — 已達止損線！建議：開盤以市價單全數賣出，嚴守紀律不凹單` });
                  else if (pnlPct <= -5) alerts.push({ level: 'warning', text: `虧損 ${pnlPct.toFixed(1)}% — 接近止損，建議：設定停損單在成本價×0.93，或明日開盤觀察若跌破立即出場` });
                  else if (pnlPct <= -3) alerts.push({ level: 'warning', text: `虧損 ${pnlPct.toFixed(1)}% — 留意：觀察是否跌破 MA5 或支撐位` });

                  // 止盈提醒（含具體建議動作）
                  if (pnlPct >= 20) alerts.push({ level: 'profit', text: `獲利 ${pnlPct.toFixed(1)}% — 建議：至少減碼 1/2 鎖住利潤，剩餘以 MA5 為移動停利` });
                  else if (pnlPct >= 15) alerts.push({ level: 'profit', text: `獲利 ${pnlPct.toFixed(1)}% — 建議：可分批停利 1/3，剩餘持股上移停損至成本價（保本出場）` });
                  else if (pnlPct >= 10) alerts.push({ level: 'profit', text: `獲利 ${pnlPct.toFixed(1)}% — 可考慮將停損上移至成本價，確保不虧損` });

                  // 持有天數
                  const buyDateObj = new Date(h.buyDate);
                  const holdDays = Math.floor((Date.now() - buyDateObj.getTime()) / 86400000);
                  if (holdDays >= 20 && pnlPct < 5) {
                    alerts.push({ level: 'warning', text: `持有已 ${holdDays} 天且獲利不足 5%，考慮換股` });
                  }

                  // surgeGrade from API data
                  const sg = p?.surgeGrade;
                  if (sg && (sg === 'D' || sg === 'C')) {
                    alerts.push({ level: 'warning', text: `飆股潛力已降至 ${sg} 級，動能減弱` });
                  }

                  return (
                    <div className="px-4 pb-2 space-y-1">
                      {alerts.map((a, ai) => (
                        <div key={ai} className={`text-[10px] px-2 py-1 rounded ${
                          a.level === 'danger' ? 'bg-red-900/60 text-red-300 font-bold' :
                          a.level === 'profit' ? 'bg-green-900/40 text-green-300' :
                          'bg-yellow-900/40 text-yellow-300'
                        }`}>
                          {a.text}
                        </div>
                      ))}
                      <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
                        <span>建議停損 <span className="text-red-400 font-mono font-bold">${stopLoss.toFixed(2)}</span></span>
                        <span>成本 -7% <span className="font-mono">${costStopLoss.toFixed(2)}</span></span>
                        <span>持有 {holdDays} 天</span>
                        <span className="ml-auto">
                          成本 <span className="font-mono">${(h.costPrice * h.shares).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}</span>
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-muted-foreground/60 text-center">* 僅供學習參考，停損計算為簡化版本，非投資建議</p>
      </div>
    </PageShell>
  );
}

interface SummaryData { totalCost: number; totalValue: number; totalPnL: number }

function MarketSummaryRow({ label, currency, summary, returnPct }:
  { label: string; currency: 'TWD' | 'CNY'; summary: SummaryData; returnPct: number }) {
  const symbol = currency === 'TWD' ? 'NT$' : '¥';
  const pnlPos = summary.totalPnL >= 0;
  return (
    <div className="bg-secondary border border-border rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-foreground/80">{label}</span>
        <span className="text-[10px] text-muted-foreground">{currency}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] text-muted-foreground mb-0.5">市值</p>
          <p className="text-sm font-bold font-mono text-yellow-400">
            {symbol}{summary.totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-0.5">損益</p>
          <p className={`text-sm font-bold font-mono ${pnlPos ? 'text-bull' : 'text-bear'}`}>
            {pnlPos ? '+' : ''}{symbol}{Math.abs(summary.totalPnL).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-0.5">報酬率</p>
          <p className={`text-sm font-bold font-mono ${returnPct >= 0 ? 'text-bull' : 'text-bear'}`}>
            {returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%
          </p>
        </div>
      </div>
    </div>
  );
}
