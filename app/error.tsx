'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="bg-secondary border border-border rounded-xl p-6 max-w-md w-full text-center space-y-4">
        <p className="text-3xl">⚠️</p>
        <h2 className="text-base font-bold text-foreground/90">發生錯誤</h2>
        <p className="text-xs text-muted-foreground">{error.message || '未知錯誤，請重新整理頁面'}</p>
        {error.digest && <p className="text-[10px] text-muted-foreground/60 font-mono">錯誤代碼：{error.digest}</p>}
        <div className="flex gap-2 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-bold transition"
          >
            重試
          </button>
          <button
            onClick={() => window.location.href = '/'}
            className="px-4 py-2 bg-muted hover:bg-muted rounded-lg text-sm font-medium transition text-foreground/80"
          >
            回到首頁
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          若問題持續發生，請嘗試清除瀏覽器快取或更換瀏覽器
        </p>
      </div>
    </div>
  );
}
