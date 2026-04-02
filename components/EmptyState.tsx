import Link from 'next/link';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

export default function EmptyState({
  icon = '📭',
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
      <p className="text-2xl mb-2">{icon}</p>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">{description}</p>
      )}
      {actionLabel && actionHref && (
        <Link href={actionHref}
          className="mt-3 text-xs px-3 py-1.5 bg-sky-600/80 hover:bg-sky-500 rounded-lg text-white font-medium transition">
          {actionLabel}
        </Link>
      )}
      {actionLabel && onAction && !actionHref && (
        <button onClick={onAction}
          className="mt-3 text-xs px-3 py-1.5 bg-sky-600/80 hover:bg-sky-500 rounded-lg text-white font-medium transition">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
