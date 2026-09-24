import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentChatRoutes, startedTurns, THREAD_HISTORY_DEFAULT_TURNS, THREAD_HISTORY_MAX_TURNS, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import { isAgentChatCommandError } from "../agent-host/orchestration/errors.ts";
import { createFakeThreadIndex, type FakeThreadIndex } from "../agent-host/orchestration/testing/fake-index.ts";
import { createTestHost, type TestHost } from "../agent-host/orchestration/testing/index.ts";
import type { AppendableDomainEvent } from "../agent-host/services.ts";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "./daemon-api.ts";
import { chatSummary } from "./fixtures.ts";
import { HISTORY_PAGES_PER_READ, readOlderHistory, unavailableHint } from "./history.ts";
import { readThread } from "./reads.ts";
import type { ToolContext } from "./tool.ts";
import { messageTools } from "./tools/messages.ts";

/*
 * The MCP's older-history walk (history.ts) against the REAL orchestrator's `readHistory`: its block planning, the
 * `turns` soft cap (`capTurnOf`), the cursors it mints (`blockCursor`, always with `beforeSeq`) and the bounds it
 * stamps on a snapshot (`historyBoundsOf`) — over the in-memory store and index the host's own tests use. The unit tests
 * (history.test.ts) pin the walk against pages written by hand; these pin that the two sides agree.
 */

const THREAD = "thread-1";
const PROJECT = "/work/project";

/**
 * The daemon routes read_transcript reads, answered as the host's HTTP server answers them
 * (agent-host/server/http-server.ts): `…/thread` is `readThread`, `…/history` is `readHistory` with `before` passed
 * through and `turns` clamped, and a command error is its envelope at its status. Every body crosses JSON, as it
 * crosses the socket. It keeps the query of every history read.
 */
function hostApi(host: TestHost): DaemonApi & { historyReads: Record<string, string>[] } {
  const wire = (status: number, body: unknown): DaemonResponse => ({ status, body: JSON.parse(JSON.stringify(body)) as unknown });
  const historyReads: Record<string, string>[] = [];
  return {
    fsRoot: "/work",
    workspacesDir: "/work",
    historyReads,
    async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string> }): Promise<DaemonResponse> {
      try {
        if (method === "GET" && path === "/api/sessions") return wire(200, [chatSummary({ id: THREAD, projectPath: PROJECT, cwd: PROJECT })]);
        if (method === "GET" && path === agentChatRoutes.thread(THREAD)) return wire(200, await host.orchestrator.readThread(THREAD));
        if (method === "GET" && path === agentChatRoutes.history(THREAD)) {
          const query = opts?.query ?? {};
          historyReads.push(query);
          const turns = Number.parseInt(query.turns ?? "", 10);
          return wire(200, await host.orchestrator.readHistory(THREAD, {
            ...(query.before ? { before: query.before } : {}),
            turns: Number.isFinite(turns) ? Math.min(THREAD_HISTORY_MAX_TURNS, Math.max(1, turns)) : THREAD_HISTORY_DEFAULT_TURNS
          }));
        }
      } catch (error) {
        if (isAgentChatCommandError(error)) return wire(error.status, error.toEnvelope());
        throw error;
      }
      return wire(404, { error: { code: "NOT_FOUND", message: `${method} ${path}` } });
    },
    async uploadAttachment() { throw new Error("not a route these tests read"); },
    subscribe: () => () => {}
  };
}

/** An event as ingestion hands it to the orchestrator's sink. */
function sinkEvent<T extends AppendableDomainEvent["type"]>(host: TestHost, eventId: string, type: T, payload: Extract<AppendableDomainEvent, { type: T }>["payload"]): AppendableDomainEvent {
  return { eventId, threadId: THREAD, type, payload, occurredAt: host.clock.nowIso(), commandId: null, causationEventId: null, metadata: {} } as AppendableDomainEvent;
}

/**
 * Turn `n`, seeded as a real thread gets it (§5.1): its prompt, written with the idle session's null turnId and linked
 * back by `userMessageId`; the provider's id adopted by a running session; `rows` activity rows, one stamp apart; the
 * reply; the turn settled.
 */
