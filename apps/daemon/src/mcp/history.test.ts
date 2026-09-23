import { test } from "node:test";
import assert from "node:assert/strict";
import { agentChatRoutes, decodeHistoryCursor, encodeHistoryCursor, type ThreadHistoryBounds, type ThreadHistoryPage, type ThreadItem, type Turn } from "@orquester/api/agent-chat";
import type { DaemonResponse } from "./daemon-api.ts";
import { activity, message, snapshot, turn } from "./fixtures.ts";
import { HISTORY_PAGES_PER_READ, mergeHistoryPages, readOlderHistory, unavailableHint } from "./history.ts";
import { FakeDaemonApi } from "./testing.ts";

const HISTORY = agentChatRoutes.history("c1");

/**
 * A thread of `n` started turns, each an opening message the host wrote with the idle session's null turnId (linked
 * back by `userMessageId`), a tool call and a reply: its turn records, and the rows of turns `from`..`to`. Built in
 * order, so the fixture's stamps rise with the log.
 */
function thread(n: number) {
  const turns: Turn[] = [];
  const rows: ThreadItem[][] = [];
  for (let t = 1; t <= n; t += 1) {
    const ask = message("user", `ask ${t}`, { turnId: null, id: `ask-${t}` });
    const call = activity("tool.completed", { itemType: "command_execution", toolUseId: `call-${t}`, title: "pnpm test", status: "completed" }, { turnId: `t${t}`, id: `call-${t}`, tone: "tool" });
    const reply = message("assistant", `reply ${t}`, { turnId: `t${t}`, id: `reply-${t}` });
    turns.push(turn({ turnId: `t${t}`, turnCount: t, requestedAt: ask.createdAt, startedAt: ask.createdAt, completedAt: reply.createdAt, userMessageId: ask.id }));
    rows.push([ask, call, reply]);
  }
  return { turns, rowsOf: (from: number, to: number): ThreadItem[] => rows.slice(from - 1, to).flat() };
}

/** A snapshot of `t` whose window holds turns `oldest`..n, with the history bounds a current host stamps. */
function windowed(t: ReturnType<typeof thread>, oldest: number, over: Partial<ThreadHistoryBounds> = {}) {
  return snapshot({ turns: t.turns, items: t.rowsOf(oldest, t.turns.length), history: { indexed: true, hasOlder: true, beforeCursor: "window", oldestRetainedOrdinal: oldest, totalTurns: t.turns.length, ...over } });
}

/** The cursor a host mints for a page that begins in turn `k` — inside it with `beforeSeq`, at its start without. */
const cursorAt = (t: ReturnType<typeof thread>, k: number, beforeSeq?: number): string =>
  encodeHistoryCursor({ threadId: "c1", beforeAnchorAt: t.turns[k - 1]!.requestedAt, beforeTurnId: `t${k}`, ...(beforeSeq === undefined ? {} : { beforeSeq }) });

const page = (items: ThreadItem[], beforeCursor: string | null): DaemonResponse =>
  ({ status: 200, body: { threadId: "c1", turns: [], items, checkpoints: [], page: { beforeCursor }, seq: 999 } satisfies ThreadHistoryPage });

/** A host answering each history request with the next of `answers`, then 404. */
function host(answers: DaemonResponse[]): FakeDaemonApi {
  let n = 0;
  return new FakeDaemonApi().on("GET", HISTORY, () => answers[n++] ?? { status: 404, body: { code: "NOT_FOUND", message: "no more pages" } });
}
const historyCalls = (api: FakeDaemonApi) => api.calls.filter((c) => c.path === HISTORY);

