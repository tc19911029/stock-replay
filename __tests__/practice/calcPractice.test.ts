import {
  calcTradeCost,
  derivePosition,
  deriveSessionSummary,
  buildTrade,
  practiceKey,
  type PracticeSession,
  type PracticeTrade,
} from '../../lib/practice/calcPractice';

// ── calcTradeCost ─────────────────────────────────────────────────────

describe('calcTradeCost (TW)', () => {
  test('TW 買 1 張 612 元 5.7 折 → fee = round(612000 × 0.001425 × 0.57) = 497', () => {
    const c = calcTradeCost(612, 1000, 'BUY', 'TW', '2330', 0.57);
    expect(c.fee).toBe(497);
    expect(c.tax).toBe(0);
  });

  test('TW 賣 1 張 615 元 5.7 折 → tax = round(615000 × 0.003) = 1845', () => {
    const c = calcTradeCost(615, 1000, 'SELL', 'TW', '2330', 0.57);
    expect(c.tax).toBe(1845);
    // fee = round(615000 × 0.001425 × 0.57) = 500
    expect(c.fee).toBe(500);
  });

  test('小額觸發最低手續費 20', () => {
    const c = calcTradeCost(10, 1000, 'BUY', 'TW', '2330', 0.57);
    // 10 × 1000 × 0.001425 × 0.57 ≈ 8 < 20 → 走最低 20
    expect(c.fee).toBe(20);
  });

  test('全額手續費（無折扣）', () => {
    const c = calcTradeCost(100, 1000, 'BUY', 'TW', '2330', 1.0);
    // 100 × 1000 × 0.001425 = 142.5 → round 143
    expect(c.fee).toBe(143);
  });
});

describe('calcTradeCost (CN)', () => {
  test('陸股深圳買入 — 過戶費為 0', () => {
    const c = calcTradeCost(10, 1000, 'BUY', 'CN', '000001.SZ', 1.0);
    // commission = max(round(10000 × 0.0003), 5) = max(3, 5) = 5
    // transfer = 0（深市）
    expect(c.fee).toBe(5);
    expect(c.tax).toBe(0);
  });

  test('陸股上海賣出 — 含過戶費 + 印花稅', () => {
    const c = calcTradeCost(100, 1000, 'SELL', 'CN', '600519.SS', 1.0);
    // amount = 100000
    // commission = max(round(100000 × 0.0003), 5) = 30
    // transfer = round(100000 × 0.00002) = 2（滬市）
    // fee = 32
    // stamp = round(100000 × 0.0005) = 50
    expect(c.fee).toBe(32);
    expect(c.tax).toBe(50);
  });
});

// ── derivePosition ─────────────────────────────────────────────────────

function makeTrade(args: {
  date: string;
  side: 'BUY' | 'SELL';
  shares: number;
  price: number;
  fee: number;
  tax?: number;
}): PracticeTrade {
  return {
    id: `t-${args.date}-${args.side}-${args.shares}`,
    date: args.date,
    side: args.side,
    shares: args.shares,
    price: args.price,
    amount: args.shares * args.price,
    fee: args.fee,
    tax: args.tax ?? 0,
  };
}

describe('derivePosition — FIFO 配對', () => {
  test('只買進 — avgCost = (買價×股+費)/股', () => {
    const trades = [
      makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 }),
    ];
    const p = derivePosition(trades);
    expect(p.shares).toBe(1000);
    // (1000 × 600 + 487) / 1000 = 600.487
    expect(p.avgCost).toBeCloseTo(600.487, 3);
    expect(p.realizedPnL).toBe(0);
  });

  test('買 1@600、買 1@620、賣 1@650 → FIFO 配 600 那張', () => {
    const trades = [
      makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 }),
      makeTrade({ date: '2026-04-02', side: 'BUY', shares: 1000, price: 620, fee: 503 }),
      makeTrade({ date: '2026-04-05', side: 'SELL', shares: 1000, price: 650, fee: 527, tax: 1950 }),
    ];
    const p = derivePosition(trades);
    // 剩 1 張 @ 620
    expect(p.shares).toBe(1000);
    expect(p.avgCost).toBeCloseTo((620000 + 503) / 1000, 3);
    // realized = (650 − 600) × 1000 − 487 − 527 − 1950 = 50000 − 2964 = 47036
    expect(p.realizedPnL).toBe(47036);
  });

  test('完全平倉 — shares = 0、avgCost = 0', () => {
    const trades = [
      makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 }),
      makeTrade({ date: '2026-04-05', side: 'SELL', shares: 1000, price: 650, fee: 527, tax: 1950 }),
    ];
    const p = derivePosition(trades);
    expect(p.shares).toBe(0);
    expect(p.avgCost).toBe(0);
    // realized = 50000 − 487 − 527 − 1950 = 47036
    expect(p.realizedPnL).toBe(47036);
  });

  test('分批賣 — FIFO 跨多 buy lot', () => {
    const trades = [
      makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 }),
      makeTrade({ date: '2026-04-02', side: 'BUY', shares: 1000, price: 620, fee: 503 }),
      // 賣 1500 股：1000 從 @600、500 從 @620
      makeTrade({ date: '2026-04-05', side: 'SELL', shares: 1500, price: 650, fee: 791, tax: 2925 }),
    ];
    const p = derivePosition(trades);
    // 剩 500 股 @ 620
    expect(p.shares).toBe(500);
    // FIFO 剩餘 lot 還剩 fee 比例 = 503 × 500/1000 = 251.5
    expect(p.avgCost).toBeCloseTo((500 * 620 + 251.5) / 500, 2);
    // matched buy: 1000×600 + 500×620 = 910000
    // matched buy fees: 487 + (503 × 0.5) = 738.5
    // sell fee+tax: 791 + 2925 = 3716（全配對因為沒超賣）
    // realized = 1500×650 − 910000 − 738.5 − 791 − 2925 = 975000 − 914454.5 = 60545.5
    expect(p.realizedPnL).toBeCloseTo(60545.5, 1);
  });
});

