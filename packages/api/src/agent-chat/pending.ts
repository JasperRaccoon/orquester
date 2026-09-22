/**
 * Agent chat — pending approvals and questions, derived from the activity fold
 * (spec §5.1, §6.2).
 *
 * Ported from T3 Code (MIT): `packages/client-runtime/src/pendingRequests.ts`.
 *
 * Rules the implementation owes:
 * - the fold keeps a **tombstone set**: a `*.resolved` row — including the
 *   `user-input.resolved` row `/dismiss` appends — closes the request id
 *   permanently, so a `*.requested` row arriving out of order can never
 *   reopen it;
 * - a `provider.*.respond.failed` row closes a request **only** when its
 *   detail says the request was stale or unknown; any other failure leaves it
 *   open so the user can retry;
 * - a question with no decodable option and no custom-answer flag is dropped
 *   rather than shown as an unanswerable card.
 */

import type { ProviderRequestKind, UserInputQuestion } from "./runtime-events.ts";
import type {
  PendingApproval,
  PendingRequests,
  PendingUserInput,
  ThreadActivityItem
} from "./thread.ts";
import type { ApprovalOption } from "./runtime-events.ts";

/** The six activity kinds `derivePendingRequests` reads. *T3: `pendingRequests.ts:89-96`.* */
export const REQUEST_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed"
]);

/**
 * Rewrite a native request type to the canonical approval kind (§5.1). Both
 * the canonical kind and the raw `requestType` are persisted, so a row written
 * by an older adapter is still classifiable.
 *
 * *T3: `pendingRequests.ts:48-65` (`requestKindFromRequestType`).*
 */
export function requestKindFromRequestType(requestType: unknown): ProviderRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    case "permission_approval":
      return "permission";
    default:
      return null;
  }
}

const PROVIDER_REQUEST_KINDS: ReadonlySet<string> = new Set<ProviderRequestKind>([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission"
]);

const APPROVAL_DECISIONS: ReadonlySet<string> = new Set([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel"
]);

/**
 * The server reports a stale or unknown request through the failure text. A
 * failed reply with any other text stays open so the user can retry.
 *
 * *T3: `pendingRequests.ts:98-112`.*
 */
const STALE_REQUEST_FAILURE_DETAILS = {
  "provider.approval.respond.failed": [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending codex approval request"
  ],
  "provider.user-input.respond.failed": [
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request"
  ]
} as const;

type StaleFailureKind = keyof typeof STALE_REQUEST_FAILURE_DETAILS;

function isStaleRequestFailure(
  kind: StaleFailureKind,
  payload: Record<string, unknown>
): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return STALE_REQUEST_FAILURE_DETAILS[kind].some((fragment) => detail.includes(fragment));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isApprovalOption(value: unknown): value is ApprovalOption {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  if (typeof record.decision !== "string" || !APPROVAL_DECISIONS.has(record.decision)) {
    return false;
  }
  if (typeof record.label !== "string") {
    return false;
  }
  return record.warning === undefined || typeof record.warning === "string";
}

/**
 * Decode the structured questions of a `user-input.requested` row, dropping
 * any question with no usable option and no custom-answer flag rather than
 * showing an unanswerable card.
 *
 * Native question ids and option labels can be answer keys — they are NOT
 * trimmed or normalised anywhere (§4.5: Claude looks answers up by text).
 *
 * *T3: `pendingRequests.ts:67-87` (`parseQuestions`).*
 */
export function parseQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const questions: UserInputQuestion[] = [];
  for (const entry of value) {
    const question = asRecord(entry);
    if (!question || !Array.isArray(question.options)) {
      continue;
    }
    const options: UserInputQuestion["options"] = [];
    for (const optionValue of question.options) {
      const option = asRecord(optionValue);
      if (!option || typeof option.label !== "string") {
        continue;
      }
      options.push({
        label: option.label,
        description: typeof option.description === "string" ? option.description : "",
        ...(typeof option.value === "string" ? { value: option.value } : {})
      });
    }
    if (options.length === 0 && question.allowCustomAnswer === false) {
      continue;
    }
    if (
      typeof question.id !== "string" ||
      typeof question.header !== "string" ||
      typeof question.question !== "string"
    ) {
      continue;
    }
    questions.push({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
      ...(typeof question.allowCustomAnswer === "boolean"
        ? { allowCustomAnswer: question.allowCustomAnswer }
        : {})
    });
  }
  return questions;
}

/**
 * Reduce request state once for the host and every client. Layout stays with
 * each surface.
 *
 * Request ids are unique, so a terminal row stays final even when provider
 * sequences and host-generated activities arrive in a different order.
 *
 * **Tombstones are ORDER-AWARE.** A resolution closes the request that
 * *precedes* it; a request that arrives *after* it is a different request and
 * opens fresh. Both halves are load-bearing and each one is a shipped bug:
 * - without the closing half, a `*.resolved` row that aged out of the 500-row
 *   retention window stopped closing its request, so a replayed `*.requested`
 *   reopened a dead card and the provider rejected the answer (R5 #4);
 * - without the opening half, a provider that RECYCLES a request id had its
 *   new request swallowed by the old tombstone. Codex mints
 *   `codex-<threadId>-<n>` from a per-provider-session counter, but a thread
 *   outlives its provider sessions: after a restart and a `thread/resume` the
 *   counter restarted at 1 and a real file-change approval was deleted by a
 *   resolution from minutes earlier — no card, no attention flag, composer
 *   unblocked, and the provider blocked forever (E2E R2-1).
 *
 * Inside `activities` the list order decides, so a resolution simply removes
 * whatever is open and a later row re-opens. `closed` covers the ids whose
 * resolution is no longer IN the list; `closedAt` carries when that resolution
 * happened, which is what lets a genuinely newer request through. A seed
 * without stamps stays conservative and closes unconditionally.
 */
