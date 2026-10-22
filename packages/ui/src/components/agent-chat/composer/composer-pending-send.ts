/**
 * What a send does while the dock holds a provider request (§7.5).
 *
 * The composer stays usable. A message sent over a pending **approval**
 * redirects the agent: the host declines every approval the user saw and
 * steers the message into the turn, in one `/turn` command
 * (`TurnCommandBody.declineApprovals`). A message sent over a pending
 * **question** is its answer: the text becomes the active question's typed
 * answer on the card (`question-composer-bridge.ts`), exactly as T3's composer
 * doubles as the question's answer field. The dock shows an approval ahead of
 * a question (`resolveDockCard`), and so does this: what the send does always
 * matches the card in front of the user.
 *
 * Pure: the composer hands this what the dock shows and renders what comes
 * back.
 */

import { REDIRECT_COMPACT_REASON, isGoalCommandText } from "@orquester/api/agent-chat";

/** The provider requests the dock shows, as the composer needs them. */
export interface ComposerPendingRequests {
  /** Every pending provider approval, oldest (the one on the card) first. */
  approvalIds: readonly string[];
  /** Requests whose answer is already on its way. */
  respondingRequestIds: readonly string[];
  /** A provider question is pending. */
  hasQuestion: boolean;
}

export const NO_PENDING_REQUESTS: ComposerPendingRequests = {
  approvalIds: [],
  respondingRequestIds: [],
  hasQuestion: false
};

export type PendingRequestSendPlan =
  /** Nothing in the way: an ordinary send. */
  | { kind: "send" }
  /** Decline these approvals and steer the message in, as one command. */
  | { kind: "redirect"; declineApprovals: string[] }
  /** The text is the open question's answer. */
  | { kind: "answer-question" }
  /** Send nothing, and say why. */
  | { kind: "refuse"; reason: string };

/** The composer's hint while an approval is pending: what Send will do. */
export const REDIRECT_HINT = "Sending declines the pending request and redirects the agent.";

/** The composer's hint while a question is pending. */
export const QUESTION_HINT = "Sending answers the question above.";

/** Why a redirect waited: the card's own answer is still on its way. */
export const APPROVAL_RESPONDING_REASON =
  "An approval is already being answered, so your message wasn't sent. Send it again in a moment.";

/** Why a draft with files cannot answer a question: the card holds an answer's attachments. */
export const QUESTION_ATTACHMENTS_REASON =
  "Files can't go with an answer from here. Attach them to the answer on the question card.";

function isCompactCommand(text: string, attachmentCount: number): boolean {
  return attachmentCount === 0 && text.trim().toLowerCase() === "/compact";
}

/**
 * What sending `text` does now.
 *
 * - A `/goal …` the HOST applies itself (`hostParsesGoal`, goals §5.1) is an
 *   ordinary send whatever is pending: it starts no turn and answers nothing.
 * - Approvals pending: a redirect declining all of them — or a refusal while
 *   one of them is being answered from the card (T3: the user's own answer
 *   wins, and the message is not sent over it), or for a bare `/compact`,
 *   which would only wait behind the card it was meant to replace.
 * - A question pending (and no approval): the text answers it, unless the
 *   draft carries files the answer cannot take from here.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/chat/useComposerSend.ts
export function planPendingRequestSend(input: {
  pending: ComposerPendingRequests;
  text: string;
  attachmentCount: number;
  hostParsesGoal: boolean;
}): PendingRequestSendPlan {
  const { pending } = input;
  if (input.hostParsesGoal && isGoalCommandText(input.text)) return { kind: "send" };
  if (pending.approvalIds.length > 0) {
    if (pending.approvalIds.some((id) => pending.respondingRequestIds.includes(id))) {
      return { kind: "refuse", reason: APPROVAL_RESPONDING_REASON };
    }
    if (isCompactCommand(input.text, input.attachmentCount)) {
      return { kind: "refuse", reason: REDIRECT_COMPACT_REASON };
    }
    return { kind: "redirect", declineApprovals: [...pending.approvalIds] };
  }
  if (pending.hasQuestion) {
    return input.attachmentCount > 0
      ? { kind: "refuse", reason: QUESTION_ATTACHMENTS_REASON }
      : { kind: "answer-question" };
  }
  return { kind: "send" };
}

/** How the composer says what a send will do to the request in front of the user. */
export interface PendingRequestWording {
  /** The line under the field. */
  hint: string;
  placeholder: string;
  /** The send button's label and tooltip. */
  sendLabel: string;
}

/** The composer's wording while a request is docked, or `null` with none. */
export function pendingRequestWording(pending: ComposerPendingRequests): PendingRequestWording | null {
  if (pending.approvalIds.length > 0) {
    return {
      hint: REDIRECT_HINT,
      placeholder: "Tell the agent what to do instead…",
      sendLabel: "Decline the request and redirect the agent"
    };
  }
  if (pending.hasQuestion) {
    return {
      hint: QUESTION_HINT,
      placeholder: "Type an answer to the question above…",
      sendLabel: "Answer the question"
    };
  }
  return null;
}
