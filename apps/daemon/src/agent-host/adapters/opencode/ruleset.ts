/**
 * Agent host — OpenCode permission rules and decision mapping
 * (spec §4.3 and §4.4, the OpenCode column).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/opencodeRuntime.ts`
 * (`buildOpenCodePermissionRules`, `toOpenCodePermissionReply`) and
 * `apps/server/src/provider/Layers/OpenCodeAdapter.ts` (the request-type and
 * decision maps).
 */

import type {
  ApprovalDecision,
  ApprovalOption,
  CanonicalRequestType,
  RuntimeMode
} from "@orquester/api/agent-chat";

import type { OpenCodePermissionReply, OpenCodePermissionRequest } from "./protocol.ts";

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

export type OpenCodePermissionRuleset = OpenCodePermissionRule[];

/**
 * §4.4's OpenCode column, as a rule **list** — OpenCode has no
 * `edit`/`bash`/`webfetch` map.
 *
 * `"auto"` keeps asking by deliberate choice, not by omission: the documented
 * rule is that providers without an AI reviewer fall back to Supervised.
 * `edit` is `allow` **only** for `auto-accept-edits`.
 */
export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): OpenCodePermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" }
    ];
  }

  const editAction: "allow" | "ask" = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" }
  ];
}

/**
 * §4.3's OpenCode column. `acceptForSession` and `acceptAlways` both reply
 * `always`, which OpenCode persists **per directory, across every session on
 * this server** — which is why the option label says "workspace" and carries a
 * warning, and why a full-access auto-answer is never `always`.
 */
export function toOpenCodePermissionReply(decision: ApprovalDecision): OpenCodePermissionReply {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
      return "reject";
    default: {
      const exhaustive: never = decision;
      void exhaustive;
      return "reject";
    }
  }
}

/** The inverse, for a `permission.replied` frame the user did not raise here. */
export function fromOpenCodePermissionReply(reply: OpenCodePermissionReply): ApprovalDecision {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
      return "decline";
    default:
      return "decline";
  }
}

/** Every OpenCode permission needs an actionable approval card. */
export function mapPermissionToRequestType(permission: string): CanonicalRequestType {
  switch (permission) {
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "command_execution_approval";
  }
}

/**
 * The card's buttons. OpenCode advertises **no** options array of its own
 * (fixtures README observation 9), so the adapter supplies §4.3's set — with
 * the workspace warning naming the pattern an `always` would actually widen
 * (`echo *`, not `echo hi`), which `permission.asked.always` now carries.
 */
export function approvalOptionsFor(request: OpenCodePermissionRequest): ApprovalOption[] {
  const widened = (request.always ?? []).filter((pattern) => pattern.trim().length > 0);
  const warning =
    widened.length > 0
      ? `Applies to ${widened.join(", ")} in every OpenCode session in this workspace.`
      : "Applies to matching requests in other OpenCode sessions in this workspace.";
  return [
    { decision: "accept", label: "Allow once" },
    { decision: "acceptForSession", label: "Allow for workspace", warning },
    { decision: "decline", label: "Deny" },
    { decision: "cancel", label: "Cancel" }
  ];
}

/** What the approval card shows under the title. */
export function permissionDetail(request: OpenCodePermissionRequest): string {
  const patterns = request.patterns.filter((pattern) => pattern !== "*");
  if (request.permission === "bash" && patterns.length > 0) {
    return patterns.join("\n");
  }
  return [request.permission.replaceAll("_", " "), ...patterns].join("\n");
}
