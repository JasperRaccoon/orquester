/**
 * The gate matrix (unified MCP design 2026-10-15 §14.2.2): tier × permission mode × planning ×
 * workflow-owned × target class (own / same workspace / other workspace / global / path outside a
 * project) × read class × own child × self → allow / card(kind, family) / deny(code).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_MODES, type RuntimeMode } from "@orquester/api/agent-chat";

import type { ScopeClaim, ThreadCaller, Tier } from "../catalog/contract.ts";
import { gate, type GateDecision, type GateInput, type GateTarget, type TargetClass } from "./policy.ts";

const OWN: GateTarget = { project: "/w/acme/api", workspace: "acme", class: "own" };
const SAME: GateTarget = { project: "/w/acme/web", workspace: "acme", class: "same-workspace" };
const OTHER: GateTarget = { project: "/w/beta/app", workspace: "beta", class: "other-workspace" };
const TARGETS: Record<TargetClass | "global", GateTarget[]> = { own: [OWN], "same-workspace": [SAME], "other-workspace": [OTHER], global: [] };

function caller(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Me", projectPath: "/w/acme/api", workspace: "acme", cwd: "/w/acme/api", agentId: "claude", callId: "c",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

function scope(over: Partial<ScopeClaim> = {}): ScopeClaim {
  return { projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [], ...over };
}

function input(over: Partial<GateInput> & { tier: Tier }): GateInput {
  return { tool: "t", planSafe: false, caller: caller(), scope: scope(), targets: [], pendingTargets: [], unknownTargets: [], workspaceTargets: [], deniedPaths: [], notOwnChildren: [], ...over };
}

/** A decision as a short string: `allow`, `card:<kind>:<family>`, `deny:<code>`. */
function short(decision: GateDecision): string {
  if (decision.kind === "allow") return "allow";
  if (decision.kind === "deny") return `deny:${decision.code}`;
  return `card:${decision.approvalKind}:${decision.family}`;
}

const ALLOW = "allow";
const CARD_XWS_READ = "card:boundary:cross-workspace-read";
const CARD_XP_READ = "card:boundary:cross-project-read";
const CARD_XP_ACT = "card:boundary:cross-project";

/** The §5.2 matrix, written out per mode: [approval-required, auto-accept-edits, auto, full-access]. */
const MATRIX: Record<"metadata" | "content" | "act", Record<TargetClass | "global", string[]>> = {
  metadata: {
    own: [ALLOW, ALLOW, ALLOW, ALLOW],
    global: [ALLOW, ALLOW, ALLOW, ALLOW],
    "same-workspace": [ALLOW, ALLOW, ALLOW, ALLOW],
    "other-workspace": [CARD_XWS_READ, CARD_XWS_READ, CARD_XWS_READ, ALLOW]
  },
  content: {
    own: [ALLOW, ALLOW, ALLOW, ALLOW],
    global: [ALLOW, ALLOW, ALLOW, ALLOW],
    "same-workspace": [CARD_XP_READ, CARD_XP_READ, ALLOW, ALLOW],
    "other-workspace": [CARD_XWS_READ, CARD_XWS_READ, CARD_XWS_READ, ALLOW]
  },
  act: {
    own: [ALLOW, ALLOW, ALLOW, ALLOW],
    global: [ALLOW, ALLOW, ALLOW, ALLOW],
    "same-workspace": [CARD_XP_ACT, CARD_XP_ACT, CARD_XP_ACT, ALLOW],
    "other-workspace": [CARD_XP_ACT, CARD_XP_ACT, CARD_XP_ACT, CARD_XP_ACT]
  }
};

test("the §5.2 matrix: reads and acts by target class and permission mode", () => {
  assert.deepEqual([...RUNTIME_MODES], ["approval-required", "auto-accept-edits", "auto", "full-access"]);
  for (const [access, rows] of Object.entries(MATRIX)) {
    for (const [target, expected] of Object.entries(rows)) {
      RUNTIME_MODES.forEach((mode, index) => {
        const decision = gate(
          input({
            tier: access === "act" ? "act" : "read",
            caller: caller({ runtimeMode: mode }),
            scope: scope({ reads: access === "act" ? "none" : (access as "metadata" | "content"), writes: access === "act" }),
            targets: TARGETS[target as TargetClass | "global"]
          })
        );
        assert.equal(short(decision), expected[index], `${access} × ${target} × ${mode}`);
      });
    }
  }
});

