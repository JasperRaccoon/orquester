// The per-host rate gate: the pause a 429 starts, how background and interactive requests meet
// it, and the slot cap. Time is an injected clock; nothing here sleeps or reaches a forge.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DEFAULT_RATE_PAUSE_MS, HostRateGate, rateGateFor, resetRateGates } from "./rate-gate";
import { GitRemoteError, MAX_RETRY_AFTER_MS } from "./types";

afterEach(() => resetRateGates());

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

const limited = (retryAfterMs?: number) =>
  new GitRemoteError(429, "Bitbucket GET /x → 429: rate limit exceeded.", "rate_limited", 429, retryAfterMs);

/** A request that settles when the test says so. */
function deferred<T = string>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("a 429 pauses the host for its Retry-After; background and interactive requests then fail fast", async () => {
  const time = clock();
  const gate = new HostRateGate("Bitbucket", { now: time.now });
  await assert.rejects(gate.run("background", async () => { throw limited(30_000); }), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.retryAfterMs, 30_000);
    return true;
  });
  assert.equal(gate.pausedForMs(), 30_000);

  let sent = 0;
  const request = async () => {
    sent += 1;
    return "ok";
  };
  time.advance(10_000);
  await assert.rejects(gate.run("background", request), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 20_000, "the poller waits out what is left of the pause");
    return true;
  });
  await assert.rejects(gate.run("interactive", request), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.message, "Bitbucket is rate limiting this account; try again in 20 s.");
    return true;
  });
  assert.equal(sent, 0, "nothing reached the host while it was paused");

  time.advance(20_000);
  assert.equal(await gate.run("background", request), "ok", "the pause is released at its end");
  assert.equal(sent, 1);
});

test("a 429 with no usable Retry-After pauses for 60 s and says so on the error", async () => {
  const time = clock();
  const gate = new HostRateGate("Bitbucket", { now: time.now });
  await assert.rejects(gate.run("background", async () => { throw limited(); }), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterMs, DEFAULT_RATE_PAUSE_MS);
    return true;
  });
  assert.equal(gate.pausedForMs(), 60_000);
});

test("a pause is extended, never shortened, and other failures start none", async () => {
  const time = clock();
  const gate = new HostRateGate("GitHub", { now: time.now });
  gate.pause(120_000);
  gate.pause(5_000);
  assert.equal(gate.pausedForMs(), 120_000);
  time.advance(120_000);
  await assert.rejects(
    gate.run("background", async () => { throw new GitRemoteError(502, "boom", "upstream", 500); }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "upstream"
  );
  assert.equal(gate.pausedForMs(), 0);
});

test("at most `slots` requests are in flight; the rest queue, and a pause started meanwhile refuses them", async () => {
  const time = clock();
  const gate = new HostRateGate("Bitbucket", { slots: 2, now: time.now });
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started: string[] = [];
  const a = gate.run("background", () => { started.push("a"); return first.promise; });
  const b = gate.run("background", () => { started.push("b"); return second.promise; });
  const c = gate.run("background", () => { started.push("c"); return third.promise; });
  const d = gate.run("interactive", async () => { started.push("d"); return "d"; });
  await Promise.resolve();
  assert.deepEqual(started, ["a", "b"]);

  first.resolve("a");
  assert.equal(await a, "a");
  await Promise.resolve();
  assert.deepEqual(started, ["a", "b", "c"], "a freed slot goes to the next in line");

  // A 429 elsewhere pauses the host while `d` still queues: `d` is refused rather than sent into the limit.
  gate.pause(15_000);
  second.resolve("b");
  assert.equal(await b, "b");
  await assert.rejects(d, (error: unknown) => error instanceof GitRemoteError && error.retryAfterMs === 15_000);
  third.resolve("c");
  assert.equal(await c, "c");
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("gates are per host and per account, and an unlimited gate never queues", async () => {
  const one = rateGateFor("bitbucket.org", "Bitbucket", { token: "t1", email: "a@x" });
  assert.equal(rateGateFor("BITBUCKET.org", "Bitbucket", { token: "t1", email: "a@x" }), one);
  assert.notEqual(rateGateFor("bitbucket.org", "Bitbucket", { token: "t2", email: "a@x" }), one);
  assert.notEqual(rateGateFor("bitbucket.org", "Bitbucket", null), one);
  assert.notEqual(rateGateFor("bb.corp.example", "Bitbucket Server", { token: "t1", email: "a@x" }), one);

  const open = new HostRateGate("GitHub", { slots: Infinity });
  const held = Array.from({ length: 10 }, () => deferred());
  let running = 0;
  const runs = held.map((h) => open.run("background", () => { running += 1; return h.promise; }));
  await Promise.resolve();
  assert.equal(running, 10);
  for (const h of held) h.resolve("x");
  await Promise.all(runs);
});

test("a pause never runs past an hour, whatever Retry-After asks for", async () => {
  const time = clock();
  const gate = new HostRateGate("Bitbucket Server (bb.corp.example)", { now: time.now });
  // A DC admin's bucket answering Retry-After: 1 week.
  await assert.rejects(gate.run("background", async () => { throw limited(7 * 24 * 3_600_000); }));
  assert.equal(gate.pausedForMs(), MAX_RETRY_AFTER_MS);
  assert.equal(MAX_RETRY_AFTER_MS, 60 * 60_000);
  gate.pause(Number.MAX_SAFE_INTEGER);
  assert.equal(gate.pausedForMs(), MAX_RETRY_AFTER_MS);
  time.advance(MAX_RETRY_AFTER_MS);
  assert.equal(await gate.run("interactive", async () => "ok"), "ok", "a user's request goes out again after the hour");
});
