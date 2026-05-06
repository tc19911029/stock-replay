import { calcTWCost, calcCNCost, calcRoundTripCost, isShanghai } from '../lib/backtest/CostModel';

describe('calcTWCost', () => {
  test('買入成本只計算手續費', () => {
    const cost = calcTWCost(100000, 'buy');
    // 100000 * 0.001425 = 142.5 → round = 143, min 20
    expect(cost).toBe(143);
  });

  test('賣出成本包含手續費+證交稅', () => {
    const cost = calcTWCost(100000, 'sell');
    // fee: 143, tax: 100000 * 0.003 = 300
    expect(cost).toBe(443);
  });

  test('小額交易使用最低手續費', () => {
    const cost = calcTWCost(1000, 'buy');
    // 1000 * 0.001425 = 1.425 → round = 1 < 20 → use min 20
    expect(cost).toBe(20);
  });

  test('折扣計算正確', () => {
    const cost = calcTWCost(100000, 'buy', 0.6);
    // 100000 * 0.001425 * 0.6 = 85.5 → round = 86
    expect(cost).toBe(86);
  });
});

describe('calcCNCost', () => {
  test('陸股買入成本（深圳）', () => {
    const cost = calcCNCost(100000, 'buy', false);
    // commission: max(100000 * 0.0003 = 30, 5) = 30
    expect(cost).toBe(30);
  });

  test('陸股賣出成本包含印花稅（深圳）', () => {
    const cost = calcCNCost(100000, 'sell', false);
    // commission: 30, stamp: 100000 * 0.0005 = 50（2023.8 起 0.1% → 0.05%）
    expect(cost).toBe(80);
  });

  test('陸股上海賣出包含過戶費', () => {
    const cost = calcCNCost(100000, 'sell', true);
    // commission: 30, stamp: 50, transfer: round(100000 * 0.00002) = 2
    expect(cost).toBe(82);
  });

  test('小額交易使用最低佣金', () => {
    const cost = calcCNCost(5000, 'buy', false);
    // 5000 * 0.0003 = 1.5 < 5 → use min 5
    expect(cost).toBe(5);
  });
});

describe('isShanghai', () => {
  test('600xxx 是滬市', () => expect(isShanghai('600519.SS')).toBe(true));
  test('601xxx 是滬市', () => expect(isShanghai('601318.SS')).toBe(true));
  test('603xxx 是滬市', () => expect(isShanghai('603986.SS')).toBe(true));
  test('000xxx 是深市', () => expect(isShanghai('000858.SZ')).toBe(false));
  test('300xxx 是深市', () => expect(isShanghai('300750.SZ')).toBe(false));
});

describe('calcRoundTripCost', () => {
  test('台股雙邊成本計算', () => {
    const cost = calcRoundTripCost('TW', '2330.TW', 200000, 210000);
    expect(cost.buyFee).toBeGreaterThan(0);
    expect(cost.sellFee).toBeGreaterThan(cost.buyFee); // 賣出多一筆稅
    expect(cost.total).toBe(cost.buyFee + cost.sellFee);
    expect(cost.roundTripPct).toBeGreaterThan(0);
  });
});
