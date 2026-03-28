'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSettingsStore } from '@/store/settingsStore';

export default function SettingsPage() {
  const { notifyEmail, notifyMinScore, setNotifyEmail, setNotifyMinScore, strategy, setStrategy, resetStrategy } = useSettingsStore();
  const [emailInput, setEmailInput] = useState(notifyEmail);
  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setNotifyEmail(emailInput.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTest() {
    const email = emailInput.trim();
    if (!email) { setTestStatus('error'); setTestMsg('請先輸入 Email'); return; }
    setTestStatus('loading');
    try {
      const res = await fetch('/api/notify/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: email,
          subject: '📈 K線走圖 — Email 通知測試',
          results: [],
          market: 'TW',
        }),
      });
      const json = await res.json();
      if (json.ok) { setTestStatus('ok'); setTestMsg('✅ 測試郵件已發送，請查收收件匣'); }
      else { setTestStatus('error'); setTestMsg('發送失敗，請確認 Email 是否正確'); }
    } catch {
      setTestStatus('error'); setTestMsg('網路錯誤，請稍後再試');
    }
  }

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center gap-3">
        <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 返回走圖</Link>
        <span className="text-base font-bold">⚙ 設定</span>
      </header>

      <div className="p-4 max-w-xl mx-auto space-y-4">

        {/* Email Notification */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-4">
          <div>
            <h2 className="text-sm font-bold text-slate-200 mb-0.5">📧 掃描通知 Email</h2>
            <p className="text-xs text-slate-500">每日掃描完成後，將符合條件的股票自動寄到你的信箱</p>
          </div>

          <div className="space-y-2">
            <input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="輸入你的 Email"
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-500"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-slate-400">通知門檻</p>
            <div className="flex gap-2">
              {[4, 5, 6].map(n => (
                <button key={n} onClick={() => setNotifyMinScore(n)}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${
                    notifyMinScore === n ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                  }`}>
                  {n}/6 分以上
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={handleSave}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${saved ? 'bg-green-700 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}>
              {saved ? '✅ 已儲存' : '儲存'}
            </button>
            <button onClick={handleTest} disabled={testStatus === 'loading'}
              className="px-4 py-2 rounded-lg text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-40 transition">
              {testStatus === 'loading' ? '發送中...' : '測試發送'}
            </button>
          </div>

          {testMsg && (
            <p className={`text-xs ${testStatus === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{testMsg}</p>
          )}
        </div>

        {/* Strategy Parameters */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-200 mb-0.5">🎯 選股策略參數</h2>
              <p className="text-xs text-slate-500">調整六大條件的判斷門檻（朱老師預設值）</p>
            </div>
            <button onClick={resetStrategy}
              className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-slate-400 transition">
              重設預設
            </button>
          </div>

          {/* KD上限 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">KD 進場上限</span>
              <span className="text-blue-400 font-mono font-bold">{strategy.kdMaxEntry}</span>
            </div>
            <input type="range" min={60} max={95} step={1}
              value={strategy.kdMaxEntry}
              onChange={e => setStrategy({ kdMaxEntry: +e.target.value })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-slate-700" />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>60（保守）</span><span>95（寬鬆）</span>
            </div>
          </div>

          {/* 乖離上限 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">MA20 乖離上限</span>
              <span className="text-blue-400 font-mono font-bold">{(strategy.deviationMax * 100).toFixed(0)}%</span>
            </div>
            <input type="range" min={10} max={35} step={1}
              value={Math.round(strategy.deviationMax * 100)}
              onChange={e => setStrategy({ deviationMax: +e.target.value / 100 })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-slate-700" />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>10%（嚴格）</span><span>35%（寬鬆）</span>
            </div>
          </div>

          {/* 量比 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">量比門檻（倍）</span>
              <span className="text-blue-400 font-mono font-bold">{strategy.volumeRatioMin.toFixed(1)}x</span>
            </div>
            <input type="range" min={10} max={30} step={1}
              value={Math.round(strategy.volumeRatioMin * 10)}
              onChange={e => setStrategy({ volumeRatioMin: +e.target.value / 10 })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-slate-700" />
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>1.0x（寬鬆）</span><span>3.0x（嚴格）</span>
            </div>
          </div>

          {/* 最低分數 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-300">最低六大條件分數</span>
              <span className="text-blue-400 font-mono font-bold">{strategy.minScore}/6</span>
            </div>
            <div className="flex gap-2">
              {[3, 4, 5, 6].map(n => (
                <button key={n} onClick={() => setStrategy({ minScore: n })}
                  className={`flex-1 py-1.5 rounded text-xs font-bold transition ${
                    strategy.minScore === n ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                  }`}>
                  {n}分
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Scan schedule */}
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4 space-y-2.5">
          <h3 className="text-xs font-bold text-slate-300">📅 自動掃描時間</h3>
          <div className="space-y-2 text-xs text-slate-400">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                台灣股市
              </span>
              <span className="text-slate-300 font-medium">每週一至五 下午 1:00</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                中國A股
              </span>
              <span className="text-slate-300 font-medium">每週一至五 下午 2:30</span>
            </div>
          </div>
        </div>

        {/* Nav links */}
        <div className="flex gap-2">
          <Link href="/watchlist" className="flex-1 py-2 text-center bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-white hover:border-slate-500 transition">
            ⭐ 自選股
          </Link>
          <Link href="/portfolio" className="flex-1 py-2 text-center bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-white hover:border-slate-500 transition">
            💼 持倉
          </Link>
          <Link href="/scanner" className="flex-1 py-2 text-center bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-white hover:border-slate-500 transition">
            🔍 掃描
          </Link>
        </div>

        {/* 重新顯示導覽 + 風險聲明 */}
        <div className="flex gap-2">
          <button
            onClick={() => {
              try { localStorage.removeItem('feature-guide-seen'); } catch {}
              window.location.href = '/';
            }}
            className="flex-1 py-2 text-center bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-sky-300 hover:border-sky-700 transition"
          >
            重新顯示功能導覽
          </button>
          <Link href="/disclaimer" className="flex-1 py-2 text-center bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-400 hover:text-amber-300 hover:border-amber-700 transition">
            風險聲明與條款
          </Link>
        </div>

      </div>
    </div>
  );
}
