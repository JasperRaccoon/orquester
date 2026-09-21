/**
 * Codex adapter — permission modes and launch configuration (spec §4.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexSessionRuntime.ts:509-666`.
 *
 * Codex expresses the permission mode on **three** axes, and the turn-level
 * sandbox uses a different spelling from the thread-level one
 * (`readOnly`/`workspaceWrite`/`dangerFullAccess` vs
 * `read-only`/`workspace-write`/`danger-full-access`). Both spellings are here
 * so no caller has to remember which is which.
 *
 * `approvalsReviewer` is **always sent explicitly**, including on resume:
 * omitting it keeps the thread's previous reviewer and leaves `auto_review`
 * sticky after a mode switch (§4.4).
 */

import type { InteractionMode, RuntimeMode } from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";

export interface CodexThreadConfig {
  approvalPolicy: CodexProtocol.v2.AskForApproval;
  sandbox: CodexProtocol.v2.SandboxMode;
  approvalsReviewer: CodexProtocol.v2.ApprovalsReviewer;
}

/** §4.4, the Codex column. */
export function runtimeModeToThreadConfig(mode: RuntimeMode): CodexThreadConfig {
  switch (mode) {
    case "approval-required":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user"
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review"
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user"
      };
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    }
  }
}

/**
 * The per-turn sandbox policy, whose spelling differs from the thread one
 * (§4.4): `readOnly`/`workspaceWrite`/`dangerFullAccess` here against
 * `read-only`/`workspace-write`/`danger-full-access` on `thread/start`.
 *
 * `networkAccess` is false everywhere but full access, matching what
 * `thread/start` resolves to on this CLI (`sandbox: {type:"readOnly",
 * networkAccess:false}` in every capture). `writableRoots` stays empty so the
 * server keeps the thread's own runtime workspace roots rather than having
 * them replaced per turn.
 */
export function runtimeModeToTurnSandboxPolicy(
  mode: RuntimeMode
): CodexProtocol.v2.SandboxPolicy {
  switch (mode) {
    case "approval-required":
      return { type: "readOnly", networkAccess: false };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      };
    case "full-access":
      return { type: "dangerFullAccess" };
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      return { type: "readOnly", networkAccess: false };
    }
  }
}

/**
 * Normalise a skill mention to the `$name` Codex parses natively (§4.6.8).
 *
 * Invocation is `$name` on the wire for every provider and the adapter
 * translates — for Codex that translation is only this: the composer's skill
 * trigger is `\p{Sc}` (ANY currency symbol), because a `€`, `£` or `¥` key is
 * where `$` sits on a non-US layout, and the CLI understands `$` alone. A
 * currency AMOUNT (`€50`, `$1.5k`) is left as prose, and an unknown `$foo`
 * stays literal — the CLI decides, not us (§4.6.5 c).
 *
 * *Ported from T3 Code (MIT): `CodexSessionRuntime.ts:608-610`.*
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export function normaliseSkillMentions(text: string): string {
  return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}

/**
 * Plan mode on Codex 0.154.0 is **sticky thread state**, not a per-turn flag
 * (fixtures README observation 9): sending `collaborationMode` on turn A and
 * omitting it on turn B leaves the thread in plan mode forever. So the value
 * is sent on **every** turn, `{mode:"default"}` included.
 *
 * `developer_instructions: null` means "use the built-in instructions for the
 * selected mode". T3 builds and sends its own ~9 KB prompt; on this CLI that
 * would *replace* a maintained upstream one, so we send `null`.
 */
export function interactionModeToCollaborationMode(
  interactionMode: InteractionMode,
  settings: { model: string; effort?: string }
): CodexProtocol.CollaborationMode {
  return {
    mode: interactionMode === "plan" ? "plan" : "default",
    settings: {
      model: settings.model,
      reasoning_effort: settings.effort ?? null,
      developer_instructions: null
    }
  };
}
