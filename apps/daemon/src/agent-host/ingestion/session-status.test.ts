import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadSessionState } from "@orquester/api/agent-chat";
import { nextSessionState } from "./session-status.ts";
import { runtimeEvent } from "./test-harness.ts";

const running: ThreadSessionState = { status: "running", activeTurnId: "turn-1" };

describe("nextSessionState (§5.1 turn model)", () => {

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

  it("an interrupted turn leaves no lastError on the head", () => {
    const next = nextSessionState({
      event: runtimeEvent("turn.completed", { state: "interrupted" }, { turnId: "turn-1" }),
      previous: { ...running, lastError: "stale" }
    });
    assert.equal(next.lastError, undefined);
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

  it("session.started keeps the resume cursor the adapter reported", () => {
    const next = nextSessionState({
      event: runtimeEvent("session.started", { resume: { cursor: 7 } }),
      previous: { status: "idle", activeTurnId: null }
    });
    assert.deepEqual(next.resumeCursor, { cursor: 7 });
  });
});
