/**
 * The gate (unified MCP design 2026-10-15 §5.2, §5.4, §6): one pure, table-driven decision per
 * chat call — `allow`, a `card` (kind, family) or `deny` (code, the fix in words). The executor
 * (`../executor.ts`) gathers the facts (`./scope.ts`), asks here, and then looks for a grant or
 * opens the card through the `ApprovalPort`. External callers never reach this module: they are
 * full trust (address validation only).
 *
 * The matrix (§5.2), by the caller's permission mode — `full` = `full-access`, `trusted` = `auto`
 * or `full-access`:
 *
 * | Target                       | Read metadata          | Read content            | Act                         | Admin            |
 * |------------------------------|------------------------|-------------------------|-----------------------------|------------------|
 * | own project / global / none  | allow                  | allow                   | allow                       | card             |
 * | other project, same workspace| allow                  | trusted: allow · card   | full: allow · card          | card (no grant)  |
 * | other workspace              | full: allow · card     | full: allow · card      | card (grantable for full)   | card (no grant)  |
 *
 * A workspace-level target (`scope.workspaces`: data a workspace owns outside its projects) uses the
 * `own` row in the caller's own workspace and the `other workspace` row elsewhere, but is never
 * grantable: its Act card names no target project, and an Admin call reaching one is cross-project.
 * Like the Global row, it is only for user-visible, undoable data (todo lists); anything affecting
 * other projects' sessions or execution (the workspace git identity, its settings) is Admin instead.
 *
 * Over it: Admin is a card in EVERY mode (ruling S1), refused while planning, and
 * `ADMIN_NOT_AVAILABLE` for a workflow-owned caller at once; a workflow-owned caller's every card
 * becomes a denial, and its cross-project Act is denied in every mode (§5.4); while planning, a
 * data-changing Act is refused unless `planSafe` (a turn-causing Act carries the plan on, §5.3);
 * a path outside a project, a refused self target and a target that is not an own child are
 * denied before anything else. Grant options are the executor's (`grantOptionsFor`).
 */

import { RUNTIME_MODES, type RuntimeMode } from "@orquester/api/agent-chat";
import type { AdminFamily, ApprovalFamily } from "@orquester/api";

import { clipText, MAX_ECHO_CHARS } from "../result.ts";
import type { ScopeClaim, ThreadCaller, Tier } from "../catalog/contract.ts";

/** Where a target project lies relative to the caller (§5.2). Global targets and calls naming none are `own`. */
export type TargetClass = "own" | "same-workspace" | "other-workspace";

export interface GateTarget {
  /** Canonical project path. */
  project: string;
  workspace: string;
  class: TargetClass;
}

/** What the executor learned about the call before asking the gate. */
export interface GateInput {
  tool: string;
  /** The tier of THIS call (a per-call tier already resolved). */
  tier: Tier;
  /** The Admin family of this call (resolved), when the tier is `admin`. */
  adminFamily?: AdminFamily;
  planSafe: boolean;
  caller: ThreadCaller;
  scope: ScopeClaim;
  /** Every project the call reaches: `scope.projects`, the projects of `scope.paths`, classified. */
  targets: readonly GateTarget[];
  /** `scope.pendingProjects`, classified by workspace (a project not created yet is never `own`). */
  pendingTargets: readonly { workspace: string; class: Exclude<TargetClass, "own"> }[];
  /** `scope.unknownProjects`: no project now, so unclassifiable — a card in every mode, never grantable. */
  unknownTargets: readonly string[];
  /**
   * `scope.workspaces` (workspace-level data, outside any project), classified: the caller's own
   * workspace reads as `own`, any other (or every one, for a caller bound to no project) as
   * `other-workspace` — the matrix's row for it applies (S13).
   */
  workspaceTargets: readonly { workspace: string; class: "own" | "other-workspace" }[];
  /** `scope.paths` that lie inside no project (ruling S6). */
  deniedPaths: readonly string[];
  /** `scope.sessions` that are not the caller's own children, when `scope.ownChildrenOnly` is set. */
  notOwnChildren: readonly string[];
}

