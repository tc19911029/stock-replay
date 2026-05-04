import { suspectsLimitOverwrite, limitPctFor } from '@/lib/datasource/limitMoveGuard';

describe('limitMoveGuard', () => {
  describe('limitPctFor', () => {
    test('CN ChiNext (300xxx) is 20%', () => {
      expect(limitPctFor('CN', '300100')).toBeCloseTo(0.198, 4);
      expect(limitPctFor('CN', '301100')).toBeCloseTo(0.198, 4);
    });
    test('CN STAR (688xxx) is 20%', () => {
      expect(limitPctFor('CN', '688100')).toBeCloseTo(0.198, 4);
    });
    test('CN main board is 10%', () => {
      expect(limitPctFor('CN', '600100')).toBeCloseTo(0.098, 4);
      expect(limitPctFor('CN', '000100')).toBeCloseTo(0.098, 4);
    });
    test('TW is 10%', () => {
      expect(limitPctFor('TW', '2330')).toBeCloseTo(0.098, 4);
    });
  });

  describe('suspectsLimitOverwrite', () => {
    // 場景 1：2486.TW 04-29 真實案例（漲停 close 被低點覆寫）
    test('TW limit-up close-overwrite (2486.TW 04-29)', () => {
      const prev = 230.5;
      const q = { open: 223, high: 253.5, low: 222, close: 222 };
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2486')).toBe(true);
    });

    // 場景 2：合法漲停一字 (open=high=low=close)
    test('legitimate one-shot limit-up (一字漲停)', () => {
      const prev = 100;
      const q = { open: 110, high: 110, low: 110, close: 110 };
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 3：漲停打開後維持高位收 (close at 98% of high)
    test('limit-up briefly opened, close near high', () => {
      const prev = 100;
      const q = { open: 105, high: 110, low: 104, close: 108 };
      // close=108 vs high=110，close/high=98.18% > 97% → 不算污染
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 4：跌停 close 被反彈 tick 覆寫（鏡像）
    test('TW limit-down close-overwrite mirror', () => {
      const prev = 100;
      const q = { open: 95, high: 95, low: 90, close: 96 }; // close 偏離 low > 3%
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(true);
    });

    // 場景 5：CN 創業板 +20% 漲停
    test('CN ChiNext 20% limit-up overwrite', () => {
      const prev = 50;
      const q = { open: 55, high: 60, low: 54, close: 54 }; // limit=60, close 偏離 high 10%
      expect(suspectsLimitOverwrite(prev, q, 'CN', '300100')).toBe(true);
    });

    // 場景 6：CN 主板 +10% 不應誤判 ChiNext +20%
    test('CN main board uses 10% not 20%', () => {
      const prev = 100;
      const q = { open: 105, high: 110, low: 104, close: 105 }; // limit=110 (10%)
      // close 105 vs high 110，差 4.5%，且 hit limit → 應該 true
      expect(suspectsLimitOverwrite(prev, q, 'CN', '600100')).toBe(true);
    });

    // 場景 7：未觸及漲跌停（普通日內波動）
    test('non-limit day not flagged', () => {
      const prev = 100;
      const q = { open: 102, high: 105, low: 99, close: 100 }; // high 5% < limit 10%
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 8：prevClose 缺失或 0
    test('missing prevClose returns false (no data → no skip)', () => {
      const q = { open: 100, high: 110, low: 100, close: 100 };
      expect(suspectsLimitOverwrite(null, q, 'TW', '2330')).toBe(false);
      expect(suspectsLimitOverwrite(0, q, 'TW', '2330')).toBe(false);
      expect(suspectsLimitOverwrite(undefined, q, 'TW', '2330')).toBe(false);
    });
  });
});
