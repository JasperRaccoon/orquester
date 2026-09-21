/**
 * The §4.3 decision-mapping table (Grok column) and the §4.4 permission-mode
 * table (Grok column), every row.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ApprovalDecision } from "@orquester/api/agent-chat";

import type { PermissionOption, RequestPermissionRequest } from "./acp/_generated/schema.ts";
import { autoApprovesEdits, autoApprovesEverything, grokSpawnArgs } from "./launch.ts";
import {
  approvalGrantKey,
  isEditApproval,
  permissionDetail,
  permissionRequestType,
  selectAutoApprovedOptionId,
  selectPermissionOptionId,
  stableStringify
} from "./permissions.ts";

/** Exactly what CLI 1.0.34 advertises for a file write, in its own order. */
const REAL_OPTIONS: PermissionOption[] = [
  { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" }
];

// ---------------------------------------------------------------------------
// §4.3 decision mapping — the Grok column
// ---------------------------------------------------------------------------

test("accept -> the allow_once option id", () => {
  assert.equal(selectPermissionOptionId(REAL_OPTIONS, "accept"), "allow-once");
});

test("acceptForSession -> allow_always when advertised", () => {
  // §4.3 says Grok advertises no options and T3 comments that `allow_always`
  // is "often omitted". 1.0.34 offers it, first.
  assert.equal(selectPermissionOptionId(REAL_OPTIONS, "acceptForSession"), "allow-edits-session");
});

test("acceptForSession -> allow_once when allow_always is absent", () => {
  const withoutAlways = REAL_OPTIONS.filter((option) => option.kind !== "allow_always");
  assert.equal(selectPermissionOptionId(withoutAlways, "acceptForSession"), "allow-once");
});

test("acceptAlways falls through to reject_once and is never surfaced", () => {
  assert.equal(selectPermissionOptionId(REAL_OPTIONS, "acceptAlways"), "reject-once");
});

test("decline -> the reject_once option id", () => {
  assert.equal(selectPermissionOptionId(REAL_OPTIONS, "decline"), "reject-once");
});

test("cancel selects nothing, so the reply is {outcome:{outcome:'cancelled'}}", () => {
  assert.equal(selectPermissionOptionId(REAL_OPTIONS, "cancel"), undefined);
});

test("selection keys on kind, never on index — allow_always is options[0]", () => {
  assert.equal(REAL_OPTIONS[0].kind, "allow_always");
  assert.notEqual(selectPermissionOptionId(REAL_OPTIONS, "accept"), REAL_OPTIONS[0].optionId);
});

test("a blank option id counts as absent", () => {
  const blank: PermissionOption[] = [{ optionId: "   ", name: "Yes", kind: "allow_once" }];
  assert.equal(selectPermissionOptionId(blank, "accept"), undefined);
});

test("full-access takes the widest grant the request offers", () => {
  assert.equal(selectAutoApprovedOptionId(REAL_OPTIONS), "allow-edits-session");
  const onceOnly = REAL_OPTIONS.filter((option) => option.kind === "allow_once");
  assert.equal(selectAutoApprovedOptionId(onceOnly), "allow-once");
});

test("every decision is covered", () => {
  const decisions: ApprovalDecision[] = [
    "accept",
    "acceptForSession",
    "acceptAlways",
    "decline",
    "cancel"
  ];
  for (const decision of decisions) {
    // No throw, and a defined answer for everything but `cancel`.
    const id = selectPermissionOptionId(REAL_OPTIONS, decision);
    assert.equal(decision === "cancel" ? id === undefined : typeof id === "string", true);
  }
});

// ---------------------------------------------------------------------------
// §4.4 permission modes — the Grok column
// ---------------------------------------------------------------------------

test("the argv per runtime mode, including the flag that moves", () => {
  assert.deepEqual(grokSpawnArgs("approval-required"), ["--permission-mode", "default", "agent", "stdio"]);
  assert.deepEqual(grokSpawnArgs("auto-accept-edits"), ["--permission-mode", "acceptEdits", "agent", "stdio"]);
  assert.deepEqual(grokSpawnArgs("auto"), ["--permission-mode", "auto", "agent", "stdio"]);
  // `--always-approve` belongs to `agent`, so it comes AFTER it.
  assert.deepEqual(grokSpawnArgs("full-access"), ["agent", "--always-approve", "stdio"]);
});

test("--permission-mode always precedes `agent`, --always-approve always follows it", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
    const args = grokSpawnArgs(mode);
    assert.ok(args.indexOf("--permission-mode") < args.indexOf("agent"));
  }
  const full = grokSpawnArgs("full-access");
  assert.ok(full.indexOf("agent") < full.indexOf("--always-approve"));
});