test("no page is read when the window already holds the range, when the host predates history, or when nothing is older", async () => {
  const t = thread(10);
  const api = host([]);
  // The window's oldest turn may be partial, so only a range starting after it is the window's alone.
  const covered = windowed(t, 7);
  const read = await readOlderHistory(api, "c1", covered, { start: 8, end: 10 });
  assert.equal(read.snapshot, covered, "the snapshot itself"); assert.equal(read.unavailable, null);
  const legacy = snapshot({ turns: t.turns, items: t.rowsOf(8, 10) }); // no `history`: an older host
  assert.deepEqual(await readOlderHistory(api, "c1", legacy, { start: 1, end: 10 }), { snapshot: legacy, unavailable: null });
  // An index that knows every turn of the thread says nothing is older: its word is taken.
  const nothingOlder = windowed(t, 8, { hasOlder: false, beforeCursor: null });
  assert.deepEqual(await readOlderHistory(api, "c1", nothingOlder, { start: 1, end: 10 }), { snapshot: nothingOlder, unavailable: null });
  const noTurns = windowed(thread(0), 1, { hasOlder: true });
  assert.deepEqual(await readOlderHistory(api, "c1", noTurns, { start: 1, end: 0 }), { snapshot: noTurns, unavailable: null }, "an empty range reads nothing");
  assert.equal(historyCalls(api).length, 0);
});

test("the first page ends at the window's boundary when the range reaches the window's oldest turn; its soft cap reaches one turn below the range", async () => {
  const t = thread(10);
  for (const [range, oldest] of [[{ start: 6, end: 10 }, 8], [{ start: 5, end: 8 }, 8], [{ start: 8, end: 8 }, 8]] as const) {
    const api = host([page(t.rowsOf(1, 7), null)]);
    const read = await readOlderHistory(api, "c1", windowed(t, oldest), range);
    const [call] = historyCalls(api);
    // The page ends inside turn 8, the window's oldest: counting that turn, turns 8 down to start − 1.
    assert.deepEqual(call!.query, { turns: String(oldest - range.start + 2) }, `${JSON.stringify(range)}: no cursor`);
    assert.equal(read.unavailable, null);
  }
});

test("a range that ends before the window's oldest turn: the first page ends where turn end + 1 begins, named by the snapshot's own turn record", async () => {
  const t = thread(10);
  // Turn 5 is older than the window; turn 8 IS the window's oldest turn, and none of it is in the range [5, 7], so its
  // evicted rows are not waded through before turn 7.
  for (const [range, next] of [[{ start: 2, end: 4 }, 5], [{ start: 5, end: 7 }, 8]] as const) {
    const api = host([page(t.rowsOf(1, range.end), null)]);
    const read = await readOlderHistory(api, "c1", windowed(t, 8), range);
    const [call] = historyCalls(api);
    // Turns end down to start − 1: the range and one turn below it.
    assert.equal(call!.query!.turns, String(range.end - range.start + 2), JSON.stringify(range));
    assert.deepEqual(decodeHistoryCursor(call!.query!.before!, "c1"), { threadId: "c1", beforeAnchorAt: t.turns[next - 1]!.requestedAt, beforeTurnId: `t${next}` }, `turn ${next}'s start, no in-turn bound`);
    assert.equal(read.unavailable, null);
  }
});

test("a page the soft cap ended at turn start − 1 names that turn with beforeSeq, as the host names every block: turn start is whole in one page", async () => {
  const t = thread(10);
  const api = host([page(t.rowsOf(3, 7), cursorAt(t, 3, 30))]);
  const read = await readOlderHistory(api, "c1", windowed(t, 8), { start: 4, end: 9 });
  assert.equal(historyCalls(api).length, 1);
  assert.deepEqual([historyCalls(api)[0]!.query!.turns, read.unavailable], ["6", null], "turns 8 down to 3");
});

test("the soft cap reaches one turn below the range, at most THREAD_HISTORY_MAX_TURNS, on every page", async () => {
  const t = thread(200);
  const api = host([page([], cursorAt(t, 120, 5)), page([], null)]);
  await readOlderHistory(api, "c1", windowed(t, 190), { start: 1, end: 200 });
  assert.deepEqual(historyCalls(api).map((c) => c.query!.turns), ["100", "100"]);
  // From turn 1 it asks for more turns than there are below: the host applies no cap, and its last page's cursor is null.
  const small = host([page(t.rowsOf(1, 3), null)]);
  await readOlderHistory(small, "c1", windowed(t, 190), { start: 1, end: 3 });
  assert.deepEqual(historyCalls(small).map((c) => c.query!.turns), ["4"]);
});

