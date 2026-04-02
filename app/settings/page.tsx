'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/settingsStore';
import { PageShell } from '@/components/shared';

export default function SettingsPage() {
  const { notifyEmail, notifyMinScore, setNotifyEmail, setNotifyMinScore, strategy, setStrategy, resetStrategy, colorTheme, setColorTheme, stopLossPercent, setStopLossPercent } = useSettingsStore();
  const [emailInput, setEmailInput] = useState(notifyEmail);
  const [testLoading, setTestLoading] = useState(false);

  function handleSave() {
    setNotifyEmail(emailInput.trim());
    toast.success('已儲存 Email 設定');
  }

  async function handleTest() {
    const email = emailInput.trim();
    if (!email) { toast.error('請先輸入 Email'); return; }
    setTestLoading(true);
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
      if (json.ok) toast.success('測試郵件已發送，請查收收件匣');
      else toast.error('發送失敗，請確認 Email 是否正確');
    } catch {
      toast.error('網路錯誤，請稍後再試');
    } finally {
      setTestLoading(false);
    }
  }

  return (
    <PageShell>
      <div className="p-4 max-w-xl mx-auto space-y-4">

        {/* Email Notification */}
        <div className="bg-secondary border border-border rounded-xl p-4 space-y-4">
          <div>
            <h2 className="text-sm font-bold text-foreground/90 mb-0.5">📧 掃描通知 Email</h2>
            <p className="text-xs text-muted-foreground">每日掃描完成後，將符合條件的股票自動寄到你的信箱</p>
          </div>

          <div className="space-y-2">
            <input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="輸入你的 Email"
              className="w-full bg-muted border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-blue-500 placeholder-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">通知門檻</p>
            <div className="flex gap-2">
              {[4, 5, 6].map(n => (
                <button key={n} onClick={() => setNotifyMinScore(n)}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${
                    notifyMinScore === n ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}>
                  {n}/6 分以上
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={handleSave}
              className="flex-1 py-2 rounded-lg text-sm font-bold transition bg-blue-600 hover:bg-blue-500 text-white">
              儲存
            </button>
            <button onClick={handleTest} disabled={testLoading}
              className="px-4 py-2 rounded-lg text-sm bg-muted hover:bg-muted/80 disabled:opacity-40 transition">
              {testLoading ? '發送中...' : '測試發送'}
            </button>
          </div>
        </div>

        {/* Strategy Parameters */}
        <div className="bg-secondary border border-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-foreground/90 mb-0.5">🎯 選股策略參數</h2>
              <p className="text-xs text-muted-foreground">調整六大條件的判斷門檻（朱老師預設值）</p>
            </div>
            <button onClick={resetStrategy}
              className="px-2 py-1 text-xs bg-muted hover:bg-muted/80 rounded text-muted-foreground transition">
              重設預設
            </button>
          </div>

          {/* KD上限 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-foreground/80 group relative cursor-help">KD 進場上限 <span className="text-muted-foreground/60">ⓘ</span>
                <span className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-56 p-2 rounded bg-secondary border border-border text-[10px] text-foreground/80 shadow-lg">
                  KD 指標衡量股價超買/超賣程度。數值越低表示只在 KD 較低（未超買）時才進場，更保守。常見設定：短線 70-80、保守 60-65。
                </span>
              </span>
              <span className="text-blue-400 font-mono font-bold">{strategy.kdMaxEntry}</span>
            </div>
            <input type="range" min={60} max={95} step={1}
              value={strategy.kdMaxEntry}
              onChange={e => setStrategy({ kdMaxEntry: +e.target.value })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-muted" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>60（保守）</span><span>95（寬鬆）</span>
            </div>
          </div>

          {/* 乖離上限 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-foreground/80 group relative cursor-help">MA20 乖離上限 <span className="text-muted-foreground/60">ⓘ</span>
                <span className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-56 p-2 rounded bg-secondary border border-border text-[10px] text-foreground/80 shadow-lg">
                  乖離率 = 股價偏離20日均線的程度。乖離越大，表示短線漲太多，回檔風險越高。設 15% 表示漲超過15%就不進場。
                </span>
              </span>
              <span className="text-blue-400 font-mono font-bold">{(strategy.deviationMax * 100).toFixed(0)}%</span>
            </div>
            <input type="range" min={10} max={35} step={1}
              value={Math.round(strategy.deviationMax * 100)}
              onChange={e => setStrategy({ deviationMax: +e.target.value / 100 })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-muted" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>10%（嚴格）</span><span>35%（寬鬆）</span>
            </div>
          </div>

          {/* 量比 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-foreground/80 group relative cursor-help">量比門檻（倍） <span className="text-muted-foreground/60">ⓘ</span>
                <span className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-56 p-2 rounded bg-secondary border border-border text-[10px] text-foreground/80 shadow-lg">
                  量比 = 今日成交量 ÷ 近期平均成交量。1.5x 表示今天的量是平常的1.5倍，代表有資金關注。設越高越嚴格。
                </span>
              </span>
              <span className="text-blue-400 font-mono font-bold">{strategy.volumeRatioMin.toFixed(1)}x</span>
            </div>
            <input type="range" min={10} max={30} step={1}
              value={Math.round(strategy.volumeRatioMin * 10)}
              onChange={e => setStrategy({ volumeRatioMin: +e.target.value / 10 })}
              className="w-full h-1.5 rounded-full accent-blue-500 bg-muted" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>1.0x（寬鬆）</span><span>3.0x（嚴格）</span>
            </div>
          </div>

          {/* 最低分數 */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-foreground/80">最低六大條件分數</span>
              <span className="text-blue-400 font-mono font-bold">{strategy.minScore}/6</span>
            </div>
            <div className="flex gap-2">
              {[3, 4, 5, 6].map(n => (
                <button key={n} onClick={() => setStrategy({ minScore: n })}
                  className={`flex-1 py-1.5 rounded text-xs font-bold transition ${
                    strategy.minScore === n ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}>
                  {n}分
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Stop-loss setting */}
        <div className="bg-secondary border border-border rounded-xl p-4 space-y-3">
          <div>
            <h2 className="text-sm font-bold text-foreground/90 mb-0.5">🛡 停損設定</h2>
            <p className="text-xs text-muted-foreground">走圖時持倉的成本停損百分比</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-foreground/80 group relative cursor-help">停損比例 <span className="text-muted-foreground/60">ⓘ</span>
                <span className="absolute z-50 left-0 top-full mt-1 hidden group-hover:block w-56 p-2 rounded bg-secondary border border-border text-[10px] text-foreground/80 shadow-lg">
                  成本停損 = 買入均價 × (1 - 停損%)。例如設 7% 表示虧損 7% 即建議停損。朱老師建議短線 5-7%，波段 7-10%。
                </span>
              </span>
              <span className="text-red-400 font-mono font-bold">-{stopLossPercent}%</span>
            </div>
            <input type="range" min={3} max={15} step={1}
              value={stopLossPercent}
              onChange={e => setStopLossPercent(+e.target.value)}
              className="w-full h-1.5 rounded-full accent-red-500 bg-muted" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>3%（短線嚴格）</span><span>15%（波段寬鬆）</span>
            </div>
          </div>
        </div>

        {/* Scan schedule */}
        <div className="bg-secondary/60 border border-border rounded-xl p-4 space-y-2.5">
          <h3 className="text-xs font-bold text-foreground/80">📅 自動掃描時間</h3>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                台灣股市
              </span>
              <span className="text-foreground/80 font-medium">每週一至五 下午 1:00</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                中國A股
              </span>
              <span className="text-foreground/80 font-medium">每週一至五 下午 2:30</span>
            </div>
          </div>
        </div>

        {/* 漲跌色彩主題 */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">漲跌色彩</h2>
          <div className="flex gap-3">
            {([
              { value: 'asia' as const, label: '紅漲綠跌', desc: '台灣/大陸慣例', up: 'bg-red-500', down: 'bg-green-500' },
              { value: 'western' as const, label: '綠漲紅跌', desc: '歐美慣例', up: 'bg-green-500', down: 'bg-red-500' },
            ]).map(t => (
              <button key={t.value} onClick={() => setColorTheme(t.value)}
                className={`flex-1 p-3 rounded-lg border text-left transition ${
                  colorTheme === t.value
                    ? 'border-sky-500 bg-sky-950/40'
                    : 'border-border bg-secondary/40 hover:border-muted-foreground/40'
                }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-3 h-3 rounded-full ${t.up}`} />
                  <span className="text-xs text-muted-foreground">漲</span>
                  <span className={`w-3 h-3 rounded-full ${t.down}`} />
                  <span className="text-xs text-muted-foreground">跌</span>
                </div>
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-[10px] text-muted-foreground">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Nav links */}
        <div className="flex gap-2">
          <Link href="/watchlist" className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition">
            ⭐ 自選股
          </Link>
          <Link href="/portfolio" className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition">
            💼 持倉
          </Link>
          <Link href="/scanner" className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition">
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
            className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-sky-300 hover:border-sky-700 transition"
          >
            重新顯示功能導覽
          </button>
          <Link href="/disclaimer" className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-amber-300 hover:border-amber-700 transition">
            風險聲明與條款
          </Link>
        </div>

        {/* 清除數據 */}
        <div className="bg-card border border-red-900/30 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-red-400">清除本機數據</h2>
          <p className="text-[11px] text-muted-foreground">清除瀏覽器中儲存的所有設定、自選股、持倉、掃描歷史等資料。此操作不可恢復。</p>
          <button
            onClick={() => {
              if (confirm('確定要清除所有本機數據嗎？此操作不可恢復。')) {
                try { localStorage.clear(); window.location.href = '/'; } catch {}
              }
            }}
            className="text-xs px-4 py-2 bg-red-900/40 hover:bg-red-800/60 text-red-300 rounded-lg border border-red-800/50 transition"
          >
            清除所有數據並重新開始
          </button>
        </div>

      </div>
    </PageShell>
  );
}
