/**
 * Where a send that did not go out puts its draft back (spec §7.4): the thread
 * it was sent FROM, whichever thread — if any — the composer that sent it
 * shows by the time it settles.
 *
 * `submit` empties the draft, and its persisted copy, before the send goes
 * out, and the send settles whenever its transport answers: after a project
 * switch unmounted the composer, or after the composer was handed another
 * thread. What a failure gives back (`draftAfterSend`) must reach that
 * thread's draft and no other, and it must reach the copy that will be shown:
 * the live draft of the composer showing the thread when one does, else the
 * persisted draft the next one loads (`failedSendRestoreTarget`).
 *
 * Component-free so it can be tested: the component hands in the two things
 * only it knows — the thread its live draft holds, and its own live restore.
 */

import { updateThreadDraft } from "../../../lib/agent-chat/store";
import type { StagedAttachment } from "./ComposerAttachments";
import { composerHandle, restoreComposerFailedSend } from "./composer-bridge";
import { persistedDraftAfterSend } from "./composer-draft";
import {
  failedSendRestoreTarget,
  type FailedSendRestore,
  type FailedSendRestoreTarget
} from "./composer-submission";

/**
 * Put a send that did not go out back into its own thread's draft, and say
 * where it went. A composer that turns it away — one that no longer shows the
 * thread — sends it on to the thread's persisted draft rather than losing it.
 */
export function restoreFailedSendDraft(input: {
  /** The thread the message was sent from. */
  sentFrom: string;
  /** The thread whose draft the sending composer's live draft holds now; `null` once it is unmounted. */
  liveThread: string | null;
  restore: FailedSendRestore<StagedAttachment>;
  /** The sending composer's own live restore; `false` when it does not show `sentFrom`. */
  restoreLive: (restore: FailedSendRestore<StagedAttachment>) => boolean;
}): FailedSendRestoreTarget {
  const { sentFrom, restore } = input;
  const target = failedSendRestoreTarget({
    sentFrom,
    liveThread: input.liveThread,
    shownByComposer: composerHandle(sentFrom) !== null
  });
  if (target === "live" && input.restoreLive(restore)) return "live";
  if (target === "composer" && restoreComposerFailedSend(sentFrom, restore)) return "composer";
  updateThreadDraft(sentFrom, (persisted) =>
    persistedDraftAfterSend({ outcome: restore.outcome, sent: restore.sent, persisted })
  );
  return "persisted";
}
