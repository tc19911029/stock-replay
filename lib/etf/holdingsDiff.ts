/**
 * 比對兩期 ETF 快照，產生 ETFChange 異動報告。
 *
 * 優先以股數變動判斷：
 *   - 兩期都有 shares → 股數 delta == 0 視為無異動（AUM 造成的權重飄移不算）
 *   - 缺 shares 時 fallback 到權重 delta > 0.01% 門檻
 */
import type { ETFSnapshot, ETFChange, ETFHolding, ETFHoldingDelta } from './types';

const WEIGHT_NOISE_THRESHOLD = 0.01;

export function computeETFChange(prior: ETFSnapshot, current: ETFSnapshot): ETFChange {
  if (prior.etfCode !== current.etfCode) {
    throw new Error(
      `ETF code mismatch: prior=${prior.etfCode} current=${current.etfCode}`,
    );
  }

  const priorMap = new Map<string, ETFHolding>();
  for (const h of prior.holdings) priorMap.set(h.symbol, h);
  const currentMap = new Map<string, ETFHolding>();
  for (const h of current.holdings) currentMap.set(h.symbol, h);

  const newEntries: ETFHolding[] = [];
  const exits: ETFHolding[] = [];
  const increased: ETFHoldingDelta[] = [];
  const decreased: ETFHoldingDelta[] = [];

  for (const [symbol, ch] of currentMap) {
    const ph = priorMap.get(symbol);
    if (!ph) {
      newEntries.push(ch);
      continue;
    }
    const delta = ch.weight - ph.weight;
    const sharesKnown = ch.shares !== undefined && ph.shares !== undefined;

    if (sharesKnown) {
      const deltaShares = ch.shares! - ph.shares!;
      if (deltaShares === 0) continue;
      const entry: ETFHoldingDelta = {
        ...ch,
        prevWeight: ph.weight,
        delta,
        deltaShares,
        priorShares: ph.shares,
      };
      if (deltaShares > 0) increased.push(entry);
      else decreased.push(entry);
    } else {
      if (Math.abs(delta) <= WEIGHT_NOISE_THRESHOLD) continue;
      const entry: ETFHoldingDelta = { ...ch, prevWeight: ph.weight, delta };
      if (delta > 0) increased.push(entry);
      else decreased.push(entry);
    }
  }

  for (const [symbol, ph] of priorMap) {
    if (!currentMap.has(symbol)) exits.push(ph);
  }

  // 排序：張數/權重絕對值大的在前
  newEntries.sort((a, b) => b.weight - a.weight);
  exits.sort((a, b) => b.weight - a.weight);
  increased.sort((a, b) => (b.deltaShares ?? b.delta) - (a.deltaShares ?? a.delta));
  decreased.sort((a, b) => (a.deltaShares ?? a.delta) - (b.deltaShares ?? b.delta));

  return {
    etfCode: current.etfCode,
    etfName: current.etfName,
    fromDate: prior.disclosureDate,
    toDate: current.disclosureDate,
    newEntries,
    exits,
    increased,
    decreased,
  };
}
