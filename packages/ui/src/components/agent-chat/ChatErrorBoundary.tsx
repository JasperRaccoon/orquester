import React from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

/**
 * One error boundary **per thread** (spec §7.1).
 *
 * A chat row renders provider-authored content — markdown, diffs, tool payloads
 * from four different CLIs — so a malformed payload can throw inside render.
 * Without a boundary that takes the whole app down: `MainView` keeps every tab
 * mounted, so one bad row in one background tab would blank the window.
 *
 * Keyed by session id at the call site, so remounting one thread's boundary
 * never disturbs another's, and "Try again" re-renders only this thread.
 */
export class ChatErrorBoundary extends React.Component<
  { sessionId: string; children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { sessionId: string; children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The daemon keeps the thread; only this render failed. Log so the payload
    // that broke it is diagnosable from the browser console.
    console.error(`agent chat: render failed for session ${this.props.sessionId}`, error, info);
  }

  componentDidUpdate(previous: { sessionId: string }): void {
    // A different thread in the same slot starts clean: the previous thread's
    // failure says nothing about this one.
    if (previous.sessionId !== this.props.sessionId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
        <TriangleAlert size={28} strokeWidth={1.25} className="text-danger" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-neutral-200">This conversation failed to render</p>
          <p className="max-w-md text-xs text-neutral-500">
            The agent and its history are untouched — only this view stopped. {error.message}
          </p>
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <RotateCcw size={13} />
          Try again
        </button>
      </div>
    );
  }
}