test("pages are followed by their beforeCursor until turn start is whole: an in-turn cursor must name an older turn", async () => {
  const t = thread(10);
  const cursors = [cursorAt(t, 3, 40), cursorAt(t, 2, 20), cursorAt(t, 1, 5)];
  const api = host([page(t.rowsOf(3, 7), cursors[0]!), page(t.rowsOf(2, 3), cursors[1]!), page(t.rowsOf(1, 2), cursors[2]!), page([], null)]);
  const read = await readOlderHistory(api, "c1", windowed(t, 8), { start: 2, end: 10 });
  const calls = historyCalls(api);
  // Inside turn 3, then inside turn 2 — still partial — then inside turn 1: turn 2 is whole.
  assert.deepEqual(calls.map((c) => c.query!.before), [undefined, cursors[0], cursors[1]]);
  assert.equal(read.unavailable, null);
  assert.deepEqual(read.snapshot.items.map((i) => i.id), t.rowsOf(1, 10).map((i) => i.id), "every row once, in log order");
});

test("pages are followed until turn start is whole: a cursor at a turn's start may name turn start itself", async () => {
  const t = thread(10);
  const cursors = [cursorAt(t, 3), cursorAt(t, 2), cursorAt(t, 1)];
  const api = host([page(t.rowsOf(3, 7), cursors[0]!), page(t.rowsOf(2, 2), cursors[1]!), page(t.rowsOf(1, 1), cursors[2]!)]);
  const read = await readOlderHistory(api, "c1", windowed(t, 8), { start: 2, end: 10 });
  assert.deepEqual(historyCalls(api).map((c) => c.query!.before), [undefined, cursors[0]], "the page from turn 2's start holds turn 2 whole");
  assert.equal(read.unavailable, null);
});

test("a null beforeCursor ends the walk: the pages reach the thread's first turn", async () => {
  const t = thread(10);
  const api = host([page(t.rowsOf(1, 7), null)]);
  const read = await readOlderHistory(api, "c1", windowed(t, 8), { start: 1, end: 10 });
  assert.equal(historyCalls(api).length, 1); assert.equal(read.unavailable, null);
  assert.deepEqual(read.snapshot.items.map((i) => i.id), t.rowsOf(1, 10).map((i) => i.id));
});

test(`at most ${HISTORY_PAGES_PER_READ} pages a read: the turns left partial are reported, and a host that never moves ends the walk too`, async () => {
  const t = thread(12);
  // Each page reaches one turn further back, inside it: after five, turn 6 is the oldest whole one.
  const api = host([10, 9, 8, 7, 6].map((k) => page(t.rowsOf(k, k), cursorAt(t, k, k * 10))));
  const read = await readOlderHistory(api, "c1", windowed(t, 11), { start: 2, end: 12 });
  assert.equal(historyCalls(api).length, HISTORY_PAGES_PER_READ);
  assert.deepEqual(read.unavailable, { turns: [2, 6], reason: "limit" });
  assert.deepEqual(read.snapshot.items.map((i) => i.id), t.rowsOf(6, 12).map((i) => i.id), "what the pages read is still served");
  // A range entirely below the window, the page limit reached before any of it: every turn of it is named.
  const stuck = host(Array.from({ length: 9 }, () => page([], cursorAt(t, 9, 90))));
  const none = await readOlderHistory(stuck, "c1", windowed(t, 11), { start: 1, end: 3 });
  assert.equal(historyCalls(stuck).length, HISTORY_PAGES_PER_READ, "the same cursor again and again: five pages, then it stops");
  assert.deepEqual(none.unavailable, { turns: [1, 3], reason: "limit" });
});

