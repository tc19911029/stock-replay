/**
 * Vercel Blob put with retry。
 *
 * 2026-05-08：原本所有 blob put 失敗 = 整個 cron 炸。
 * 加 3 次 retry + 指數退避（0.5s/1s/2s），降低偶發 5xx / 網路抖動的影響。
 *
 * 重要：不該 silent 吞 error；3 次都失敗仍要 throw 讓 caller 知道並寫入 fs fallback
 *      或記入 alert chain（取決於 caller 設計）。
 */

type PutOptions = {
  access: 'private' | 'public';
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  contentType?: string;
};

export async function blobPutWithRetry(
  pathname: string,
  data: string,
  options: PutOptions,
  maxAttempts = 3,
): Promise<void> {
  const { put } = await import('@vercel/blob');
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await put(pathname, data, options);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}
