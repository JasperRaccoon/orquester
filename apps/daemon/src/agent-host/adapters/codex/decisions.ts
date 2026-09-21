/**
 * Codex adapter — approval decisions (spec §4.3, the Codex column).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2107, 2165, 2287-2294`.
 *
 * Three things reality changed (fixtures README observation 2):
 *
 * - `availableDecisions` **exists** on `item/commandExecution/requestApproval`
 *   and is the provider's own button set. It is a *presentation* hint, not a
 *   validation whitelist: `03-…` sends `decline`, `cancel` and
 *   `acceptForSession` — none of them advertised — and all three are honoured.
 *   So we render from it and never gate on it.
 * - The structured `{acceptWithExecpolicyAmendment}` arm is the nearest thing
 *   Codex has to §4.3's `acceptAlways`, and the server offers it first-class
 *   paired with `proposedExecpolicyAmendment`. The spec's "Codex downgrades
 *   `acceptAlways` to `acceptForSession`" would lose that, so `acceptAlways`
 *   takes the amendment when one is proposed and only then falls back to the
 *   documented downgrade.
 * - `item/fileChange/requestApproval` carries **no** `availableDecisions` and
 *   its enum has no amendment arms, so it always uses the default four.
 */

import type { ApprovalDecision, ApprovalOption } from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";

type CommandDecision = CodexProtocol.v2.CommandExecutionApprovalDecision;
type FileChangeDecision = CodexProtocol.v2.FileChangeApprovalDecision;

/**
 * The default set the UI shows when a provider advertises nothing (§4.3), in
 * T3's order: Cancel, Decline, Always allow this session, Approve.
 *
 * *T3: `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx:23-28`.*
 */
export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" }
] as const;

/** `decline` and `cancel` are two answers, not two labels for one (§4.3). */
export const FILE_CHANGE_APPROVAL_OPTIONS: readonly ApprovalOption[] = DEFAULT_APPROVAL_OPTIONS;

/**
 * Map one of our five decisions onto the command-approval enum.
 *
 * `acceptAlways` takes `{acceptWithExecpolicyAmendment}` when the server
 * proposed one ("allow this command shape permanently"), otherwise it is
 * downgraded to `acceptForSession` exactly as the spec says.
 */
export function toCommandDecision(
  decision: ApprovalDecision,
  proposedExecpolicyAmendment?: CodexProtocol.ExecPolicyAmendment | null
): CommandDecision {
  switch (decision) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "acceptAlways":
      if (proposedExecpolicyAmendment !== undefined && proposedExecpolicyAmendment !== null) {
        return {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: proposedExecpolicyAmendment
          }
        };
      }
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default: {
      const exhaustive: never = decision;
      void exhaustive;
      return "cancel";
    }
  }
}

/** The file-change enum has no amendment arms, so `acceptAlways` always downgrades. */
export function toFileChangeDecision(decision: ApprovalDecision): FileChangeDecision {
  switch (decision) {
    case "accept":
      return "accept";
    case "acceptForSession":
    case "acceptAlways":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default: {
      const exhaustive: never = decision;
      void exhaustive;
      return "cancel";
    }
  }
}

/**
 * MCP elicitation answers `{action, content, _meta}` — richer than the
 * `{decision}` the spec describes (fixtures README observation 12). Only
 * `accept` runs the tool; everything else is a refusal, and `cancel` is the
 * one the host issues when it settles an open request.
 */
export function toElicitationAction(
  decision: ApprovalDecision
): CodexProtocol.v2.McpServerElicitationAction {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return "accept";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default: {
      const exhaustive: never = decision;
      void exhaustive;
      return "cancel";
    }
  }
}

/**
 * `item/permissions/requestApproval` answers `{permissions, scope}`: approving
 * grants the requested profile, denying answers with an **empty** grant so the
 * app-server treats the permission as withheld, and `scope: "session"` is sent
 * only for `acceptForSession` (§4.5).
 */
export function toPermissionsResponse(
  decision: ApprovalDecision,
  requested: CodexProtocol.v2.RequestPermissionProfile
): CodexProtocol.v2.PermissionsRequestApprovalResponse {
  const allow =
    decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
  const granted: CodexProtocol.v2.GrantedPermissionProfile = allow
    ? {
        ...(requested.network !== null ? { network: requested.network } : {}),
        ...(requested.fileSystem !== null ? { fileSystem: requested.fileSystem } : {})
      }
    : {};
  return {
    permissions: granted,
    scope: decision === "acceptForSession" || decision === "acceptAlways" ? "session" : "turn"
  };
}

// ---------------------------------------------------------------------------
// availableDecisions → the UI's option set
// ---------------------------------------------------------------------------

const COMMAND_DECISION_LABELS: Readonly<Record<ApprovalDecision, string>> = {
  accept: "Approve",
  acceptForSession: "Always allow this session",
  acceptAlways: "Always allow this command",
  decline: "Decline",
  cancel: "Cancel"
};

/**
 * Turn the provider's advertised decisions into §4.3's per-request `options`.
 *
 * Both structured arms are mapped: `acceptWithExecpolicyAmendment` is the
 * permanent grant (our `acceptAlways`), and `applyNetworkPolicyAmendment` is
 * the managed-network equivalent, surfaced as `acceptForSession` with the
 * provider's own caution because it widens network policy.
 *
 * Returns `undefined` when nothing usable was advertised, which is the signal
 * for the UI to fall back to {@link DEFAULT_APPROVAL_OPTIONS}.
 */
export function approvalOptionsFromAvailableDecisions(
  available: readonly CommandDecision[] | null | undefined
): ApprovalOption[] | undefined {
  if (available === null || available === undefined || available.length === 0) {
    return undefined;
  }
  const seen = new Set<ApprovalDecision>();
  const options: ApprovalOption[] = [];
  for (const entry of available) {
    const mapped = availableDecisionToApproval(entry);
    if (mapped === undefined || seen.has(mapped.decision)) {
      continue;
    }
    seen.add(mapped.decision);
    options.push(mapped);
  }
  return options.length > 0 ? options : undefined;
}

function availableDecisionToApproval(entry: CommandDecision): ApprovalOption | undefined {
  if (typeof entry === "string") {
    switch (entry) {
      case "accept":
      case "acceptForSession":
      case "decline":
      case "cancel":
        return { decision: entry, label: COMMAND_DECISION_LABELS[entry] };
      default: {
        // A decision string this build does not know: surfaced by the caller as
        // a warning, never silently rendered as a wrong button.
        return undefined;
      }
    }
  }
  if ("acceptWithExecpolicyAmendment" in entry) {
    return {
      decision: "acceptAlways",
      label: COMMAND_DECISION_LABELS.acceptAlways,
      warning: "Allows every command matching this shape, in every future turn."
    };
  }
  if ("applyNetworkPolicyAmendment" in entry) {
    return {
      decision: "acceptForSession",
      label: "Allow this network access",
      warning: "Changes the network policy for the rest of this session."
    };
  }
  return undefined;
}

/**
 * True when `availableDecisions` held an arm this build does not understand —
 * the caller emits a `runtime.warning` rather than dropping it silently (§10).
 */
export function unknownAvailableDecisions(
  available: readonly CommandDecision[] | null | undefined
): string[] {
  if (available === null || available === undefined) {
    return [];
  }
  const unknown: string[] = [];
  for (const entry of available) {
    if (availableDecisionToApproval(entry) === undefined) {
      unknown.push(typeof entry === "string" ? entry : Object.keys(entry).join(","));
    }
  }
  return unknown;
}
