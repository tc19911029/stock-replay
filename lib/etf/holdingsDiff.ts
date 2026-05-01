/**
 * 比對兩期 ETF 快照，產生 ETFChange 異動報告。
 *
 * 規則：
 *   - delta 絕對值 ≤ 0.01% 視為無變動（過濾揭露 rounding）
 *   - 比重以 prior 為基準，比較 current
 *   - 結果不修改 input
 */
import type { ETFSnapshot, ETFChange, ETFHolding, ETFHoldingDelta } from './types';

const NOISE_THRESHOLD = 0.01;

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
    if (Math.abs(delta) <= NOISE_THRESHOLD) continue;
    const entry: ETFHoldingDelta = { ...ch, prevWeight: ph.weight, delta };
    if (delta > 0) increased.push(entry);
    else decreased.push(entry);
  }

  for (const [symbol, ph] of priorMap) {
    if (!currentMap.has(symbol)) exits.push(ph);
  }

  // 排序：權重大的在前
  newEntries.sort((a, b) => b.weight - a.weight);
  exits.sort((a, b) => b.weight - a.weight);
  increased.sort((a, b) => b.delta - a.delta);
  decreased.sort((a, b) => a.delta - b.delta);

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