test("a page read that fails — 503 INDEX_UNAVAILABLE, another status, a throw, a body that is no page — is never an error: the window's rows are served and the turns left are named", async (t) => {
  const th = thread(10);
  const snap = windowed(th, 8);
  const logged = t.mock.method(console, "error", () => {});
  const failures: [string, DaemonResponse | (() => never)][] = [
    ["503 INDEX_UNAVAILABLE", { status: 503, body: { error: { code: "INDEX_UNAVAILABLE", message: "Older history is not available on this host right now." } } }],
    ["404 THREAD_NOT_FOUND", { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "gone" } } }],
    ["a thrown call", () => { throw new Error("socket hang up at /var/lib/orquester/daemon/agent-host.sock"); }],
    ["a body without items", { status: 200, body: { threadId: "c1", page: { beforeCursor: null } } }],
    ["a cursor that is not a string", { status: 200, body: { threadId: "c1", items: [], checkpoints: [], page: { beforeCursor: 7 } } }]
  ];
  for (const [what, answer] of failures) {
    const api = new FakeDaemonApi().on("GET", HISTORY, typeof answer === "function" ? answer : () => answer);
    const read = await readOlderHistory(api, "c1", snap, { start: 6, end: 10 });
    assert.equal(read.snapshot, snap, `${what}: the window alone`);
    // The window's oldest turn (8) may be partial: turns 6 to 8 were not read whole.
    assert.deepEqual(read.unavailable, { turns: [6, 8], reason: "unavailable" }, what);
  }
  assert.equal(logged.mock.callCount(), 1, "only the thrown call is logged, and never returned");
  // A failure after pages were read keeps them: the turns they hold whole are not named.
  const api = host([page(th.rowsOf(5, 7), cursorAt(th, 5, 50)), { status: 503, body: { error: { code: "INDEX_UNAVAILABLE", message: "rebuilding" } } }]);
  const partial = await readOlderHistory(api, "c1", snap, { start: 2, end: 10 });
  assert.deepEqual(partial.unavailable, { turns: [2, 5], reason: "unavailable" });
  assert.deepEqual(partial.snapshot.items.map((i) => i.id), th.rowsOf(5, 10).map((i) => i.id));
  // A cursor that names no turn this thread has started cannot be placed: the walk stops there.
  const foreign = host([page(th.rowsOf(5, 7), encodeHistoryCursor({ threadId: "c1", beforeAnchorAt: th.turns[0]!.requestedAt, beforeTurnId: "t-unknown", beforeSeq: 3 }))]);
  assert.deepEqual((await readOlderHistory(foreign, "c1", snap, { start: 2, end: 10 })).unavailable, { turns: [2, 8], reason: "unavailable" });
});

test("a page's rows without the fields the transcript reads are dropped, never read into a failed call; bounds that are not the host's read nothing", async () => {
  const t = thread(10);
  const malformed = [null, "row", { id: "no-stamp", kind: "message", role: "user", text: "x" }, { id: "no-kind", createdAt: t.turns[5]!.requestedAt, activityKind: "tool.started", summary: "s" },
    { kind: "activity", id: "no-activity-kind", summary: "s", createdAt: t.turns[5]!.requestedAt }, { kind: "message", id: "no-text", role: "assistant", createdAt: t.turns[5]!.requestedAt }];
  const api = host([{ status: 200, body: { threadId: "c1", turns: [], items: [...t.rowsOf(5, 7), ...malformed], checkpoints: [null, { turnId: "t5" }], page: { beforeCursor: null }, seq: 1 } }]);
  const read = await readOlderHistory(api, "c1", windowed(t, 8), { start: 5, end: 10 });
  assert.deepEqual(read.snapshot.items.map((i) => i.id), t.rowsOf(5, 10).map((i) => i.id), "the well-formed rows, in log order");
  assert.deepEqual([read.snapshot.checkpoints, read.unavailable], [[], null]);
  for (const over of [{ indexed: "yes" }, { hasOlder: 1 }, { oldestRetainedOrdinal: "8" }]) {
    const quiet = host([]);
    assert.deepEqual((await readOlderHistory(quiet, "c1", windowed(t, 8, over as never), { start: 1, end: 10 })).unavailable, null, JSON.stringify(over));
    assert.equal(historyCalls(quiet).length, 0, JSON.stringify(over));
  }
});

