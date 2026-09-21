/**
 * The OpenCode column of the §4.3 decision table and the §4.4 permission-mode
 * table — every row, asserted against the rules the adapter actually sends.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_MODES, type ApprovalDecision, type RuntimeMode } from "@orquester/api/agent-chat";

import {
  approvalOptionsFor,
  buildOpenCodePermissionRules,
  fromOpenCodePermissionReply,
  mapPermissionToRequestType,
  permissionDetail,
  toOpenCodePermissionReply,
  type OpenCodePermissionRuleset
} from "./ruleset.ts";

function ruleFor(
  rules: OpenCodePermissionRuleset,
  permission: string,
  pattern = "*"
): string | undefined {
  return rules.find((rule) => rule.permission === permission && rule.pattern === pattern)?.action;
}

// ---------------------------------------------------------------------------
// §4.3 — the decision mapping table, OpenCode column
// ---------------------------------------------------------------------------

test("§4.3: every decision maps to the reply the OpenCode column names", () => {
  const table: [ApprovalDecision, "once" | "always" | "reject"][] = [
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "reject"],
    ["cancel", "reject"]
  ];
  for (const [decision, expected] of table) {
    assert.equal(toOpenCodePermissionReply(decision), expected, `decision ${decision}`);
  }
});

test("§4.3: a reply that arrives from elsewhere maps back to a decision", () => {
  assert.equal(fromOpenCodePermissionReply("once"), "accept");
  assert.equal(fromOpenCodePermissionReply("always"), "acceptForSession");
  assert.equal(fromOpenCodePermissionReply("reject"), "decline");
});

test("§4.3: `Allow for workspace` warns, and names the pattern it widens", () => {
  const options = approvalOptionsFor({
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["echo hi"],
    always: ["echo *"]
  });
  const workspace = options.find((option) => option.decision === "acceptForSession");
  assert.equal(workspace?.label, "Allow for workspace");
  assert.match(String(workspace?.warning), /echo \*/);
  assert.match(String(workspace?.warning), /every OpenCode session in this workspace/);
});

test("§4.3: the card falls back to the default four when the ask names no patterns", () => {
  const options = approvalOptionsFor({
    id: "per_1",
    sessionID: "ses_1",
    permission: "webfetch",
    patterns: []
  });
  assert.deepEqual(
    options.map((option) => option.decision),
    ["accept", "acceptForSession", "decline", "cancel"]
  );
  const workspace = options.find((option) => option.decision === "acceptForSession");
  assert.match(String(workspace?.warning), /other OpenCode sessions in this workspace/);
});

test("§4.3: a permission maps to a canonical request type", () => {
  assert.equal(mapPermissionToRequestType("read"), "file_read_approval");
  assert.equal(mapPermissionToRequestType("edit"), "file_change_approval");
  assert.equal(mapPermissionToRequestType("bash"), "command_execution_approval");
  // Every other OpenCode permission still needs an actionable card.
  assert.equal(mapPermissionToRequestType("doom_loop"), "command_execution_approval");
  assert.equal(mapPermissionToRequestType("external_directory"), "command_execution_approval");
});

test("a bash ask shows its command; anything else shows the permission name", () => {
  assert.equal(
    permissionDetail({
      id: "p",
      sessionID: "s",
      permission: "bash",
      patterns: ["echo hi", "*"]
    }),
    "echo hi"
  );
  assert.equal(
    permissionDetail({
      id: "p",
      sessionID: "s",
      permission: "external_directory",
      patterns: ["/etc"]
    }),
    "external directory\n/etc"
  );
});

// ---------------------------------------------------------------------------
// §4.4 — the permission-mode table, OpenCode column
// ---------------------------------------------------------------------------

test("§4.4 full access: `*`→allow plus an explicit external_directory allow", () => {
  const rules = buildOpenCodePermissionRules("full-access");
  assert.deepEqual(rules, [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" }
  ]);
});

test("§4.4 supervised: `*`→ask, reads allow except `.env`", () => {
  const rules = buildOpenCodePermissionRules("approval-required");
  assert.equal(ruleFor(rules, "*"), "ask");
  assert.equal(ruleFor(rules, "read"), "allow");
  assert.equal(ruleFor(rules, "read", "*.env"), "ask");
  assert.equal(ruleFor(rules, "read", "*.env.*"), "ask");
  assert.equal(ruleFor(rules, "read", "*.env.example"), "allow");
  assert.equal(ruleFor(rules, "edit"), "ask");
});

test("§4.4 accept edits: the SAME list, with `edit`→allow", () => {
  const supervised = buildOpenCodePermissionRules("approval-required");
  const acceptEdits = buildOpenCodePermissionRules("auto-accept-edits");
  assert.equal(ruleFor(acceptEdits, "edit"), "allow");
  assert.equal(supervised.length, acceptEdits.length);
  for (let index = 0; index < supervised.length; index += 1) {
    const left = supervised[index];
    const right = acceptEdits[index];
    assert.equal(left?.permission, right?.permission);
    assert.equal(left?.pattern, right?.pattern);
    if (left?.permission !== "edit") {
      assert.equal(left?.action, right?.action, `rule ${index} (${String(left?.permission)})`);
    }
  }
});

test("§4.4 auto: falls back to Supervised, by deliberate choice and not by omission", () => {
  assert.deepEqual(
    buildOpenCodePermissionRules("auto"),
    buildOpenCodePermissionRules("approval-required")
  );
});

test("§4.4: the read-only and always-allowed tools are exactly the documented set", () => {
  const rules = buildOpenCodePermissionRules("approval-required");
  for (const permission of ["glob", "grep", "lsp", "skill", "todowrite", "question"]) {
    assert.equal(ruleFor(rules, permission), "allow", `${permission} must be allowed`);
  }
  for (const permission of [
    "bash",
    "webfetch",
    "websearch",
    "codesearch",
    "external_directory",
    "doom_loop"
  ]) {
    assert.equal(ruleFor(rules, permission), "ask", `${permission} must ask`);
  }
});

test("every RuntimeMode produces a usable ruleset", () => {
  for (const mode of RUNTIME_MODES as readonly RuntimeMode[]) {
    const rules = buildOpenCodePermissionRules(mode);
    assert.ok(rules.length > 0, `mode ${mode}`);
    for (const rule of rules) {
      assert.ok(["allow", "ask", "deny"].includes(rule.action));
      assert.ok(rule.permission.length > 0);
      assert.ok(rule.pattern.length > 0);
    }
  }
});
