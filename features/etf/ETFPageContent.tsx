'use client';

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useETFStore, type ETFTab } from '@/store/etfStore';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

  return (
    <div className="px-4 py-4 max-w-7xl mx-auto">
      <header className="mb-4 flex items-start gap-3">
        <Link
          href="/"
          className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          走圖
        </Link>
        <div>
          <h1 className="text-xl font-semibold text-foreground">主動式 ETF 追蹤器</h1>
          <p className="text-xs text-muted-foreground mt-1">
            台股 11 檔主動式 ETF 績效排行 · 持股異動 · 共識買榜 · 被納入後表現
          </p>
        </div>
      </header>

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
  );
}
