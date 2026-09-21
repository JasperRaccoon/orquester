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
 */

import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision } from "@orquester/api/agent-chat";

/**
 * Which of `canUseTool`'s three branches a tool takes (§4.5). Shared by the
 * live session and the fixture replay harness so a replay exercises the same
 * routing decision the adapter makes, rather than the harness's own copy of it.
 */
export type CanUseToolRoute = "user-input" | "proposed-plan" | "approval";

export function claudeCanUseToolRoute(toolName: string): CanUseToolRoute {
  if (toolName === "AskUserQuestion") {
    // Intercepted BEFORE any approval logic, in every runtime mode — plan mode
    // leans on it heavily.
    return "user-input";
  }
  if (toolName === "ExitPlanMode") {
    // The plan is a client-owned card, never the SDK's gate; it is captured
    // and then always denied.
    return "proposed-plan";
  }
  return "approval";
}

/**
 * The key the pending-request maps use. The SDK's own `requestId` is preferred
 * because it **redelivers** a request whose response was lost in a transport
 * gap, and a freshly minted key would open a second card for the same call
 * (fixtures/claude README observation 11).
 */
export function claudeRequestKey(
  requestId: string | undefined,
  fallback: () => string
): string {
  const trimmed = typeof requestId === "string" ? requestId.trim() : "";
  return trimmed.length > 0 ? trimmed : fallback();
}

export const DECLINE_MESSAGE = "User declined tool execution.";
export const CANCEL_MESSAGE = "User cancelled tool execution.";
/**
 * `acceptAlways` has no expression through `canUseTool`. Denying with a plain
 * message would read to the model as a refusal of the work; this says what
 * actually happened so it can offer the session-scoped option instead.
 */
export const ACCEPT_ALWAYS_UNSUPPORTED_MESSAGE =
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
}): PermissionResult {
  const { decision, toolName, toolInput, suggestions } = input;
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

/**
 * `full-access` short-circuits to allow with **no event at all** — nothing is
 * written to the timeline (§4.3). On this CLI `acceptEdits` and
 * `bypassPermissions` already silence `canUseTool` entirely
 * (fixtures README observation 2), so this is belt-and-braces rather than the
 * only gate.
 */
export function shouldShortCircuitToAllow(runtimeMode: string): boolean {
  return runtimeMode === "full-access";
}
