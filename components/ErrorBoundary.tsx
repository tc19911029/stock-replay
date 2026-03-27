'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
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

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-full bg-slate-900 text-slate-400 p-4">
          <div className="text-center">
            <div className="text-2xl mb-2">chart error</div>
            <div className="text-xs text-red-400 mb-3">{this.state.error?.message}</div>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="bg-slate-700 text-white px-4 py-2 rounded text-sm hover:bg-slate-600"
            >
              retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