test("Admin: a card in EVERY permission mode, cross-project marked, never while planning, never for a workflow-owned chat", () => {
  for (const mode of RUNTIME_MODES) {
    for (const [target, targets] of Object.entries(TARGETS)) {
      const decision = gate(input({ tier: "admin", adminFamily: "desktops", caller: caller({ runtimeMode: mode }), targets }));
      assert.equal(short(decision), "card:admin:desktops", `${target} × ${mode}`);
      assert.equal(decision.kind === "card" && decision.crossProject, target === "same-workspace" || target === "other-workspace", `${target} crossProject`);
    }
    const planning = gate(input({ tier: "admin", adminFamily: "workflows", caller: caller({ runtimeMode: mode, planning: true }), targets: [OWN] }));
    assert.equal(short(planning), "deny:PERMISSION_DENIED");
    assert.match((planning as { message: string }).message, /planning/);
    const owned = gate(input({ tier: "admin", adminFamily: "workflows", caller: caller({ runtimeMode: mode, workflowOwned: true, planning: true }), targets: [OWN] }));
    assert.equal(short(owned), "deny:ADMIN_NOT_AVAILABLE", "workflow-owned wins over planning: never a card");
  }
  // A temp project not created yet is never the caller's own.
  const pending = gate(input({ tier: "admin", adminFamily: "workflows", targets: [OWN], pendingTargets: [{ workspace: "acme", class: "same-workspace" }] }));
  assert.equal(pending.kind === "card" && pending.crossProject, true);
  // An Admin call that names no family is refused, never a card the user cannot judge.
  assert.equal(short(gate(input({ tier: "admin", targets: [OWN] }))), "deny:PERMISSION_DENIED");
});

test("workflow-owned callers: every card becomes a denial; cross-project Act is denied in every mode; own-project work is allowed", () => {
  for (const mode of RUNTIME_MODES) {
    const who = caller({ runtimeMode: mode, workflowOwned: true });
    assert.equal(short(gate(input({ tier: "act", caller: who, scope: scope({ writes: true }), targets: [OWN] }))), ALLOW, mode);
    assert.equal(short(gate(input({ tier: "read", caller: who, scope: scope({ reads: "content" }), targets: [OWN] }))), ALLOW, mode);
    assert.equal(short(gate(input({ tier: "act", caller: who, scope: scope({ writes: true }), targets: [SAME] }))), "deny:PERMISSION_DENIED", `act same ${mode}`);
    assert.equal(short(gate(input({ tier: "act", caller: who, scope: scope({ writes: true }), targets: [OTHER] }))), "deny:PERMISSION_DENIED", `act other ${mode}`);
    assert.equal(short(gate(input({ tier: "act", caller: who, pendingTargets: [{ workspace: "acme", class: "same-workspace" }] }))), "deny:PERMISSION_DENIED");
    const read = short(gate(input({ tier: "read", caller: who, scope: scope({ reads: "content" }), targets: [OTHER] })));
    assert.equal(read, mode === "full-access" ? ALLOW : "deny:PERMISSION_DENIED", `read other ${mode}`);
  }
});

test("plan mode: reads allowed; turn-causing Act carries on; data-changing Act refused unless planSafe", () => {
  const planner = caller({ planning: true, runtimeMode: "full-access" });
  assert.equal(short(gate(input({ tier: "read", caller: planner, scope: scope({ reads: "content" }), targets: [OWN] }))), ALLOW);
  assert.equal(short(gate(input({ tier: "act", caller: planner, scope: scope({ causesTurnIn: ["x"] }), targets: [OWN] }))), ALLOW);
  assert.equal(short(gate(input({ tier: "act", caller: planner, scope: scope({ writes: true }), targets: [OWN] }))), "deny:PERMISSION_DENIED");
  assert.equal(short(gate(input({ tier: "act", planSafe: true, caller: planner, scope: scope({ writes: true }), targets: [OWN] }))), ALLOW);
});

test("paths outside a project, self targets and not-own children are refused before anything else", () => {
  const full = caller({ runtimeMode: "full-access" });
  const outside = gate(input({ tier: "read", caller: full, deniedPaths: ["/w/acme"] }));
  assert.equal(short(outside), "deny:PERMISSION_DENIED");
  assert.match((outside as { message: string }).message, /inside a project/);
  assert.equal(short(gate(input({ tier: "act", caller: full, scope: scope({ sessions: ["me"], self: "refuse" }) }))), "deny:PERMISSION_DENIED");
  assert.equal(short(gate(input({ tier: "act", caller: full, scope: scope({ sessions: ["me"], self: "allow" }) }))), ALLOW);
  assert.equal(short(gate(input({ tier: "act", caller: full, scope: scope({ sessions: ["other"], self: "refuse" }) }))), ALLOW);
  const notChild = gate(input({ tier: "act", caller: full, scope: scope({ sessions: ["c2"], ownChildrenOnly: "Only chats you created." }), notOwnChildren: ["c2"] }));
  assert.deepEqual(notChild, { kind: "deny", code: "PERMISSION_DENIED", message: "Only chats you created." });
  assert.equal(short(gate(input({ tier: "act", caller: full, scope: scope({ sessions: ["c2"], ownChildrenOnly: "x" }), notOwnChildren: [] }))), ALLOW);
  // Even Admin: an outside path is refused, not carded.
  assert.equal(short(gate(input({ tier: "admin", adminFamily: "desktops", caller: full, deniedPaths: ["/etc"] }))), "deny:PERMISSION_DENIED");
});

