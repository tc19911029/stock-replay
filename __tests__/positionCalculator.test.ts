/**
 * Unit tests for position sizing logic.
 * Tests the core math without React rendering.
 */

// Pure function extracted from PositionCalculator component logic
function calcPosition(
  accountSize: number,
  riskPct: number,
  entryPrice: number,
  stopLossPrice: number,
  takeProfitPrice: number,
) {
  if (entryPrice <= 0 || stopLossPrice <= 0) return null;
  if (stopLossPrice >= entryPrice) return null;

  const riskPerShare = entryPrice - stopLossPrice;
  const maxLossPerTrade = accountSize * (riskPct / 100);
  const rawShares = maxLossPerTrade / riskPerShare;

  const lots = Math.max(1, Math.floor(rawShares / 1000));
  const shares = lots * 1000;
  const totalCost = shares * entryPrice;
  const actualMaxLoss = shares * riskPerShare;
  const riskRatio = (actualMaxLoss / accountSize) * 100;

  let rewardRisk = 0;
  if (takeProfitPrice > entryPrice) {
    const profit = shares * (takeProfitPrice - entryPrice);
    rewardRisk = profit / actualMaxLoss;
  }

  return { shares, lots, totalCost, maxLoss: actualMaxLoss, riskRatio, rewardRisk };
}

describe('Position Calculator Logic', () => {
  it('returns null when entry price is 0', () => {
    expect(calcPosition(1_000_000, 1, 0, 95, 115)).toBeNull();
  });

  it('returns null when stop loss >= entry price', () => {
    expect(calcPosition(1_000_000, 1, 100, 100, 115)).toBeNull();
    expect(calcPosition(1_000_000, 1, 100, 110, 115)).toBeNull();
  });

  it('calculates shares in multiples of 1000', () => {
    const result = calcPosition(1_000_000, 1, 100, 95, 115);
    expect(result).not.toBeNull();
    expect(result!.shares % 1000).toBe(0);
  });

  it('keeps actual risk ratio at or below target', () => {
    const result = calcPosition(1_000_000, 1, 100, 95, 115);
    expect(result).not.toBeNull();
    // Due to floor, actual risk should be ≤ target
    expect(result!.riskRatio).toBeLessThanOrEqual(1.0);
  });

  it('calculates correct reward:risk ratio', () => {
    // entry=100, stop=95 (risk=5/share), tp=115 (reward=15/share) → R:R = 3
    const result = calcPosition(1_000_000, 1, 100, 95, 115);
    expect(result).not.toBeNull();
    expect(result!.rewardRisk).toBeCloseTo(3, 1);
  });

  it('returns R:R=0 when no take profit provided', () => {
    const result = calcPosition(1_000_000, 1, 100, 95, 0);
    expect(result).not.toBeNull();
    expect(result!.rewardRisk).toBe(0);
  });

  it('minimum lot size is 1', () => {
    // Very tight stop (1 tick), tiny account — should still give 1 lot
    const result = calcPosition(10_000, 0.5, 1000, 999.9, 1010);
    expect(result).not.toBeNull();
    expect(result!.lots).toBeGreaterThanOrEqual(1);
  });

  it('larger account allows more lots', () => {
    const small = calcPosition(100_000, 1, 100, 95, 0);
    const large = calcPosition(10_000_000, 1, 100, 95, 0);
    expect(large!.lots).toBeGreaterThan(small!.lots);
  });
});
