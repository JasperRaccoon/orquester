/**
 * Agent chat — pending approvals and questions, derived from the activity fold
 * (spec §5.1, §6.2).
 *
 * **Signature only. Package W2 implements the body.**
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

import type { ProviderRequestKind } from "./runtime-events.ts";
import type { PendingRequests, ThreadActivityItem } from "./thread.ts";

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

/**
 * Reduce request state once for the host and every client. Layout stays with
 * each surface.
 */
export function derivePendingRequests(
  activities: readonly ThreadActivityItem[]
): PendingRequests {
  void activities;
  throw new Error("agent-chat: derivePendingRequests not implemented (package W2)");
}
