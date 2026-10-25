/**
 * Code-split views. The app's first paint — the shell, an agent chat and its
 * composer — must not wait on the heavy features it does not show (terminals,
 * the file browser and its viewers, workflows, settings…), so those load as
 * their own chunks the first time they are rendered.
 *
 * - {@link lazyNamed}: `React.lazy` over a module's named export. A failed
 *   load (offline, or a chunk a newer deploy removed) rejects with a
 *   {@link LazyLoadError}.
 * - {@link LazyBoundary}: the Suspense fallback while the chunk loads, and a
 *   "Reload" card in place of the view when it could not load. Any other
 *   error passes through to the boundary above, as it did before the split.
 * - {@link useOpenedOnce} / {@link lazyDialog}: for a dialog that stays
 *   mounted while closed — load it the first time it opens, then keep it
 *   mounted (its state survives a close, as before).
 */

import React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

/** A lazy view's chunk failed to load. */
export class LazyLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : "This part of the app could not be loaded.");
    this.name = "LazyLoadError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = React.ComponentType<any>;

/** `React.lazy` over the named export `name` of the module `load` imports. */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K
): M[K] extends AnyComponent ? React.LazyExoticComponent<M[K]> : never {
  const lazy = React.lazy(() =>
    load().then(
      (module) => ({ default: module[name] as AnyComponent }),
      (cause: unknown) => {
        throw new LazyLoadError(cause);
      }
    )
  );
  return lazy as never;
}

/** A centred spinner filling its container: a lazy tab's fallback. */
export const LoadingPane: React.FC<{ label?: string; className?: string }> = ({ label = "Loading…", className }) => (
  <div
    role="status"
    className={cn("flex h-full w-full items-center justify-center gap-2 text-sm text-neutral-500", className)}
  >
    <Loader2 size={16} className="motion-safe:animate-spin" /> {label}
  </div>
);

/** A spinner over the app: a lazy dialog's fallback while it first opens. */
export const LoadingOverlay: React.FC = () => (
  <div
    role="status"
    aria-label="Loading"
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 text-neutral-300"
  >
    <Loader2 size={20} className="motion-safe:animate-spin" />
  </div>
);

class LazyErrorBoundary extends React.Component<
  React.PropsWithChildren<{ inline: boolean }>,
  { error: unknown }
> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    // Only a failed chunk is this boundary's; anything else goes on up.
    if (!(error instanceof LazyLoadError)) throw error;
    return (
      <div
        role="alert"
        className={cn(
          "flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-neutral-400",
          this.props.inline ? "h-full w-full" : "fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded border border-neutral-800 bg-neutral-900"
        )}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-warn" /> This part of the app could not be loaded.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800"
        >
          Reload
        </button>
      </div>
    );
  }
}

export interface LazyBoundaryProps {
  children: React.ReactNode;
  /** Shown while the chunk loads; defaults to {@link LoadingPane}. */
  fallback?: React.ReactNode;
  /**
   * The view fills a pane (a tab): its load error fills it too. Otherwise
   * (a dialog, a popover) the error is a small card over the app.
   */
  inline?: boolean;
}

export const LazyBoundary: React.FC<LazyBoundaryProps> = ({ children, fallback, inline = true }) => (
  <LazyErrorBoundary inline={inline}>
    <React.Suspense fallback={fallback === undefined ? <LoadingPane /> : fallback}>{children}</React.Suspense>
  </LazyErrorBoundary>
);

/** `true` from the first render where `open` is, for good. */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = React.useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/**
 * A lazy dialog taking `open`: nothing is loaded or mounted until it first
 * opens, and from then on it is the dialog itself, open or closed.
 */
export function lazyDialog<P extends { open: boolean }>(Dialog: React.ComponentType<P>): React.FC<P> {
  return function LazyDialog(props: P) {
    const opened = useOpenedOnce(props.open);
    return opened ? (
      <LazyBoundary inline={false} fallback={props.open ? <LoadingOverlay /> : null}>
        <Dialog {...props} />
      </LazyBoundary>
    ) : null;
  };
}
