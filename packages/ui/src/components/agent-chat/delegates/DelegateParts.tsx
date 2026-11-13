/**
 * The pieces every surface showing a parent's delegated chats is built from — the timeline's
 * subagent strip (`timeline/rows/DelegateGroupRow.tsx`) and the roster's delegated rows
 * (`roster/DelegateRosterRow.tsx`) — so the two speak one visual language with the roster's own
 * agent rows: the same status dot and tones, the same agent icons the tab strip draws. What they
 * read live from the app's tabs is in `delegate-tabs.ts`.
 */

import React from "react";

import { cn } from "../../../lib/cn";
import {
  DELEGATE_STATUS_LABEL,
  isDelegateLive,
  type DelegateChildStatus
} from "../../../lib/agent-chat/delegates.logic";
import { getRegistryIcon } from "../../../icons";
import type { ChatTone } from "../primitives";

export interface DelegateStatusVisual {
  tone: ChatTone;
  label: string;
  /** In motion: the slow breath. */
  pulse: boolean;
  /** Act now (it waits for its user): the halo. */
  ping: boolean;
}

/**
 * Status → dot and word, on the roster's rules (`rosterStatusVisual`): in motion breathes in the
 * info tone, waiting for the user pings in warn, broken is danger, done is ok, and resting —
 * stopped, idle, closed — is muted.
 */
export function delegateStatusVisual(status: DelegateChildStatus): DelegateStatusVisual {
  const label = DELEGATE_STATUS_LABEL[status];
  switch (status) {
    case "starting":
    case "working":
      return { tone: "info", label, pulse: true, ping: false };
    case "needs-input":
      return { tone: "warn", label, pulse: false, ping: true };
    case "done":
      return { tone: "ok", label, pulse: false, ping: false };
    case "failed":
      return { tone: "danger", label, pulse: false, ping: false };
    case "stopped":
    case "idle":
    case "closed":
      return { tone: "muted", label, pulse: false, ping: false };
  }
}

/** The agent's own icon in a round chip, as the strip overlaps them (`ring` cuts each from the next). */
export function DelegateAvatar({
  refId,
  className
}: {
  refId: string | null;
  className?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-neutral-300 ring-2 ring-neutral-950",
        className
      )}
    >
      {getRegistryIcon("agent-chat", refId ?? undefined, 12)}
    </span>
  );
}

/** How many avatars overlap before the rest read "+N". */
export const DELEGATE_AVATARS_SHOWN = 3;

/** Up to {@link DELEGATE_AVATARS_SHOWN} overlapping agent avatars, then "+N". */
export function DelegateAvatars({ refIds }: { refIds: readonly (string | null)[] }): React.ReactElement {
  const shown = refIds.slice(0, DELEGATE_AVATARS_SHOWN);
  const rest = refIds.length - shown.length;
  return (
    <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden data-delegate-avatars={refIds.length}>
      {shown.map((refId, index) => (
        <DelegateAvatar key={index} refId={refId} />
      ))}
      {rest > 0 ? (
        <span className="ac-tabular inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-neutral-800 px-1 text-[10px] font-medium text-neutral-400 ring-2 ring-neutral-950">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** The summary line's colour: act-now first, then in motion, then broken; else muted. */
export function delegateSummaryTone(statuses: readonly DelegateChildStatus[]): string {
  if (statuses.includes("needs-input")) return "text-warn-300";
  if (statuses.some(isDelegateLive)) return "text-info-300";
  if (statuses.includes("failed")) return "text-danger-300";
  return "text-neutral-500";
}
