'use client';

import { useState, useEffect, useMemo } from 'react';

interface JournalEntry {
  id: string;
  date: string;         // YYYY-MM-DD
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  shares: number;
  exitReason: 'tp' | 'sl' | 'manual';
  note: string;
}

const STORAGE_KEY = 'daytrade_journal_v1';

function loadEntries(): JournalEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as JournalEntry[]) : [];
  } catch { return []; }
}

function saveEntries(entries: JournalEntry[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch {}
}

function calcPnL(e: JournalEntry) {
  const multiplier = e.direction === 'long' ? 1 : -1;
  return (e.exitPrice - e.entryPrice) * e.shares * multiplier;
}

function calcPct(e: JournalEntry) {
  const multiplier = e.direction === 'long' ? 1 : -1;
  return ((e.exitPrice - e.entryPrice) / e.entryPrice) * multiplier * 100;
}

const EMPTY: Omit<JournalEntry, 'id'> = {
  date: new Date().toISOString().slice(0, 10),
  symbol: '',
  direction: 'long',
  entryPrice: 0,
  exitPrice: 0,
  shares: 1000,
  exitReason: 'manual',
  note: '',
};

export function TradeJournal() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<JournalEntry, 'id'>>(EMPTY);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setEntries(loadEntries()); }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const stats = useMemo(() => {
    if (entries.length === 0) return null;
    const pnls = entries.map(calcPnL);
    const wins = pnls.filter(p => p > 0).length;
    const total = pnls.reduce((s, p) => s + p, 0);
    const winRate = (wins / entries.length) * 100;
    const avgWin  = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0) / Math.max(wins, 1);
    const avgLoss = pnls.filter(p => p < 0).reduce((s, p) => s + p, 0) / Math.max(entries.length - wins, 1);
    return { winRate, total, avgWin, avgLoss, count: entries.length };
  }, [entries]);

  function addEntry() {
    if (!form.symbol || form.entryPrice <= 0 || form.exitPrice <= 0) return;
    const newEntry: JournalEntry = { ...form, id: Date.now().toString() };
    const updated = [newEntry, ...entries];
    setEntries(updated);
    saveEntries(updated);
    setShowForm(false);
    setForm(EMPTY);
  }

  function removeEntry(id: string) {
    const updated = entries.filter(e => e.id !== id);
    setEntries(updated);
    saveEntries(updated);
  }

  function exportCsv() {
    const header = 'date,symbol,direction,entry,exit,shares,pnl,pct,reason,note';
    const rows = entries.map(e =>
      `${e.date},${e.symbol},${e.direction},${e.entryPrice},${e.exitPrice},${e.shares},${calcPnL(e).toFixed(0)},${calcPct(e).toFixed(2)},${e.exitReason},"${e.note}"`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trade-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-secondary/40 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">交易日誌</span>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <button onClick={exportCsv} className="text-[10px] text-muted-foreground hover:text-foreground/80 px-2 py-1 rounded border border-border hover:bg-secondary">
              匯出 CSV
            </button>
          )}
          <button
            onClick={() => setShowForm(s => !s)}
            className="text-[10px] text-sky-400 hover:text-sky-300 px-2 py-1 rounded border border-sky-700/60 hover:bg-sky-900/30"
          >
            {showForm ? '取消' : '+ 新增'}
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {stats && (
        <div className="grid grid-cols-4 border-b border-border/60 divide-x divide-slate-800/60">
          {[
            { label: '筆數', value: stats.count.toString(), color: 'text-foreground/80' },
            { label: '勝率', value: `${stats.winRate.toFixed(0)}%`, color: stats.winRate >= 50 ? 'text-bull' : 'text-bear' },
            { label: '總損益', value: `${stats.total >= 0 ? '+' : ''}${stats.total.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`, color: stats.total >= 0 ? 'text-bull' : 'text-bear' },
            { label: 'Avg W/L', value: `${(stats.avgWin / Math.abs(stats.avgLoss)).toFixed(1)}x`, color: stats.avgWin / Math.abs(stats.avgLoss) >= 1.5 ? 'text-sky-400' : 'text-muted-foreground' },
          ].map(({ label, value, color }) => (
            <div key={label} className="px-3 py-2.5 flex flex-col gap-0.5">
              <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
              <div className={`text-sm font-bold tabular-nums ${color}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="p-4 border-b border-border space-y-3 bg-secondary/20">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">日期</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">股票代號</label>
              <input type="text" value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                placeholder="2330" className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">方向</label>
              <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value as 'long' | 'short' }))}
                className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500">
                <option value="long">多單</option>
                <option value="short">空單</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">股數</label>
              <input type="number" value={form.shares} onChange={e => setForm(f => ({ ...f, shares: Number(e.target.value) }))}
                step={1000} className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500 tabular-nums" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">進場價</label>
              <input type="number" value={form.entryPrice || ''} onChange={e => setForm(f => ({ ...f, entryPrice: Number(e.target.value) }))}
                step={0.01} placeholder="0.00" className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500 tabular-nums" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">出場價</label>
              <input type="number" value={form.exitPrice || ''} onChange={e => setForm(f => ({ ...f, exitPrice: Number(e.target.value) }))}
                step={0.01} placeholder="0.00" className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500 tabular-nums" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">出場原因</label>
              <select value={form.exitReason} onChange={e => setForm(f => ({ ...f, exitReason: e.target.value as 'tp' | 'sl' | 'manual' }))}
                className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500">
                <option value="tp">停利</option>
                <option value="sl">停損</option>
                <option value="manual">手動</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">備注</label>
            <input type="text" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              placeholder="交易心得、進場理由..." className="w-full bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-sky-500" />
          </div>
          <button onClick={addEntry}
            className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-foreground rounded text-xs font-semibold transition-colors">
            儲存交易
          </button>
        </div>
      )}

      {/* Entries list */}
      {entries.length === 0 ? (
        <div className="text-center py-10 text-slate-600 text-xs">尚無交易紀錄</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-muted-foreground uppercase border-b border-border/60 bg-secondary/40">
                <th className="py-2 px-3 text-left">日期</th>
                <th className="py-2 px-3 text-left">股票</th>
                <th className="py-2 px-3 text-center">方向</th>
                <th className="py-2 px-3 text-right tabular-nums">進場</th>
                <th className="py-2 px-3 text-right tabular-nums">出場</th>
                <th className="py-2 px-3 text-right tabular-nums">損益</th>
                <th className="py-2 px-3 text-center">原因</th>
                <th className="py-2 px-1"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const pnl = calcPnL(e);
                const pct = calcPct(e);
                return (
                  <tr key={e.id} className="border-b border-border/40 hover:bg-secondary/30 transition-colors">
                    <td className="py-2 px-3 text-muted-foreground">{e.date}</td>
                    <td className="py-2 px-3 font-mono font-bold text-foreground">{e.symbol}</td>
                    <td className="py-2 px-3 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${e.direction === 'long' ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300'}`}>
                        {e.direction === 'long' ? '多' : '空'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-foreground/80">{e.entryPrice}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-foreground/80">{e.exitPrice}</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                      <span className="font-normal text-[9px] ml-1">({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        e.exitReason === 'tp' ? 'bg-red-900/40 text-red-300' :
                        e.exitReason === 'sl' ? 'bg-green-900/40 text-green-300' :
                        'bg-muted/50 text-muted-foreground'
                      }`}>
                        {e.exitReason === 'tp' ? '停利' : e.exitReason === 'sl' ? '停損' : '手動'}
                      </span>
                    </td>
                    <td className="py-2 px-1">
                      <button onClick={() => removeEntry(e.id)} className="text-slate-600 hover:text-red-400 text-[10px] px-1 transition-colors">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