export type GateDenyCode = "PERMISSION_DENIED" | "ADMIN_NOT_AVAILABLE";

export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; code: GateDenyCode; message: string }
  | {
      kind: "card";
      approvalKind: "admin" | "boundary";
      family: ApprovalFamily;
      /** Admin: the call reaches a project other than the caller's own (never grantable). */
      crossProject: boolean;
      /** `cross-project` Act: the single other-workspace project a grant would be for; absent → no grant. */
      targetProjectPath?: string;
      /** Why a card is needed, in words for the card and the log. */
      reason: string;
    };

type Access = "metadata" | "content" | "act";

/**
 * The narrowest caller mode that needs NO card, per target class and access; `null`: always a card
 * (§5.2). Modes widen in `RUNTIME_MODES` order: approval-required < auto-accept-edits < auto <
 * full-access.
 */
export const NO_CARD_FROM: Readonly<Record<TargetClass, Readonly<Record<Access, RuntimeMode | null>>>> = {
  own: { metadata: "approval-required", content: "approval-required", act: "approval-required" },
  "same-workspace": { metadata: "approval-required", content: "auto", act: "full-access" },
  "other-workspace": { metadata: "full-access", content: "full-access", act: null }
};

/** The card family when {@link NO_CARD_FROM} asks for a card. */
const CARD_FAMILY: Readonly<Record<Exclude<TargetClass, "own">, Readonly<Record<Access, ApprovalFamily>>>> = {
  "same-workspace": { metadata: "cross-project-read", content: "cross-project-read", act: "cross-project" },
  "other-workspace": { metadata: "cross-workspace-read", content: "cross-workspace-read", act: "cross-project" }
};

/** A permission mode's breadth; an unknown mode is the narrowest (fail closed). */
function breadth(mode: RuntimeMode): number {
  const index = RUNTIME_MODES.indexOf(mode);
  return index === -1 ? -1 : index;
}

function needsCard(targetClass: TargetClass, access: Access, mode: RuntimeMode): boolean {
  const from = NO_CARD_FROM[targetClass][access];
  return from === null || breadth(mode) < breadth(from);
}

const deny = (code: GateDenyCode, message: string): GateDecision => ({ kind: "deny", code, message });

const WORKFLOW_OWNED = "This chat runs inside an automated workflow, where nobody can approve";

