/**
 * UnifiedRateLimiter — Token Bucket 統一限流器
 *
 * 每個 data provider 獨立的 token bucket，
 * 防止全市場掃描/批量下載時超過 API 額度上限。
 *
 * 特點：
 *  - 每個 provider 獨立桶（FinMind, EastMoney, Tencent, Fugle, TWSE）
 *  - acquire() 等待取得 token，不會超限
 *  - 429/5xx 自動退避（exponential backoff）
 *  - 提供統計資訊供 diagnostics 使用
 */

type ProviderId = 'finmind' | 'eastmoney' | 'tencent' | 'fugle' | 'twse' | 'eodhd' | 'yahoo';

interface BucketConfig {
  /** 桶最大容量 */
  maxTokens: number;
  /** 每秒補充 token 數 */
  refillRate: number;
  /** 遇到 429 時的初始退避時間 (ms) */
  backoffMs: number;
  /** 最大退避時間 (ms) */
  maxBackoffMs: number;
}

/** Provider 限流配置 */
const PROVIDER_CONFIGS: Record<ProviderId, BucketConfig> = {
  // FinMind: 600 req/hr (有 token) = 10/min，保守設 8 並發、0.13/s refill
  finmind: {
    maxTokens: 8,
    refillRate: 0.13, // ~8/min = 480/hr < 600 上限
    backoffMs: 60_000,
    maxBackoffMs: 300_000,
  },
  // EastMoney: 無明確限制，保守估計
  eastmoney: {
    maxTokens: 15,
    refillRate: 2, // ~120/min
    backoffMs: 3_000,
    maxBackoffMs: 60_000,
  },
  // Tencent: 無明確限制，保守估計
  tencent: {
    maxTokens: 15,
    refillRate: 2,
    backoffMs: 3_000,
    maxBackoffMs: 60_000,
  },
  // Fugle: 60 req/min
  fugle: {
    maxTokens: 5,
    refillRate: 0.8, // ~48/min < 60 上限
    backoffMs: 2_000,
    maxBackoffMs: 30_000,
  },
  // TWSE: ~3s between batches (unofficial)
  twse: {
    maxTokens: 3,
    refillRate: 0.3, // ~18/min
    backoffMs: 5_000,
    maxBackoffMs: 60_000,
  },
  // EODHD: 付費配額，僅供 cron 批次下載，極保守限流
  // 402 = 配額耗盡，需長時間退避（1hr）
  eodhd: {
    maxTokens: 2,
    refillRate: 0.01, // ~0.6/min，極保守
    backoffMs: 3_600_000, // 402 退避 1 小時
    maxBackoffMs: 3_600_000,
  },
  // Yahoo Finance: 無明確限制，保守估計 ~90/min
  yahoo: {
    maxTokens: 10,
    refillRate: 1.5, // ~90/min
    backoffMs: 5_000,
    maxBackoffMs: 120_000,
  },
};

interface BucketState {
  tokens: number;
  lastRefill: number;
  /** 退避到此時間前不允許請求 */
  backoffUntil: number;
  /** 當前退避倍數 */
  backoffMultiplier: number;
  /** 統計 */
  stats: {
    acquired: number;
    waited: number;
    errors: number;
    lastError: string | null;
  };
}

class TokenBucket {
  private config: BucketConfig;
  private state: BucketState;
  private waitQueue: Array<() => void> = [];

  constructor(config: BucketConfig) {
    this.config = config;
    this.state = {
      tokens: config.maxTokens,
      lastRefill: Date.now(),
      backoffUntil: 0,
      backoffMultiplier: 1,
      stats: { acquired: 0, waited: 0, errors: 0, lastError: null },
    };
  }

  /** 補充 token（根據經過的時間） */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.state.lastRefill) / 1000;
    this.state.tokens = Math.min(
      this.config.maxTokens,
      this.state.tokens + elapsed * this.config.refillRate,
    );
    this.state.lastRefill = now;
  }

  /** 等待取得一個 token */
  async acquire(): Promise<void> {
    // 退避中：等待退避結束
    const now = Date.now();
    if (this.state.backoffUntil > now) {
      const waitMs = this.state.backoffUntil - now;
      this.state.stats.waited++;
      await sleep(waitMs);
    }

    this.refill();

    if (this.state.tokens >= 1) {
      this.state.tokens -= 1;
      this.state.stats.acquired++;
      return;
    }

    // 沒有 token：等待下一個 token 補充
    const waitMs = Math.ceil((1 - this.state.tokens) / this.config.refillRate * 1000);
    this.state.stats.waited++;
    await sleep(Math.max(waitMs, 100));

    this.refill();
    this.state.tokens = Math.max(0, this.state.tokens - 1);
    this.state.stats.acquired++;
  }

  /** 回報 API 錯誤，觸發退避 */
  reportError(status: number, message?: string): void {
    this.state.stats.errors++;
    this.state.stats.lastError = `${status}: ${message ?? 'unknown'}`;

    if (status === 402 || status === 429 || status >= 500) {
      const backoffMs = Math.min(
        this.config.backoffMs * this.state.backoffMultiplier,
        this.config.maxBackoffMs,
      );
      this.state.backoffUntil = Date.now() + backoffMs;
      this.state.backoffMultiplier = Math.min(this.state.backoffMultiplier * 2, 16);
    }
  }

  /** 成功時重置退避倍數 */
  reportSuccess(): void {
    this.state.backoffMultiplier = 1;
  }

  getStats() {
    return { ...this.state.stats, tokens: Math.floor(this.state.tokens) };
  }
}

/** 全域限流器 singleton */
class UnifiedRateLimiter {
  private buckets: Map<ProviderId, TokenBucket> = new Map();

  constructor() {
    for (const [id, config] of Object.entries(PROVIDER_CONFIGS)) {
      this.buckets.set(id as ProviderId, new TokenBucket(config));
    }
  }

  /** 等待取得指定 provider 的 token */
  async acquire(provider: ProviderId): Promise<void> {
    const bucket = this.buckets.get(provider);
    if (!bucket) return; // 未知 provider 不限流
    await bucket.acquire();
  }

  /** 回報 API 錯誤 */
  reportError(provider: ProviderId, status: number, message?: string): void {
    this.buckets.get(provider)?.reportError(status, message);
  }

  /** 回報 API 成功 */
  reportSuccess(provider: ProviderId): void {
    this.buckets.get(provider)?.reportSuccess();
  }

  /** 取得所有 provider 統計 */
  getStats(): Record<string, ReturnType<TokenBucket['getStats']>> {
    const result: Record<string, ReturnType<TokenBucket['getStats']>> = {};
    for (const [id, bucket] of this.buckets) {
      result[id] = bucket.getStats();
    }
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 全域 singleton */
export const rateLimiter = new UnifiedRateLimiter();
export type { ProviderId };
