import { PageShell } from '@/components/shared';
import { ETFPageContent } from '@/features/etf';

export const metadata = {
  title: '主動式 ETF 追蹤器',
};

export default function ETFPage() {
  return (
    <PageShell>
      <ETFPageContent />
    </PageShell>
  );
}
