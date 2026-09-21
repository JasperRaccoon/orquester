import test from "node:test";
import assert from "node:assert/strict";
import type { PendingApproval, ThreadItem } from "@orquester/api/agent-chat";

import {
  APPROVAL_DETAIL_UNAVAILABLE,
  diffLineTone,
  findApprovalItem,
  looksLikeDiff,
  resolveApprovalDetail
} from "./approval-detail.ts";

/**
 * Fixture-shaped: the activity is exactly what `derivePendingRequests` and the
 * §5.6 slimming allow-list put on the wire — `toolUseId`, `changedFiles`,
 * `detail`, `itemType` on an `item.started` row.
 */
function activity(payload: Record<string, unknown>, overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    kind: "activity",
    id: "act-1",
    tone: "info",
    activityKind: "item.started",
    summary: "Editing ui-hello.txt",
    payload,
    turnId: "turn-1",
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides
  } as ThreadItem;
}

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: "req-1",
    requestKind: "file-change",
    createdAt: "2026-09-21T10:00:01.000Z",
    ...overrides
  };
}

const DIFF = "--- a/ui-hello.txt\n+++ b/ui-hello.txt\n@@ -0,0 +1 @@\n+hello from the agent";

test("E7: the request's own detail wins and is marked as such", () => {
  const resolved = resolveApprovalDetail(approval({ detail: DIFF }), []);
  assert.equal(resolved.source, "request");
  assert.equal(resolved.text, DIFF);
  assert.equal(resolved.isDiff, true);
});

test("E7: with no detail, the card joins the gated tool call by toolUseId", () => {
  const entries = [
    activity({ toolUseId: "call-other", changedFiles: ["nope.txt"] }, { id: "a0" }),
    activity({
      itemType: "file_change",
      toolUseId: "call-1",
      changedFiles: ["src/ui-hello.txt"],
      detail: DIFF
    })
  ];
  const resolved = resolveApprovalDetail(approval({ toolUseId: "call-1" }), entries);
  assert.equal(resolved.source, "item");
  assert.match(resolved.text ?? "", /src\/ui-hello\.txt/, "the path must be shown");
  assert.match(resolved.text ?? "", /\+hello from the agent/, "the diff must be shown");
  assert.equal(resolved.isDiff, true);
});

test("E7: the path list alone is enough when the item carries no diff", () => {
  const entries = [activity({ toolUseId: "call-1", changedFiles: ["a.txt", "b.txt"] })];
  const resolved = resolveApprovalDetail(approval({ toolUseId: "call-1" }), entries);
  assert.equal(resolved.text, "a.txt\nb.txt");
  assert.equal(resolved.source, "item");
  assert.equal(resolved.isDiff, false);
});

test("E7: the body is NEVER the card's own title", () => {
  // The bug: "File change approval" rendered as its own detail block.
  const resolved = resolveApprovalDetail(approval(), []);
  assert.equal(resolved.text, null);
  assert.equal(resolved.source, "none");
  assert.match(APPROVAL_DETAIL_UNAVAILABLE, /Decline it unless you know/);
});

test("E7: the join is by id only — a second write in flight is never guessed at", () => {
  // Showing one path while approving another is worse than showing nothing.
  const entries = [
    activity({ toolUseId: "call-a", changedFiles: ["a.txt"] }, { id: "a" }),
    activity({ toolUseId: "call-b", changedFiles: ["b.txt"] }, { id: "b" })
  ];
  assert.equal(resolveApprovalDetail(approval(), entries).source, "none");
  assert.equal(findApprovalItem({ toolUseId: undefined }, entries), null);
});

test("E7: the newest activity wins when a tool id is reused across updates", () => {
  const entries = [
    activity({ toolUseId: "call-1", changedFiles: ["old.txt"] }, { id: "old" }),
    activity({ toolUseId: "call-1", changedFiles: ["new.txt"] }, { id: "new" })
  ];
  assert.equal(findApprovalItem({ toolUseId: "call-1" }, entries)?.id, "new");
});

test("E7: a command payload is used when there are no changed files", () => {
  const entries = [activity({ toolUseId: "call-1", command: "git apply patch.diff" })];
  assert.equal(
    resolveApprovalDetail(approval({ toolUseId: "call-1" }), entries).text,
    "git apply patch.diff"
  );
});

test("E7: a missing or malformed payload never throws", () => {
  for (const payload of [null, "text", 42, undefined]) {
    const entries = [activity({}, { payload } as Partial<ThreadItem>)];
    assert.doesNotThrow(() => resolveApprovalDetail(approval({ toolUseId: "call-1" }), entries));
  }
  assert.equal(resolveApprovalDetail(approval({ toolUseId: "call-1" })).source, "none");
});

test("a file header alone is not a diff, but a hunk or a +/- pair is", () => {
  assert.equal(looksLikeDiff("--- a/x\n+++ b/x"), false);
  assert.equal(looksLikeDiff("@@ -1 +1 @@"), true);
  assert.equal(looksLikeDiff("+added"), true);
  assert.equal(looksLikeDiff("just some prose"), false);
});

test("diff lines get their tone from the leading marker", () => {
  assert.equal(diffLineTone("+new"), "added");
  assert.equal(diffLineTone("-gone"), "removed");
  assert.equal(diffLineTone("@@ -1 +1 @@"), "meta");
  assert.equal(diffLineTone("+++ b/x"), "meta");
  assert.equal(diffLineTone(" unchanged"), "context");
});
