import { ScanSession, MarketId, ScanDirection, MtfMode } from '@/lib/scanner/types';
import { isWeekday } from '@/lib/utils/tradingDay';

// ── Storage abstraction for scan sessions ────────────────────────────────────
// Production (Vercel): uses Vercel Blob for durable persistence
// Local dev: uses filesystem (data/ directory)

const IS_VERCEL = !!process.env.VERCEL;

if (IS_VERCEL && !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('[scanStorage] BLOB_READ_WRITE_TOKEN 未設定，Blob 操作將失敗。請至 Vercel Dashboard → Storage 建立 Blob Store 並連接專案');
}

/** Summary entry returned by listScanDates */
export interface ScanDateEntry {
  market: MarketId;
  date: string;
  direction?: ScanDirection;
  mtfMode?: MtfMode;
  resultCount: number;
  scanTime: string;
}

// ── Vercel Blob helpers ──────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  const { put } = await import('@vercel/blob');
  await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
}

async function blobGet(pathname: string): Promise<string | null> {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private' });
  if (!result || !result.stream) return null;
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function blobListPrefix(prefix: string): Promise<Array<{ pathname: string; uploadedAt: Date }>> {
  const { list: blobList } = await import('@vercel/blob');
  const all: Array<{ pathname: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  // paginate through all blobs with this prefix
  do {
    const result = await blobList({ prefix, limit: 100, cursor });
    all.push(...result.blobs.map(b => ({ pathname: b.pathname, uploadedAt: b.uploadedAt })));
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return all;
}

async function blobDelete(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const { del } = await import('@vercel/blob');
  await del(urls);
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.writeFile(fullPath, data, 'utf-8');
  // 寫入驗證：避免「掃完了卻沒檔」靜默失敗（2026-04-17 加）
  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(`fsPut verify failed: ${filename} (size=${stat?.size ?? 'missing'})`);
  }
}

async function fsGet(filename: string): Promise<string | null> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  try {
    return await fs.readFile(path.join(process.cwd(), 'data', filename), 'utf-8');
  } catch {
    return null;
  }
}

async function fsListPrefix(prefix: string): Promise<string[]> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const dir = path.join(process.cwd(), 'data');
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  } catch {
    return [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive MTF mode from session */
function sessionMtfMode(session: ScanSession): MtfMode {
  return session.multiTimeframeEnabled ? 'mtf' : 'daily';
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Save a scan session (cron or manual)
 *
 * Key format (Fundamental Requirement R5):
 *   post_close: scans/{market}/{dir}/{mtf}/{date}.json (唯一正式結果)
 *   intraday:   scans/{market}/{dir}/{mtf}/{date}/intraday/{HHMM}.json (可多筆)
 *
 * post_close 封存後不可被非官方來源覆蓋（需傳 allowOverwritePostClose: true）
 * intraday 帶時間戳，不會互相覆蓋
 * 每次儲存 post_close 後自動清理，只保留最近 KEEP_SCAN_DAYS 個交易日
 */
const KEEP_SCAN_DAYS = 20;

interface SaveScanOptions {
  /** 只有官方 cron 才應傳 true，允許覆蓋已存在的 post_close 結果 */
  allowOverwritePostClose?: boolean;
}

/** 檢查指定日期是否已有 post_close 結果（封存檢查） */
async function isPostCloseSealed(
  market: MarketId, direction: string, mtfMode: string, date: string,
): Promise<boolean> {
  const blobPath = `scans/${market}/${direction}/${mtfMode}/${date}.json`;
  const localName = `scan-${market}-${direction}-${mtfMode}-${date}.json`;

  if (IS_VERCEL) {
    const raw = await blobGet(blobPath).catch(() => null);
    return raw !== null;
  }
  const raw = await fsGet(localName);
  return raw !== null;
}

export async function saveScanSession(
  session: ScanSession,
  opts?: SaveScanOptions,
): Promise<void> {
  const data = JSON.stringify(session);
  const dir = session.direction ?? 'long';
  const mtf = sessionMtfMode(session);
  const sessionType = session.sessionType ?? 'post_close';

  if (sessionType === 'intraday') {
    // 盤中快照：帶時間戳，不覆蓋正式結果
    const hhmm = new Date(session.scanTime).toISOString().slice(11, 16).replace(':', '');
    const blobPath = `scans/${session.market}/${dir}/${mtf}/${session.date}/intraday/${hhmm}.json`;
    const localName = `scan-${session.market}-${dir}-${mtf}-${session.date}-intraday-${hhmm}.json`;

    if (IS_VERCEL) {
      await blobPut(blobPath, data);
    } else {
      await fsPut(localName, data);
    }
  } else {
    // ── 封存保護：post_close 已存在時，非官方來源不可覆蓋 ──
    if (!opts?.allowOverwritePostClose) {
      const sealed = await isPostCloseSealed(session.market, dir, mtf, session.date);
      if (sealed) {
        console.warn(
          `[scanStorage] ⛔ 拒絕覆蓋已封存的 post_close: ${session.market}/${dir}/${mtf}/${session.date}` +
          ` (caller id: ${session.id}). 若為官方 cron 請傳 allowOverwritePostClose: true`,
        );
        return; // 不存，靜默退出
      }
    }

    // 收盤後正式結果：唯一
    const blobPath = `scans/${session.market}/${dir}/${mtf}/${session.date}.json`;
    const localName = `scan-${session.market}-${dir}-${mtf}-${session.date}.json`;

    if (IS_VERCEL) {
      await blobPut(blobPath, data);
    } else {
      await fsPut(localName, data);
    }

    console.log(`[scanStorage] ✅ post_close 已儲存: ${session.market}/${dir}/${mtf}/${session.date} (${session.resultCount} 檔)`);

    // 儲存完畢後非同步清理舊檔（不阻塞回傳）
    pruneOldScanSessions(session.market, dir as ScanDirection, mtf, KEEP_SCAN_DAYS).catch(
      err => console.warn('[scanStorage] prune failed (non-critical):', err)
    );
  }
}

/**
 * 只保留最近 keepDays 個交易日的 post_close 掃描結果，刪除更舊的。
 * intraday 快照不處理（跟著 post_close 日期一起自然消失）。
 */
async function pruneOldScanSessions(
  market: MarketId,
  direction: ScanDirection,
  mtfMode: MtfMode,
  keepDays: number,
): Promise<void> {
  const prefix = `scans/${market}/${direction}/${mtfMode}/`;

  if (IS_VERCEL) {
    const blobs = await blobListPrefix(prefix);
    // 只取 post_close 檔（直接在 prefix 下，形如 YYYY-MM-DD.json）
    const postCloseBlobs = blobs.filter(b => /\d{4}-\d{2}-\d{2}\.json$/.test(b.pathname));
    // 依日期降序，保留前 keepDays 筆，刪除其餘
    const sorted = postCloseBlobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
    const toDelete = sorted.slice(keepDays);
    if (toDelete.length > 0) {
      // Vercel Blob del 接受 URL 陣列，需先取得 URL
      // blobListPrefix 回傳的是 pathname，需組合成完整 URL
      // 實際上 del 也可接受 pathname 陣列（v0.6+）
      const { del } = await import('@vercel/blob');
      await del(toDelete.map(b => b.pathname));
      console.log(`[scanStorage] pruned ${toDelete.length} old sessions for ${market}/${direction}/${mtfMode}`);
    }
  } else {
    // Local dev：清理 data/ 目錄
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const dir = path.join(process.cwd(), 'data');
    const prefix_local = `scan-${market}-${direction}-${mtfMode}-`;
    try {
      const files = await fs.readdir(dir);
      const postCloseFiles = files
        .filter(f => f.startsWith(prefix_local) && /\d{4}-\d{2}-\d{2}\.json$/.test(f));
      const sorted = postCloseFiles.sort((a, b) => b.localeCompare(a));
      const toDelete = sorted.slice(keepDays);
      for (const f of toDelete) {
        await fs.unlink(path.join(dir, f)).catch(() => {});
      }
      if (toDelete.length > 0) {
        console.log(`[scanStorage] pruned ${toDelete.length} old local sessions for ${market}/${direction}/${mtfMode}`);
      }
    } catch { /* dir may not exist in test env */ }
  }
}

/** List all available scan dates for a market + direction + optional mtfMode */
export async function listScanDates(
  market: MarketId,
  direction: ScanDirection = 'long',
  mtfMode?: MtfMode,
): Promise<ScanDateEntry[]> {
  const entries: ScanDateEntry[] = [];
  const modes: MtfMode[] = mtfMode ? [mtfMode] : ['daily', 'mtf'];

  if (IS_VERCEL) {
    try {
      for (const m of modes) {
        // New MTF-aware path
        const blobs = await blobListPrefix(`scans/${market}/${direction}/${m}/`);
        for (const blob of blobs) {
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction, mtfMode: m,
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }

      // Fallback: check old direction-aware path (no mtf subfolder)
      if (entries.length === 0) {
        const blobs = await blobListPrefix(`scans/${market}/${direction}/`);
        for (const blob of blobs) {
          // Skip mtf subfolders
          if (blob.pathname.includes('/daily/') || blob.pathname.includes('/mtf/')) continue;
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction, mtfMode: 'daily',
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }

      // Fallback: legacy path (no direction, no mtf)
      if (entries.length === 0 && direction === 'long') {
        const legacyBlobs = await blobListPrefix(`scans/${market}/`);
        for (const blob of legacyBlobs) {
          if (blob.pathname.includes('/long/') || blob.pathname.includes('/short/')) continue;
          if (blob.pathname.includes('/daily/') || blob.pathname.includes('/mtf/')) continue;
          const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
          if (!match) continue;
          entries.push({
            market, direction: 'long', mtfMode: 'daily',
            date: match[1], resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[scanStorage] Blob listScanDates failed (token missing?):', err);
    }
  } else {
    // Local dev: read from data/ directory
    for (const m of modes) {
      const files = await fsListPrefix(`scan-${market}-${direction}-${m}-`);
      for (const file of files) {
        const match = file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;
        try {
          const raw = await fsGet(file);
          if (raw) {
            const session = JSON.parse(raw) as ScanSession;
            entries.push({
              market, direction, mtfMode: m,
              date: match[1],
              resultCount: session.resultCount,
              scanTime: session.scanTime,
            });
          }
        } catch {
          entries.push({
            market, direction, mtfMode: m,
            date: match[1], resultCount: -1, scanTime: '',
          });
        }
      }
    }

    // Always merge legacy format files (old format without direction/mtf dimension)
    // so that new-format and old-format records coexist seamlessly.
    {
      let files = await fsListPrefix(`scan-${market}-${direction}-`);
      // Filter out new-format files (already read above)
      files = files.filter(f => !f.includes('-daily-') && !f.includes('-mtf-'));
      // Legacy fallback (no direction prefix)
      if (files.length === 0 && direction === 'long') {
        const legacyFiles = await fsListPrefix(`scan-${market}-`);
        files = legacyFiles.filter(f => !f.includes('-long-') && !f.includes('-short-') && !f.includes('-daily-') && !f.includes('-mtf-'));
      }
      for (const file of files) {
        const match = file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!match) continue;
        try {
          const raw = await fsGet(file);
          if (raw) {
            const session = JSON.parse(raw) as ScanSession;
            entries.push({
              market, direction, mtfMode: 'daily',
              date: match[1],
              resultCount: session.resultCount,
              scanTime: session.scanTime,
            });
          }
        } catch {
          entries.push({
            market, direction, mtfMode: 'daily',
            date: match[1], resultCount: -1, scanTime: '',
          });
        }
      }
    }
  }

  // ── 盤中 intraday session 也納入清單 ──
  // 不再跳過已有 post_close 的日期，讓 intraday 進入 entries，
  // 由下方 dedup 步驟依 scanTime 取最新（盤中 intraday 較新 → 選 intraday）

  if (IS_VERCEL) {
    try {
      for (const m of modes) {
        const blobs = await blobListPrefix(`scans/${market}/${direction}/${m}/`);
        for (const blob of blobs) {
          // 匹配 intraday 路徑: {date}/intraday/{HHMM}.json
          const intradayMatch = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\/intraday\/\d{4}\.json$/);
          if (!intradayMatch) continue;
          const dateStr = intradayMatch[1];
          // 不跳過：讓 intraday 與 post_close 共存，由 dedup 取最新 scanTime
          entries.push({
            market, direction, mtfMode: m,
            date: dateStr, resultCount: -1,
            scanTime: blob.uploadedAt.toISOString(),
          });
        }
      }
    } catch { /* non-critical */ }
  } else {
    for (const m of modes) {
      const intradayFiles = await fsListPrefix(`scan-${market}-${direction}-${m}-`);
      for (const file of intradayFiles) {
        const intradayMatch = file.match(/(\d{4}-\d{2}-\d{2})-intraday-\d{4}\.json$/);
        if (!intradayMatch) continue;
        const dateStr = intradayMatch[1];
        // 不跳過也不加入 existingDates，讓同日多筆 intraday 都進 entries，由 dedup 取最新
        try {
          const raw = await fsGet(file);
          if (raw) {
            const session = JSON.parse(raw) as ScanSession;
            entries.push({
              market, direction, mtfMode: m,
              date: dateStr,
              resultCount: session.resultCount,
              scanTime: session.scanTime,
            });
          } else {
            entries.push({
              market, direction, mtfMode: m,
              date: dateStr, resultCount: -1, scanTime: '',
            });
          }
        } catch {
          entries.push({
            market, direction, mtfMode: m,
            date: dateStr, resultCount: -1, scanTime: '',
          });
        }
      }
    }
  }

  // Deduplicate by date+mtfMode
  // 選擇規則（和 loadScanSession 邏輯保持一致）：
  // 1) 優先選 resultCount > 0 的 entry
  // 2) 同是有結果（或同為 0） → 取最新 scanTime
  // 這樣空 post_close（歷史日期 backfill 重跑變 0）不會遮蓋有結果的 intraday
  const seen = new Map<string, ScanDateEntry>();
  for (const e of entries) {
    const key = `${e.date}-${e.mtfMode}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
      continue;
    }
    const eHas = e.resultCount > 0;
    const oHas = existing.resultCount > 0;
    if (eHas && !oHas) seen.set(key, e);
    else if (!eHas && oHas) { /* keep existing */ }
    else {
      // 兩邊同有結果或同為 0 → 取最新 scanTime
      if (e.scanTime > existing.scanTime) seen.set(key, e);
    }
  }

  // Filter out non-trading days (weekends + holidays) that may have been backfilled incorrectly
  return [...seen.values()]
    .filter(e => isWeekday(e.date, e.market as 'TW' | 'CN'))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Load a specific scan session by market + date + direction + mtfMode */
export async function loadScanSession(
  market: MarketId,
  date: string,
  direction: ScanDirection = 'long',
  mtfMode: MtfMode = 'daily',
): Promise<ScanSession | null> {
  let raw: string | null = null;

  if (IS_VERCEL) {
    try {
      // New MTF-aware path
      raw = await blobGet(`scans/${market}/${direction}/${mtfMode}/${date}.json`);
      // Fallback: old direction path (no mtf) — only for daily mode
      // (old format data was effectively daily-only; don't serve it for mtf requests)
      if (!raw && mtfMode === 'daily') {
        raw = await blobGet(`scans/${market}/${direction}/${date}.json`);
      }
      // Fallback: legacy path (no direction) — only for daily + long
      if (!raw && mtfMode === 'daily' && direction === 'long') {
        raw = await blobGet(`scans/${market}/${date}.json`);
      }
    } catch (err) {
      console.error('[scanStorage] Blob loadScanSession failed (token missing?):', err);
    }
  }

  // Local filesystem: new format
  if (!raw) {
    raw = await fsGet(`scan-${market}-${direction}-${mtfMode}-${date}.json`);
  }
  // Fallback: old format without mtf — only for daily mode
  if (!raw && mtfMode === 'daily') {
    raw = await fsGet(`scan-${market}-${direction}-${date}.json`);
  }
  // Legacy fallback — only for daily + long
  if (!raw && mtfMode === 'daily' && direction === 'long') {
    raw = await fsGet(`scan-${market}-${date}.json`);
  }

  // 若有 post_close，決定是否改用 intraday：
  //   1) 空的 post_close + 有結果的 intraday → 一律優先 intraday
  //      （歷史日期的 post_close 被重跑變 0 筆，不該蓋掉真實盤中結果）
  //   2) intraday 比 post_close 新且有結果 → 優先 intraday（盤中即時覆蓋）
  if (raw) {
    const intradayRaw = await loadLatestIntradayRaw(market, date, direction, mtfMode);
    if (intradayRaw) {
      try {
        const postClose = JSON.parse(raw) as ScanSession;
        const intraday = JSON.parse(intradayRaw) as ScanSession;
        const intradayNewer =
          !!intraday.scanTime && !!postClose.scanTime &&
          intraday.scanTime > postClose.scanTime;
        const postCloseEmpty = postClose.resultCount === 0;
        if (intraday.resultCount > 0 && (intradayNewer || postCloseEmpty)) {
          raw = intradayRaw;
        }
      } catch { /* parse 失敗就用 post_close */ }
    }
  }

  // Fallback: 若無 post_close session，嘗試載入最新的 intraday session
  if (!raw) {
    raw = await loadLatestIntradayRaw(market, date, direction, mtfMode);
  }

  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as ScanSession;
    // 事後補 turnoverRank：session 原始寫入時若索引缺，results 的 turnoverRank 會是 null
    // 讀取時用當前索引補一次，避免 UI 永遠顯示「成交量#—」
    const missingRanks = session.results?.some(r => r.turnoverRank == null);
    if (missingRanks && session.results) {
      try {
        const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
        const idx = await readTurnoverRank(market as 'TW' | 'CN');
        if (idx) {
          for (const r of session.results) {
            if (r.turnoverRank == null) {
              const rank = idx.ranks.get(r.symbol);
              if (rank) r.turnoverRank = rank;
            }
          }
        }
      } catch { /* 索引讀失敗 — 保持 null */ }
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * 檢查 session 是否為「乾淨的」——結果中大多數是該日的 K 棒
 * 用於過濾 STOCK_DAY_ALL 汙染等資料源事故漏網之魚
 * 判定：若有 dataFreshness，則 ≥50% 結果的 lastCandleDate === date
 * 若沒 dataFreshness 欄位（舊版），保留兼容（視為 clean）
 */
function isFreshSession(session: ScanSession, date: string): boolean {
  if (!session.results || session.results.length === 0) return true;
  const withFreshness = session.results.filter(r => r?.dataFreshness?.lastCandleDate);
  if (withFreshness.length === 0) return true; // 舊版無欄位 → 兼容
  const fresh = withFreshness.filter(r => r.dataFreshness!.lastCandleDate === date);
  return fresh.length / withFreshness.length >= 0.5;
}

/**
 * 載入指定日期最新的 intraday session 原始 JSON
 * 路徑: scans/{market}/{dir}/{mtf}/{date}/intraday/{HHMM}.json
 * 取最大 HHMM（最新一筆）
 * 並要求多數結果的 lastCandleDate === date（防汙染資料漏網）
 */
async function loadLatestIntradayRaw(
  market: MarketId,
  date: string,
  direction: ScanDirection,
  mtfMode: MtfMode,
): Promise<string | null> {
  if (IS_VERCEL) {
    try {
      const prefix = `scans/${market}/${direction}/${mtfMode}/${date}/intraday/`;
      const blobs = await blobListPrefix(prefix);
      if (blobs.length === 0) return null;
      // 從最新往回找，優先返回有結果 + 資料新鮮的 intraday
      const sorted = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
      for (const blob of sorted) {
        const raw = await blobGet(blob.pathname);
        if (raw) {
          try {
            const session = JSON.parse(raw) as ScanSession;
            if (session.resultCount > 0 && isFreshSession(session, date)) return raw;
          } catch { /* continue */ }
        }
      }
      // 全部都 0 結果或資料都汙染 → 返回最新的
      return await blobGet(sorted[0].pathname);
    } catch {
      return null;
    }
  }

  // Local dev: 從最新往回找有結果 + 資料新鮮的 intraday
  const prefix = `scan-${market}-${direction}-${mtfMode}-${date}-intraday-`;
  const files = await fsListPrefix(prefix);
  if (files.length === 0) return null;
  const sorted = files.sort((a, b) => b.localeCompare(a));
  for (const file of sorted) {
    const raw = await fsGet(file);
    if (raw) {
      try {
        const session = JSON.parse(raw) as ScanSession;
        if (session.resultCount > 0 && isFreshSession(session, date)) return raw;
      } catch { /* continue */ }
    }
  }
  // 全部都 0 結果或資料都汙染 → 返回最新的
  return await fsGet(sorted[0]);
}
