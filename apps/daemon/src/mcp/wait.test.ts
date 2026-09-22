import { test } from "node:test";
import assert from "node:assert/strict";
import { busEvent, FakeDaemonApi } from "./testing.ts";
import { chatSummary, shellSummary, stamp } from "./fixtures.ts";
import { attentionQualifies, turnBaseline, waitForAttention, waitForTurn, watchSessions } from "./wait.ts";

const now = () => Date.now();
const running = (over = {}) => chatSummary({ chatSessionStatus: "running", activity: { state: "working", attention: null, lastOutputAt: null, needsAttentionAt: null }, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null }, ...over });
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(3) }, ...over });

test("watchSessions subscribes BEFORE the first read, evaluates on events, and unsubscribes", async () => {
  const api = new FakeDaemonApi();
  api.on("GET", "/api/sessions", () => { assert.equal(api.listenerCount(), 1, "subscribed before reading"); return { status: 200, body: [running()] }; });
  const p = watchSessions({ api, select: (s) => s.id === "c1", evaluate: (st) => (st.sessions.get("c1")?.chatSessionStatus === "ready" ? "ready" : null), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", done()));
  assert.equal(await p, "ready");
  assert.equal(api.listenerCount(), 0);
});

test("watchSessions merges session.activity into the summary and drops closed sessions", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running()] });
  const seen: string[] = [];
  const p = watchSessions({ api, select: () => true, evaluate: (st) => { seen.push(`${st.sessions.get("c1")?.activity?.state ?? "-"}/${st.closed.has("c1")}`); return st.closed.has("c1") ? "closed" : null; }, timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.activity", { id: "c1", activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(9) } }));
  api.emit(busEvent("session.closed", { id: "c1" }));
  assert.equal(await p, "closed");
  assert.ok(seen.includes("waiting/false"));
});

test("watchSessions times out with null and honours abort", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [] });
  assert.equal(await watchSessions({ api, select: () => true, evaluate: () => null, timeoutMs: 20, signal: new AbortController().signal, now, settleMs: 0 }), null);
  const ac = new AbortController();
  const p = watchSessions({ api, select: () => true, evaluate: () => null, timeoutMs: 5_000, signal: ac.signal, now, settleMs: 0 });
  ac.abort();
  assert.equal(await p, null);
  assert.equal(api.listenerCount(), 0);
});

test("waitForTurn: a new turn completing after the baseline, a pending question, a plan, an error, and a steer", async () => {
  const idle = chatSummary();
  const base = turnBaseline(idle);
  assert.deepEqual(base, { turnId: "t1", completedAt: stamp(1), running: false });
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [idle] });
  const p = waitForTurn(api, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", chatSummary({ latestTurn: { turnId: null, state: "pending", startedAt: null, completedAt: null } })));
  api.emit(busEvent("session.updated", running()));
  api.emit(busEvent("session.updated", done()));
  assert.equal((await p).outcome, "completed");
  const q = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running({ hasPendingUserInput: true })] });
  assert.equal((await waitForTurn(q, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "needs-input");
  const plan = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done({ hasActionableProposedPlan: true })] });
  assert.equal((await waitForTurn(plan, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "plan-ready");
  const err = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary({ chatSessionStatus: "error" })] });
  assert.equal((await waitForTurn(err, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "failed");
  const steerBase = turnBaseline(running());
  assert.deepEqual(steerBase, { turnId: "t2", completedAt: null, running: true });
  const steer = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running()] });
  const sp = waitForTurn(steer, "c1", steerBase, { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  steer.emit(busEvent("session.updated", done({ latestTurn: { turnId: "t2", state: "interrupted", startedAt: stamp(2), completedAt: stamp(4) } })));
  assert.equal((await sp).outcome, "interrupted");
});

test("waitForTurn: the baseline turn itself never counts, a timeout reports timeout, a closed session throws", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const r = await waitForTurn(api, "c1", turnBaseline(chatSummary()), { timeoutMs: 20, signal: new AbortController().signal, now });
  assert.equal(r.outcome, "timeout");
  const gone = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const p = waitForTurn(gone, "c1", turnBaseline(chatSummary()), { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  gone.emit(busEvent("session.closed", { id: "c1" }));
  await assert.rejects(p, (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});

test("attentionQualifies and waitForAttention: cursor semantics, immediate return, settle window collects siblings, timeout", async () => {
  assert.equal(attentionQualifies(done(), stamp(2)), true);
  assert.equal(attentionQualifies(done(), stamp(3)), false, "equal stamps do not qualify");
  assert.equal(attentionQualifies(running(), stamp(0)), false);
  assert.equal(attentionQualifies(shellSummary({ activity: { state: "idle", attention: "bell", lastOutputAt: null, needsAttentionAt: stamp(5) } }), stamp(4)), true);
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done()] });
  const immediate = await waitForAttention(api, { select: () => true, after: stamp(0), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual(immediate.sessions.map((s) => s.id), ["c1"]); assert.equal(immediate.cursor, stamp(3)); assert.equal(immediate.timedOut, false);
  const again = await waitForAttention(api, { select: () => true, after: immediate.cursor, timeoutMs: 20, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual(again, { sessions: [], cursor: stamp(3), timedOut: true });
  let reads = 0;
  const two = new FakeDaemonApi().on("GET", "/api/sessions", () => (++reads === 1
    ? { status: 200, body: [running(), running({ id: "c2" })] }
    : { status: 200, body: [done({ activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } }), done({ id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } })] }));
  const p = waitForAttention(two, { select: (s) => s.kind === "agent-chat", after: stamp(3), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 30 });
  await new Promise((r) => setImmediate(r));
  two.emit(busEvent("session.activity", { id: "c1", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } }));
  const r = await p;
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["c1", "c2"], "the settle window re-read picked up the sibling");
  assert.equal(r.cursor, stamp(7));
});

test("waitForTurn: every event is evaluated, so a completion followed at once by the next turn is still reported", async () => {
  const idle = chatSummary();
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [idle] });
  const p = waitForTurn(api, "c1", turnBaseline(idle), { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", done()));
  api.emit(busEvent("session.updated", running({ latestTurn: { turnId: "t3", state: "running", startedAt: stamp(4), completedAt: null } })));
  const r = await p;
  assert.equal(r.outcome, "completed");
  assert.equal(r.summary?.latestTurn?.turnId, "t2", "the summary is the one that settled");
});

test("waitForTurn: a plan-ready baseline (implement_plan) does not count until the latest turn moves past it", async () => {
  // The daemon's summary moves only on the host poll, so the first read after posting still shows the plan being implemented.
  const planned = chatSummary({ hasActionableProposedPlan: true });
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [planned] });
  const p = waitForTurn(api, "c1", turnBaseline(planned), { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", running()));
  api.emit(busEvent("session.updated", done()));
  assert.equal((await p).outcome, "completed");
});

test("a frozen caller clock never stops a timeout (the tools' test contexts freeze `now`)", async () => {
  const frozen = () => Date.parse("2026-09-22T12:00:00.000Z");
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] });
  const backstop = AbortSignal.timeout(2_000);
  assert.equal((await waitForTurn(api, "c1", turnBaseline(chatSummary()), { timeoutMs: 20, signal: backstop, now: frozen })).outcome, "timeout");
  assert.equal(backstop.aborted, false, "the wait's own timeout ended it, not the backstop");
  assert.equal((await waitForAttention(api, { select: () => true, after: stamp(5), timeoutMs: 20, signal: backstop, now: frozen, settleMs: 0 })).timedOut, true);
  assert.equal(backstop.aborted, false, "the wait's own timeout ended it, not the backstop");
});
