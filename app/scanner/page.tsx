'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ScanPageContent } from '@/features/scan';

function ScannerInner() {
  const searchParams = useSearchParams();
  const mode = searchParams.get('mode');
  const defaultMode = mode === 'full' ? 'full' : 'sop';

  return <ScanPageContent defaultMode={defaultMode} />;
}

export default function ScannerPage() {
  return (
    <Suspense>
      <ScannerInner />
    </Suspense>
  );
}
