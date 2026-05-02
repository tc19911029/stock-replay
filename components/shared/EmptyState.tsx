import Link from 'next/link';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  cta?: { label: string; href: string };
  /** `compact` = panel 內小型空狀態（text-2xl + py-8）。預設 full-page（text-5xl + py-20）。 */
  variant?: 'full' | 'compact';
  className?: string;
}

/**
 * 全站統一空狀態。每頁不要再自寫 emoji+文案+CTA。
 */
export function EmptyState({ icon = '📋', title, description, cta, variant = 'full', className = '' }: EmptyStateProps) {
  const isCompact = variant === 'compact';
  return (
    <div className={[
      'text-center text-muted-foreground',
      isCompact ? 'py-8' : 'py-20 border border-dashed border-border rounded-xl',
      className,
    ].filter(Boolean).join(' ')}>
      <p className={isCompact ? 'text-2xl mb-2' : 'text-5xl mb-4'}>{icon}</p>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground/60 mt-1">{description}</p>
      )}
      {cta && (
        <Link
          href={cta.href}
          className="inline-block mt-4 text-xs px-4 py-1.5 bg-blue-600/80 hover:bg-blue-500 rounded-lg text-foreground font-medium transition"
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}