test("a host without a usable index: the range's turns with no row in the window are named, and nothing is read", async () => {
  const t = thread(10);
  const api = host([]);
  const unindexed = (items: ThreadItem[]) => snapshot({ turns: t.turns, items, history: { indexed: false, hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 } });
  assert.deepEqual((await readOlderHistory(api, "c1", unindexed(t.rowsOf(5, 10)), { start: 3, end: 10 })).unavailable, { turns: [3, 4], reason: "unavailable" });
  assert.deepEqual((await readOlderHistory(api, "c1", unindexed(t.rowsOf(3, 5).concat(t.rowsOf(7, 10))), { start: 3, end: 10 })).unavailable, { turns: [6, 6], reason: "unavailable" });
  // A span, first to last: turn 5 has rows, but it lies between two turns that have none.
  assert.deepEqual((await readOlderHistory(api, "c1", unindexed([...t.rowsOf(5, 5), ...t.rowsOf(7, 10)]), { start: 3, end: 10 })).unavailable, { turns: [3, 6], reason: "unavailable" });
  // One row is enough: turn 3 by its reply's turn id, turn 4 by its opening message alone (named by userMessageId).
  const [ask4] = t.rowsOf(4, 4);
  const thin = [t.rowsOf(3, 3).at(-1)!, ask4!, ...t.rowsOf(5, 10)];
  assert.equal((await readOlderHistory(api, "c1", unindexed(thin), { start: 3, end: 10 })).unavailable, null, "every turn has a row");
  assert.equal(historyCalls(api).length, 0);
});

test("an index that has not caught up with the thread — it knows fewer turns — cannot place the window: the turns up to the window's oldest are named, and nothing is read", async () => {
  const t = thread(10);
  const api = host([]);
  // The first host start after an index rebuild: the thread is not indexed at all yet.
  const fresh = windowed(t, 8, { hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 });
  const read = async (snap: ReturnType<typeof windowed>, start: number, end: number) => (await readOlderHistory(api, "c1", snap, { start, end })).unavailable;
  // With no ordinal from the host, the window's oldest activity row says where it begins: turn 8, maybe partial.
  assert.deepEqual(await read(fresh, 2, 3), { turns: [2, 3], reason: "unavailable" }, "a range below the window");
  assert.deepEqual(await read(fresh, 6, 10), { turns: [6, 8], reason: "unavailable" }, "up to the window's oldest turn");
  assert.deepEqual(await read(fresh, 8, 8), { turns: [8, 8], reason: "unavailable" });
  assert.equal(await read(fresh, 9, 10), null, "after it, the window's alone");
  // Caught up part of the way: the host's own ordinal, when it has one.
  const partway = windowed(t, 8, { hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: 7, totalTurns: 6 });
  assert.deepEqual(await read(partway, 1, 10), { turns: [1, 7], reason: "unavailable" });
  // Caught up: `hasOlder: false` is the host's word that nothing is older.
  assert.equal(await read(windowed(t, 8, { hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: 8, totalTurns: 10 }), 1, 10), null);
  // A window with no activity row at all cannot say where it begins: nothing is named for it.
  assert.equal(await read(snapshot({ turns: t.turns, items: t.rowsOf(8, 10).filter((i) => i.kind === "message"), history: fresh.history }), 1, 10), null);
  assert.equal(historyCalls(api).length, 0);
});

