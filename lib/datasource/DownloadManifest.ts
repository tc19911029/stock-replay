/**
 * DownloadManifest — 記錄每次 cron 下載的結果
 *
 * 檔案路徑: data/manifest/{market}-{date}.json
 * 用途: 掃描前快速判斷本地資料覆蓋率，不需逐檔檢查
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MANIFEST_DIR = path.join(process.cwd(), 'data', 'manifest');

export interface DownloadManifestData {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  coverage: number;        // 0-100%
  durationSec: number;
  timestamp?: string;       // ISO
}

function getManifestPath(market: 'TW' | 'CN', date: string): string {
  return path.join(MANIFEST_DIR, `${market}-${date}.json`);
}

export async function saveDownloadManifest(
  market: 'TW' | 'CN',
  date: string,
  data: DownloadManifestData,
): Promise<void> {
  if (!existsSync(MANIFEST_DIR)) {
    await mkdir(MANIFEST_DIR, { recursive: true });
  }
  const manifest = { ...data, timestamp: new Date().toISOString() };
  await writeFile(getManifestPath(market, date), JSON.stringify(manifest), 'utf-8');
}

export async function loadDownloadManifest(
  market: 'TW' | 'CN',
  date: string,
): Promise<DownloadManifestData | null> {
  try {
    const raw = await readFile(getManifestPath(market, date), 'utf-8');
    return JSON.parse(raw) as DownloadManifestData;
  } catch {
    return null;
  }
}
