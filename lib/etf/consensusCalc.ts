/**
 * 共識買榜：找出在窗口期間（最近 N 個交易日）被 2+ ETF 新增/加碼的個股
 */
import type { ETFChange, ETFConsensusEntry } from './types';

interface ConsensusBuilder {
  symbol: string;
  stockName: string;
  etfMap: Map<string, { etfName: string; weight: number; date: string; type: 'new' | 'increased' }>;
}

export function computeConsensus(
  changes: ETFChange[],
  minEtfs = 2,
): ETFConsensusEntry[] {
  const map = new Map<string, ConsensusBuilder>();

  for (const change of changes) {
    for (const h of change.newEntries) {
      addEntry(map, change, h.symbol, h.name, h.weight, 'new');
    }
    for (const h of change.increased) {
      addEntry(map, change, h.symbol, h.name, h.weight, 'increased');
    }
  }

  const out: ETFConsensusEntry[] = [];
  for (const [, builder] of map) {
    if (builder.etfMap.size < minEtfs) continue;

    const etfCodes: string[] = [];
    const etfNames: string[] = [];
    let weightSum = 0;
    let firstDate = '';
    let newCount = 0;
    let increasedCount = 0;

    for (const [code, info] of builder.etfMap) {
      etfCodes.push(code);
      etfNames.push(info.etfName);
      weightSum += info.weight;
      if (!firstDate || info.date < firstDate) firstDate = info.date;
      if (info.type === 'new') newCount++;
      else increasedCount++;
    }

    out.push({
      symbol: builder.symbol,
      stockName: builder.stockName,
      etfCodes,
      etfNames,
      firstAddedDate: firstDate,
      avgWeight: weightSum / builder.etfMap.size,
      newCount,
      increasedCount,
    });
  }

  // 動作 ETF 數越多排越前
  out.sort((a, b) => {
    const lenDiff = b.etfCodes.length - a.etfCodes.length;
    if (lenDiff !== 0) return lenDiff;
    return b.avgWeight - a.avgWeight;
  });

  return out;
}

function addEntry(
  map: Map<string, ConsensusBuilder>,
  change: ETFChange,
  symbol: string,
  name: string,
  weight: number,
  type: 'new' | 'increased',
): void {
  let builder = map.get(symbol);
  if (!builder) {
    builder = { symbol, stockName: name, etfMap: new Map() };
    map.set(symbol, builder);
  }
  // 同一檔 ETF 在窗口內可能對同一股票有多次動作 → 取最早的
  const existing = builder.etfMap.get(change.etfCode);
  if (!existing || change.toDate < existing.date) {
    builder.etfMap.set(change.etfCode, {
      etfName: change.etfName,
      weight,
      date: change.toDate,
      type,
    });
  }
}