async function seedTurn(host: TestHost, n: number, rows: number): Promise<void> {
  const turnId = `turn-${n}`;
  host.clock.advance(1_000);
  for (const event of [
    sinkEvent(host, `ask-${n}:sent`, "thread.message-sent", { messageId: `ask-${n}`, role: "user", text: `ask ${n}`, streaming: false, turnId: null }),
    sinkEvent(host, `ask-${n}:start`, "thread.turn-start-requested", { turnId: null, messageId: `ask-${n}`, interactionMode: "default" }),
    sinkEvent(host, `${turnId}:running`, "thread.session-set", { session: { status: "running", activeTurnId: turnId } })
  ]) await host.orchestrator.ingestionSink(THREAD, [event]);
  const activities = Array.from({ length: rows }, (_, i) => {
    host.clock.advance(1);
    const at = host.clock.nowIso();
    return sinkEvent(host, `${turnId}-row-${i}`, "thread.activity-appended", {
      activity: { kind: "activity", id: `${turnId}-row-${i}`, tone: "info", activityKind: "runtime.warning", summary: `row ${i} of turn ${n}`, payload: {}, turnId, createdAt: at, updatedAt: at }
    });
  });
  if (activities.length) await host.orchestrator.ingestionSink(THREAD, activities);
  host.clock.advance(1);
  for (const event of [
    sinkEvent(host, `reply-${n}:sent`, "thread.message-sent", { messageId: `reply-${n}`, role: "assistant", text: `reply ${n}`, streaming: false, turnId }),
    sinkEvent(host, `${turnId}:ready`, "thread.session-set", { session: { status: "ready", activeTurnId: null } })
  ]) await host.orchestrator.ingestionSink(THREAD, [event]);
}

/** A host whose one thread has turns of the given sizes, in activity rows, seeded through the sink. */
async function threadOf(rowsPerTurn: readonly number[], index: FakeThreadIndex = createFakeThreadIndex()): Promise<{ host: TestHost; index: FakeThreadIndex; api: ReturnType<typeof hostApi> }> {
  const host = createTestHost({ index });
  await host.createThread({ threadId: THREAD });
  for (const [i, rows] of rowsPerTurn.entries()) await seedTurn(host, i + 1, rows);
  await host.settle();
  return { host, index, api: hostApi(host) };
}

/** Every row the log appended for turns `from`..`to`: its activities and its messages, the prompt included. */
function logRowsOf(host: TestHost, from: number, to: number): string[] {
  const inRange = (turnId: string | null): boolean => {
    const n = turnId === null ? NaN : Number(turnId.replace("turn-", ""));
    return n >= from && n <= to;
  };
  return host.store.logs.get(THREAD)!.flatMap((event) => {
    if (event.type === "thread.activity-appended") return inRange(event.payload.activity.turnId) ? [event.payload.activity.id] : [];
    if (event.type === "thread.message-sent") {
      const prompt = /^ask-(\d+)$/.exec(event.payload.messageId);
      const n = prompt ? Number(prompt[1]) : NaN;
      return (prompt ? n >= from && n <= to : inRange(event.payload.turnId)) ? [event.payload.messageId] : [];
    }
    return [];
  });
}

/** The ids `snap` is missing of the log's rows of turns `from`..`to`: none when the range was read whole. */
function missingOf(host: TestHost, snap: ThreadSnapshotPayload, from: number, to: number): string[] {
  const held = new Set(snap.items.map((item) => item.id));
  return logRowsOf(host, from, to).filter((id) => !held.has(id));
}

/** One walk: the snapshot read fresh, then `readOlderHistory` over `[start, end]`, with the history reads it made. */
async function walk(api: ReturnType<typeof hostApi>, start: number, end: number) {
  const snap = await readThread(api, THREAD);
  const before = api.historyReads.length;
  const read = await readOlderHistory(api, THREAD, snap, { start, end });
  return { snap, ...read, pages: api.historyReads.length - before };
}

