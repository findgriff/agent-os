// Page-level error boundary. A render crash in any single page (e.g. a
// ReferenceError from a stale build, or reading a field off undefined API
// data) is caught here and shown as a recoverable fallback instead of
// white-screening the whole app. Mounted inside Layout so the sidebar/top bar
// stay usable, and remounted per-route (Layout keys <main> on the pathname)
// so navigating away clears the error automatically.
import React from 'react';
import { Icon } from './ui';

interface Props { children: React.ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface it in the console for debugging (vite build ships runtime crashes
    // the type-checker can't see).
    console.error('[AGENT OS] page crashed:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center animate-fadeInUp">
          <div className="grid h-16 w-16 place-items-center rounded-3xl glass"
            style={{ color: '#F43F5E', boxShadow: '0 0 32px -8px rgba(244,63,94,0.55)' }}>
            <Icon name="error" size={30} />
          </div>
          <div className="font-display text-lg font-semibold text-ink">This page hit a snag</div>
          <div className="max-w-sm text-sm text-muted">
            Something went wrong while rendering this view. You can retry, or head back to the
            dashboard — the rest of AGENT OS is still running.
          </div>
          {error.message && (
            <code className="max-w-sm truncate rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-rose/90">
              {error.message}
            </code>
          )}
          <div className="mt-1 flex gap-2">
            <button onClick={this.reset}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-[#04222b] transition-all hover:brightness-110 active:scale-[0.97]">
              <Icon name="refresh" size={18} /> Try again
            </button>
            <button onClick={() => { window.location.href = '/'; }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-raised px-3.5 py-2 text-sm text-ink border border-white/10 transition-all hover:bg-[#1a2942] active:scale-[0.97]">
              <Icon name="home" size={18} /> Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
