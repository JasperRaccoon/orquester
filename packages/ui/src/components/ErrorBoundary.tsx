import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Root-level render-crash guard. Without it, one throwing component unmounts
 * the entire React tree and the app dies to a blank page with the only clue
 * buried in the console (a stale-localStorage crash shipped exactly that way).
 * Instead: show the actual error and offer a recovery path — clearing local
 * data fixes the "poisoned persisted state" class outright.
 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private resetAndReload = (): void => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage unavailable — reload alone may still recover */
    }
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-8 text-neutral-200">
        <div className="text-lg font-semibold">Something broke</div>
        <div className="max-w-xl overflow-auto rounded border border-neutral-800 bg-neutral-900 p-3 font-mono text-xs text-red-400">
          {this.state.error.message || String(this.state.error)}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.resetAndReload}
            className="rounded border border-red-800 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
          >
            Reset local data &amp; reload
          </button>
        </div>
        <div className="max-w-xl text-center text-xs text-neutral-500">
          "Reset local data" clears this browser's saved layout, preferences and login for this
          app, then reloads — sessions and files live on the server and are unaffected.
        </div>
      </div>
    );
  }
}