test("cards: Act covers what it reads; the wider boundary names a read card; a grantable cross-project card names its one target", () => {
  const auto = caller({ runtimeMode: "auto" });
  const actAndRead = gate(input({ tier: "act", caller: auto, scope: scope({ reads: "content", causesTurnIn: ["x"] }), targets: [SAME] }));
  assert.equal(short(actAndRead), CARD_XP_ACT);
  assert.equal((actAndRead as { targetProjectPath?: string }).targetProjectPath, undefined, "same workspace: no grant target");
  const both = gate(input({ tier: "read", caller: caller(), scope: scope({ reads: "content" }), targets: [SAME, OTHER] }));
  assert.equal(short(both), CARD_XWS_READ);
  const full = caller({ runtimeMode: "full-access" });
  const one = gate(input({ tier: "act", caller: full, targets: [OTHER] }));
  assert.equal((one as { targetProjectPath?: string }).targetProjectPath, OTHER.project);
  const two = gate(input({ tier: "act", caller: full, targets: [OTHER, { ...OTHER, project: "/w/gamma/x", workspace: "gamma" }] }));
  assert.equal(short(two), CARD_XP_ACT);
  assert.equal((two as { targetProjectPath?: string }).targetProjectPath, undefined, "two targets: no single grant target");
});

test("an unknown permission mode is the narrowest: every boundary cards", () => {
  const odd = caller({ runtimeMode: "brand-new-mode" as RuntimeMode });
  assert.equal(short(gate(input({ tier: "read", caller: odd, scope: scope({ reads: "content" }), targets: [SAME] }))), CARD_XP_READ);
  assert.equal(short(gate(input({ tier: "act", caller: odd, targets: [SAME] }))), CARD_XP_ACT);
});

test("workspace-level targets (S13): own workspace = own row; another workspace = the other-workspace row (cards below Full access, Act always a card, never grantable)", () => {
  const own = [{ workspace: "acme", class: "own" as const }];
  const away = [{ workspace: "beta", class: "other-workspace" as const }];
  // Own workspace: allowed like the caller's own project, in every mode.
  assert.equal(short(gate(input({ tier: "read", scope: scope({ reads: "metadata" }), workspaceTargets: own }))), ALLOW);
  assert.equal(short(gate(input({ tier: "act", scope: scope({ writes: true }), workspaceTargets: own }))), ALLOW);
  // Another workspace: a read is a card below Full access (never a refusal), allowed in Full access.
  for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
    assert.equal(short(gate(input({ tier: "read", caller: caller({ runtimeMode: mode }), scope: scope({ reads: "metadata" }), workspaceTargets: away }))), CARD_XWS_READ, mode);
  }
  assert.equal(short(gate(input({ tier: "read", caller: caller({ runtimeMode: "full-access" }), scope: scope({ reads: "metadata" }), workspaceTargets: away }))), ALLOW);
  // An Act there is a card in every mode, naming no target project: never grantable.
  for (const mode of ["approval-required", "full-access"] as const) {
    const decision = gate(input({ tier: "act", caller: caller({ runtimeMode: mode }), scope: scope({ writes: true }), workspaceTargets: away }));
    assert.equal(short(decision), CARD_XP_ACT, mode);
    assert.equal(decision.kind === "card" ? decision.targetProjectPath : "?", undefined, "no target project: no grant");
  }
  // Admin reaching workspace-level data, even its own workspace's: cross-project (never granted).
  const admin = gate(input({ tier: "admin", adminFamily: "desktops", caller: caller({ runtimeMode: "full-access" }), workspaceTargets: own }));
  assert.equal(admin.kind === "card" && admin.crossProject, true);
  // A workflow-owned chat never acts there, and its read card is a denial.
  assert.equal(short(gate(input({ tier: "act", caller: caller({ workflowOwned: true, runtimeMode: "full-access" }), scope: scope({ writes: true }), workspaceTargets: away }))), "deny:PERMISSION_DENIED");
  assert.equal(short(gate(input({ tier: "read", caller: caller({ workflowOwned: true }), scope: scope({ reads: "metadata" }), workspaceTargets: away }))), "deny:PERMISSION_DENIED");
});

test("an unknown project (a stored path that is no project now): a boundary card in every mode, never a grant target; Admin cross-project; workflow-owned refused", () => {
  const unknownTargets = ["/w/acme/gone"];
  for (const mode of RUNTIME_MODES) {
    const act = gate(input({ tier: "act", caller: caller({ runtimeMode: mode }), scope: scope({ writes: true, unknownProjects: unknownTargets }), unknownTargets }));
    assert.equal(short(act), CARD_XP_ACT, mode);
    assert.ok(act.kind === "card" && act.crossProject && act.targetProjectPath === undefined, mode);
    const admin = gate(input({ tier: "admin", adminFamily: "saved-prompts", caller: caller({ runtimeMode: mode }), scope: scope({ writes: true }), unknownTargets }));
    assert.ok(admin.kind === "card" && admin.approvalKind === "admin" && admin.crossProject, mode);
    assert.equal(short(gate(input({ tier: "read", caller: caller({ runtimeMode: mode }), scope: scope({ reads: "metadata" }), unknownTargets }))), CARD_XWS_READ, mode);
  }
  assert.equal(short(gate(input({ tier: "act", caller: caller({ runtimeMode: "full-access", workflowOwned: true }), scope: scope({ writes: true }), unknownTargets }))), "deny:PERMISSION_DENIED");
});
