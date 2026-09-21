import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_HOST_DEADLINES,
  DeadlineExceededError,
  TURN_LIVENESS_WINDOWS,
  withDeadline
} from "./deadline.ts";

test("resolves the underlying value when it beats the deadline", async () => {
  const value = await withDeadline(Promise.resolve(7), { label: "probe", timeoutMs: 1_000 });
  assert.equal(value, 7);
});

test("propagates the underlying rejection unchanged", async () => {
  const boom = new Error("provider refused");
  await assert.rejects(
    withDeadline(Promise.reject(boom), { label: "probe", timeoutMs: 1_000 }),
    (error: unknown) => error === boom
  );
});

test("expiry rejects with DeadlineExceededError and runs onTimeout", async () => {
  let killed = false;
  await assert.rejects(
    withDeadline(new Promise<never>(() => {}), {
      label: "handshake",
      timeoutMs: 5,
      onTimeout: () => {
        killed = true;
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof DeadlineExceededError);
      assert.equal(error.label, "handshake");
      assert.equal(error.timeoutMs, 5);
      assert.match(error.message, /handshake timed out after 5ms/);
      return true;
    }
  );
  assert.equal(killed, true, "the child is killed rather than left starting forever");
});

test("a late rejection after expiry does not become an unhandled rejection", async () => {
  let reject!: (error: unknown) => void;
  const work = new Promise<never>((_resolve, r) => {
    reject = r;
  });
  await assert.rejects(withDeadline(work, { label: "cancel", timeoutMs: 5 }));
  reject(new Error("too late"));
  // If this were unhandled the test run itself would fail.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("a failing onTimeout never replaces the deadline error", async () => {
  await assert.rejects(
    withDeadline(new Promise<never>(() => {}), {
      label: "interrupt",
      timeoutMs: 5,
      onTimeout: () => {
        throw new Error("kill failed");
      }
    }),
    DeadlineExceededError
  );
});

test("an abort signal wins, before and during the wait", async () => {
  const already = AbortSignal.abort(new Error("host stopping"));
  await assert.rejects(
    withDeadline(new Promise<never>(() => {}), {
      label: "x",
      timeoutMs: 1_000,
      signal: already
    }),
    /host stopping/
  );

  const controller = new AbortController();
  const pending = withDeadline(new Promise<never>(() => {}), {
    label: "y",
    timeoutMs: 1_000,
    signal: controller.signal
  });
  controller.abort(new Error("shutdown"));
  await assert.rejects(pending, /shutdown/);
});

test("a thunk is only invoked once, and lazily", async () => {
  let calls = 0;
  const value = await withDeadline(
    async () => {
      calls += 1;
      return "ok";
    },
    { label: "lazy", timeoutMs: 1_000 }
  );
  assert.equal(value, "ok");
  assert.equal(calls, 1);
});

test("the documented windows are the ones the spec states", () => {
  assert.equal(AGENT_HOST_DEADLINES.sessionOpenMs, 90_000);
  assert.equal(AGENT_HOST_DEADLINES.cancelMs, 15_000);
  assert.equal(AGENT_HOST_DEADLINES.interruptChildMs, 3_000);
  assert.equal(AGENT_HOST_DEADLINES.interruptAllMs, 10_000);
  assert.equal(TURN_LIVENESS_WINDOWS.idleMs, 600_000);
  assert.equal(TURN_LIVENESS_WINDOWS.activeToolMs, 1_800_000);
});
