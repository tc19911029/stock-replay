'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useSettingsStore } from '@/store/settingsStore';
import { PageShell } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

interface ActiveStrategySnapshot {
  id: string;
  name: string;
  thresholds: {
    deviationMax: number;
    volumeRatioMin: number;
    kdMaxEntry: number;
    upperShadowMax: number;
    minScore: number;
    bullMinScore?: number;
    sidewaysMinScore?: number;
    bearMinScore?: number;
    marketTrendFilter?: boolean;
  };
}

function ActiveStrategyCard() {
  const [active, setActive] = useState<ActiveStrategySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/strategy/active')
      .then(r => r.json())
      .then(json => {
        if (!alive) return;
        if (!json.ok) { setError('讀取失敗'); return; }
        setActive({ id: json.strategyId, name: json.name, thresholds: json.thresholds });
      })
      .catch(() => alive && setError('讀取失敗'));
    return () => { alive = false; };
  }, []);

  return (
    <div className="bg-secondary border border-border rounded-xl p-4 space-y-3">
      <div>
        <h2 className="text-sm font-bold text-foreground/90 mb-0.5">🎯 選股策略</h2>
        <p className="text-xs text-muted-foreground">
          所有條件 / 戒律 / 淘汰法均依寶典 2024，不開放 UI 調整以避免偏離書本（CLAUDE.md Rule 5）
        </p>
      </div>
      {error && <div className="text-xs text-bear">{error}</div>}
      {active && (
        <>
          <div className="text-xs text-foreground/90">
            目前生效：<span className="font-bold text-blue-400">{active.name}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-mono">
            <Row label="MA20 乖離上限" value={`${(active.thresholds.deviationMax * 100).toFixed(0)}%`} />
            <Row label="量比門檻" value={`${active.thresholds.volumeRatioMin.toFixed(1)}x`} />
            <Row label="KD 進場上限" value={active.thresholds.kdMaxEntry >= 100 ? '不限' : String(active.thresholds.kdMaxEntry)} />
            <Row label="上影線上限" value={active.thresholds.upperShadowMax >= 1 ? '不限' : `${(active.thresholds.upperShadowMax * 100).toFixed(0)}%`} />
            <Row label="最低分" value={`${active.thresholds.minScore}/6`} />
            <Row label="大盤趨勢過濾" value={active.thresholds.marketTrendFilter ? '開' : '關'} />
            {active.thresholds.marketTrendFilter && (
              <Row
                label="多/盤/空門檻"
                value={`${active.thresholds.bullMinScore ?? '-'}/${active.thresholds.sidewaysMinScore ?? '-'}/${active.thresholds.bearMinScore ?? '-'}`}
                colSpan={2}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, colSpan }: { label: string; value: string; colSpan?: number }) {
  return (
    <div className={`flex justify-between ${colSpan === 2 ? 'col-span-2' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground/90 font-bold">{value}</span>
    </div>
  );
}

export default function SettingsPage() {
  const { notifyEmail, notifyMinScore, setNotifyEmail, setNotifyMinScore, colorTheme, setColorTheme, stopLossPercent, setStopLossPercent } = useSettingsStore();
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
            <Input
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="輸入你的 Email"
              className="h-10 bg-muted"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">通知門檻</p>
            <div className="flex gap-2">
              {[4, 5, 6].map(n => (
                <Button key={n} onClick={() => setNotifyMinScore(n)}
                  variant={notifyMinScore === n ? 'default' : 'secondary'}
                  className={`flex-1 font-bold ${notifyMinScore === n ? 'bg-blue-600 hover:bg-blue-500' : ''}`}>
                  {n}/6 分以上
                </Button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} className="flex-1 bg-blue-600 hover:bg-blue-500 font-bold">
              儲存
            </Button>
            <Button onClick={handleTest} disabled={testLoading} variant="secondary">
              {testLoading ? '發送中...' : '測試發送'}
            </Button>
          </div>
        </div>

        {/* Active strategy (read-only — 朱家泓純書本版固定，不再開放 UI 調整) */}
        <ActiveStrategyCard />

        {/* Stop-loss setting */}
        <div className="bg-secondary border border-border rounded-xl p-4 space-y-3">
          <div>
            <h2 className="text-sm font-bold text-foreground/90 mb-0.5">🛡 停損設定</h2>
            <p className="text-xs text-muted-foreground">走圖時持倉的成本停損百分比</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <Tooltip>
                <TooltipTrigger className="text-foreground/80 cursor-help">停損比例 <span className="text-muted-foreground/60">ⓘ</span></TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-[14rem] text-[10px]">
                  成本停損 = 買入均價 × (1 - 停損%)。例如設 7% 表示虧損 7% 即建議停損。朱老師建議短線 5-7%，波段 7-10%。
                </TooltipContent>
              </Tooltip>
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
              <Button key={t.value} onClick={() => setColorTheme(t.value)}
                variant="outline"
                className={`flex-1 h-auto p-3 text-left justify-start flex-col items-start ${
                  colorTheme === t.value
                    ? 'border-sky-500 bg-sky-950/40'
                    : ''
                }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-3 h-3 rounded-full ${t.up}`} />
                  <span className="text-xs text-muted-foreground">漲</span>
                  <span className={`w-3 h-3 rounded-full ${t.down}`} />
                  <span className="text-xs text-muted-foreground">跌</span>
                </div>
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-[10px] text-muted-foreground">{t.desc}</div>
              </Button>
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
          <Button
            variant="outline"
            className="flex-1 text-muted-foreground hover:text-sky-300 hover:border-sky-700"
            onClick={() => {
              try { localStorage.removeItem('feature-guide-seen'); } catch {}
              window.location.href = '/';
            }}
          >
            重新顯示功能導覽
          </Button>
          <Link href="/disclaimer" className="flex-1 py-2 text-center bg-secondary border border-border rounded-lg text-sm text-muted-foreground hover:text-amber-300 hover:border-amber-700 transition">
            風險聲明與條款
          </Link>
        </div>

        {/* 清除數據 */}
        <div className="bg-card border border-red-900/30 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-red-400">清除本機數據</h2>
          <p className="text-[11px] text-muted-foreground">清除瀏覽器中儲存的所有設定、自選股、持倉、掃描歷史等資料。此操作不可恢復。</p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (confirm('確定要清除所有本機數據嗎？此操作不可恢復。')) {
                try { localStorage.clear(); window.location.href = '/'; } catch {}
              }
            }}
          >
            清除所有數據並重新開始
          </Button>
        </div>

      </div>
    </PageShell>
  );
}
