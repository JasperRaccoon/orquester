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
 */
export function derivePendingRequests(
  activities: readonly ThreadActivityItem[]
): PendingRequests {
  const approvals = new Map<string, PendingApproval>();
  const userInputs = new Map<string, PendingUserInput>();
  const closedApprovals = new Set<string>();
  const closedUserInputs = new Set<string>();

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
        closedApprovals.has(requestId) ||
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
        ...(options.length > 0 ? { options } : {})
      });
    } else if (activity.activityKind === "user-input.requested") {
      if (closedUserInputs.has(requestId)) {
        continue;
      }
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) {
        continue;
      }
      userInputs.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
        dismissible: payload.responseMode === "message"
      });
    } else if (
      activity.activityKind === "approval.resolved" ||
      (activity.activityKind === "provider.approval.respond.failed" &&
        isStaleRequestFailure("provider.approval.respond.failed", payload))
    ) {
      closedApprovals.add(requestId);
      approvals.delete(requestId);
    } else if (
      activity.activityKind === "user-input.resolved" ||
      (activity.activityKind === "provider.user-input.respond.failed" &&
        isStaleRequestFailure("provider.user-input.respond.failed", payload))
    ) {
      closedUserInputs.add(requestId);
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
