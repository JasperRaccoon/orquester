import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentHostStatusResponse } from "@orquester/api/agent-chat";

import {
  blockerAgeSeconds,
  blockerKindLabel,
  blockerStopAction,
  groupRestartBlockers,
  restartNowConsequences,
  shortCodeStamp
} from "./agent-host-restart";

const status: AgentHostStatusResponse = {
  state: "healthy",
  reason: null,
  hostInstanceId: "host-1",
  pid: 42,
  codeStamp: "1570de7c8ee6aaaa",
  checkoutCodeStamp: "f5aff27f7805bbbb",
  pendingRestart: {
    reason: "agent host code 1570de7c8ee6 != f5aff27f7805",
    since: "2026-10-23T09:00:00.000Z",
    deferredBy: "1 thread(s) with live background work",
    blockers: [
      { threadId: "t1", threadTitle: "Auth fixes", kind: "background", taskId: "b1", title: "Run the suite", command: "pnpm test > /tmp/x.log", since: "2026-10-23T09:03:00.000Z", stoppable: true },
      { threadId: "t2", kind: "turn" },
      { threadId: "t1", threadTitle: "Auth fixes", kind: "agent", taskId: "a1", title: "Review", stoppable: false },
      { threadId: "t3", kind: "wake", since: "2026-10-23T09:19:00.000Z" }
    ]
  }
};

test("blockers group by thread, named by the tab's title", () => {
  const groups = groupRestartBlockers(status.pendingRestart!.blockers);
  assert.deepEqual(
    groups.map((group) => [group.label, group.blockers.map((blocker) => blocker.kind)]),
    [
      ["Auth fixes", ["background", "agent"]],
      ["t2", ["turn"]],
      ["t3", ["wake"]]
    ]
  );
});

test("each blocker offers the stop it can take: the task alone, the session, or none", () => {
  const [shell, turn, agent, wake] = status.pendingRestart!.blockers;
  assert.equal(blockerStopAction(shell!), "task");
  assert.equal(blockerStopAction(agent!), "session", "a task the provider cannot stop alone");
  assert.equal(blockerStopAction(turn!), null);
  assert.equal(blockerStopAction(wake!), null);
  assert.equal(blockerKindLabel(shell!), "Background shell");
  assert.equal(blockerAgeSeconds(shell!, Date.parse("2026-10-23T09:20:00.000Z")), 17 * 60);
  assert.equal(blockerAgeSeconds(turn!, 0), null);
});

test("the restart-now confirmation lists everything it stops", () => {
  assert.deepEqual(restartNowConsequences(status), [
    "Auth fixes: Background shell — Run the suite",
    "Auth fixes: Subagent — Review",
    "t2: Turn running",
    "t3: About to continue with a finished background task"
  ]);
  assert.deepEqual(restartNowConsequences({ ...status, pendingRestart: null }), [
    "Nothing is running in any chat right now."
  ]);
  assert.equal(shortCodeStamp("1570de7c8ee6aaaa"), "1570de7c8ee6");
  assert.equal(shortCodeStamp(null), "unknown");
});