// ── deriveSessionSummary ─────────────────────────────────────────────

describe('deriveSessionSummary', () => {
  const baseSession: PracticeSession = {
    symbol: '2330',
    market: 'TW',
    initialCapital: 1_000_000,
    feeDiscount: 0.57,
    trades: [],
    createdAt: '2026-04-01',
  };

  test('空 session — 現金 = 初始、總報酬 = 0', () => {
    const s = deriveSessionSummary(baseSession);
    expect(s.cash).toBe(1_000_000);
    expect(s.totalEquity).toBe(1_000_000);
    expect(s.totalReturn).toBe(0);
    expect(s.position.shares).toBe(0);
  });

  test('買 1 張後 — 現金扣買金額+費', () => {
    const session = {
      ...baseSession,
      trades: [makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 })],
    };
    const s = deriveSessionSummary(session, 600);
    // cash = 1000000 − 600000 − 487 = 399513
    expect(s.cash).toBe(399513);
    // marketValue = 1000 × 600 = 600000
    expect(s.marketValue).toBe(600000);
    // totalEquity = 999513
    expect(s.totalEquity).toBe(999513);
    // totalReturn = (999513 − 1000000) / 1000000 = −0.000487
    expect(s.totalReturn).toBeCloseTo(-0.000487, 6);
  });

  test('完整一輪 — totalReturn 反映 realizedPnL', () => {
    const session = {
      ...baseSession,
      trades: [
        makeTrade({ date: '2026-04-01', side: 'BUY', shares: 1000, price: 600, fee: 487 }),
        makeTrade({ date: '2026-04-05', side: 'SELL', shares: 1000, price: 650, fee: 527, tax: 1950 }),
      ],
    };
    const s = deriveSessionSummary(session, 650);
    // cash = 1M − (600000 + 487) + (650000 − 527 − 1950) = 1_047_036
    expect(s.cash).toBe(1_047_036);
    expect(s.marketValue).toBe(0);
    expect(s.totalEquity).toBe(1_047_036);
    expect(s.totalReturn).toBeCloseTo(0.047036, 5);
    expect(s.position.realizedPnL).toBe(47036);
  });
});

// ── buildTrade ────────────────────────────────────────────────────────

describe('buildTrade', () => {
  test('自動算 fee + amount + id', () => {
    const t = buildTrade({
      date: '2026-04-01',
      side: 'BUY',
      shares: 1000,
      price: 612,
      market: 'TW',
      symbol: '2330',
      feeDiscount: 0.57,
    });
    expect(t.amount).toBe(612000);
    expect(t.fee).toBe(497);
    expect(t.tax).toBe(0);
    expect(t.side).toBe('BUY');
    expect(t.id).toMatch(/^pt/);
  });
});

// ── practiceKey ───────────────────────────────────────────────────────

describe('practiceKey', () => {
  test('strip TW suffix', () => {
    expect(practiceKey('TW', '2330.TW')).toBe('TW:2330');
    expect(practiceKey('TW', '6488.TWO')).toBe('TW:6488');
    expect(practiceKey('TW', '2330')).toBe('TW:2330');
  });
  test('strip CN suffix', () => {
    expect(practiceKey('CN', '600519.SS')).toBe('CN:600519');
    expect(practiceKey('CN', '000001.SZ')).toBe('CN:000001');
  });
});
