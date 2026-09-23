import React from "react";
import { ChevronsUp, LoaderCircle } from "lucide-react";

export interface LoadOlderRowProps {
  /** A `GET …/history` is in flight: the button spins and cannot be pressed again. */
  loading: boolean;
  /** Why the last load failed, in words; shown under the button, which stays to retry. */
  error: string | null;
  onLoad: () => void;
}

/**
 * "Load older turns" — the door to the indexed history above the retained
 * window (design 2026-09-23 §C "History page", "Client").
 *
 * **Not a timeline row.** It carries no `data-timeline-row-id`, so the
 * reading-anchor walk and a reveal step over it, and it is never part of the
 * row list the store projects: it sits above the first row, in the scroll
 * content, only while something older exists.
 *
 * The spinner is allowed here and nowhere else in the timeline: this control
 * has a request of its own in flight (the working row's rule — "keep the
 * spinner for a control whose own request is in flight").
 */
export const LoadOlderRow = React.memo(function LoadOlderRow({
  loading,
  error,
  onLoad
}: LoadOlderRowProps): React.ReactElement {
  return (
    <div
      data-timeline-load-older=""
      className="mx-auto flex w-full min-w-0 max-w-3xl select-none flex-col items-center gap-1 pb-3"
    >
      <button
        type="button"
        data-timeline-load-older-button=""
        onClick={onLoad}
        disabled={loading}
        aria-busy={loading ? true : undefined}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-neutral-500"
      >
        {loading ? (
          <LoaderCircle size={12} strokeWidth={1.8} aria-hidden className="animate-spin" />
        ) : (
          <ChevronsUp size={12} strokeWidth={1.8} aria-hidden />
        )}
        {loading ? "Loading older turns…" : "Load older turns"}
      </button>
      {error !== null && !loading ? (
        <p role="alert" className="select-text px-2 text-center text-[11px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});
