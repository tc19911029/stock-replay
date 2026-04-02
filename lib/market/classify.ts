export type MarketTab = 'all' | 'TW' | 'CN';

export function classifyMarket(symbol: string): 'TW' | 'CN' | 'other' {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  return 'other';
}

export function filterByMarket<T extends { symbol: string }>(
  items: T[],
  tab: MarketTab,
): T[] {
  if (tab === 'all') return items;
  return items.filter(i => classifyMarket(i.symbol) === tab);
}

/** Check if a YYYY-MM-DD date string falls on a weekend (not a trading day). */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}