test("the adapter compensates for acceptEdits being a no-op on this CLI", () => {
  assert.equal(autoApprovesEdits("approval-required"), false);
  assert.equal(autoApprovesEdits("auto-accept-edits"), true);
  assert.equal(autoApprovesEdits("auto"), true);
  assert.equal(autoApprovesEdits("full-access"), true);
  assert.equal(autoApprovesEverything("auto"), false);
  assert.equal(autoApprovesEverything("full-access"), true);
});

// ---------------------------------------------------------------------------
// The session-scoped grant key
// ---------------------------------------------------------------------------

function toolCall(overrides: Partial<RequestPermissionRequest["toolCall"]>): RequestPermissionRequest["toolCall"] {
  return { toolCallId: "call-1", ...overrides } as RequestPermissionRequest["toolCall"];
}

test("the key is the operation, so the same write twice matches", () => {
  const first = approvalGrantKey(
    toolCall({
      kind: "edit",
      title: "Write `/tmp/a.txt`",
      rawInput: { variant: "Write", file_path: "/tmp/a.txt", content: "x" },
      locations: [{ path: "/tmp/a.txt" }]
    })
  );
  const second = approvalGrantKey(
    toolCall({
      toolCallId: "call-2",
      kind: "edit",
      title: "Write `/tmp/a.txt`",
      rawInput: { variant: "Write", file_path: "/tmp/a.txt", content: "x" },
      locations: [{ path: "/tmp/a.txt" }]
    })
  );
  assert.equal(first, second, "the tool-call id must not be part of the key");
  assert.ok(first !== undefined);
});

test("a Bash description is stripped, because the model rewords it every run", () => {
  const a = approvalGrantKey(
    toolCall({
      kind: "execute",
      title: "Execute `ls`",
      rawInput: { variant: "Bash", command: "ls", description: "List the files" }
    })
  );
  const b = approvalGrantKey(
    toolCall({
      kind: "execute",
      title: "Execute `ls`",
      rawInput: { variant: "Bash", command: "ls", description: "Show what is here" }
    })
  );
  assert.equal(a, b);
});

test("no command and no input means NO key, so nothing blanket-approves", () => {
  assert.equal(approvalGrantKey(toolCall({ kind: "other", title: "Terminal" })), undefined);
  assert.equal(approvalGrantKey(toolCall({ kind: "other", title: "Terminal", rawInput: {} })), undefined);
});

test("a generic title with different commands does not collide", () => {
  const a = approvalGrantKey(
    toolCall({ kind: "execute", title: "Terminal", rawInput: { variant: "Bash", command: "ls" } })
  );
  const b = approvalGrantKey(
    toolCall({ kind: "execute", title: "Terminal", rawInput: { variant: "Bash", command: "rm -rf /" } })
  );
  assert.notEqual(a, b);
});

test("stableStringify is key-order independent, array-order dependent, undefined-dropping", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("the vendor tool kind beats ACP's coarser one", () => {
  const write = toolCall({
    kind: "edit",
    title: "Write `/tmp/a.txt`",
    _meta: { "x.ai/tool": { version: 1, name: "write", kind: "write", namespace: "opencode", label: "Write", read_only: false } }
  });
  assert.equal(permissionRequestType(write), "file_change_approval");
  assert.equal(isEditApproval(write), true);

  const read = toolCall({
    kind: "read",
    title: "Read `/tmp/a.txt`",
    _meta: { "x.ai/tool": { version: 1, name: "read_file", kind: "read", namespace: "grok_build", label: "Read", read_only: true } }
  });
  assert.equal(permissionRequestType(read), "file_read_approval");
  assert.equal(isEditApproval(read), false);

  const exec = toolCall({
    kind: "execute",
    title: "Execute `ls`",
    rawInput: { variant: "Bash", command: "ls" }
  });
  assert.equal(permissionRequestType(exec), "exec_command_approval");

  const plan = toolCall({
    kind: "other",
    title: "Plan: Exit",
    _meta: { "x.ai/tool": { version: 1, name: "exit_plan_mode", kind: "exit_plan", namespace: "grok_build", label: "Exit Plan Mode", read_only: true } }
  });
  assert.equal(permissionRequestType(plan), "permission_approval");
});

test("the card detail never falls back to raw params", () => {
  assert.equal(
    permissionDetail(toolCall({ kind: "execute", rawInput: { variant: "Bash", command: "echo hi" } })),
    "echo hi"
  );
  assert.equal(permissionDetail(toolCall({ title: "Write `/tmp/a.txt`" })), "/tmp/a.txt");
  assert.equal(permissionDetail(toolCall({ locations: [{ path: "/tmp/b" }] })), "/tmp/b");
  assert.equal(permissionDetail(toolCall({})), "Tool call");
});
