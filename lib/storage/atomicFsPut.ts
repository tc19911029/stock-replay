/**
 * Atomic local file write — temp + rename。
 *
 * fs.writeFile 是 truncate+write，並行寫同一檔會 interleave 造成
 * JSON 結構壞掉（0424 L2 incident 根因）。POSIX rename 是 atomic，
 * 保證讀者只看到舊版或新版完整內容。
 *
 * 適用範圍：所有「全量覆寫」單一 JSON 檔的 local fs 寫入路徑。
 * 不解決：read-merge-write pattern 的 lose update（仍需在 caller 加鎖）。
 */

import { promises as fs } from 'fs';

export async function atomicFsPut(target: string, data: string): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, data, 'utf-8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}