export function derivePendingRequests(
  activities: readonly ThreadActivityItem[],
  options?: {
    readonly closed?: ReadonlySet<string>;
    readonly closedAt?: ReadonlyMap<string, string>;
  }
): PendingRequests {
  const approvals = new Map<string, PendingApproval>();
  const userInputs = new Map<string, PendingUserInput>();

  /**
   * The latest resolution seen for an id so far in THIS walk. Seeded
   * tombstones (whose closing row is no longer in the list) are consulted as a
   * fallback.
   */
  const resolvedAt = new Map<string, string>();

  /**
   * True when a tombstone covers this request row: a resolution for the same
   * id happened at or after it, so the row is that resolution's own request —
   * replayed, or seen out of order. A row stamped strictly later is a
   * different request that merely reuses the id, and must open.
   */
  const isClosed = (requestId: string, createdAt: string): boolean => {
    const inWalk = resolvedAt.get(requestId);
    if (inWalk !== undefined) {
      return createdAt <= inWalk;
    }
    if (options?.closed?.has(requestId) !== true) {
      return false;
    }
    // A seed with no stamp carries no ordering, so it closes unconditionally —
    // the conservative reading, and the one that predates the stamp map.
    const seeded = options.closedAt?.get(requestId);
    return seeded === undefined || createdAt <= seeded;
  };

  /** Record a resolution, keeping the latest stamp for a recycled id. */
  const noteResolved = (requestId: string, createdAt: string): void => {
    const known = resolvedAt.get(requestId);
    if (known === undefined || createdAt > known) {
      resolvedAt.set(requestId, createdAt);
    }
  };

  for (const activity of activities) {
    if (!REQUEST_ACTIVITY_KINDS.has(activity.activityKind)) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!payload || typeof payload.requestId !== "string" || payload.requestId.length === 0) {
      continue;
    }
    const requestId = payload.requestId;

    if (activity.activityKind === "approval.requested") {
      if (
        isClosed(requestId, activity.createdAt) ||
        // A question, not an approval (§5.1), and a token refresh is not a
        // user-facing decision at all.
        payload.requestType === "tool_user_input" ||
        payload.requestType === "auth_tokens_refresh"
      ) {
        continue;
      }
      const requestKind =
        typeof payload.requestKind === "string" && PROVIDER_REQUEST_KINDS.has(payload.requestKind)
          ? (payload.requestKind as ProviderRequestKind)
          : requestKindFromRequestType(payload.requestType);
      const options = Array.isArray(payload.options)
        ? payload.options.filter(isApprovalOption)
        : [];
      approvals.set(requestId, {
        requestId,
        // Older OpenCode approvals do not always carry a recognised kind.
        requestKind: requestKind ?? "command",
        createdAt: activity.createdAt,
        ...(typeof payload.detail === "string" && payload.detail
          ? { detail: payload.detail }
          : {}),
        ...(typeof payload.appName === "string" && payload.appName
          ? { appName: payload.appName }
          : {}),
        // Carries the join key to the card (E2E E7); absent on adapters that
        // do not know which call they are gating, which the card handles.
        ...(typeof payload.toolUseId === "string" && payload.toolUseId
          ? { toolUseId: payload.toolUseId }
          : {}),
        ...(options.length > 0 ? { options } : {})
      });
    } else if (activity.activityKind === "user-input.requested") {
      if (isClosed(requestId, activity.createdAt)) {
        continue;
      }
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) {
        continue;
      }
      // `responseMode` is promoted onto the entry (§6.2): the four behaviours
      // that branch on it — dismiss legality, the terminal-turn cleanup,
      // settle eligibility and the turn-pause gate — read one field rather
      // than each re-deriving it from the raw payload.
      const responseMode = payload.responseMode === "message" ? ("message" as const) : undefined;
      userInputs.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
        ...(responseMode !== undefined ? { responseMode } : {}),
        dismissible: responseMode === "message",
        turnId: activity.turnId
      });
    } else if (
      activity.activityKind === "approval.resolved" ||
      (activity.activityKind === "provider.approval.respond.failed" &&
        isStaleRequestFailure("provider.approval.respond.failed", payload))
    ) {
      // Closes whatever is open for this id, and records WHEN, so a later row
      // is judged by its stamp rather than its position (see the header).
      noteResolved(requestId, activity.createdAt);
      approvals.delete(requestId);
    } else if (
      activity.activityKind === "user-input.resolved" ||
      (activity.activityKind === "provider.user-input.respond.failed" &&
        isStaleRequestFailure("provider.user-input.respond.failed", payload))
    ) {
      noteResolved(requestId, activity.createdAt);
      userInputs.delete(requestId);
    }
  }

  const byCreatedAt = (
    left: { readonly createdAt: string },
    right: { readonly createdAt: string }
  ): number => left.createdAt.localeCompare(right.createdAt);

  return {
    approvals: [...approvals.values()].sort(byCreatedAt),
    userInputs: [...userInputs.values()].sort(byCreatedAt)
  };
}
