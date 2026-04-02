'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Custom fallback UI */
  fallback?: React.ReactNode;
  /** Section name for error context (e.g. "圖表", "掃描") */
  section?: string;
  /** Optional callback when error is caught */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.section ? `:${this.props.section}` : ''}]`,
      error,
      info,
    );
    this.props.onError?.(error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const section = this.props.section ?? '模組';
      return (
        <div className="flex items-center justify-center h-full min-h-[120px] bg-card border border-border rounded-lg text-muted-foreground p-4">
          <div className="text-center space-y-2">
            <p className="text-sm font-medium">{section}載入失敗</p>
            <p className="text-xs text-red-400/80 max-w-xs truncate">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-2 bg-muted hover:bg-muted/80 text-foreground px-4 py-1.5 rounded-md text-xs font-medium transition-colors"
            >
              重試
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Convenience wrapper for feature sections.
 * Usage: <SectionBoundary section="掃描結果"><ScanResults /></SectionBoundary>
 */
export function SectionBoundary({
  section,
  children,
}: {
  section: string;
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary section={section}>
      {children}
    </ErrorBoundary>
  );
}
