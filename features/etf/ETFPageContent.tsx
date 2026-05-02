'use client';

import Link from 'next/link';
import { useETFStore, type ETFTab } from '@/store/etfStore';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PageShell } from '@/components/shared';
import { ETFPerformanceTab } from './components/ETFPerformanceTab';
import { ETFChangesTab } from './components/ETFChangesTab';
import { ETFConsensusTab } from './components/ETFConsensusTab';
import { ETFTrackingTab } from './components/ETFTrackingTab';

const TABS: Array<{ value: ETFTab; label: string }> = [
  { value: 'performance', label: '績效排行' },
  { value: 'changes', label: '持股異動' },
  { value: 'consensus', label: '共識買榜' },
  { value: 'tracking', label: '被納入後表現' },
];

export function ETFPageContent() {
  const { activeTab, setActiveTab } = useETFStore();

  const header = (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <Link href="/" className="p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0">
        ←
      </Link>
      <span className="font-bold text-sm whitespace-nowrap shrink-0">📈 ETF追蹤</span>
    </div>
  );

  return (
    <PageShell headerSlot={header}>
      <div className="px-4 py-4 max-w-7xl mx-auto">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ETFTab)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="performance"><ETFPerformanceTab /></TabsContent>
          <TabsContent value="changes"><ETFChangesTab /></TabsContent>
          <TabsContent value="consensus"><ETFConsensusTab /></TabsContent>
          <TabsContent value="tracking"><ETFTrackingTab /></TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}
