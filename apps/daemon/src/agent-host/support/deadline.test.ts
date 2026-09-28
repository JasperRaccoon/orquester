import assert from "node:assert/strict";
import test from "node:test";

import {
  DeadlineExceededError,
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
  await new Promise<void>((resolve) => setImmediate(resolve));
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
