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

test("a REPLAY of a resolved request cannot reopen it", () => {
  // A replay is the same row delivered twice, so it carries the SAME stamp as
  // the original — which is how it is told apart from a provider recycling the
  // id for a genuinely new request (E2E R2-1).
  resetActivityIds();
  const requested = activity(
    "approval.requested",
    { requestId: "r1", requestType: "command_execution_approval" },
    { createdAt: "2026-01-01T00:00:01.000Z" }
  );
  const resolved = activity(
    "approval.resolved",
    { requestId: "r1", decision: "decline" },
    { createdAt: "2026-01-01T00:00:02.000Z" }
  );
  // Out-of-order delivery: the resolution is seen first, then the request it
  // closed. The seed is what carries the ordering across that.
  const pending = derivePendingRequests([resolved, requested], {
    closed: new Set(["r1"]),
    closedAt: new Map([["r1", resolved.createdAt]])
  });
  assert.deepEqual(pending.approvals, []);
});

test("a dismissal's user-input.resolved row closes the question it answered", () => {
  resetActivityIds();
  const question = {
    requestId: "q1",
    responseMode: "message",
    questions: [
      { id: "Pick one", header: "h", question: "Pick one", options: [{ label: "a" }] }
    ]
  };
  const requested = activity("user-input.requested", question, {
    createdAt: "2026-01-01T00:00:01.000Z"
  });
  const pending = derivePendingRequests([
    requested,
    activity("user-input.resolved", { requestId: "q1", answers: {} }, {
      createdAt: "2026-01-01T00:00:02.000Z"
    }),
    // The same row redelivered — same stamp, so it is the question that was
    // already dismissed, not a new one.
    requested
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

// --- R2-1: a recycled requestId must not be swallowed by an old tombstone ---

test("a request that arrives AFTER a resolution with the same id opens fresh", () => {
  // E2E round 2, R2-1 (blocker): Codex mints `codex-<threadId>-<n>` with a
  // per-provider-session counter, but a THREAD outlives its provider sessions.
  // After a daemon restart + thread/resume the counter restarted at 1, so a
  // brand-new file-change approval reused the id of an approval resolved
  // minutes earlier. The old tombstone deleted the new request: no card, no
  // attention flag, composer unblocked, and the provider blocked forever.
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", {
      requestId: "codex-T-1",
      requestKind: "command",
      requestType: "command_execution_approval"
    }),
    activity("approval.resolved", { requestId: "codex-T-1", decision: "accept" }),
    activity("approval.requested", {
      requestId: "codex-T-1",
      requestKind: "file-change",
      requestType: "file_change_approval",
      detail: "/w/p/r2-card.txt"
    })
  ]);
  assert.deepEqual(
    pending.approvals.map((entry) => [entry.requestId, entry.requestKind]),
    [["codex-T-1", "file-change"]],
    "the later request is a different request and must render"
  );
});

test("a resolution still closes the request that PRECEDES it", () => {
  resetActivityIds();
  const pending = derivePendingRequests([
    activity("approval.requested", { requestId: "r1", requestType: "permission_approval" }),
    activity("approval.resolved", { requestId: "r1", decision: "accept" })
  ]);
  assert.deepEqual(pending.approvals, []);
});

test("a recycled question id opens fresh too", () => {
  resetActivityIds();
  const question = (header: string) => ({
    requestId: "q-1",
    responseMode: "message",
    questions: [{ id: "a", header, question: "q", options: [{ label: "yes" }] }]
  });
  const pending = derivePendingRequests([
    activity("user-input.requested", question("first")),
    activity("user-input.resolved", { requestId: "q-1", answers: {} }),
    activity("user-input.requested", question("second"))
  ]);
  assert.equal(pending.userInputs.length, 1);
  assert.equal(pending.userInputs[0]?.questions[0]?.header, "second");
});

test("a seeded tombstone closes only requests at or before its stamp", () => {
  // The R5 #4 guarantee (an aged-out resolution keeps its request closed) has
  // to survive R2-1's fix, so the seed carries WHEN the resolution happened.
  resetActivityIds();
  const older = derivePendingRequests(
    [
      activity(
        "approval.requested",
        { requestId: "r1", requestType: "permission_approval" },
        { createdAt: "2026-01-01T00:00:01.000Z" }
      )
    ],
    {
      closed: new Set(["r1"]),
      closedAt: new Map([["r1", "2026-01-01T00:00:05.000Z"]])
    }
  );
  assert.deepEqual(older.approvals, [], "a request older than the tombstone stays closed");

  resetActivityIds();
  const newer = derivePendingRequests(
    [
      activity(
        "approval.requested",
        { requestId: "r1", requestType: "permission_approval" },
        { createdAt: "2026-01-01T00:00:09.000Z" }
      )
    ],
    {
      closed: new Set(["r1"]),
      closedAt: new Map([["r1", "2026-01-01T00:00:05.000Z"]])
    }
  );
  assert.equal(newer.approvals.length, 1, "a request newer than the tombstone opens");
});

test("a seed with no stamps stays conservative", () => {
  // A state built by a constructor that predates the stamp map: without
  // ordering information the tombstone still closes, which is the R5 #4
  // behaviour and never resurrects a dead card.
  resetActivityIds();
  const pending = derivePendingRequests(
    [activity("approval.requested", { requestId: "r1", requestType: "permission_approval" })],
    { closed: new Set(["r1"]) }
  );
  assert.deepEqual(pending.approvals, []);
});
