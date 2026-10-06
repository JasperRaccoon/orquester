import { test } from "node:test";
import assert from "node:assert/strict";
import { busEvent,FakeDaemonApi } from "./testing.ts";
import { chatSummary,shellSummary,stamp } from "./fixtures.ts";
import { turnBaseline,waitForAttention,waitForTurn } from "./wait.ts";

const now = () => Date.now();
const running = (over = {}) => chatSummary({ chatSessionStatus: "running", activity: { state: "working", attention: null, lastOutputAt: null, needsAttentionAt: null }, latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null }, ...over });
const done = (over = {}) => chatSummary({ latestTurn: { turnId: "t2", state: "completed", startedAt: stamp(2), completedAt: stamp(3) }, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(3) }, ...over });

test("waitForTurn: a new turn completing after the baseline, a pending question, a plan, an error, and a steer", async () => {
  const idle = chatSummary();
  const base = turnBaseline(idle);
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

test("waitForAttention: cursor semantics, immediate return, settle window collects siblings, timeout", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done()] });
  const immediate = await waitForAttention(api, { select: () => true, after: stamp(0), timeoutMs: 5_000, signal: new AbortController().signal, now });
  assert.deepEqual(immediate.sessions.map((s) => s.id), ["c1"]); assert.equal(immediate.cursor, stamp(3)); assert.equal(immediate.timedOut, false);
  const again = await waitForAttention(api, { select: () => true, after: immediate.cursor, timeoutMs: 20, signal: new AbortController().signal, now });
  assert.deepEqual(again, { sessions: [], cursor: stamp(3), timedOut: true });
  let reads = 0;
  const two = new FakeDaemonApi().on("GET", "/api/sessions", () => (++reads === 1
    ? { status: 200, body: [running(), running({ id: "c2" })] }
    : { status: 200, body: [done({ activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } }), done({ id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(7) } })] }));
  const p = waitForAttention(two, { select: (s) => s.kind === "agent-chat", after: stamp(3), timeoutMs: 5_000, signal: new AbortController().signal, now });
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

test("an exited terminal keeps its finished attention through summaries that omit activity (a rename, the settle re-read)", async () => {
  // The daemon drops `activity` from an exited tab's summary and stamps `finished` on the bus after `session.exited`.
  const live = shellSummary({ id: "s1", activity: { state: "working", attention: null, lastOutputAt: stamp(1), needsAttentionAt: null } });
  const exited = { ...live, status: "exited" as const, exitCode: 0, activity: undefined };
  let reads = 0;
  const api = new FakeDaemonApi().on("GET", "/api/sessions", () => ({ status: 200, body: [++reads === 1 ? live : exited] }));
  const p = waitForAttention(api, { select: () => true, after: stamp(2), timeoutMs: 1_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.exited", exited));
  api.emit(busEvent("session.activity", { id: "s1", activity: { state: "idle", attention: "finished", lastOutputAt: stamp(1), needsAttentionAt: stamp(5) } }));
  api.emit(busEvent("session.updated", { ...exited, title: "renamed" }));
  const r = await p;
  assert.deepEqual(r.sessions.map((s) => s.id), ["s1"]);
  assert.equal(r.cursor, stamp(5));
});

test("aborting an attention wait during settling releases the subscription; cursor offsets denote instants", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done()] });
  const ac = new AbortController();
  const p = waitForAttention(api, { select: () => true, after: stamp(0), timeoutMs: 5_000, signal: ac.signal, now });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  assert.deepEqual((await p).sessions, []);
  assert.equal(api.listenerCount(), 0);
  const r = await waitForAttention(api, { select: () => true, after: "2026-09-22T02:00:02+02:00", timeoutMs: 5_000, signal: new AbortController().signal, now });
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c1"], stamp(3)]);
  const same = await waitForAttention(api, { select: () => true, after: "2026-09-22T02:00:03+02:00", timeoutMs: 1, signal: new AbortController().signal, now });
  assert.deepEqual(same.sessions, []);
});

test("a late session.exited cannot bring a closed tab back into the watch", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running(), running({ id: "c2" })] });
  const pending = waitForAttention(api, { select: () => true, after: stamp(3), timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((resolve) => setImmediate(resolve));
  api.emit(busEvent("session.closed", { id: "c1" }));
  const closed = done({ status: "exited", exitCode: 0, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(9) } });
  const sibling = done({ id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(8) } });
  api.emit(busEvent("session.exited", closed));
  api.on("GET", "/api/sessions", { status: 200, body: [closed, sibling] });
  api.emit(busEvent("session.updated", sibling));
  const result = await pending;
  assert.deepEqual([result.sessions.map((session) => session.id), result.cursor], [["c2"], stamp(8)]);
});

test("activity published during the initial list read is preserved, with the newest stamp winning", async () => {
  const finished = (n: number) => ({ state: "idle" as const, attention: "finished" as const, lastOutputAt: null, needsAttentionAt: stamp(n) });
  const api: FakeDaemonApi = new FakeDaemonApi().on("GET", "/api/sessions", () => {
    api.emit(busEvent("session.activity", { id: "c1", activity: finished(9) }));
    api.emit(busEvent("session.activity", { id: "c2", activity: finished(2) }));
    return { status: 200, body: [running(), done({ id: "c2", activity: finished(4) })] };
  });
  const r = await waitForAttention(api, { select: () => true, after: stamp(0), timeoutMs: 5_000, signal: new AbortController().signal, now });
  assert.deepEqual(r.sessions.map((s) => [s.id, s.activity?.needsAttentionAt]).sort(), [["c1", stamp(9)], ["c2", stamp(4)]]);
  assert.equal(r.cursor, stamp(9));
});

