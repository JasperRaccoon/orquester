import React from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";

/**
 * The drill-in's own error boundary (§7.6).
 *
 * A child's rows render provider-authored content like the thread's — a
 * malformed payload can throw in render — and the thread's boundary
 * (`ChatErrorBoundary`) wraps the whole view: a crashing child row replaced
 * the composer, the roster and the breadcrumb's Back with its fallback, and on
 * a touch device, with no Escape key, only closing the tab recovered. This one
 * wraps the drill-in alone, so a child's crash takes down the child's view and
 * nothing else — the overlay stays mounted over it, the parent can still be
 * steered — and its fallback's way back is a real, touch-sized button.
 *
 * Keyed by the agent at the call site: another agent's drill-in starts clean.
 */
interface DrillInErrorBoundaryProps {
  agentId: string;
  /** Leave the drill-in, back to the thread's timeline. */
  onBack: () => void;
  children: React.ReactNode;
}

export class DrillInErrorBoundary extends React.Component<DrillInErrorBoundaryProps, { error: Error | null }> {
  constructor(props: DrillInErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The daemon keeps the agent's rows; only this view failed. Log so the
    // payload that broke it is diagnosable from the browser console.
    console.error(`agent chat: the drill-in of agent ${this.props.agentId} failed to render`, error, info);
  }

  /** "Back to the thread": leaving unmounts this boundary with the child. */
  back = (): void => {
    this.props.onBack();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div
        data-drill-in-crashed={this.props.agentId}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <TriangleAlert size={28} strokeWidth={1.25} className="text-danger" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-neutral-200">This agent&apos;s view failed to render</p>
          <p className="max-w-md text-xs text-neutral-500">
            The agent, its rows and the thread are untouched — only this view stopped. {error.message}
          </p>
        </div>
        <button
          type="button"
          onClick={this.back}
          className="ac-press flex min-h-10 items-center gap-1.5 rounded-md border border-neutral-700 px-3 text-sm text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <ArrowLeft size={14} aria-hidden />
          Back to the thread
        </button>
      </div>
    );
  }
}
