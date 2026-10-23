import assert from "node:assert/strict";
import test from "node:test";

import { REDIRECT_COMPACT_REASON, SUBAGENT_FEEDBACK_ATTACHMENTS_REASON } from "@orquester/api/agent-chat";

import {
  APPROVAL_RESPONDING_REASON,
  composerPendingRequestsOf,
  NO_PENDING_REQUESTS,
  pendingRequestWording,
  planPendingRequestSend,
  QUESTION_ATTACHMENTS_REASON,
  QUESTION_HINT,
  REDIRECT_HINT,
  SUBAGENT_REDIRECT_HINT,
  type ComposerPendingRequests
} from "./composer-pending-send";
import {
  PENDING_REQUEST_REASON,
  planExternalSend,
  planExternalSubmit,
  resolveFollowUpDisposition
} from "./composer-submission";

const APPROVALS: ComposerPendingRequests = {
  approvalIds: ["req-1", "req-2"],
  respondingRequestIds: [],
  hasQuestion: false
};
const QUESTION: ComposerPendingRequests = { ...NO_PENDING_REQUESTS, hasQuestion: true };
const plan = (pending: ComposerPendingRequests, text = "use staging instead", attachmentCount = 0, hostParsesGoal = false) =>
  planPendingRequestSend({ pending, text, attachmentCount, hostParsesGoal });

test("nothing pending: an ordinary send, and no hint", () => {
  assert.deepEqual(plan(NO_PENDING_REQUESTS), { kind: "send" });
  assert.equal(pendingRequestWording(NO_PENDING_REQUESTS), null);
});

test("a message over pending approvals redirects: every approval is declined, files and all", () => {
  assert.deepEqual(plan(APPROVALS), { kind: "redirect", declineApprovals: ["req-1", "req-2"] });
  assert.deepEqual(plan(APPROVALS, "see the screenshot", 2), {
    kind: "redirect",
    declineApprovals: ["req-1", "req-2"]
  });
  assert.equal(pendingRequestWording(APPROVALS)?.hint, REDIRECT_HINT);
});

test("an approval being answered from its card holds the redirect back", () => {
  assert.deepEqual(plan({ ...APPROVALS, respondingRequestIds: ["req-2"] }), {
    kind: "refuse",
    reason: APPROVAL_RESPONDING_REASON
  });
  // An answer on its way for something else is no reason.
  assert.equal(plan({ ...APPROVALS, respondingRequestIds: ["q-1"] }).kind, "redirect");
});

test("a bare /compact cannot redirect; /compact with words or files is a message", () => {
  assert.deepEqual(plan(APPROVALS, "  /COMPACT "), { kind: "refuse", reason: REDIRECT_COMPACT_REASON });
  assert.equal(plan(APPROVALS, "/compact now please").kind, "redirect");
  assert.equal(plan(APPROVALS, "/compact", 1).kind, "redirect");
});

test("a /goal the host applies itself is an ordinary send over any card", () => {
  assert.deepEqual(plan(APPROVALS, "/goal pause", 0, true), { kind: "send" });
  assert.deepEqual(plan(QUESTION, "/goal clear", 0, true), { kind: "send" });
  // Where the provider parses /goal it is an ordinary message, and redirects.
  assert.equal(plan(APPROVALS, "/goal pause", 0, false).kind, "redirect");
});

test("a message over a question is its answer, unless it carries files", () => {
  assert.deepEqual(plan(QUESTION), { kind: "answer-question" });
  assert.deepEqual(plan(QUESTION, "b.txt", 1), { kind: "refuse", reason: QUESTION_ATTACHMENTS_REASON });
  assert.equal(pendingRequestWording(QUESTION)?.hint, QUESTION_HINT);
});

test("an approval is in front of a question, in the dock and in what a send does", () => {
  const both = { ...APPROVALS, hasQuestion: true };
  assert.equal(plan(both).kind, "redirect");
  assert.equal(pendingRequestWording(both)?.hint, REDIRECT_HINT);
});

test("a redirect is never queued behind the turn it answers", () => {
  for (const intent of ["foreground", "alternate"] as const) {
    assert.equal(
      resolveFollowUpDisposition({ followUpBehavior: "queue", intent, isRunning: true, redirect: true }),
      "send"
    );
    assert.equal(
      resolveFollowUpDisposition({ followUpBehavior: "steer", intent, isRunning: true, redirect: true }),
      "send"
    );
  }
});

const EXTERNAL = {
  text: "Review the current changes",
  reverting: false,
  sending: false,
  hasPendingRequest: true,
  adapterId: "claude",
  hostParsesGoal: false
};

