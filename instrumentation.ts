// instrumentation.ts — Next.js server startup hook
// 本地開發時定期呼叫 API route 模擬 Vercel Cron。
//
// 設計原則（鐵律 4：Edge-safe 模組邊界）：
//   本檔只做「時間判斷 + fetch 呼叫」，**不 import 任何含 fs/path 的模組**。
//   實際做事交給宣告 runtime='nodejs' 的 API route。
//   這樣 Edge bundler 才不會在 HMR 後把 fs 依賴拉進來炸掉（歷史傷疤：DabanScanner 2026-04-17）。

import { isMarketOpen, isPostCloseWindow, getLastTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

function localUrl(path: string): string {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}${path}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.CRON_SECRET) h['authorization'] = `Bearer ${process.env.CRON_SECRET}`;
  return h;
}

async function callRoute(path: string, label: string): Promise<unknown> {
  try {
    const res = await fetch(localUrl(path), { headers: authHeaders() });
    if (!res.ok) {
      console.error(`[local-cron] ${label} HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[local-cron] ${label} fetch failed:`, err);
    return null;
  }
}

export async function register() {
  // 只在本地開發啟動定時器（Vercel 有自己的 cron）
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;

  console.log('[local-cron] 本地開發模式：定期呼叫 API route 模擬 Vercel Cron');
  console.log('[local-cron] 刷新+掃描：TW / CN 每 5 分鐘；打板開盤確認：9:25–9:35 CST；L1 下載：盤後一次');

  // ── 盤中：買法掃描（B/C/D/E/F），輪流觸發 —— 獨立於 A 六條件避免單輪超時 ──
  async function scanBuyMethodIntraday(market: 'TW' | 'CN', method: 'B' | 'C' | 'D' | 'E' | 'F') {
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;
    const data = await callRoute(
      `/api/cron/update-intraday-bm?market=${market}&method=${method}`,
      `${market} update-intraday-bm ${method}`,
    ) as { data?: { skipped?: boolean; reason?: string; resultCount?: number } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} 買法 ${method} 跳過：${(payload as { reason?: string }).reason}`);
    } else {
      console.log(`[local-cron] ${market} 買法 ${method}: ${(payload as { resultCount?: number }).resultCount ?? -1} 檔`);
    }
  }

  // ── 盤中：L2 刷新 + L4 掃描（走 update-intraday route） ──
  async function refreshAndScan(market: 'TW' | 'CN') {
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;
    const data = await callRoute(`/api/cron/update-intraday?market=${market}`, `${market} update-intraday`);
    if (data && typeof data === 'object') {
      const payload = ('data' in (data as object) ? (data as { data: unknown }).data : data) as {
        snapshot?: { count?: number; updatedAt?: string };
        scanCount?: number;
        skipped?: boolean;
        reason?: string;
      };
      if (payload?.skipped) {
        console.log(`[local-cron] ${market} update-intraday 跳過：${payload.reason}`);
      } else {
        const count = payload?.snapshot?.count ?? -1;
        const scanCount = payload?.scanCount ?? -1;
        console.log(`[local-cron] ${market} L2 刷新 ${count} 支；L4 掃描 ${scanCount} 檔`);
      }
    }
  }

  // ── 盤後：買法 post_close 掃描（B/C/D/E/F 各自呼叫 scan-bm） ──
  // TW：收盤後 14:10 CST（UTC+8 = 06:10 UTC），確保 L1 已下載
  // CN：收盤後 16:10 CST（UTC+8 = 08:10 UTC），確保 L1 已下載
  const postCloseBmDone = { TW: '', CN: '' };
  async function scanBuyMethodPostClose(market: 'TW' | 'CN', method: 'B' | 'C' | 'D' | 'E' | 'F') {
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const hhmm = nowLocal.getHours() * 100 + nowLocal.getMinutes();

    // TW: 14:10–17:00；CN: 16:10–19:00
    const windowStart = market === 'TW' ? 1410 : 1610;
    const windowEnd = market === 'TW' ? 1700 : 1900;
    if (hhmm < windowStart || hhmm > windowEnd) return;

    const key = `${market}-${method}`;
    const doneKey = `${todayLocal}-${key}`;
    if ((postCloseBmDone as Record<string, string>)[key] === doneKey) return;
    if (!isTradingDay(todayLocal, market)) return;

    (postCloseBmDone as Record<string, string>)[key] = doneKey;
    console.log(`[local-cron] ${market} scan-bm ${method} post_close 啟動 (${todayLocal})...`);
    const data = await callRoute(
      `/api/cron/scan-bm?market=${market}&method=${method}`,
      `${market} scan-bm ${method}`,
    ) as { data?: { resultCount?: number; skipped?: boolean; reason?: string } } | null;
    const payload = data?.data ?? data ?? {};
    if ((payload as { skipped?: boolean }).skipped) {
      console.log(`[local-cron] ${market} scan-bm ${method} 跳過：${(payload as { reason?: string }).reason}`);
    } else {
      console.log(`[local-cron] ${market} scan-bm ${method}: ${(payload as { resultCount?: number }).resultCount ?? -1} 檔`);
    }
  }

  // ── 盤後：L1 下載（走 download-candles route） ──
  // 規則：收盤後到隔日盤前之間都可跑。以「最後一個交易日」為 key 去重，
  // 確保 dev server 若在 postClose 窗口後才啟動，當天 L1 仍會補下載。
  const l1Downloaded = { TW: '', CN: '' };
  async function downloadL1(market: 'TW' | 'CN') {
    if (isMarketOpen(market)) return; // 盤中不下（收盤價還沒定）
    const lastTrading = getLastTradingDay(market);
    if (l1Downloaded[market] === lastTrading) return;

    l1Downloaded[market] = lastTrading; // 先標記，防重複執行
    console.log(`[local-cron] ${market} 觸發 download-candles (lastTrading=${lastTrading})...`);
    await callRoute(`/api/cron/download-candles?market=${market}`, `${market} download-candles`);
  }

  // ── 盤後：L2 快照補 L1（收盤後 30 分鐘，TW≥14:00 / CN≥15:30，每日一次） ──
  // 比 download-candles 快（5 秒完成全市場），用於補 download-candles 遺漏的個股
  const l1SnapshotDone = { TW: '', CN: '' };
  async function appendL1FromSnapshot(market: 'TW' | 'CN') {
    if (isMarketOpen(market)) return;
    const lastTrading = getLastTradingDay(market);
    if (l1SnapshotDone[market] === lastTrading) return;

    // 30 分鐘緩衝：TW 收盤 13:30 → 等到 14:00；CN 收盤 15:00 → 等到 15:30
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const now = new Date();
    const hhmm = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(now).replace(':', ''),
      10,
    );
    const triggerMin = market === 'TW' ? 1400 : 1530; // 14:00 CST / 15:30 CST
    if (hhmm < triggerMin) return;

    l1SnapshotDone[market] = lastTrading;
    console.log(`[local-cron] ${market} append-from-snapshot 觸發 (lastTrading=${lastTrading})...`);
    const json = await callRoute(
      `/api/cron/append-from-snapshot?market=${market}`,
      `${market} append-from-snapshot`,
    ) as { appended?: number; already?: number } | null;
    console.log(`[local-cron] ${market} append-from-snapshot 完成: appended=${(json as { appended?: number })?.appended ?? '?'}`);
  }

  // ── 打板開盤確認（CN 9:25–9:35 CST，每日一次） ──
  const dabanConfirmed = { date: '' };
  async function maybeConfirmDabanOpen() {
    const nowCN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const hhmm = nowCN.getHours() * 100 + nowCN.getMinutes();

    if (hhmm < 925 || hhmm > 935) return;
    if (dabanConfirmed.date === todayCN) return;
    if (!isTradingDay(todayCN, 'CN')) return;

    dabanConfirmed.date = todayCN;
    console.log('[local-cron] CN 打板開盤確認啟動...');
    const json = await callRoute('/api/cron/confirm-daban-open', 'CN confirm-daban-open') as
      { data?: { confirmed?: number; total?: number; resultCount?: number } } | null;
    const data = json?.data ?? json ?? {};
    const confirmed = (data as { confirmed?: number }).confirmed ?? 0;
    const total = (data as { resultCount?: number; total?: number }).resultCount ?? (data as { total?: number }).total ?? 0;
    console.log(`[local-cron] CN 打板開盤確認完成: ${confirmed}/${total} 支確認進場`);
  }

  // 計時器
  setInterval(() => { refreshAndScan('TW').catch(err => console.error('[local-cron] TW refreshAndScan:', err)); }, 5 * 60 * 1000);
  setInterval(() => { refreshAndScan('CN').catch(err => console.error('[local-cron] CN refreshAndScan:', err)); }, 5 * 60 * 1000);

  // 買法 B/C/D/E/F 錯開：每分鐘檢查，:02→B :04→C :06→D :08→E :00→F（10 分鐘輪一圈）
  setInterval(() => {
    const rem = new Date().getMinutes() % 10;
    const method = rem === 2 ? 'B' : rem === 4 ? 'C' : rem === 6 ? 'D' : rem === 8 ? 'E' : rem === 0 ? 'F' : null;
    if (!method) return;
    scanBuyMethodIntraday('TW', method).catch(err => console.error(`[local-cron] TW bm ${method}:`, err));
    scanBuyMethodIntraday('CN', method).catch(err => console.error(`[local-cron] CN bm ${method}:`, err));
  }, 60 * 1000);

  setInterval(() => { maybeConfirmDabanOpen().catch(err => console.error('[local-cron] confirm-daban-open:', err)); }, 60 * 1000);
  setInterval(() => {
    downloadL1('TW').catch(err => console.error('[local-cron] TW downloadL1:', err));
    downloadL1('CN').catch(err => console.error('[local-cron] CN downloadL1:', err));
  }, 10 * 60 * 1000);
  setInterval(() => {
    appendL1FromSnapshot('TW').catch(err => console.error('[local-cron] TW appendL1FromSnapshot:', err));
    appendL1FromSnapshot('CN').catch(err => console.error('[local-cron] CN appendL1FromSnapshot:', err));
  }, 5 * 60 * 1000);

  // 盤後買法掃描：每分鐘檢查，時間窗口內對 B/C/D/E/F 各觸發一次
  setInterval(() => {
    for (const method of ['B', 'C', 'D', 'E', 'F'] as const) {
      scanBuyMethodPostClose('TW', method).catch(err => console.error(`[local-cron] TW scan-bm ${method}:`, err));
      scanBuyMethodPostClose('CN', method).catch(err => console.error(`[local-cron] CN scan-bm ${method}:`, err));
    }
  }, 60 * 1000);
}
