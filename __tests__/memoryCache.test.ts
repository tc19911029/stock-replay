import { MemoryCache } from '../lib/datasource/MemoryCache';

describe('MemoryCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Basic get/set/clear ───────────────────────────────────────────────────────

  describe('basic operations', () => {
    test('get returns null for missing key', () => {
      const cache = new MemoryCache();
      expect(cache.get('missing')).toBeNull();
    });

    test('set then get returns stored value', () => {
      const cache = new MemoryCache();
      cache.set('key1', { foo: 'bar' });
      expect(cache.get('key1')).toEqual({ foo: 'bar' });
    });

    test('set overwrites existing key', () => {
      const cache = new MemoryCache();
      cache.set('k', 1);
      cache.set('k', 2);
      expect(cache.get('k')).toBe(2);
      expect(cache.size).toBe(1);
    });

    test('clear removes all entries', () => {
      const cache = new MemoryCache();
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeNull();
    });
  });

  // ── size property ─────────────────────────────────────────────────────────────

  describe('size', () => {
    test('reflects number of stored entries', () => {
      const cache = new MemoryCache();
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });
  });

  // ── TTL expiration ────────────────────────────────────────────────────────────

  describe('TTL expiration', () => {
    test('returns null after TTL expires', () => {
      const cache = new MemoryCache();
      cache.set('temp', 'data', 1000); // 1 second TTL
      expect(cache.get('temp')).toBe('data');

      jest.advanceTimersByTime(1001);
      expect(cache.get('temp')).toBeNull();
    });

    test('entry is still available before TTL expires', () => {
      const cache = new MemoryCache();
      cache.set('temp', 'data', 5000);

      jest.advanceTimersByTime(4999);
      expect(cache.get('temp')).toBe('data');
    });

    test('default TTL is 5 minutes', () => {
      const cache = new MemoryCache();
      cache.set('default-ttl', 'value');

      jest.advanceTimersByTime(4 * 60 * 1000); // 4 min
      expect(cache.get('default-ttl')).toBe('value');

      jest.advanceTimersByTime(2 * 60 * 1000); // total 6 min
      expect(cache.get('default-ttl')).toBeNull();
    });
  });

  // ── LRU eviction ──────────────────────────────────────────────────────────────

  describe('LRU eviction', () => {
    test('evicts least recently used entry when maxSize exceeded', () => {
      const cache = new MemoryCache(3);
      cache.set('a', 1);
      jest.advanceTimersByTime(10);
      cache.set('b', 2);
      jest.advanceTimersByTime(10);
      cache.set('c', 3);
      jest.advanceTimersByTime(10);

      // Adding 4th entry should evict 'a' (oldest lastAccessed)
      cache.set('d', 4);
      expect(cache.size).toBe(3);
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('d')).toBe(4);
    });

    test('accessing an entry updates its LRU position', () => {
      const cache = new MemoryCache(3);
      cache.set('a', 1);
      jest.advanceTimersByTime(10);
      cache.set('b', 2);
      jest.advanceTimersByTime(10);
      cache.set('c', 3);
      jest.advanceTimersByTime(10);

      // Access 'a' to make it recently used
      cache.get('a');
      jest.advanceTimersByTime(10);

      // Now 'b' is the least recently used
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1); // kept (recently accessed)
      expect(cache.get('b')).toBeNull(); // evicted
    });

    test('overwriting existing key does not trigger eviction', () => {
      const cache = new MemoryCache(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10); // overwrite, should not evict
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBe(2);
    });
  });

  // ── Periodic cleanup ──────────────────────────────────────────────────────────

  describe('periodic cleanup', () => {
    test('removes expired entries after cleanup interval', () => {
      const cache = new MemoryCache();
      cache.set('short', 'val', 1000); // 1s TTL
      cache.set('long', 'val', 120_000); // 2min TTL

      // Advance past TTL of 'short' AND past cleanup interval (60s)
      jest.advanceTimersByTime(61_000);

      // Trigger cleanup via get
      cache.get('anything');

      // 'short' should have been cleaned up, 'long' still valid
      expect(cache.get('long')).toBe('val');
      // The expired entry was removed during cleanup
      expect(cache.size).toBe(1);
    });
  });
});
