/**
 * The thread's pull request watches (spec 2026-10-14 §5 "PR watch"), between
 * the status line and the banner dock: one chip per watched pull request —
 * its number (a link to its page), what its last read showed, and a stop
 * button. Renders nothing while the thread watches none.
 *
 * T3 shows its watches in the thread details card; here they sit with the
 * other live facts of the thread, since a watch is exactly why an idle
 * thread may start working by itself.
 */

import React from "react";
import { BellRing, GitPullRequest, X } from "lucide-react";

import { cn } from "../../../lib/cn";
import { usePullRequestWatches } from "../../../lib/pr-watches/hooks";
import { ChatIconButton } from "../primitives";
import { TONE_TEXT } from "../primitives/tone";
import { describePullRequestWatch } from "./pr-watch-strip";

export function PullRequestWatchStrip({ sessionId, enabled = true }: { sessionId: string; enabled?: boolean }): React.ReactElement | null {
  const { watches, stopping, error, stop } = usePullRequestWatches(sessionId, enabled);
  if (watches.length === 0 && error === null) return null;
  return (
    <div
      aria-label="Pull request watches"
      role="group"
      data-session-id={sessionId}
      className="mx-auto flex w-full max-w-3xl min-w-0 flex-wrap items-center gap-1.5 pb-1 text-[11px] leading-4"
    >
      {watches.map((watch) => {
        const chip = describePullRequestWatch(watch);
        const busy = stopping.has(watch.id);
        return (
          <span
            key={watch.id}
            title={chip.title}
            className={cn(
              "flex min-w-0 max-w-full items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/80 py-0.5 ps-1.5 pe-0.5",
              busy && "opacity-60"
            )}
          >
            <GitPullRequest size={12} aria-hidden className={cn("shrink-0", TONE_TEXT[chip.tone])} />
            {watch.url ? (
              <a
                href={watch.url}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 font-mono text-neutral-200 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
              >
                {chip.label}
              </a>
            ) : (
              <span className="shrink-0 font-mono text-neutral-200">{chip.label}</span>
            )}
            <span className={cn("min-w-0 truncate", TONE_TEXT[chip.tone])}>{chip.detail}</span>
            {watch.wakePending ? <BellRing size={11} aria-label="Update waiting" className="shrink-0 text-info" /> : null}
            <ChatIconButton
              label={chip.stopLabel}
              size="micro"
              variant="ghost"
              disabled={busy}
              onClick={() => stop(watch.id)}
            >
              <X size={11} aria-hidden />
            </ChatIconButton>
          </span>
        );
      })}
      {error ? (
        <span role="alert" className="text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}
