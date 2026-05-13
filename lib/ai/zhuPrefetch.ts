/**
 * 朱老師問答的伺服器端 prefetch — 把容易拿到的所有資料先撈完打包進 question.json
 *
 * 朱老師打開問題檔就看完整桌面，不用一條一條 Bash 自己查。
 * 拿不到的（新聞、法說、同業即時）保持讓朱老師上網查。
 *
 * 拉的資料：
 *   - 法人三大買賣超 /api/institutional/<symbol>
 *   - 綜合籌碼 /api/chip?symbol=...
 *   - 鎖股觀察 /api/lockwatch?market=...
 *   - 持有此股的主動 ETF（從 data/etf/snapshots/ grep）
 *   - 同產業近期掃描結果（從 /api/scanner/results 取同產業前幾名）
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const SELF_BASE = process.env.NEXT_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const FETCH_TIMEOUT_MS = 4_000;

export interface ZhuPrefetchData {
  institutional?: unknown;            // 法人三大買賣超
  chip?: unknown;                     // 綜合籌碼
  lockwatch?: unknown;                // 鎖股觀察狀態
  etfHoldings?: Array<{               // 哪些主動 ETF 持有它
    etf: string;
    snapshotDate: string;
    weight?: number;
    shares?: number;
  }>;
  sectorPeers?: unknown;              // 同產業近期表現
  fetchErrors?: string[];             // 哪些 prefetch 失敗，讓朱老師知道要 fallback
}

async function fetchJSON(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchInstitutional(symbol: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/institutional/${encodeURIComponent(symbol)}`);
}

async function fetchChip(symbol: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/chip?symbol=${encodeURIComponent(symbol)}`);
}

async function fetchLockwatch(market: 'TW' | 'CN', symbol: string): Promise<unknown> {
  const data = await fetchJSON(`${SELF_BASE}/api/lockwatch?market=${market}`);
  if (!data || typeof data !== 'object') return null;
  const list = (data as { entries?: Array<{ symbol?: string }> }).entries ?? [];
  return list.find(e => e.symbol === symbol || e.symbol === `${symbol}.TW` || e.symbol === `${symbol}.TWO`) ?? null;
}

/** 找哪些主動 ETF 最近的 snapshot 含這檔股票 */
async function findETFHoldings(symbol: string): Promise<ZhuPrefetchData['etfHoldings']> {
  try {
    const snapshotsDir = path.join(process.cwd(), 'data/etf/snapshots');
    const files = await readdir(snapshotsDir).catch(() => [] as string[]);
    // 只看最新的每個 ETF（檔名 etf-snap-<code>-<date>.json）
    const latestByETF = new Map<string, string>();
    for (const f of files) {
      const m = f.match(/^etf-snap-([^-]+)-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const [, etf, date] = m;
      const cur = latestByETF.get(etf);
      if (!cur || date > cur) latestByETF.set(etf, f);
    }
    const holdings: ZhuPrefetchData['etfHoldings'] = [];
    for (const [etf, file] of latestByETF) {
      try {
        const raw = await readFile(path.join(snapshotsDir, file), 'utf-8');
        if (!raw.includes(symbol)) continue;
        const parsed = JSON.parse(raw) as { disclosureDate?: string; holdings?: Array<{ symbol?: string; weight?: number; shares?: number }> };
        const hit = (parsed.holdings ?? []).find(h => h.symbol === symbol);
        if (!hit) continue;
        holdings.push({
          etf,
          snapshotDate: parsed.disclosureDate ?? file.replace(/^etf-snap-[^-]+-/, '').replace(/\.json$/, ''),
          weight: hit.weight,
          shares: hit.shares,
        });
      } catch {
        // skip bad files
      }
    }
    return holdings.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  } catch {
    return [];
  }
}

async function fetchSectorPeers(market: 'TW' | 'CN', scanDate: string): Promise<unknown> {
  return fetchJSON(`${SELF_BASE}/api/scanner/results?market=${market}&date=${scanDate}&direction=long&mtf=daily`);
}

/** 平行打所有 prefetch，個別失敗不影響其他 */
export async function prefetchZhuChart(opts: {
  market: 'TW' | 'CN';
  symbol: string;
  date: string;
}): Promise<ZhuPrefetchData> {
  const { market, symbol, date } = opts;
  const errors: string[] = [];

  const [inst, chip, lockwatch, etfHoldings, sectorPeers] = await Promise.all([
    fetchInstitutional(symbol).catch(e => { errors.push(`institutional: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchChip(symbol).catch(e => { errors.push(`chip: ${e instanceof Error ? e.message : e}`); return null; }),
    fetchLockwatch(market, symbol).catch(e => { errors.push(`lockwatch: ${e instanceof Error ? e.message : e}`); return null; }),
    findETFHoldings(symbol).catch(e => { errors.push(`etf: ${e instanceof Error ? e.message : e}`); return [] as NonNullable<ZhuPrefetchData['etfHoldings']>; }),
    fetchSectorPeers(market, date).catch(e => { errors.push(`sectorPeers: ${e instanceof Error ? e.message : e}`); return null; }),
  ]);

  return {
    institutional: inst,
    chip,
    lockwatch,
    etfHoldings,
    sectorPeers,
    fetchErrors: errors.length ? errors : undefined,
  };
}
