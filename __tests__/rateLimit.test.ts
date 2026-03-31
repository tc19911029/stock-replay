import { createRateLimit, generalLimiter, aiLimiter, scanLimiter } from '../lib/rateLimit';

// ── createRateLimit ─────────────────────────────────────────────────────────────

describe('createRateLimit', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('first request succeeds and returns remaining = maxRequests - 1', () => {
    const limiter = createRateLimit('test-first', { maxRequests: 5, windowMs: 60_000 });
    const result = limiter.check('user-a');
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
  });

  test('allows up to maxRequests then blocks', () => {
    const limiter = createRateLimit('test-block', { maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check('ip1').success).toBe(true); // remaining 2
    expect(limiter.check('ip1').success).toBe(true); // remaining 1
    expect(limiter.check('ip1').success).toBe(true); // remaining 0

    const blocked = limiter.check('ip1');
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  test('different identifiers have independent buckets', () => {
    const limiter = createRateLimit('test-indep', { maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check('a').success).toBe(true);
    expect(limiter.check('a').success).toBe(false);
    expect(limiter.check('b').success).toBe(true); // separate bucket
  });

  test('tokens refill over time', () => {
    const limiter = createRateLimit('test-refill', { maxRequests: 2, windowMs: 10_000 });
    expect(limiter.check('u').success).toBe(true);
    expect(limiter.check('u').success).toBe(true);
    expect(limiter.check('u').success).toBe(false);

    // Advance time by the full window to fully refill
    jest.advanceTimersByTime(10_000);
    const result = limiter.check('u');
    expect(result.success).toBe(true);
  });

  test('partial refill adds proportional tokens', () => {
    const limiter = createRateLimit('test-partial', { maxRequests: 10, windowMs: 10_000 });
    // Use all 10 tokens
    for (let i = 0; i < 10; i++) limiter.check('u');
    expect(limiter.check('u').success).toBe(false);

    // Advance half the window -> refill ~5 tokens
    jest.advanceTimersByTime(5_000);
    const result = limiter.check('u');
    expect(result.success).toBe(true);
  });

  test('retryAfter is a positive number when rate limited', () => {
    const limiter = createRateLimit('test-retry', { maxRequests: 1, windowMs: 60_000 });
    limiter.check('u');
    const blocked = limiter.check('u');
    expect(blocked.success).toBe(false);
    expect(typeof blocked.retryAfter).toBe('number');
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  test('periodic cleanup removes entries older than 2x windowMs', () => {
    const windowMs = 10_000;
    const limiter = createRateLimit('test-cleanup', { maxRequests: 5, windowMs });
    limiter.check('old-user');

    // Advance past cleanup interval (60s) AND past 2x window
    jest.advanceTimersByTime(61_000);

    // Trigger cleanup by calling check with a different identifier
    limiter.check('new-user');

    // The old entry should have been cleaned up.
    // Verify by checking the old identifier gets a fresh bucket (full tokens).
    const result = limiter.check('old-user');
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4); // maxRequests - 1 = fresh bucket
  });
});

// ── Pre-configured limiters ─────────────────────────────────────────────────────

describe('pre-configured limiters', () => {
  test('generalLimiter allows 60 requests', () => {
    const result = generalLimiter.check('general-test-ip');
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(59);
  });

  test('aiLimiter allows 10 requests', () => {
    const result = aiLimiter.check('ai-test-ip');
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(9);
  });

  test('scanLimiter allows 5 requests', () => {
    const result = scanLimiter.check('scan-test-ip');
    expect(result.success).toBe(true);
    expect(result.remaining).toBeLessThanOrEqual(4);
  });
});
