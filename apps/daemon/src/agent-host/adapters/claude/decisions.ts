/**
 * Claude adapter — approval decisions (spec §4.3, Claude's column).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts:312-331`
 * (`toSessionPermissionUpdates`) and `:4802-4823` (the decision mapping).
 *
 * | Decision | Claude |
 * |---|---|
 * | `accept` | `{behavior:"allow", updatedInput}` |
 * | `acceptForSession` | allow **+** `updatedPermissions` rescoped to `destination:"session"` |
 * | `acceptAlways` | **deny** — Claude has no permanent grant through `canUseTool` |
 * | `decline` | `{behavior:"deny", message:"User declined tool execution."}` |
 * | `cancel` | `{behavior:"deny", message:"User cancelled tool execution."}` |
 *
 * A decline that redirects — the user sent a message over the card — denies
 * with {@link APPROVAL_REDIRECT_MESSAGE}, so Claude reads the message that
 * follows as the new instruction rather than retrying the tool.
 */

import { stripVTControlCharacters } from "node:util";

import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision, ApprovalOption } from "@orquester/api/agent-chat";

import { APPROVAL_REDIRECT_MESSAGE } from "../../adapter.ts";

const DECLINE_MESSAGE = "User declined tool execution.";
const CANCEL_MESSAGE = "User cancelled tool execution.";
/**
 * `acceptAlways` has no expression through `canUseTool`. Denying with a plain
 * message would read to the model as a refusal of the work; this says what
 * actually happened so it can offer the session-scoped option instead.
 */
const ACCEPT_ALWAYS_UNSUPPORTED_MESSAGE =
  "Claude Code cannot grant a permanent permission from here. Use \"Always allow this session\" instead.";

/**
 * Permission updates applied for an "Always allow this session" decision.
 *
 * The CLI's own suggestions are reused when present but **rescoped to
 * `destination: "session"`**: echoing them verbatim would persist a
 * session-only choice as a permanent rule, because the first suggestion really
 * does target `localSettings`, i.e. `.claude/settings.local.json`
 * (fixtures/claude README observation 11). When the CLI offers no suggestion —
 * the live path for `AskUserQuestion` and `ExitPlanMode`, and common for MCP
 * tools — fall back to a whole-tool session allow rule so the decision still
 * sticks instead of silently degrading into a one-shot accept.
 */
export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined
): PermissionUpdate[] {
  const sessionScoped = (suggestions ?? []).map(
    (suggestion): PermissionUpdate => ({ ...suggestion, destination: "session" })
  );
  if (sessionScoped.length > 0) {
    return sessionScoped;
  }
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session"
    }
  ];
}

export function permissionResultForDecision(input: {
  decision: ApprovalDecision;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: readonly PermissionUpdate[];
  /** The decline redirects: the user's message follows it as a steer. */
  redirect?: boolean;
}): PermissionResult {
  const { decision, toolName, toolInput, suggestions } = input;
  if (decision === "decline" && input.redirect === true) {
    return { behavior: "deny", message: APPROVAL_REDIRECT_MESSAGE };
  }
  if (decision === "accept") {
    return { behavior: "allow", updatedInput: toolInput };
  }
  if (decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: toolInput,
      updatedPermissions: toSessionPermissionUpdates(toolName, suggestions)
    };
  }
  if (decision === "acceptAlways") {
    return { behavior: "deny", message: ACCEPT_ALWAYS_UNSUPPORTED_MESSAGE };
  }
  // Decline and cancel are two answers, not two labels for one: the agent
  // reads a decline as "do it another way" and a cancel as "stop this".
  return {
    behavior: "deny",
    message: decision === "cancel" ? CANCEL_MESSAGE : DECLINE_MESSAGE
  };
}

/** "Always allow" would grant more than this ask's own action, so only Approve and Decline. */
const NO_STANDING_GRANT_OPTIONS: ApprovalOption[] = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" }
];

/**
 * What the card says beside the request itself: why Claude asked
 * (`decisionReason` — an ask rule, a path outside the workspace, a safety
 * check), and the options when the CLI forbids a standing grant
 * (`suppressAlwaysAllowRule`). The reason is dropped when it only repeats
 * the card's detail, and is absent when Claude gives none.
 */
// Adapted from T3 Code (MIT): apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
export function claudeApprovalPresentation(input: {
  detail: string;
  callbackOptions: Pick<Parameters<CanUseTool>[2], "decisionReason" | "suppressAlwaysAllowRule">;
}): { reason?: string; options?: ApprovalOption[] } {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = stripVTControlCharacters(input.callbackOptions.decisionReason ?? "").trim();
  return {
    ...(reason === "" || reason === input.detail.trim() ? {} : { reason }),
    ...(input.callbackOptions.suppressAlwaysAllowRule === true
      ? { options: NO_STANDING_GRANT_OPTIONS.map((option) => ({ ...option })) }
      : {})
  };
}
