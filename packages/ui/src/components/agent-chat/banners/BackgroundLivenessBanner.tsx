// Ported from T3 Code (MIT): apps/web/src/components/ChatView.tsx:6225-6303
import React from "react";
import type { BackgroundLiveness } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { BannerCard, StatusDot } from "../primitives";
import { backgroundLivenessTitle } from "./banner-model";

export interface BackgroundLivenessBannerProps {
  liveness: BackgroundLiveness;
  /** From the roster's panel model; 0 means "something is running, unnamed". */
  liveAgentCount: number;
  /** True from the click until liveness clears — not until the command returns. */
  stopping: boolean;
  onStop: () => void;
}

/**
 * The background-work banner — the one stop affordance after a turn settles.
 *
 * Background work (subagent fleets, watch loops, background shells) outlives
 * the turn that started it, and once the turn settles **the composer's stop
 * button is gone**. So while liveness is non-null and no turn is working, this
 * banner sits in the notice stack at `activity` priority with a single Stop.
 *
 * Two rules that look like details and are not:
 *
 *  - **Stop posts `/interrupt` with no `turnId`** (§6.2), which stops every
 *    live subagent, shell and watch loop of the thread at once. There is no
 *    per-row stop: a fleet is stopped as a fleet.
 *  - **"Stopping…" holds until `backgroundLiveness` clears**, not until the
 *    command returns — an accepted interrupt is not yet a dead process. The
 *    caller owns that flag and resets it per thread, so switching tabs while
 *    one thread is stopping never disables another's button.
 *
 * *T3: `ChatView.tsx:6225-6303`.*
 */
export function BackgroundLivenessBanner({
  liveness,
  liveAgentCount,
  stopping,
  onStop
}: BackgroundLivenessBannerProps): React.ReactElement {
  const working = liveness === "working";
  return (
    <BannerCard
      variant="default"
      density="compact"
      icon={<StatusDot tone={working ? "info" : "muted"} size="xs" pulse={working} />}
      title={backgroundLivenessTitle(liveness, liveAgentCount)}
      actions={
        <button
          type="button"
          disabled={stopping}
          onClick={onStop}
          data-background-stop="true"
          className={cn(
            "ac-press inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium",
            "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            "disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      }
    />
  );
}
