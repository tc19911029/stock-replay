import { ScanSession, MarketId, ScanDirection, MtfMode } from '@/lib/scanner/types';
import { isTradingDay } from '@/lib/utils/tradingDay';
// 0512: v11 G/H/I 已被 normalizeMatchedMethods 自動轉成 v12 J/L/K
import {
  BULLISH_TRACK_LETTERS,
  V11_TO_V12_LETTER,
  normalizeMatchedMethods,
} from '@/lib/scanner/buyMethodTracks';

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

// 所有 buy-method 字母（v11 B-I + v12 J-Q）
// 用於 listScanDates 的 legacy filter — 漏列任一字母會讓 daily 模式 date list
// 把 buy-method post_close 誤列為 daily entry（議題：0421 -F- bug 同類）
const BUY_METHOD_LETTERS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'] as const;
const BUY_METHOD_FILE_TOKENS = BUY_METHOD_LETTERS.map((l) => `-${l}-`);
const isBuyMethodFile = (filename: string): boolean =>
  BUY_METHOD_FILE_TOKENS.some((token) => filename.includes(token));

// ── Vercel Blob helpers ──────────────────────────────────────────────────────

async function blobPut(pathname: string, data: string): Promise<void> {
  // 2026-05-08：blob put 加 3 次 retry，防 Blob 偶發 5xx 讓整個 cron 炸掉
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
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

// ── Filesystem helpers ───────────────────────────────────────────────────────

async function fsPut(filename: string, data: string): Promise<void> {
  const { promises: fs } = await import('fs');
  const path = await import('path');
  const { atomicFsPut } = await import('./atomicFsPut');
  const dir = path.join(process.cwd(), 'data');
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await atomicFsPut(fullPath, data);
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

/** Derive MTF mode from session — 買法 session (buyMethod=B-Q) 優先 */
function sessionMtfMode(session: ScanSession): MtfMode {
  if (session.buyMethod) return session.buyMethod;
  return session.multiTimeframeEnabled ? 'mtf' : 'daily';
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Save a scan session (cron or manual)
 *
 * Key format (Fundamental Requirement R5):
 *   post_close: scans/{market}/{dir}/{mtf}/{date}.json (唯一正式結果)
 *   intraday:   scans/{market}/{dir}/{mtf}/{date}/intraday/{HHMMSS}.json (可多筆，秒級防同分鐘撞檔)
 *
 * post_close 封存後不可被非官方來源覆蓋（需傳 allowOverwritePostClose: true）
 * intraday 帶時間戳，不會互相覆蓋
 * 每次儲存 post_close 後自動清理，只保留最近 KEEP_SCAN_DAYS 個交易日
 */
const KEEP_SCAN_DAYS = 22;

interface SaveScanOptions {
  /** 只有官方 cron 才應傳 true，允許覆蓋已存在的 post_close 結果 */
  allowOverwritePostClose?: boolean;
}

/** 檢查指定日期是否已有有效 post_close 結果（封存檢查）
 *
 * 2026-05-07 修：sealed 不只看「檔案存在」，還要 resultCount > 0。
 * 原因：歷史回填產生的空 session 會永久 lock 該日，正式 cron 重跑被靜默擋。
 */
async function isPostCloseSealed(
  market: MarketId, direction: string, mtfMode: string, date: string,
): Promise<boolean> {
  const blobPath = `scans/${market}/${direction}/${mtfMode}/${date}.json`;
  const localName = `scan-${market}-${direction}-${mtfMode}-${date}.json`;

  const raw = IS_VERCEL ? await blobGet(blobPath).catch(() => null) : await fsGet(localName);
  if (raw === null) return false;
  try {
    const session = JSON.parse(raw) as { resultCount?: number };
    // 空 session 不算 sealed，允許正式 cron 覆蓋（避免空結果永久 lock）
    return (session.resultCount ?? 0) > 0;
  } catch {
    // JSON 損壞當沒 sealed，重寫機會
    return false;
  }
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
    // 2026-05-07 修：HHMM (4 碼) → HHMMSS (6 碼)，避免同分鐘多 cron 並發互蓋
    // （原 :08/:00 兩個 method cron 重啟後可能疊到同分鐘觸發）
    const hhmmss = new Date(session.scanTime).toISOString().slice(11, 19).replace(/:/g, '');
    const blobPath = `scans/${session.market}/${dir}/${mtf}/${session.date}/intraday/${hhmmss}.json`;
    const localName = `scan-${session.market}-${dir}-${mtf}-${session.date}-intraday-${hhmmss}.json`;

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
      // 排除已在上面讀過的 new-format files + 所有 buy-method 字母（B-Q）
      files = files.filter(f => !f.includes('-daily-') && !f.includes('-mtf-') && !isBuyMethodFile(f));
      // Legacy fallback (no direction prefix)
      if (files.length === 0 && direction === 'long') {
        const legacyFiles = await fsListPrefix(`scan-${market}-`);
        files = legacyFiles.filter(f =>
          !f.includes('-long-') && !f.includes('-short-') && !f.includes('-daily-') && !f.includes('-mtf-') &&
          !isBuyMethodFile(f),
        );
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
          // 匹配 intraday 路徑: {date}/intraday/{HHMM 或 HHMMSS}.json
          // 2026-05-08：HHMM 4 碼 → HHMMSS 6 碼後相容兩種
          const intradayMatch = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\/intraday\/\d{4,6}\.json$/);
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
        // 2026-05-08：HHMM 4 碼 → HHMMSS 6 碼後相容兩種，避免新檔漏列
        const intradayMatch = file.match(/(\d{4}-\d{2}-\d{2})-intraday-\d{4,6}\.json$/);
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

  // 計 top500 filter 後的真實 count（和 loadScanSession 一致）
  // 避免 UI badge 和面板對不上
  let rankIdx: Awaited<ReturnType<typeof import('@/lib/scanner/TurnoverRank').readTurnoverRank>> = null;
  try {
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    rankIdx = await readTurnoverRank(market as 'TW' | 'CN');
  } catch { /* 索引讀失敗 → 不套 filter，保持原 count */ }

  const filtered = [...seen.values()].filter(e => isTradingDay(e.date, e.market as 'TW' | 'CN'));

  if (rankIdx) {
    // 實際讀每個日期的最佳 session，算 filter 後 count
    // filter 規則和 applyTurnoverFilter 一致：有 turnoverRank 保留，沒 rank 就看當前 index
    // 注意：B/C/D/E 買法 session 不套 top500 filter（掃全市場，不限前500）
    await Promise.all(filtered.map(async (e) => {
      const mode = e.mtfMode ?? 'daily';
      if (mode === 'B' || mode === 'C' || mode === 'D' || mode === 'E' || mode === 'F' || mode === 'G' || mode === 'H' || mode === 'I') return; // 不套 filter
      try {
        const session = await loadScanSessionRaw(e.market, e.date, e.direction ?? 'long', mode);
        if (session && session.results) {
          const realCount = session.results.filter(r =>
            r.turnoverRank != null || rankIdx!.ranks.has(r.symbol)
          ).length;
          e.resultCount = realCount;
        }
      } catch { /* keep original count */ }
    }));
  }

  return filtered.sort((a, b) => b.date.localeCompare(a.date));
}

/** 內部：讀 session 原始資料（不套 turnoverFilter，避免遞迴） */
async function loadScanSessionRaw(
  market: MarketId,
  date: string,
  direction: ScanDirection,
  mtfMode: MtfMode,
): Promise<ScanSession | null> {
  let raw: string | null = null;
  if (IS_VERCEL) {
    try {
      raw = await blobGet(`scans/${market}/${direction}/${mtfMode}/${date}.json`);
      if (!raw && mtfMode === 'daily') raw = await blobGet(`scans/${market}/${direction}/${date}.json`);
      if (!raw && mtfMode === 'daily' && direction === 'long') raw = await blobGet(`scans/${market}/${date}.json`);
    } catch { /* ignore */ }
  }
  if (!raw) raw = await fsGet(`scan-${market}-${direction}-${mtfMode}-${date}.json`);
  if (!raw && mtfMode === 'daily') raw = await fsGet(`scan-${market}-${direction}-${date}.json`);
  if (!raw && mtfMode === 'daily' && direction === 'long') raw = await fsGet(`scan-${market}-${date}.json`);

  if (raw) {
    const intradayRaw = await loadLatestIntradayRaw(market, date, direction, mtfMode);
    if (intradayRaw) {
      try {
        const postClose = JSON.parse(raw) as ScanSession;
        const intraday = JSON.parse(intradayRaw) as ScanSession;
        const intradayNewer = !!intraday.scanTime && !!postClose.scanTime && intraday.scanTime > postClose.scanTime;
        const postCloseEmpty = postClose.resultCount === 0;
        if (intraday.resultCount > 0 && (intradayNewer || postCloseEmpty)) raw = intradayRaw;
      } catch { /* use post_close */ }
    }
  }
  if (!raw) raw = await loadLatestIntradayRaw(market, date, direction, mtfMode);
  if (!raw) return null;
  try { return JSON.parse(raw) as ScanSession; } catch { return null; }
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
    // 0512：載入後先 normalize matchedMethods（v11 G/H/I → v12 J/L/K）— 統一全 UI 只看 v12
    if (Array.isArray(session.results)) {
      for (const r of session.results) {
        if (Array.isArray(r.matchedMethods) && r.matchedMethods.length > 0) {
          r.matchedMethods = normalizeMatchedMethods(r.matchedMethods);
        }
      }
    }
    // turnover filter 只適用 A（daily）session；B/C/D/E 掃全市場，不限 top500
    if (mtfMode === 'daily') {
      await applyTurnoverFilter(session, market);
      if (!session.step1Filter) session.step1Filter = 'bypassed'; // daily session 設計上不過 Step 1
    } else if (BULLISH_LETTERS.has(mtfMode)) {
      // 多頭軌字母 (B/C/E/J/K/L/M/P) retro-filter：只保留仍在當日 Step 1 池子內的股票
      // 防 drift：池子被 cron 重跑 / 手動 scan / 回填 覆蓋後，凍結 session 不會 retro-filter
      // 結果：UI 會看到 leak。filter-on-read 是 belt-and-suspenders 防呆。
      await applyStep1Filter(session);
    } else {
      // 反轉軌（D/F/N/O）/ 戰法軌（Q）— 設計上不過 Step 1，但 UI 應提示「全市場掃」
      if (!session.step1Filter) session.step1Filter = 'bypassed';
      // 0512 修：反轉/戰法軌 session 內的 matchedMethods 若含多頭軌字母（B/C/E/J/K/L/M/P），
      // 但 symbol 不在當日 Step 1 池子 → 從 matchedMethods 移除該字母
      // 原因：用戶 600089 反饋「他不符合 step1 所以當然也不會是 step2 裡的回後買上漲」
      await stripMultiTrackLeakFromMatched(session);
      // 0512 修 #2：型態確認 (N) / V反轉 (F) / 打底完成 (O) / 一字底 (D) / 三均戰法 (Q) tab
      // 應該只顯示「完整觸發」的股（matchedMethods 含該 session 字母）
      // 不顯示 lockwatch-only pending-breakout（結構成立但沒過 ×3% 真突破）
      // 那些 pending 由「鎖股觀察」panel 獨立顯示（不污染掃描結果 tab）
      // 用戶反饋：「型態確認不應該是要完成四個型態確認的條件才算嗎」
      if (mtfMode && session.results && session.results.length > 0) {
        const before = session.results.length;
        session.results = session.results.filter(r =>
          Array.isArray(r.matchedMethods) && r.matchedMethods.includes(mtfMode as string),
        );
        session.resultCount = session.results.length;
        if (session.results.length < before) {
          console.info(
            `[scanStorage] 反轉/戰法軌 lockwatch-only 過濾: ${market}/${mtfMode}/${session.date} ${before} → ${session.results.length}`,
          );
        }
      }
      // 0512 修 #3：sticky-pattern fix
      // 從 lockwatch 補進「pending 已升級為 observation/entry-signal/purchased」的股
      // 例：2408 5/5 鎖圓弧底 pending → 5/6 close 282 ≥ 鎖定 neckline×1.03 → lockwatch 升級
      // 但 fresh N detector 5/6 沒抓到（pivot 重組改判頭肩底），所以 N scan 沒它
      // sticky fix：lockwatch 升級的股直接補進 N tab（用 locked neckline 而非 fresh re-detect）
      if (mtfMode === 'N' || mtfMode === 'F') {
        await augmentReversalWithPromotedLockwatch(session, mtfMode as 'N' | 'F');
      }
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * 反轉/戰法軌 session 載入時，把每筆 result 的 matchedMethods 中**不在當日 Step 1 池**的
 * 多頭軌字母剝掉 — 對齊「多頭軌 = Step 1 ∩ detector 觸發」語意。
 *
 * 不剝反轉/戰法軌字母（D/F/N/O/Q）— 那些 by design 全市場掃。
 */
async function stripMultiTrackLeakFromMatched(session: ScanSession): Promise<void> {
  if (!session.results || session.results.length === 0) return;
  try {
    const { loadStep1Pool } = await import('@/lib/scanner/step1Pool');
    const pool = await loadStep1Pool(session.market, session.date);
    if (!pool || pool.symbols.length === 0) return; // 池子缺漏 — 不剝，等池子回來再處理
    const allowed = new Set(pool.symbols);
    const bullishSet = new Set<string>([...BULLISH_TRACK_LETTERS, ...Object.keys(V11_TO_V12_LETTER)]);
    for (const r of session.results) {
      if (!Array.isArray(r.matchedMethods) || r.matchedMethods.length === 0) continue;
      if (allowed.has(r.symbol)) continue; // 已在池子裡 — 多頭軌字母合法
      const before = r.matchedMethods;
      const filtered = before.filter(m => !bullishSet.has(m));
      if (filtered.length !== before.length) r.matchedMethods = filtered;
    }
  } catch {
    /* 池子讀失敗 — 保持原樣 */
  }
}

/**
 * 多頭軌字母（書本 8 個進場位置 + v11 alias G/H/I）— 必須過 Step 1 池子才能進場
 *
 * 0512 修：含 G/H/I 因為它們是 J/L/K 的 alias 用同 detector
 * （若不含，舊 I scan 跟新 K scan 對同一檔股會給不同結果）
 */
const BULLISH_LETTERS = new Set<MtfMode>([
  ...BULLISH_TRACK_LETTERS,
  ...Object.keys(V11_TO_V12_LETTER),
] as readonly MtfMode[]);

/**
 * Sticky-pattern fix：從 lockwatch 補進「pending 已升級為 observation/entry-signal/purchased」的股
 *
 * 場景：2408 5/5 鎖圓弧底 pending → 5/6 close 282 ≥ 鎖定 neckline × 1.03
 * → updateLockWatch 升級 stage → 但 fresh N detector 5/6 沒抓到（pivot 重組改判頭肩底）
 * → N scan 沒它 → 型態確認 tab 看不到
 *
 * 修法：載入 N/F session 時，從同日 lockwatch snapshot 撈出「升級紀錄」補進來，
 * 用鎖定的 neckline/target 而非 fresh re-detect，sticky 對齊用戶心智模型。
 */
async function augmentReversalWithPromotedLockwatch(
  session: ScanSession,
  letter: 'N' | 'F',
): Promise<void> {
  try {
    const { loadLockWatchSnapshot } = await import('@/lib/storage/lockWatchStorage');
    const snap = await loadLockWatchSnapshot(session.market, session.date);
    if (!snap || !Array.isArray(snap.records)) return;
    const existing = new Set(session.results?.map(r => r.symbol) ?? []);
    const PROMOTED = new Set(['observation', 'entry-signal', 'purchased']);

    // 候選清單先決定，再 parallel 解中文名（lockwatch 沒存 name 欄位 — 不查會渲染成 code-only 卡片）
    const candidates = snap.records.filter(r =>
      r.triggerSignal === letter && PROMOTED.has(r.currentStage) && !existing.has(r.symbol),
    );
    if (candidates.length === 0) return;

    const { getCNChineseName, getTWChineseName } = await import('@/lib/datasource/TWSENames');
    const nameLookups = await Promise.all(candidates.map(async (r) => {
      try {
        const m = r.symbol.match(/^(\d+)\.(SS|SZ|TW|TWO)$/i);
        const code = m?.[1] ?? r.symbol;
        const market = m?.[2]?.toUpperCase();
        if (market === 'SS' || market === 'SZ') {
          return (await getCNChineseName(code, market)) ?? '';
        }
        if (market === 'TW' || market === 'TWO') {
          return (await getTWChineseName(code)) ?? '';
        }
        return '';
      } catch {
        return '';
      }
    }));

    let added = 0;
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      session.results.push({
        symbol: r.symbol,
        name: nameLookups[i],
        market: session.market,
        price: r.currentClose ?? r.triggerPrice,
        changePercent: 0,
        volume: 0,
        triggeredRules: [],
        matchedMethods: [letter],
        sixConditionsScore: 0,
        sixConditionsBreakdown: { trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false },
        trendState: '多頭',
        trendPosition: '',
        scanTime: snap.lastUpdated ?? new Date().toISOString(),
        lockWatchPayload: {
          triggerPrice: r.triggerPrice,
          patternType: r.patternType,
          patternTargetPrice: r.patternTargetPrice,
          patternAchievementRate: r.patternAchievementRate,
        },
      });
      added++;
    }
    if (added > 0) {
      session.resultCount = session.results.length;
      console.info(
        `[scanStorage] sticky-pattern 補進 ${letter}: ${session.market}/${session.date} +${added} 檔（lockwatch 升級）`,
      );
    }
  } catch (err) {
    console.warn(`[scanStorage] augmentReversalWithPromotedLockwatch 異常:`, err);
  }
}

/**
 * 多頭軌 letter session 的 retro-filter：丟掉不在當日 Step 1 池子的結果
 *
 * 池子缺漏處理（修訂 2026-05-10）：
 *   - 池子不存在 → 不過濾，但設 session.step1Filter='missing' 讓 UI 顯示警告
 *   - 池子存在但空 → 視為異常狀態，等同不存在
 *   - 池子存在且非空 → 過濾掉池子外股票，設 step1Filter='applied'
 *
 * 之前的設計：silent fallback 不過濾、不告知 → 用戶看到「漏跑 Step 1」幻覺
 *
 * 副作用：mutate session.results + session.resultCount + session.step1Filter
 */
async function applyStep1Filter(session: ScanSession): Promise<void> {
  if (!session.results || session.results.length === 0) {
    // 空 session 也標記，方便 UI 邏輯
    if (!session.step1Filter) session.step1Filter = 'applied';
    return;
  }
  try {
    const { loadStep1Pool } = await import('@/lib/scanner/step1Pool');
    const pool = await loadStep1Pool(session.market, session.date);
    if (!pool || pool.symbols.length === 0) {
      // 池子缺漏 — 不過濾但明確標 'missing' 讓 UI 顯示警告
      if (!session.step1Filter) session.step1Filter = 'missing';
      console.warn(
        `[scanStorage] Step1 池子缺漏: ${session.market}/${session.buyMethod ?? '?'}/${session.date} — UI 應顯示警告`,
      );
      return;
    }
    const allowed = new Set(pool.symbols);
    const before = session.results.length;
    const filtered = session.results.filter((r) => allowed.has(r.symbol));
    if (filtered.length < before) {
      session.results = filtered;
      session.resultCount = filtered.length;
      console.info(
        `[scanStorage] Step1 retro-filter: ${session.market}/${session.buyMethod ?? '?'}/${session.date} ${before} → ${filtered.length}`,
      );
    }
    if (!session.step1Filter) session.step1Filter = 'applied';
  } catch (err) {
    console.warn(`[scanStorage] applyStep1Filter 異常 ${session.market}/${session.buyMethod ?? '?'}/${session.date}:`, err);
    /* 讀檔異常時保留原 session.step1Filter（若為 undefined 不覆寫，不誤導 UI）*/
  }
}

/**
 * 給 session 套上當前 top500 索引：補 turnoverRank + 過濾髒資料
 * 原因：fail-closed 上線前，索引壞時會跑無過濾掃描產出不在前 500 的結果。
 *
 * 過濾規則（不誤傷歷史正確資料）：
 *   - 保留 `turnoverRank` 已設的（代表當日 filter 時有資料，之前篩過了）
 *   - 對 `turnoverRank` 為 null 的，看當前索引是否含：
 *     * 含 → 可能是當日排名已填，現在缺欄位（舊格式）→ 補 rank 保留
 *     * 不含 → 當日無過濾寫入且今天也不在前 500 → 髒，過濾掉
 *   注意：這會誤放過「當日不在前 500 但今天恰好在」極少數漂移案例，
 *   但不會誤殺「當日在前 500 但今天掉出去」的正常歷史資料。
 */
async function applyTurnoverFilter(session: ScanSession, market: MarketId): Promise<void> {
  if (!session.results || session.results.length === 0) return;
  try {
    const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
    const idx = await readTurnoverRank(market as 'TW' | 'CN');
    if (!idx) return;
    const filtered = session.results.filter(r => {
      // 有 turnoverRank 代表當日 filter 時在前 500 → 一律保留
      if (r.turnoverRank != null) return true;
      // 沒有 rank → 需確認當前索引含否
      const currentRank = idx.ranks.get(r.symbol);
      if (currentRank != null) {
        r.turnoverRank = currentRank;
        return true;
      }
      return false; // 當日未 filter 且今天也不在前 500 → 髒
    });
    session.results = filtered;
    session.resultCount = filtered.length;
  } catch { /* 索引讀失敗 — 保持原樣 */ }
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
  if (withFreshness.length === 0) {
    // 舊版無 dataFreshness — 但若連 triggeredRules 也沒有，是 coarse scan 殘骸，拒絕
    const hasRules = session.results.some(r => r?.triggeredRules !== undefined);
    return hasRules;
  }
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