test("another surface's send over an approval redirects too; over a question it waits", () => {
  assert.deepEqual(planExternalSend({ ...EXTERNAL, pendingRequests: APPROVALS }), {
    text: "Review the current changes",
    notice: null,
    declineApprovals: ["req-1", "req-2"]
  });
  assert.deepEqual(planExternalSend({ ...EXTERNAL, pendingRequests: QUESTION }), {
    text: null,
    notice: PENDING_REQUEST_REASON
  });
  // Not told what the dock holds: any card holds it back, as before.
  assert.equal(planExternalSend(EXTERNAL).notice, PENDING_REQUEST_REASON);
});

test("the rail's Send over an approval is a redirect, sent now even with queueing preferred", () => {
  const rail = {
    ...EXTERNAL,
    pendingRequests: APPROVALS,
    showPlanModeToggle: false,
    followUpBehavior: "queue" as const,
    isTurnActive: true,
    lastQueued: null,
    now: 1
  };
  assert.deepEqual(planExternalSubmit(rail), {
    kind: "send",
    text: "Review the current changes",
    declineApprovals: ["req-1", "req-2"]
  });
  assert.deepEqual(planExternalSubmit({ ...rail, pendingRequests: NO_PENDING_REQUESTS, hasPendingRequest: false }), {
    kind: "queue",
    text: "Review the current changes"
  });
});

test("a request already answered elsewhere is neither redirected nor answered again", () => {
  const pending = {
    approvals: [{ requestId: "req-1" }, { requestId: "req-2" }],
    userInputs: [{ requestId: "q-1" }],
    respondingRequestIds: [],
    answeredRequestIds: ["req-1", "q-1"]
  };
  const told = composerPendingRequestsOf(pending);
  assert.deepEqual(told, { approvalIds: ["req-2"], respondingRequestIds: [], hasQuestion: false });
  assert.deepEqual(plan(told), { kind: "redirect", declineApprovals: ["req-2"] });
  // Everything answered: an ordinary send, never a second answer.
  const allAnswered = composerPendingRequestsOf({ ...pending, answeredRequestIds: ["req-1", "req-2", "q-1"] });
  assert.deepEqual(plan(allAnswered), { kind: "send" });
  assert.equal(composerPendingRequestsOf({ ...pending, answeredRequestIds: ["req-1", "req-2"] }).hasQuestion, true);
});

test("only subagents' approvals: the message is their answer, text only, and the wording says so", () => {
  const told = composerPendingRequestsOf({
    approvals: [{ requestId: "req-1", requestingAgentId: "task-1" }],
    userInputs: [],
    respondingRequestIds: [],
    answeredRequestIds: [],
    approvalFeedbackToSubagents: true
  });
  assert.equal(told.subagentOnly, true);
  assert.deepEqual(plan(told), { kind: "redirect", declineApprovals: ["req-1"] });
  assert.deepEqual(plan(told, "see the log", 1), { kind: "refuse", reason: SUBAGENT_FEEDBACK_ATTACHMENTS_REASON });
  assert.equal(pendingRequestWording(told)?.hint, SUBAGENT_REDIRECT_HINT);
  assert.equal(pendingRequestWording(told)?.placeholder, "Tell the subagent what to do instead…");

  // A main-agent approval among them, or a provider that cannot hand the words over: today's redirect.
  const mixed = composerPendingRequestsOf({
    approvals: [{ requestId: "req-1", requestingAgentId: "task-1" }, { requestId: "req-2" }],
    userInputs: [],
    respondingRequestIds: [],
    answeredRequestIds: [],
    approvalFeedbackToSubagents: true
  });
  assert.equal(mixed.subagentOnly, undefined);
  assert.equal(plan(mixed, "see the log", 1).kind, "redirect");
  assert.equal(pendingRequestWording(mixed)?.hint, REDIRECT_HINT);
  const codex = composerPendingRequestsOf({
    approvals: [{ requestId: "req-1", requestingAgentId: "child-1" }],
    userInputs: [],
    respondingRequestIds: [],
    answeredRequestIds: []
  });
  assert.equal(codex.subagentOnly, undefined);
  // An answered main-agent approval leaves the subagent's alone in front.
  const leftAlone = composerPendingRequestsOf({
    approvals: [{ requestId: "req-1", requestingAgentId: "task-1" }, { requestId: "req-2" }],
    userInputs: [],
    respondingRequestIds: [],
    answeredRequestIds: ["req-2"],
    approvalFeedbackToSubagents: true
  });
  assert.equal(leftAlone.subagentOnly, true);
});
