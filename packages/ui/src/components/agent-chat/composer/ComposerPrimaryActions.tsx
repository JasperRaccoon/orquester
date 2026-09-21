// Ported from T3 Code (MIT): apps/web/src/components/chat/ComposerPrimaryActions.tsx
import React from "react";

import { cn } from "../../../lib/cn";

export interface ComposerPrimaryActionsProps {
  /** A turn is live: Stop is present, and a sendable draft queues or steers. */
  isRunning: boolean;
  /** A plan is waiting to be implemented: the send button becomes Implement/Refine. */
  showPlanFollowUp: boolean;
  promptHasText: boolean;
  hasSendableContent: boolean;
  /** A send is in flight — the button spins rather than accepting a second click. */
  isSendBusy: boolean;
  /** Non-null disables send and becomes the button's accessible name. */
  sendDisabledReason: string | null;
  /** True once a plain send would queue rather than steer (§7.4). */
  willQueue: boolean;
  onInterrupt: () => void;
}

const ROUND =
  "ac-press inline-flex items-center justify-center rounded-full " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-30";

/**
 * Send, Stop, and the plan follow-up pair.
 *
 * **While a turn runs, Stop and Send sit side by side.** T3 learned that
 * hiding send during a turn is wrong: a sendable draft has somewhere to go —
 * it steers or it queues — and taking the button away makes the user think it
 * does not.
 *
 * The plan follow-up is one button with two meanings, never two buttons:
 * **Implement** on an empty draft, **Refine** once there is text. They are the
 * same submit — `resolvePlanFollowUpSubmission` decides which — so the label
 * always describes what pressing it will actually do.
 *
 * differs from T3: T3's Implement is a split button whose menu offers
 * "Implement in a new thread". Orquester has no new-thread action in
 * `AgentChatActions` (a new thread is a new tab, opened from the launch flow),
 * so the split would hang off nothing and the button is plain.
 *
 * *T3: `ComposerPrimaryActions.tsx:161-216, 218-284`.*
 */
export function ComposerPrimaryActions({
  isRunning,
  showPlanFollowUp,
  promptHasText,
  hasSendableContent,
  isSendBusy,
  sendDisabledReason,
  willQueue,
  onInterrupt
}: ComposerPrimaryActionsProps): React.ReactElement {
  const sendDisabled = sendDisabledReason !== null || isSendBusy || !hasSendableContent;

  const stopButton = (
    <button
      type="button"
      data-composer-shortcut="stop"
      onPointerDown={(event) => event.preventDefault()}
      onClick={onInterrupt}
      aria-label="Stop generation"
      title="Stop generation (Esc)"
      className={cn(
        ROUND,
        "h-8 w-8 bg-danger-900/70 text-danger-200 hover:bg-danger-900 sm:h-8 sm:w-8"
      )}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );

  if (showPlanFollowUp) {
    return (
      <div className="flex items-center justify-end gap-2">
        {isRunning ? stopButton : null}
        <button
          type="submit"
          data-composer-shortcut="send"
          onPointerDown={(event) => event.preventDefault()}
          disabled={sendDisabledReason !== null || isSendBusy}
          title={sendDisabledReason ?? undefined}
          className={cn(
            ROUND,
            "h-8 bg-neutral-200 px-4 text-xs font-medium text-neutral-900 hover:bg-neutral-50"
          )}
        >
          {isSendBusy ? "Sending…" : promptHasText ? "Refine" : "Implement"}
        </button>
      </div>
    );
  }

  const sendButton = (
    <button
      type="submit"
      data-composer-shortcut="send"
      onPointerDown={(event) => event.preventDefault()}
      disabled={sendDisabled}
      title={sendDisabledReason ?? undefined}
      aria-label={
        sendDisabledReason ??
        (isSendBusy ? "Sending" : isRunning ? (willQueue ? "Queue message" : "Steer the agent") : "Send message")
      }
      className={cn(
        ROUND,
        "h-9 w-9 bg-neutral-200 text-neutral-900 hover:bg-neutral-50 sm:h-8 sm:w-8"
      )}
    >
      {isSendBusy ? (
        <span className="ac-spin h-3.5 w-3.5 rounded-full border border-neutral-900/30 border-t-neutral-900" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  if (!isRunning) return sendButton;

  return (
    <div className="flex items-center justify-end gap-2">
      {stopButton}
      {hasSendableContent ? sendButton : null}
    </div>
  );
}