describe("read_transcript's older history against the real orchestrator (design 2026-09-23, C)", () => {
  it("a small range below the window is read in ONE page, every log row of its turns present", async () => {
    // Twenty turns of 60 rows: the window keeps the last 500–550 parent rows, so the first eleven or so turns aged out.
    const { host, api } = await threadOf(Array.from({ length: 20 }, () => 60));
    const snap = await readThread(api, THREAD);
    const oldest = snap.history?.oldestRetainedOrdinal;
    assert.equal(snap.history?.hasOlder, true);
    assert.ok(typeof oldest === "number" && oldest > 8, `the window starts in turn ${oldest}`);
    assert.ok(missingOf(host, snap, 1, oldest - 1).length > 0, "the turns below the window are not in it");
    // Every range of one to four turns that needs a page — it starts at or before the window's oldest turn, which may be
    // partial — ending at most one turn past it: turn start − 1 and the range together are well under the 400-activity
    // block, so the soft cap ends the page there and turn start is whole on it.
    for (let size = 1; size <= 4; size += 1) {
      for (let start = 1; start <= oldest && start + size - 1 <= oldest + 1; start += 1) {
        const end = start + size - 1;
        const r = await walk(api, start, end);
        const where = `[${start}, ${end}]`;
        assert.equal(r.pages, 1, `${where}: one page`);
        assert.equal(r.unavailable, null, `${where}: read whole`);
        assert.deepEqual(missingOf(host, r.snapshot, start, end), [], `${where}: every log row of its turns`);
      }
    }
    await host.stop();
  });

  it("a range from turn 1 walks every block down to the log's start, where the host's cursor is null", async () => {
    const { host, api } = await threadOf(Array.from({ length: 20 }, () => 60));
    const oldest = (await readThread(api, THREAD)).history!.oldestRetainedOrdinal!;
    const r = await walk(api, 1, oldest);
    // Some 650 rows aged out: two blocks of at most 400 activities, no soft cap from turn 1.
    assert.equal(r.pages, 2);
    assert.deepEqual(api.historyReads.map((q) => q.turns), [String(oldest + 1), String(oldest + 1)]);
    assert.equal(r.unavailable, null);
    assert.deepEqual(missingOf(host, r.snapshot, 1, oldest), []);
    await host.stop();
  });

  it("paging back by olderTurns through the tool never skips a turn, however much each read sheds", async () => {
    const { host, api } = await threadOf(Array.from({ length: 20 }, () => 60));
    const read = messageTools.find((t) => t.name === "read_transcript")!;
    const ctx: ToolContext = { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.now() };
    const shown = new Set<number>();
    let beforeTurn: number | undefined;
    let shed = 0;
    for (let call = 0; call < 40; call += 1) {
      // Five turns asked, about two fit: the shed drops the oldest rows of every read.
      const r = await read.run({ sessionId: THREAD, turns: 5, include: ["tools", "activity"], maxChars: 15_000, ...(beforeTurn === undefined ? {} : { beforeTurn }) }, ctx);
      assert.equal(r.unavailableTurns, undefined, `call ${call}: every turn asked was read`);
      const [from, to] = r.coveredTurns as [number, number];
      for (let n = from; n <= to; n += 1) shown.add(n);
      if (r.truncated) shed += 1;
      assert.equal(r.olderTurns, from - 1, `call ${call}: counted back from the first turn shown`);
      assert.ok(beforeTurn === undefined || r.olderTurns < beforeTurn - 1, `call ${call}: always moves back`);
      if (r.olderTurns === 0) break;
      beforeTurn = r.olderTurns + 1;
    }
    assert.ok(shed > 5, `the reads shed (${shed})`);
    assert.deepEqual([...shown].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1), "every turn was shown");
    await host.stop();
  });

  it("a turn larger than five pages: its latest rows are returned, and the hint names the call for the turns before it", async () => {
    // Turn 3 alone is 2 600 rows, entirely below the window; turn 5's evicted part is 2 500 rows below the window's start.
    const { host, api } = await threadOf([10, 10, 2_600, 10, 3_000]);
    const snap = await readThread(api, THREAD);
    assert.equal(snap.history?.oldestRetainedOrdinal, 5, "the window starts inside turn 5");

    const large = await walk(api, 3, 3);
    assert.equal(large.pages, HISTORY_PAGES_PER_READ);
    assert.deepEqual(large.unavailable, { turns: [3, 3], reason: "limit" });
    assert.equal(unavailableHint(large.unavailable!, 3), `Turn 3 is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned.`);
    // Five blocks of 400: exactly its latest 2 000 rows.
    const turn3 = logRowsOf(host, 3, 3).filter((id) => id.includes("-row-"));
    const held = new Set(large.snapshot.items.map((item) => item.id));
    assert.deepEqual(turn3.filter((id) => held.has(id)), turn3.slice(-2_000));

    const wider = await walk(api, 1, 3);
    assert.deepEqual(wider.unavailable, { turns: [1, 3], reason: "limit" });
    const hint = unavailableHint(wider.unavailable!, 3);
    assert.equal(hint, `Turn 3 is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned. Read turns 1–2 with beforeTurn: 3, turns: 2.`);
    // The call the hint names reads turns 1 and 2 whole, in one page.
    const rest = await walk(api, 1, 2);
    assert.deepEqual([rest.pages, rest.unavailable, missingOf(host, rest.snapshot, 1, 2)], [1, null, []]);

    // The turn just before the window's oldest one is read from that turn's start: walking down from the window's
    // boundary would spend all five pages inside turn 5's evicted rows and never reach turn 4.
    const before = await walk(api, 4, 4);
    assert.deepEqual([before.pages, before.unavailable, missingOf(host, before.snapshot, 4, 4)], [1, null, []]);
    await host.stop();
  });

  it("restarted onto a fresh index: the turns the window no longer holds are named until the catch-up, then read whole", async () => {
    const first = await threadOf(Array.from({ length: 20 }, () => 60));
    // Where the window begins, as a caught-up index says.
    const oldest = (await readThread(first.api, THREAD)).history!.oldestRetainedOrdinal!;
    await first.host.stop();
    // The next host starts on an empty index — as after the schema bump that rebuilds every index — and has not caught
    // this thread up yet.
    const index = createFakeThreadIndex();
    const host = createTestHost({ store: first.host.store, index });
    const api = hostApi(host);
    const snap = await readThread(api, THREAD);
    assert.deepEqual(snap.history, { indexed: true, hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 });
    const turnCount = startedTurns(snap.turns).length;

    const early = await walk(api, 2, 4);
    assert.equal(early.pages, 0, "nothing to page yet");
    assert.deepEqual(early.unavailable, { turns: [2, 4], reason: "unavailable" });
    assert.ok(missingOf(host, early.snapshot, 2, 4).length > 0, "those turns really are partial");
    assert.equal(unavailableHint(early.unavailable!, 4), "Turns 2–4 could not be read whole: older turns are unavailable on this host right now. Try again later.");
    // A range reaching the window's oldest turn names the turns up to it; one after it is the window's alone.
    const reaching = await walk(api, oldest - 1, oldest + 1);
    assert.deepEqual(reaching.unavailable, { turns: [oldest - 1, oldest], reason: "unavailable" });
    assert.equal((await walk(api, oldest + 1, turnCount)).unavailable, null);

    await index.catchUp({ threadId: THREAD, projectPath: PROJECT, title: "Test thread", logSeq: await host.store.lastSeq(THREAD), read: (cursor) => host.store.readEventsFrom(THREAD, cursor) });
    const caughtUp = await walk(api, 2, 4);
    assert.equal(caughtUp.snap.history?.hasOlder, true);
    assert.equal(caughtUp.snap.history?.oldestRetainedOrdinal, oldest);
    assert.deepEqual([caughtUp.pages, caughtUp.unavailable, missingOf(host, caughtUp.snapshot, 2, 4)], [1, null, []]);
    await host.stop();
  });
});
