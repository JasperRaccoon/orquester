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
  assert.ok(seen.includes("waiting/false"), "the activity was merged before the close");
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

test("an exited terminal keeps its finished attention through summaries that omit activity (a rename, the settle re-read)", async () => {
  // The daemon drops `activity` from an exited tab's summary and stamps `finished` on the bus after `session.exited`.
  const live = shellSummary({ id: "s1", activity: { state: "working", attention: null, lastOutputAt: stamp(1), needsAttentionAt: null } });
  const exited = { ...live, status: "exited" as const, exitCode: 0, activity: undefined };
  let reads = 0;
  const api = new FakeDaemonApi().on("GET", "/api/sessions", () => ({ status: 200, body: [++reads === 1 ? live : exited] }));
  const p = waitForAttention(api, { select: () => true, after: stamp(2), timeoutMs: 1_000, signal: new AbortController().signal, now, settleMs: 20 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.exited", exited));
  api.emit(busEvent("session.activity", { id: "s1", activity: { state: "idle", attention: "finished", lastOutputAt: stamp(1), needsAttentionAt: stamp(5) } }));
  api.emit(busEvent("session.updated", { ...exited, title: "renamed" }));
  const r = await p;
  assert.deepEqual(r.sessions.map((s) => s.id), ["s1"]);
  assert.equal(r.cursor, stamp(5));
  assert.equal(reads, 2, "the settle window re-read the list");
});

test("the safety-net re-read keeps its cadence however busy the bus is", async () => {
  let reads = 0;
  const api = new FakeDaemonApi().on("GET", "/api/sessions", () => { reads += 1; return { status: 200, body: [running(), shellSummary()] }; });
  const p = watchSessions({ api, select: (s) => s.id === "c1", evaluate: () => null, timeoutMs: 300, signal: new AbortController().signal, now, settleMs: 0, rereadMs: 40 });
  const quiet = { state: "working", attention: null, lastOutputAt: null, needsAttentionAt: null };
  let beat = 0;
  // Every 10 ms, alternately: the watched chat (nothing decisive) and an unwatched terminal.
  const chatter = setInterval(() => api.emit(busEvent("session.activity", { id: beat++ % 2 ? "c1" : "t1", activity: quiet })), 10);
  try {
    assert.equal(await p, null);
  } finally {
    clearInterval(chatter);
  }
  assert.ok(reads >= 3, `re-read on schedule: ${reads} reads in 300 ms at rereadMs 40`);
});

test("events about unwatched sessions neither evaluate nor wake the watch", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [running(), shellSummary()] });
  let evaluations = 0;
  const ac = new AbortController();
  const p = watchSessions({ api, select: (s) => s.id === "c1", evaluate: () => { evaluations += 1; return null; }, timeoutMs: 5_000, signal: ac.signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  const before = evaluations;
  api.emit(busEvent("session.activity", { id: "t1", activity: { state: "idle", attention: "bell", lastOutputAt: null, needsAttentionAt: stamp(9) } }));
  api.emit(busEvent("session.updated", shellSummary({ title: "renamed" })));
  api.emit(busEvent("session.closed", { id: "t9" }));
  await new Promise((r) => setImmediate(r));
  assert.equal(evaluations, before, "nothing the watch holds changed");
  api.emit(busEvent("session.activity", { id: "c1", activity: { state: "working", attention: null, lastOutputAt: null, needsAttentionAt: null } }));
  assert.equal(evaluations, before + 1, "a watched session's event is evaluated at once");
  ac.abort();
  assert.equal(await p, null);
});

test("an abort inside the settle window resolves null; attention stamps compare as instants, whatever offset `after` uses", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [done()] });
  const ac = new AbortController();
  const p = watchSessions({ api, select: () => true, evaluate: (st) => (st.sessions.size ? "hit" : null), timeoutMs: 5_000, signal: ac.signal, now, settleMs: 2_000 });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  assert.equal(await p, null, "not the hit the settle window was holding");
  assert.equal(attentionQualifies(done(), "2026-09-22T02:00:02+02:00"), true, "00:00:03Z is after 02:00:02+02:00");
  assert.equal(attentionQualifies(done(), "2026-09-22T02:00:03+02:00"), false, "the same instant does not qualify");
  const r = await waitForAttention(api, { select: () => true, after: "2026-09-22T02:00:02+02:00", timeoutMs: 50, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c1"], stamp(3)], "the cursor is the daemon's own stamp");
});