test("a sibling stamped while the settle window's re-read is in flight is still collected", async () => {
  // The host poll stamps every session it touches with one needsAttentionAt: a sibling missed here would also
  // miss the next call, whose `after` is that same stamp.
  const finished = { state: "idle" as const, attention: "finished" as const, lastOutputAt: null, needsAttentionAt: stamp(7) };
  let reads = 0;
  const api: FakeDaemonApi = new FakeDaemonApi().on("GET", "/api/sessions", () => {
    reads += 1;
    if (reads === 2) api.emit(busEvent("session.activity", { id: "c2", activity: finished }));
    return { status: 200, body: [done({ activity: finished }), running({ id: "c2" })] };
  });
  const r = await waitForAttention(api, { select: () => true, after: stamp(5), timeoutMs: 5_000, signal: new AbortController().signal, now });
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["c1", "c2"]);
  assert.equal(r.cursor, stamp(7));
});

test("a single-session wait ends with SESSION_NOT_FOUND when its session closes, or is already gone at the first read", async () => {
  const notFound = (e: { code: string }) => e.code === "SESSION_NOT_FOUND";
  const signal = new AbortController().signal;
  // Closed between the caller's lookup and the wait's first read: no close event ever reaches the wait.
  const gone = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [shellSummary()] });
  await assert.rejects(waitForTurn(gone, "c1", turnBaseline(chatSummary()), { timeoutMs: 5_000, signal, now }), notFound);
  const one = (api: FakeDaemonApi) => waitForAttention(api, { sessionId: "c1", after: stamp(5), timeoutMs: 5_000, signal, now });
  await assert.rejects(one(gone), notFound);
  const closing = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const p = one(closing);
  await new Promise((r) => setImmediate(r));
  closing.emit(busEvent("session.closed", { id: "c1" }));
  await assert.rejects(p, notFound);
  assert.deepEqual([gone, closing].map((a) => a.listenerCount()), [0, 0]);
});

test("a project-wide or unfiltered attention wait just stops watching a closed session", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const p = waitForAttention(api, { select: () => true, after: stamp(5), timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.closed", { id: "c1" }));
  api.on("GET", "/api/sessions", { status: 200, body: [chatSummary(), done({ id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(9) } })] });
  api.emit(busEvent("session.activity", { id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(9) } }));
  const r = await p;
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c2"], stamp(9)]);
});

test("a single-session attention wait is scoped by its sessionId alone, so no selection can disagree with it", async () => {
  const flagged = (id: string, n: number) => chatSummary({ id, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(n) } });
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [flagged("c1", 7), flagged("c2", 9)] });
  const signal = new AbortController().signal;
  const r = await waitForAttention(api, { sessionId: "c1", after: stamp(5), timeoutMs: 5_000, signal, now });
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c1"], stamp(7)], "c2 qualifies too, and is not watched");
});

test("waitForTurn: while the host reports a goal continuing, a new settled turn is a pause between two goal turns — the wait goes on until the goal stops", async () => {
  const goal = (status: "active" | "paused", continuing: boolean) => ({ goal: { objective: "Make the build green", status, continuing } });
  const idle = chatSummary();
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [idle] });
  const p = waitForTurn(api, "c1", turnBaseline(idle), { timeoutMs: 5_000, signal: new AbortController().signal, now });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.updated", running(goal("active", true))));
  // A host poll between two goal turns: t2 settled, and Codex starts t3 by itself.
  api.emit(busEvent("session.updated", done(goal("active", true))));
  api.emit(busEvent("session.updated", running({ latestTurn: { turnId: "t3", state: "running", startedAt: stamp(4), completedAt: null }, ...goal("active", true) })));
  const t3 = { turnId: "t3", state: "completed" as const, startedAt: stamp(4), completedAt: stamp(5) };
  api.emit(busEvent("session.updated", done({ latestTurn: t3, ...goal("active", true) })));
  let ended = false;
  void p.then(() => { ended = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, false, "no outcome while the goal continues");
  api.emit(busEvent("session.updated", done({ latestTurn: t3, ...goal("paused", false) })));
  const r = await p;
  assert.equal(r.outcome, "completed");
  assert.deepEqual([r.summary?.latestTurn?.turnId, r.summary?.goal?.status], ["t3", "paused"], "the summary is the one where the goal stopped");
  // What needs the caller still ends the wait at once, goal or not.
  const asked = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done({ hasPendingUserInput: true, ...goal("active", true) })] });
  assert.equal((await waitForTurn(asked, "c1", turnBaseline(idle), { timeoutMs: 5_000, signal: new AbortController().signal, now })).outcome, "needs-input");
});

test("waitForTurn: an errored session whose goal the host still reports continuing (a restart's owed resume) is not failed until the goal stops continuing", async () => {
  const goal = (continuing: boolean) => ({ goal: { objective: "Make the build green", status: "active" as const, continuing } });
  const base = turnBaseline(chatSummary());
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary({ chatSessionStatus: "error", ...goal(true) })] });
  const p = waitForTurn(api, "c1", base, { timeoutMs: 5_000, signal: new AbortController().signal, now });
  let ended = false;
  void p.then(() => { ended = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(ended, false, "the ladder holds its error rung back, and so does the wait");
  // The resume failed: the host clears its mark, the goal is still active in the provider's store, and it no longer continues.
  api.emit(busEvent("session.updated", chatSummary({ chatSessionStatus: "error", ...goal(false) })));
  const r = await p;
  assert.equal(r.outcome, "failed");
  assert.equal(r.summary?.goal?.continuing, false);
});