/** The gate. Pure: every fact it needs is in `input`. */
export function gate(input: GateInput): GateDecision {
  const { caller, scope, tool } = input;
  if (input.deniedPaths.length > 0) {
    const path = clipText(input.deniedPaths[0]!, MAX_ECHO_CHARS);
    return deny("PERMISSION_DENIED", `"${path}" is not inside a project: paths must lie inside a project directory ("<workspace>/<project>/…", list_projects).`);
  }
  if (scope.self === "refuse" && scope.sessions.includes(caller.threadId)) {
    return deny("PERMISSION_DENIED", `${tool} cannot target this chat itself.`);
  }
  if (input.notOwnChildren.length > 0) {
    return deny("PERMISSION_DENIED", scope.ownChildrenOnly ?? `${tool} acts only on chats this chat created.`);
  }

  // Admin (§6): a card in every permission mode; never while planning; never for a workflow-owned chat.
  if (input.tier === "admin") {
    if (caller.workflowOwned) {
      return deny("ADMIN_NOT_AVAILABLE", `${WORKFLOW_OWNED} ${tool}: it is not available here. Say what you need in your final reply instead.`);
    }
    if (caller.planning) {
      return deny("PERMISSION_DENIED", `You are planning: ${tool} makes a change that needs the user's approval. Propose it in your plan instead.`);
    }
    if (input.adminFamily === undefined) {
      // A catalog tool whose Admin call names no family is a bug: never a card the user cannot judge.
      return deny("PERMISSION_DENIED", `${tool} is not available: it declares no approval family.`);
    }
    // Workspace-level data lies outside the caller's project wherever it is: never a grant.
    const crossProject = input.targets.some((target) => target.class !== "own") || input.pendingTargets.length > 0 || input.workspaceTargets.length > 0 || input.unknownTargets.length > 0;
    return {
      kind: "card",
      approvalKind: "admin",
      family: input.adminFamily,
      crossProject,
      reason: crossProject ? "a change outside this chat's project" : "a change that needs the user's approval"
    };
  }

  if (input.tier === "act" && caller.planning && !input.planSafe && scope.writes) {
    return deny("PERMISSION_DENIED", `You are planning: ${tool} changes data. Propose it in your plan instead.`);
  }

  // Workflow-owned callers never act across projects, in any mode (§5.4).
  const away = [
    ...input.targets.filter((target) => target.class !== "own"),
    ...input.pendingTargets,
    ...input.workspaceTargets.filter((target) => target.class !== "own")
  ];
  if (input.tier === "act" && caller.workflowOwned && (away.length > 0 || input.unknownTargets.length > 0)) {
    return deny("PERMISSION_DENIED", `${WORKFLOW_OWNED} work in another project: ${tool} may act only in this chat's own project.`);
  }

  // The cards the matrix asks for: Act first (it covers what the call reads), then reads.
  let actCard: Extract<GateDecision, { kind: "card" }> | null = null;
  if (input.tier === "act") {
    // A pending project or a workspace-level target names no project (`""`): its card is never grantable.
    const carded = [
      ...input.targets,
      ...input.pendingTargets.map((pending) => ({ project: "", ...pending })),
      ...input.workspaceTargets.map((target) => ({ project: "", ...target }))
    ].filter((target) => target.class !== "own" && needsCard(target.class, "act", caller.runtimeMode));
    if (input.unknownTargets.length > 0) {
      // Unclassifiable: a card in every mode, and never a grant (no single known target).
      actCard = { kind: "card", approvalKind: "boundary", family: "cross-project", crossProject: true, reason: "an action in a project that no longer exists" };
    } else if (carded.length > 0) {
      const single = carded.length === 1 && carded[0]!.class === "other-workspace" && carded[0]!.project !== "" ? carded[0]!.project : undefined;
      actCard = {
        kind: "card",
        approvalKind: "boundary",
        family: "cross-project",
        crossProject: true,
        ...(single !== undefined ? { targetProjectPath: single } : {}),
        reason: carded.some((target) => target.class === "other-workspace") ? "an action in another workspace" : "an action in another project"
      };
    }
  }
  let readCard: Extract<GateDecision, { kind: "card" }> | null = null;
  if (actCard === null && scope.reads !== "none") {
    const access: Access = scope.reads;
    const carded = [...input.targets, ...input.workspaceTargets].filter((target) => target.class !== "own" && needsCard(target.class, access, caller.runtimeMode));
    if (input.unknownTargets.length > 0) {
      readCard = { kind: "card", approvalKind: "boundary", family: CARD_FAMILY["other-workspace"][access], crossProject: true, reason: "reading a project that no longer exists" };
    } else if (carded.length > 0) {
      // The wider boundary names the card.
      const widest = carded.some((target) => target.class === "other-workspace") ? "other-workspace" : "same-workspace";
      readCard = {
        kind: "card",
        approvalKind: "boundary",
        family: CARD_FAMILY[widest][access],
        crossProject: true,
        reason: widest === "other-workspace" ? "reading another workspace's chats or files" : "reading another project's content"
      };
    }
  }
  const card = actCard ?? readCard;
  if (card === null) return { kind: "allow" };
  if (caller.workflowOwned) {
    return deny("PERMISSION_DENIED", `${WORKFLOW_OWNED} ${card.reason}: ${tool} may not do it here.`);
  }
  return card;
}
