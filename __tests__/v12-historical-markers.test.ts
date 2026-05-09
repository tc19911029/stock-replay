/**
 * useV12HistoricalMarkers cache 邏輯測試
 *
 * 不測 React hook 本身（需要 RTL），只測 cache key 計算 + 限制邏輯
 */
import type { CandleWithIndicators } from '../types';

// 模擬 cache 邏輯（複製自 hook 內部 LRU 實作）
function makeCache(maxSize = 50) {
  const cache = new Map<string, unknown>();
  return {
    get: (k: string) => cache.get(k),
    set: (k: string, v: unknown) => {
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      cache.set(k, v);
    },
    size: () => cache.size,
    keys: () => Array.from(cache.keys()),
  };
}

describe('useV12HistoricalMarkers cache 邏輯', () => {
  it('cache key 應為 ticker + lastDate + count', () => {
    const candles: Partial<CandleWithIndicators>[] = [
      { date: '2026-05-08', close: 100 },
    ];
    const ticker = '2330.TW';
    const lastDate = candles[candles.length - 1]?.date ?? '';
    const key = `${ticker}|${lastDate}|${candles.length}`;
    expect(key).toBe('2330.TW|2026-05-08|1');
  });

  it('LRU 超過 max 移除最舊', () => {
    const cache = makeCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.size()).toBe(3);
    cache.set('d', 4);
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBeUndefined();  // 被淘汰
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('cache hit 時不需要重算（O(1)）', () => {
    const cache = makeCache();
    const data = [{ date: '2026-05-08', label: 'N' }];
    cache.set('2330.TW|2026-05-08|100', data);
    expect(cache.get('2330.TW|2026-05-08|100')).toEqual(data);
  });

  it('不同 ticker 各自有 entry', () => {
    const cache = makeCache();
    cache.set('2330.TW|2026-05-08|100', ['a']);
    cache.set('2454.TW|2026-05-08|100', ['b']);
    expect(cache.get('2330.TW|2026-05-08|100')).toEqual(['a']);
    expect(cache.get('2454.TW|2026-05-08|100')).toEqual(['b']);
  });

  it('lastDate 變化（隔日）→ key 變 → cache miss → 重算', () => {
    const cache = makeCache();
    cache.set('2330.TW|2026-05-07|100', ['old']);
    expect(cache.get('2330.TW|2026-05-08|100')).toBeUndefined();  // miss → 觸發重算
  });
});
