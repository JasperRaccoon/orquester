import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadSessionState } from "@orquester/api/agent-chat";

import {
  initialSessionState,
  isSessionLifecycleEvent,
  nextSessionState,
  sameSessionState,
  threadStatusFromRuntimeState
} from "./session-status.ts";
import { runtimeEvent } from "./test-harness.ts";

const running: ThreadSessionState = { status: "running", activeTurnId: "turn-1" };

describe("threadStatusFromRuntimeState", () => {
  const cases = [
    ["starting", "starting"],
    ["ready", "ready"],
    ["running", "running"],
    ["stopped", "stopped"],
    ["error", "error"]
  ] as const;
  for (const [state, expected] of cases) {
    it(`${state} -> ${expected}`, () => {
      assert.equal(threadStatusFromRuntimeState(state), expected);
    });
  }
});

describe("nextSessionState (§5.1 turn model)", () => {
  it("turn.started makes the event's turn the active one", () => {
    const next = nextSessionState({
      event: runtimeEvent("turn.started", {}, { turnId: "turn-9" }),
      previous: initialSessionState()
    });
    assert.deepEqual(next, { status: "running", activeTurnId: "turn-9" });
  });

  it("turn.completed leaves running for ready, clearing the active turn", () => {
    const next = nextSessionState({
      event: runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" }),
      previous: running
    });
    assert.equal(next.status, "ready");
    assert.equal(next.activeTurnId, null);
    assert.equal(next.lastError, undefined);
  });

  it("a failed turn leaves running for error, with the message", () => {
    const next = nextSessionState({
      event: runtimeEvent(
        "turn.completed",
        { state: "failed", errorMessage: "context overflow" },
        { turnId: "turn-1" }
      ),
      previous: running
    });
    assert.equal(next.status, "error");
    assert.equal(next.lastError, "context overflow");
  });

  it("turn.aborted folds T3's `interrupted` into `stopped` (§5.1)", () => {
    const next = nextSessionState({
      event: runtimeEvent("turn.aborted", { reason: "user" }, { turnId: "turn-1" }),
      previous: running
    });
    assert.equal(next.status, "stopped");
    assert.equal(next.activeTurnId, null);
  });

  it("session.exited always clears the active turn", () => {
    const next = nextSessionState({
      event: runtimeEvent("session.exited", { recoverable: false, exitKind: "error", reason: "exit 1" }),
      previous: running
    });
    assert.deepEqual(next, { status: "stopped", activeTurnId: null, lastError: "exit 1" });
  });

  it("a graceful exit carries no error", () => {
    const next = nextSessionState({
      event: runtimeEvent("session.exited", { recoverable: true, exitKind: "graceful" }),
      previous: { ...running, lastError: "old" }
    });
    assert.equal(next.lastError, undefined);
  });

  it("thread.started during an active turn preserves running and records the provider id", () => {
    const next = nextSessionState({
      event: runtimeEvent("thread.started", { providerThreadId: "prov-1" }),
      previous: running
    });
    assert.equal(next.status, "running");
    assert.equal(next.activeTurnId, "turn-1");
    assert.equal(next.providerThreadId, "prov-1");
  });

  it("a session state that cannot hold a turn drops the active turn", () => {
    const next = nextSessionState({
      event: runtimeEvent("session.state.changed", { state: "ready" }),
      previous: running
    });
    assert.equal(next.activeTurnId, null);
  });

  it("runtime.error puts the session in error with the message", () => {
    const next = nextSessionState({
      event: runtimeEvent("runtime.error", { message: "bad json", class: "transport_error" }),
      previous: running
    });
    assert.equal(next.status, "error");
    assert.equal(next.lastError, "bad json");
    assert.equal(next.activeTurnId, null);
  });

  it("session.started keeps the resume cursor the adapter reported", () => {
    const next = nextSessionState({
      event: runtimeEvent("session.started", { resume: { cursor: 7 } }),
      previous: initialSessionState()
    });
    assert.deepEqual(next.resumeCursor, { cursor: 7 });
  });
});

describe("sameSessionState (Claude's 3-per-turn `system/status` flood)", () => {
  it("treats an unchanged fact as the same state", () => {
    assert.equal(sameSessionState({ ...running }, { ...running }), true);
    assert.equal(
      sameSessionState(running, { status: "running", activeTurnId: "turn-2" }),
      false
    );
  });
});

describe("isSessionLifecycleEvent", () => {
  it("names exactly the events that move the session machine", () => {
    assert.equal(isSessionLifecycleEvent(runtimeEvent("turn.started", {})), true);
    assert.equal(
      isSessionLifecycleEvent(runtimeEvent("runtime.warning", { message: "x" })),
      false
    );
    assert.equal(
      isSessionLifecycleEvent(runtimeEvent("thread.metadata.updated", { name: "x" })),
      false
    );
  });
});
