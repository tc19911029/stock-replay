/**
 * curlFetch — Node fetch + curl shell fallback
 *
 * 背景（2026-05-11）：TPEx openapi (tpex_mainboard_quotes) 對 Node 端的 TLS fingerprint
 * 越來越常被 Cloudflare 阻擋（403），但同一台機器的 curl 帶 Mozilla UA 即可 200。
 * 結果是 stocklist provider、L2 IntradayCache、download-candles 三條鏈在 cron 跑時
 * 同時失敗 → 全市場掃描整批漏抓上櫃股。
 *
 * 這個 helper：
 *   1. 先試 Node fetch（快、不需要 spawn 子程序）
 *   2. fetch 失敗或回 ≥400 → 用 curl shell（execFile + promisify）重試
 *
 * 使用情境：對外部第三方 API 抓 JSON（TWSE / TPEx openapi 等），尤其是 Cloudflare 護盾下的 endpoint。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface CurlFetchOptions {
  /** 總 timeout（ms），同時用於 Node fetch 與 curl --max-time */
  timeoutMs?: number;
  /** 自訂 headers（會傳給 fetch 與 curl 兩端） */
  headers?: Record<string, string>;
  /** 自訂 User-Agent（會被 headers['User-Agent'] 蓋過） */
  userAgent?: string;
  /** curl 子程序的 stdout 上限（bytes），預設 50MB */
  maxBuffer?: number;
}

export type CurlFetchSource = 'node-fetch' | 'curl';

export interface CurlFetchResult<T> {
  data: T;
  source: CurlFetchSource;
}

/**
 * 抓 JSON，Node fetch 失敗就走 curl。回傳 parsed JSON + 哪條 source 來的（log 用）。
 *
 * 失敗條件：
 *   - Node fetch throw（網路錯、timeout、AbortError）
 *   - HTTP status >= 400（403 是常見 Cloudflare block）
 *   - JSON parse 失敗
 *
 * 若兩條都失敗，throw 最後一個錯誤。
 */
export async function fetchJsonWithCurlFallback<T>(
  url: string,
  options: CurlFetchOptions = {},
): Promise<CurlFetchResult<T>> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const ua = options.headers?.['User-Agent'] ?? options.userAgent ?? DEFAULT_UA;
  const headers: Record<string, string> = { 'User-Agent': ua, ...(options.headers ?? {}) };
  const maxBuffer = options.maxBuffer ?? 50 * 1024 * 1024;

  // ── 1) Node fetch 第一試 ──────────────────────────────────────────
  let lastErr: unknown = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) {
      const data = await res.json() as T;
      return { data, source: 'node-fetch' };
    }
    lastErr = new Error(`HTTP ${res.status}`);
    // 403/429/5xx → 落到 curl
  } catch (err) {
    lastErr = err;
  }

  // ── 2) curl shell fallback ────────────────────────────────────────
  try {
    // -4 強制 IPv4：dev server child process 環境 IPv6 路由可能撞不同 Cloudflare edge
    // 被當 bot 擋（0514 實測：tpex_mainboard_quotes 從 shell curl 200，從 Node spawn curl
    // 回 HTML challenge page）。手動 shell 用 -i 觀察 cf-ray 看 edge 差異可確認。
    const args = ['-s', '-4', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
    args.push(url);
    const { stdout } = await execFileAsync('curl', args, { encoding: 'utf-8', maxBuffer });
    if (!stdout || stdout.length === 0) {
      throw new Error('curl returned empty stdout');
    }
    const data = JSON.parse(stdout) as T;
    return { data, source: 'curl' };
  } catch (err) {
    // 兩條都掛 → throw 最後錯誤（包含 fetch 與 curl 兩條都的 trace）
    const fetchMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const curlMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch failed (${fetchMsg}); curl fallback also failed (${curlMsg})`);
  }
}