test("where the window begins is its oldest activity row that retention would drop — not a row it keeps whatever its age — and a turnless one is placed by its time", async () => {
  const t = thread(10);
  const api = host([]);
  const [ask2] = t.rowsOf(2, 2);
  const at = (item: ThreadItem, ms: number) => new Date(Date.parse(item.createdAt) + ms).toISOString();
  // Rows of turn 2 the fold keeps however old: an agent's launch and end, a compaction marker, an open async question,
  // and a subagent's own row (its own window). The parent's window begins in turn 8.
  const kept = [
    activity("task.started", { taskId: "a1", agentKind: "agent", title: "Explore" }, { turnId: "t2", createdAt: at(ask2!, 1) }),
    activity("context-compaction", { state: "compacted" }, { turnId: "t2", createdAt: at(ask2!, 2) }),
    activity("user-input.requested", { requestId: "q1", responseMode: "message", questions: [] }, { turnId: "t2", createdAt: at(ask2!, 3) }),
    activity("tool.completed", { itemType: "command_execution", toolUseId: "sub", status: "completed" }, { turnId: "t2", agentId: "a1", createdAt: at(ask2!, 4) }),
    activity("task.completed", { taskId: "a1", agentKind: "agent", status: "completed" }, { turnId: "t2", createdAt: at(ask2!, 5) })
  ];
  const bounds = { indexed: true, hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 };
  const window = snapshot({ turns: t.turns, items: [...kept, ...t.rowsOf(8, 10)], history: bounds });
  assert.deepEqual((await readOlderHistory(api, "c1", window, { start: 3, end: 10 })).unavailable, { turns: [3, 8], reason: "unavailable" });
  // Kept rows alone: the oldest activity row of any kind is all there is to go by.
  const onlyKept = snapshot({ turns: t.turns, items: [...kept, ...t.rowsOf(8, 10).filter((i) => i.kind === "message")], history: bounds });
  assert.deepEqual((await readOlderHistory(api, "c1", onlyKept, { start: 1, end: 10 })).unavailable, { turns: [1, 2], reason: "unavailable" });
  // A turnless row — a failure before the provider named the turn — belongs to the last turn requested before it.
  const [ask6] = t.rowsOf(6, 6);
  const failed = activity("provider.turn.start.failed", { detail: "x" }, { turnId: null, tone: "error", createdAt: at(ask6!, 1) });
  const turnless = snapshot({ turns: t.turns, items: [failed, ...t.rowsOf(8, 10)], history: bounds });
  assert.deepEqual((await readOlderHistory(api, "c1", turnless, { start: 1, end: 10 })).unavailable, { turns: [1, 6], reason: "unavailable" });
  assert.equal(historyCalls(api).length, 0);
});

test("the safety net: after a walk that reported nothing, a turn of the range with no row in the merged snapshot is named — the host's empty page with a null cursor included", async () => {
  const t = thread(10);
  // A host that could not plan a block, or read one back whole, answers an empty page with a null cursor: to the walk
  // alone, that reads as "the thread's first turn reached".
  const empty = host([page([], null)]);
  const read = await readOlderHistory(empty, "c1", windowed(t, 8), { start: 2, end: 9 });
  assert.equal(historyCalls(empty).length, 1);
  assert.deepEqual(read.unavailable, { turns: [2, 7], reason: "unavailable" });
  // A page that brought some of the range back: only the turns still without a row.
  const some = await readOlderHistory(host([page(t.rowsOf(5, 7), null)]), "c1", windowed(t, 8), { start: 2, end: 9 });
  assert.deepEqual(some.unavailable, { turns: [2, 4], reason: "unavailable" });
  assert.deepEqual(some.snapshot.items.map((i) => i.id), t.rowsOf(5, 10).map((i) => i.id), "the rows read are served");
});

