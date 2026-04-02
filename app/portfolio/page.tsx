'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePortfolioStore, PortfolioHolding } from '@/store/portfolioStore';
import { useSettingsStore } from '@/store/settingsStore';
import { PageShell } from '@/components/shared';

interface PriceData {
  price: number;
  changePercent: number;
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

  async function fetchPrice(symbol: string) {
    setPrices(prev => ({ ...prev, [symbol]: { ...prev[symbol], loading: true } as PriceData }));
    try {
      const res = await fetch(`/api/watchlist/conditions?symbol=${encodeURIComponent(symbol)}&strategyId=${encodeURIComponent(useSettingsStore.getState().activeStrategyId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setPrices(prev => ({ ...prev, [symbol]: { price: json.price, changePercent: json.changePercent, loading: false } }));
    } catch {
      setPrices(prev => ({ ...prev, [symbol]: { price: 0, changePercent: 0, loading: false, error: '無法取得' } }));
    }
  }

  useEffect(() => {
    holdings.forEach(h => fetchPrice(h.symbol));
  }, [holdings]);

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
      const res = await fetch(`/api/watchlist/conditions?symbol=${encodeURIComponent(form.symbol)}`);
      const json = await res.json();
      const name = res.ok ? json.name : form.symbol;
      const symbol = res.ok ? json.symbol : form.symbol.toUpperCase();
      add({ symbol, name, shares: Number(form.shares), costPrice: Number(form.costPrice), buyDate: form.buyDate });
      if (res.ok) setPrices(prev => ({ ...prev, [symbol]: { price: json.price, changePercent: json.changePercent, loading: false } }));
      setForm({ ...EMPTY_FORM, buyDate: new Date().toISOString().split('T')[0] });
      setShowForm(false);
    } finally {
      setFormLoading(false);
    }
  }

  // Portfolio summary
  const summary = holdings.reduce((acc, h) => {
    const p = prices[h.symbol];
    const currentPrice = p?.price ?? 0;
    const currentValue = h.shares * currentPrice;
    const costValue = h.shares * h.costPrice;
    const pnl = currentPrice > 0 ? currentValue - costValue : 0;
    acc.totalCost += costValue;
    acc.totalValue += currentPrice > 0 ? currentValue : costValue;
    acc.totalPnL += pnl;
    return acc;
  }, { totalCost: 0, totalValue: 0, totalPnL: 0 });

  const totalReturn = summary.totalCost > 0 ? (summary.totalPnL / summary.totalCost) * 100 : 0;

  const portfolioHeader = (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-bold text-sm whitespace-nowrap">💼 持倉</span>
      <button onClick={() => usePortfolioStore.getState().exportJSON()}
        className="px-2 py-1 bg-muted hover:bg-muted/80 rounded transition" title="匯出備份">匯出</button>
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
      <button onClick={() => { cancelForm(); setShowForm(v => !v); }}
        className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded font-bold transition text-white">
        + 新增
      </button>
    </div>
  );

  return (
    <PageShell headerSlot={portfolioHeader}>
      <div className="p-4 max-w-3xl mx-auto space-y-4">

        {/* Summary */}
        {holdings.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: '總持倉市值', value: `$${summary.totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: 'text-yellow-400' },
              { label: '總損益', value: `${summary.totalPnL >= 0 ? '+' : ''}$${Math.abs(summary.totalPnL).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: summary.totalPnL >= 0 ? 'text-bull' : 'text-bear' },
              { label: '總報酬率', value: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`, color: totalReturn >= 0 ? 'text-bull' : 'text-bear' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-secondary border border-border rounded-xl p-3 text-center">
                <p className="text-[10px] text-muted-foreground mb-1">{label}</p>
                <p className={`text-base font-bold font-mono ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Add / Edit form */}
        {showForm && (
          <div className="bg-secondary border border-border rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-bold text-foreground/90">{editId ? '編輯持倉' : '新增持倉'}</h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">股票代號</label>
                <input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
                  placeholder="2330 / AAPL"
                  disabled={!!editId}
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-blue-500 disabled:opacity-60" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">加入日期</label>
                <input type="date" value={form.buyDate} onChange={e => setForm(f => ({ ...f, buyDate: e.target.value }))}
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">持股數</label>
                <input type="number" value={form.shares} onChange={e => setForm(f => ({ ...f, shares: e.target.value }))}
                  placeholder="1000"
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">成本價（買進均價）</label>
                <input type="number" value={form.costPrice} onChange={e => setForm(f => ({ ...f, costPrice: e.target.value }))}
                  placeholder="150.00"
                  className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-blue-500" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={formLoading || !form.symbol || !form.shares || !form.costPrice}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg text-sm font-bold transition">
                {formLoading ? '載入中...' : editId ? '儲存變更' : '確認新增'}
              </button>
              <button onClick={cancelForm}
                className="px-4 py-2 bg-muted hover:bg-muted/80 rounded-lg text-sm transition">取消</button>
            </div>
          </div>
        )}

        {holdings.length === 0 && !showForm && (
          <div className="text-center py-12 text-muted-foreground space-y-4">
            <p className="text-4xl">💼</p>
            <p className="text-sm font-medium text-muted-foreground">尚未新增任何持倉</p>
            <p className="text-xs text-muted-foreground/60">追蹤你的持股，即時查看損益、停損/停利提醒</p>
            <div className="flex justify-center gap-3 mt-2">
              <button onClick={() => setShowForm(true)}
                className="text-xs px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition font-medium">
                + 新增第一筆持倉
              </button>
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
            const pnl = currentPrice > 0 ? (currentPrice - h.costPrice) * h.shares : 0;
            const pnlPct = h.costPrice > 0 ? ((currentPrice - h.costPrice) / h.costPrice) * 100 : 0;
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
                      <span className="text-xs text-muted-foreground truncate">{h.name}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {h.shares.toLocaleString()} 股 · 均價 <span className="text-yellow-400 font-mono">${h.costPrice.toFixed(2)}</span>
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
                    <button onClick={() => openEdit(h)}
                      className="px-2 py-1 bg-muted hover:bg-muted/80 rounded text-xs text-muted-foreground hover:text-foreground/90 transition">編輯</button>
                    <button onClick={() => remove(h.id)}
                      className="px-2 py-1 bg-muted hover:bg-red-900/60 hover:text-red-300 rounded text-xs text-muted-foreground transition">刪除</button>
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