test("a late session.exited cannot bring a closed tab back into the watch", async () => {
  // The daemon can publish a tab's exit after its close (the tmux exit path settles asynchronously).
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [shellSummary()] });
  const ac = new AbortController();
  const p = watchSessions({ api, select: () => true, evaluate: (st) => (st.closed.has("t1") && st.sessions.has("t1") ? "resurrected" : null), timeoutMs: 5_000, signal: ac.signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.closed", { id: "t1" }));
  api.emit(busEvent("session.exited", { ...shellSummary(), status: "exited", exitCode: 0, activity: undefined }));
  await new Promise((r) => setImmediate(r));
  ac.abort();
  assert.equal(await p, null, "the closed tab stayed out of the watch");
});

test("activity published while the first list read is in flight is merged into it, the later attention stamp winning, with no re-read", async () => {
  const finished = (n: number) => ({ state: "idle" as const, attention: "finished" as const, lastOutputAt: null, needsAttentionAt: stamp(n) });
  let reads = 0;
  const api: FakeDaemonApi = new FakeDaemonApi().on("GET", "/api/sessions", () => {
    reads += 1;
    // Published after the watch subscribed, before the list it is reading answers.
    api.emit(busEvent("session.activity", { id: "c1", activity: finished(9) }));
    api.emit(busEvent("session.activity", { id: "c2", activity: finished(2) }));
    return { status: 200, body: [running(), done({ id: "c2", activity: finished(4) })] };
  });
  const stamps = await watchSessions({ api, select: () => true, evaluate: (st) => (st.sessions.size ? [...st.sessions.values()].map((s) => [s.id, s.activity?.needsAttentionAt]) : null), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual(stamps, [["c1", stamp(9)], ["c2", stamp(4)]], "c1: the bus's later stamp; c2: the list's later stamp");
  assert.equal(reads, 1, "merged without a re-read");
  const attention = new FakeDaemonApi();
  attention.on("GET", "/api/sessions", () => { attention.emit(busEvent("session.activity", { id: "c1", activity: finished(9) })); return { status: 200, body: [running()] }; });
  const r = await waitForAttention(attention, { select: () => true, after: stamp(5), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor, attention.calls.length], [["c1"], stamp(9), 1], "the wait ends on the first read, not the 10 s safety net");
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
  const r = await waitForAttention(api, { select: () => true, after: stamp(5), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 10 });
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["c1", "c2"]);
  assert.equal(r.cursor, stamp(7)); assert.equal(reads, 2);
});

test("a single-session wait ends with SESSION_NOT_FOUND when its session closes, or is already gone at the first read", async () => {
  const notFound = (e: { code: string }) => e.code === "SESSION_NOT_FOUND";
  const signal = new AbortController().signal;
  // Closed between the caller's lookup and the wait's first read: no close event ever reaches the wait.
  const gone = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [shellSummary()] });
  await assert.rejects(waitForTurn(gone, "c1", turnBaseline(chatSummary()), { timeoutMs: 5_000, signal, now }), notFound);
  const one = (api: FakeDaemonApi) => waitForAttention(api, { sessionId: "c1", after: stamp(5), timeoutMs: 5_000, signal, now, settleMs: 0 });
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
  const p = waitForAttention(api, { select: () => true, after: stamp(5), timeoutMs: 5_000, signal: new AbortController().signal, now, settleMs: 0 });
  await new Promise((r) => setImmediate(r));
  api.emit(busEvent("session.closed", { id: "c1" }));
  api.emit(busEvent("session.activity", { id: "c2", activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(9) } }));
  const r = await p;
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c2"], stamp(9)]);
});

test("a single-session attention wait is scoped by its sessionId alone, so no selection can disagree with it", async () => {
  const flagged = (id: string, n: number) => chatSummary({ id, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(n) } });
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [flagged("c1", 7), flagged("c2", 9)] });
  const signal = new AbortController().signal;
  const r = await waitForAttention(api, { sessionId: "c1", after: stamp(5), timeoutMs: 5_000, signal, now, settleMs: 0 });
  assert.deepEqual([r.sessions.map((s) => s.id), r.cursor], [["c1"], stamp(7)], "c2 qualifies too, and is not watched");
  // @ts-expect-error one session or a selection, never both
  const both = () => waitForAttention(api, { sessionId: "c1", select: () => true, after: stamp(5), timeoutMs: 5_000, signal, now });
  assert.equal(typeof both, "function", "never called: the type is what refuses it");
});