test("the merge: a row a page repeats keeps the window's copy, once, and every row sorts into log order; checkpoints by turn id", () => {
  const ask = message("user", "go", { turnId: "t1" });
  const started = activity("tool.started", { itemType: "command_execution", toolUseId: "tu1", status: "inProgress" }, { turnId: "t1", tone: "tool" });
  const progress = activity("task.progress", { taskId: "a", detail: "early" }, { turnId: "t1", id: "task-progress:a" });
  const completed = activity("tool.completed", { itemType: "command_execution", toolUseId: "tu1", status: "completed" }, { turnId: "t1", tone: "tool" });
  const reply = message("assistant", "done", { turnId: "t1" });
  // A row replaced in place carries a fresh stamp: the window's copy of the progress row is newer than the completion.
  const fresh = new Date(Date.parse(completed.createdAt) + 500).toISOString();
  const replaced = { ...progress, payload: { taskId: "a", detail: "late" }, createdAt: fresh, updatedAt: fresh };
  const cp = (turnId: string | null, completedAt: string, path: string) => ({ turnId, checkpointTurnCount: 1, checkpointRef: `refs/${path}`, status: "ready" as const, files: [{ path, additions: 1, deletions: 0 }], assistantMessageId: null, completedAt });
  const snap = snapshot({ items: [replaced, completed, reply], checkpoints: [cp("t1", reply.createdAt, "window.ts"), cp(null, reply.createdAt, "turnless.ts")] });
  // Newest page first, as they are read; the two pages share the tool's start row.
  const merged = mergeHistoryPages(snap, [
    { items: [started, progress], checkpoints: [cp("t1", ask.createdAt, "page.ts"), cp("t0", ask.createdAt, "older.ts")] },
    { items: [ask, started], checkpoints: [cp(null, ask.createdAt, "page-turnless.ts")] }
  ]);
  assert.deepEqual(merged.items.map((i) => i.id), [ask.id, started.id, completed.id, progress.id, reply.id], "each row once, in log order: the progress row at its window copy's time");
  assert.equal((merged.items.find((i) => i.id === progress.id) as { payload: { detail: string } }).payload.detail, "late", "the window's copy of a row a page repeats");
  assert.deepEqual(merged.checkpoints.map((c) => c.files[0]!.path), ["older.ts", "window.ts", "turnless.ts"], "the window's checkpoint for t1 wins; a page's without a turn id is not kept");
  assert.equal(mergeHistoryPages(snap, []), snap, "no page, the snapshot itself");
  assert.deepEqual(snap.items, [replaced, completed, reply], "the snapshot is not touched");
});

test("the hint names the turns, why, and — for the page limit — the call that reads them", () => {
  assert.equal(unavailableHint({ turns: [3, 5], reason: "unavailable" }, 5), "Turns 3–5 could not be read whole: older turns are unavailable on this host right now. Try again later.");
  assert.equal(unavailableHint({ turns: [4, 4], reason: "unavailable" }, 9), "Turn 4 could not be read whole: older turns are unavailable on this host right now. Try again later.");
  // The limit, with turns after them read whole: the call that reads the rest ends before this one did.
  assert.equal(unavailableHint({ turns: [2, 6], reason: "limit" }, 12), `Turns 2–6 could not be read whole: one call reads at most ${HISTORY_PAGES_PER_READ} pages of older history. Read them with beforeTurn: 7, turns: 5.`);
  assert.equal(unavailableHint({ turns: [9, 9], reason: "limit" }, 10), `Turn 9 could not be read whole: one call reads at most ${HISTORY_PAGES_PER_READ} pages of older history. Read it with beforeTurn: 10, turns: 1.`);
  // The limit inside the range's last turn: asking again would read the same pages, so the turns before it are named.
  const large = `larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned.`;
  assert.equal(unavailableHint({ turns: [3, 3], reason: "limit" }, 3), `Turn 3 is ${large}`);
  assert.equal(unavailableHint({ turns: [4, 5], reason: "limit" }, 5), `Turn 5 is ${large} Read turn 4 with beforeTurn: 5, turns: 1.`);
  assert.equal(unavailableHint({ turns: [1, 5], reason: "limit" }, 5), `Turn 5 is ${large} Read turns 1–4 with beforeTurn: 5, turns: 4.`);
});

test("the page limit inside the range's last turn — every page stays in turn end — says that turn is larger than one call, and never repeats the call", async () => {
  const t = thread(12);
  // Turn 9 alone outlasts five pages: each ends a little further inside it.
  const inside = () => host([90, 80, 70, 60, 50].map((seq) => page([], cursorAt(t, 9, seq))));
  const alone = await readOlderHistory(inside(), "c1", windowed(t, 11), { start: 9, end: 9 });
  assert.deepEqual(alone.unavailable, { turns: [9, 9], reason: "limit" });
  assert.equal(unavailableHint(alone.unavailable!, 9), `Turn 9 is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned.`);
  const wider = await readOlderHistory(inside(), "c1", windowed(t, 11), { start: 6, end: 9 });
  assert.deepEqual(wider.unavailable, { turns: [6, 9], reason: "limit" });
  assert.equal(unavailableHint(wider.unavailable!, 9), `Turn 9 is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned. Read turns 6–8 with beforeTurn: 9, turns: 3.`);
});
