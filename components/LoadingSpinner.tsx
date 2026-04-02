export function LoadingSpinner({ size = 'md', text }: { size?: 'sm' | 'md' | 'lg'; text?: string }) {
  const sizeMap = { sm: 'w-4 h-4', md: 'w-8 h-8', lg: 'w-12 h-12' };
  return (
    <div className="flex flex-col items-center gap-3">
      <div className={`${sizeMap[size]} border-2 border-muted border-t-sky-500 rounded-full animate-spin`} />
      {text && <p className="text-xs text-muted-foreground">{text}</p>}
    </div>
  );
}

export function FullPageLoading({ text = '載入中...' }: { text?: string }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <LoadingSpinner size="lg" text={text} />
    </div>
  );
}

/** Skeleton placeholder for loading content */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-muted/50 rounded ${className}`} />
  );
}

/** Skeleton rows for panel-like loading states */
export function SkeletonPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}

/** Thin progress bar for page-level loading */
export function TopProgressBar({ progress }: { progress: number }) {
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] h-0.5 bg-secondary">
      <div
        className="h-full bg-sky-500 transition-all duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
      />
    </div>
  );
}
