/**
 * Pending approvals and questions (§5.1). Cases ported from T3 Code (MIT):
 * `packages/client-runtime/src/pendingRequests.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { derivePendingRequests, parseQuestions, requestKindFromRequestType } from "./pending.ts";
import { activity, resetActivityIds } from "./test-helpers.ts";

test("requestKindFromRequestType maps every native spelling", () => {
  assert.equal(requestKindFromRequestType("command_execution_approval"), "command");
  assert.equal(requestKindFromRequestType("exec_command_approval"), "command");
  assert.equal(requestKindFromRequestType("dynamic_tool_call"), "command");
  assert.equal(requestKindFromRequestType("file_read_approval"), "file-read");
  assert.equal(requestKindFromRequestType("apply_patch_approval"), "file-change");
  assert.equal(requestKindFromRequestType("file_change_approval"), "file-change");
  assert.equal(requestKindFromRequestType("mcp_elicitation_approval"), "mcp-elicitation");
  assert.equal(requestKindFromRequestType("permission_approval"), "permission");
  assert.equal(requestKindFromRequestType("nonsense"), null);
});

test("tracks open approvals and removes resolved ones", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "command_execution_approval" }),
    activity("approval.requested", { requestId: "r2", requestType: "file_change_approval" }),
    activity("approval.resolved", { requestId: "r1", decision: "accept" })
  ]);
  assert.deepEqual(
    pending.approvals.map((entry) => [entry.requestId, entry.requestKind]),
    [["r2", "file-change"]]
  );
});

test("a resolved row is a tombstone: a later requested row cannot reopen it", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.resolved", { requestId: "r1", decision: "decline" }),
    activity("approval.requested", { requestId: "r1", requestType: "command_execution_approval" })
  ]);
  assert.deepEqual(pending.approvals, []);
});

test("a dismissal's user-input.resolved row closes the question permanently", () => {
  resetActivityIds();
  const question = {
    requestId: "q1",
    responseMode: "message",
    questions: [
      { id: "Pick one", header: "h", question: "Pick one", options: [{ label: "a" }] }
    ]
  };
  const pending = derivePendingRequests([
    activity("user-input.requested", question),
    activity("user-input.resolved", { requestId: "q1", answers: {} }),
    // An out-of-order redelivery of the same request.
    activity("user-input.requested", question)
  ]);
  assert.deepEqual(pending.userInputs, []);
});

test("tool_user_input and auth_tokens_refresh never become approvals", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "tool_user_input" }),
    activity("approval.requested", { requestId: "r2", requestType: "auth_tokens_refresh" })
  ]);
  assert.deepEqual(pending.approvals, []);
});

test("an unrecognised request type still yields an actionable command approval", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "unknown" })
  ]);
  assert.equal(pending.approvals[0]?.requestKind, "command");
});

test("a canonical requestKind on the row wins over the raw requestType", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", {
      requestId: "r1",
      requestKind: "file-read",
      requestType: "command_execution_approval"
    })
  ]);
  assert.equal(pending.approvals[0]?.requestKind, "file-read");
});

test("keeps detail, appName and well-formed options; drops malformed options", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", {
      requestId: "r1",
      requestType: "permission_approval",
      detail: "rm -rf /",
      appName: "Finder",
      options: [
        { decision: "accept", label: "Approve" },
        { decision: "nope", label: "Bogus" },
        { decision: "decline", label: 42 },
        { decision: "acceptForSession", label: "Always", warning: "careful" }
      ]
    })
  ]);
  const approval = pending.approvals[0];
  assert.equal(approval?.detail, "rm -rf /");
  assert.equal(approval?.appName, "Finder");
  assert.deepEqual(approval?.options?.map((option) => option.decision), [
    "accept",
    "acceptForSession"
  ]);
});

test("a stale-failure row closes the request; any other failure leaves it open", () => {
  resetActivityIds();
  const open = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "permission_approval" }),
    activity("provider.approval.respond.failed", {
      requestId: "r1",
      detail: "transport closed while replying"
    })
  ]);
  assert.equal(open.approvals.length, 1, "a retryable failure keeps the card");

  resetActivityIds();
  const closed = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "permission_approval" }),
    activity("provider.approval.respond.failed", {
      requestId: "r1",
      detail: "Unknown pending approval request r1"
    })
  ]);
  assert.deepEqual(closed.approvals, [], "a stale/unknown failure closes it");
});

test("a stale user-input failure closes the question", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("user-input.requested", {
      requestId: "q1",
      questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
    }),
    activity("provider.user-input.respond.failed", {
      requestId: "q1",
      detail: "stale pending user-input request"
    })
  ]);
  assert.deepEqual(pending.userInputs, []);
});

test("only async questions are dismissible", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("user-input.requested", {
      requestId: "q1",
      responseMode: "message",
      questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
    }),
    activity("user-input.requested", {
      requestId: "q2",
      questions: [{ id: "b", header: "h", question: "q", options: [{ label: "yes" }] }]
    })
  ]);
  assert.deepEqual(
    pending.userInputs.map((entry) => [entry.requestId, entry.dismissible]),
    [
      ["q1", true],
      ["q2", false]
    ]
  );
});

test("parseQuestions preserves native answer keys and drops unanswerable cards", () => {
  const questions = parseQuestions([
    {
      // Claude looks answers up by the full question text: NOT trimmed.
      id: "  Which file? ",
      header: "Header",
      question: "Which file?",
      options: [{ label: "a.ts", description: "first" }, { label: 7 }, "nope"],
      multiSelect: true
    },
    // No option and no custom-answer flag: unanswerable, dropped.
    { id: "x", header: "h", question: "q", options: [], allowCustomAnswer: false },
    // No option but free text allowed: kept.
    { id: "y", header: "h", question: "q", options: [], allowCustomAnswer: true }
  ]);
  assert.equal(questions.length, 2);
  assert.equal(questions[0]?.id, "  Which file? ");
  assert.deepEqual(questions[0]?.options.map((option) => option.label), ["a.ts"]);
  assert.equal(questions[0]?.options[0]?.description, "first");
  assert.equal(questions[0]?.multiSelect, true);
  assert.equal(questions[1]?.id, "y");
});

test("a question row with no decodable question at all is dropped, not shown empty", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("user-input.requested", {
      requestId: "q1",
      questions: [{ id: "a", header: "h", question: "q", options: [], allowCustomAnswer: false }]
    })
  ]);
  assert.deepEqual(pending.userInputs, []);
});

test("rows are ordered by createdAt", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestId: "late", requestType: "permission_approval" }, {
      createdAt: "2026-02-01T00:00:00.000Z"
    }),
    activity("approval.requested", { requestId: "early", requestType: "permission_approval" }, {
      createdAt: "2026-01-01T00:00:00.000Z"
    })
  ]);
  assert.deepEqual(pending.approvals.map((entry) => entry.requestId), ["early", "late"]);
});

test("rows with no requestId, and non-request kinds, are ignored", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestType: "permission_approval" }),
    activity("tool.started", { requestId: "r9" }),
    activity("approval.requested", "not an object")
  ]);
  assert.deepEqual(pending, { approvals: [], userInputs: [] });
});
