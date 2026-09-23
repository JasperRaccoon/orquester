/**
 * The thread store's indexed history (design 2026-09-23 §C "History page",
 * "Client"): paging older turns in above the window, resetting on a new
 * snapshot, revealing a turn for the command palette's search hit — and the
 * bridge that keeps the pages joined to a window that keeps evicting (fold
 * performance, "Client — the history bridge"), with its cap.
 *
 * `history.logic.test.ts` owns the pure rules; this file owns the wiring —
 * which request goes out, when, and what the slice and the rows look like
 * after it answers.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  type AdapterCapabilities,
  type AgentChatStreamFrame,
  type DomainEvent,
  type ProviderSnapshot,
  type ThreadActivityItem,
  type ThreadHistoryBounds,
  type ThreadHistoryPage,
  type ThreadHistoryQuery,
  type ThreadItem,
  type ThreadReadResponse,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import { deriveTimelineEntriesFromItems } from "./entries.logic";
import { canLoadOlderHistory } from "./history.logic";
import { providersStore, resetProvidersStore } from "./providers";
import { deriveTimelineRows } from "./rows.logic";
import {
  createThreadStore,
  resetThreadRetention,
  type AgentChatThreadState,
  type ThreadStore,
  type ThreadStoreDeps
} from "./store";
import { AgentChatCommandError, type AgentChatTransport } from "./transport";
import {
  activity,
  ev,
  foldTurn,
  head,
  historyPage,
  historyTurn,
  message,
  resetBuilders,
  snapshot,
  stamp
} from "./test-helpers";

type Destroyable = ThreadStore & { destroy?: (options?: { retain?: boolean }) => void };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeTransport() {
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  const historyCalls: Array<{ sessionId: string; query: ThreadHistoryQuery }> = [];
  const pending: Array<Deferred<ThreadHistoryPage>> = [];
  const posted: Array<{ name: string; body: Record<string, unknown> }> = [];
  let readAnswer: () => ThreadReadResponse = () => ({ kind: "snapshot", thread: snapshot() });
  let reads = 0;

  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command(_sessionId, name, body) {
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    async switchAccount() {
      return { seq: 0 };
    },
    async read() {
      reads += 1;
      return readAnswer();
    },
    async readItem() {
      throw new Error("unused");
    },
    readHistory(sessionId, query) {
      historyCalls.push({ sessionId, query });
      const answer = deferred<ThreadHistoryPage>();
      pending.push(answer);
      return answer.promise;
    },
    async search() {
      throw new Error("unused");
    },
    async turnDiff() {
      throw new Error("unused");
    },
    async providers() {
      return { providers: [], hostInstanceId: "h1" };
    },
    async refreshProvider() {
      throw new Error("unused");
    },
    async upload() {
      return { type: "file", id: "/a/b", name: "b", sizeBytes: 1 };
    }
  };

  return {
    transport,
    posted,
    historyCalls,
    push: (frame: AgentChatStreamFrame) => onFrame?.(frame),
    /** Answer the oldest unanswered `GET …/history`. */
    answer(page: ThreadHistoryPage): void {
      const next = pending.shift();
      assert.ok(next, "no history request is waiting for an answer");
      next.resolve(page);
    },
    fail(error: unknown): void {
      const next = pending.shift();
      assert.ok(next, "no history request is waiting for an answer");
      next.reject(error);
    },
    get waiting(): number {
      return pending.length;
    },
    /** What `GET …/thread` answers from now on — evaluated per call. */
    answerReadsWith(answer: () => ThreadReadResponse): void {
      readAnswer = answer;
    },
    get reads(): number {
      return reads;
    }
  };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Turn the event loop until `predicate` holds — never a sleep. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 100 && !predicate(); turn += 1) {
    await settle();
  }
  assert.ok(predicate(), `never happened: ${label}`);
}

async function open(
  sessionId = "s1",
  overrides: Partial<Omit<ThreadStoreDeps, "transport">> = {}
): Promise<{
  store: Destroyable;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const store = createThreadStore(sessionId, {
    transport: fake.transport,
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    now: () => stamp(1),
    delay: async () => {},
    ...overrides
  }) as Destroyable;
  await flush();
  return { store, fake, state: () => store.getState() };
}

const bounds = (overrides: Partial<ThreadHistoryBounds> = {}): ThreadHistoryBounds => ({
  indexed: true,
  hasOlder: true,
  beforeCursor: "cursor-window",
  oldestRetainedOrdinal: 3,
  totalTurns: 3,
  ...overrides
});

const FOLD_TURNS = [foldTurn("t1", "u1"), foldTurn("t2", "u2"), foldTurn("t3", "u3")];

/** The window holds turn 3; turns 1–2 are only in the log. */
const windowSnapshot = (overrides: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload =>
  snapshot({
    items: [
      message("user", "third", { id: "u3", createdAt: stamp(30) }),
      message("assistant", "three", { id: "a3", turnId: "t3", createdAt: stamp(31) })
    ],
    turns: FOLD_TURNS,
    seq: 10,
    history: bounds(),
    ...overrides
  });

/** Turns 1–2, the page just below the window. */
const turnsOneAndTwo = (overrides: Partial<ThreadHistoryPage> = {}): ThreadHistoryPage =>
  historyPage({
    items: [
      message("user", "first", { id: "u1", createdAt: stamp(10) }),
      message("assistant", "one", { id: "a1", turnId: "t1", createdAt: stamp(11) }),
      message("user", "second", { id: "u2", createdAt: stamp(20) }),
      message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(21) })
    ],
    turns: [
      historyTurn("t1", 1, { userMessageId: "u1" }),
      historyTurn("t2", 2, { userMessageId: "u2" })
    ],
    page: { beforeCursor: null },
    seq: 10,
    ...overrides
  });

function synchronize(
  fake: ReturnType<typeof fakeTransport>,
  thread: ThreadSnapshotPayload = windowSnapshot()
): void {
  fake.push({ kind: "snapshot", thread });
  fake.push({ kind: "synchronized", hostInstanceId: "h1" });
}

const rowIds = (state: AgentChatThreadState): string[] => state.rows.map((row) => row.id);

const capabilities: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "native" },
  supportsConversationRollback: true
};

beforeEach(() => {
  resetBuilders();
  resetThreadRetention();
});

afterEach(() => {
  resetProvidersStore();
  resetThreadRetention();
});

describe("the history slice", () => {
  it("reads the bounds off the snapshot, with nothing loaded yet", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    assert.deepEqual(state().slice.history.bounds, bounds());
    assert.deepEqual(state().slice.history.pages, []);
    assert.equal(state().slice.history.loading, false);
    assert.equal(state().slice.history.error, null);
  });

  it("loads the page just below the window and paints it above the live rows", async () => {
    const { fake, state } = await open();
    synchronize(fake);

    const loading = state().actions.loadOlderHistory();
    assert.equal(state().slice.history.loading, true, "the row spins from the first moment");
    assert.deepEqual(fake.historyCalls, [
      { sessionId: "s1", query: { before: "cursor-window", turns: 20 } }
    ]);

    fake.answer(turnsOneAndTwo());
    await loading;

    assert.equal(state().slice.history.loading, false);
    assert.equal(state().slice.history.pages.length, 1);
    assert.deepEqual(rowIds(state()), ["u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  it("pages by the oldest page's cursor and keeps the pages oldest first", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const turnsThreeAndFour = historyPage({
      items: [message("user", "older", { id: "u-older", createdAt: stamp(25) })],
      turns: [historyTurn("t2b", 3, { userMessageId: "u-older" })],
      page: { beforeCursor: "cursor-page-1" }
    });

    const first = state().actions.loadOlderHistory();
    fake.answer(turnsThreeAndFour);
    await first;
    const second = state().actions.loadOlderHistory();
    assert.deepEqual(fake.historyCalls[1]?.query, { before: "cursor-page-1", turns: 20 });
    fake.answer(turnsOneAndTwo());
    await second;

    assert.deepEqual(
      state().slice.history.pages.map((page) => page.page.beforeCursor),
      [null, "cursor-page-1"]
    );
    assert.deepEqual(rowIds(state()), ["u1", "a1", "u2", "a2", "u-older", "u3", "a3"]);

    await state().actions.loadOlderHistory();
    assert.equal(fake.historyCalls.length, 2, "the page that reached turn 1 ends the paging");
  });

  it("shares one request between overlapping loads", async () => {
    const { fake, state } = await open();
    synchronize(fake);

    const first = state().actions.loadOlderHistory();
    const second = state().actions.loadOlderHistory();
    assert.equal(fake.historyCalls.length, 1);
    fake.answer(turnsOneAndTwo());
    await Promise.all([first, second]);
    assert.equal(state().slice.history.pages.length, 1);
  });

  it("asks nothing when the snapshot offers nothing older", async () => {
    for (const thread of [
      windowSnapshot({ history: bounds({ hasOlder: false }) }),
      windowSnapshot({ history: bounds({ indexed: false, hasOlder: false }) }),
      windowSnapshot({ history: undefined })
    ]) {
      const { fake, state } = await open();
      synchronize(fake, thread);
      await state().actions.loadOlderHistory();
      assert.equal(fake.historyCalls.length, 0, JSON.stringify(thread.history));
    }
  });

  it("records a readable error, keeps what it has, and clears it on the next success", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const loaded = state().actions.loadOlderHistory();
    fake.answer(turnsOneAndTwo({ page: { beforeCursor: "cursor-page-1" } }));
    await loaded;

    const failing = state().actions.loadOlderHistory();
    fake.fail(new AgentChatCommandError(503, "INDEX_UNAVAILABLE", "index is rebuilding"));
    await failing;
    assert.match(state().slice.history.error ?? "", /unavailable/i);
    assert.equal(state().slice.history.loading, false);
    assert.equal(state().slice.history.pages.length, 1, "the loaded page survives the failure");
    assert.equal(state().slice.errorBanner, null, "a history read is not a thread-level error");

    const retry = state().actions.loadOlderHistory();
    fake.answer(historyPage({ page: { beforeCursor: null } }));
    await retry;
    assert.equal(state().slice.history.error, null);
  });

  it("recovers from a transport that throws before it answers, and can page again", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const readHistory = fake.transport.readHistory;
    let throwNow = true;
    fake.transport.readHistory = (sessionId, query, signal) => {
      if (throwNow) {
        throwNow = false;
        throw new Error("the bridge refused the request");
      }
      return readHistory(sessionId, query, signal);
    };

    await state().actions.loadOlderHistory();
    assert.equal(state().slice.history.loading, false);
    assert.ok(state().slice.history.error, "the failure is recorded");

    const retry = state().actions.loadOlderHistory();
    assert.equal(fake.historyCalls.length, 1, "a new request goes out — nothing stayed latched");
    fake.answer(turnsOneAndTwo());
    await retry;
    assert.equal(state().slice.history.pages.length, 1);
  });

  it("drops the pages and re-reads the bounds on a new snapshot", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const loaded = state().actions.loadOlderHistory();
    fake.answer(turnsOneAndTwo());
    await loaded;

    fake.push({
      kind: "snapshot",
      thread: windowSnapshot({ seq: 12, history: bounds({ beforeCursor: "cursor-after-restart" }) })
    });

    assert.deepEqual(state().slice.history.pages, []);
    assert.equal(state().slice.history.bounds?.beforeCursor, "cursor-after-restart");
    assert.deepEqual(rowIds(state()), ["u3", "a3"]);
  });

  it("discards a page that lands after the snapshot it was asked against was replaced", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const loading = state().actions.loadOlderHistory();
    fake.push({ kind: "snapshot", thread: windowSnapshot({ seq: 12 }) });

    fake.answer(turnsOneAndTwo());
    await loading;

    assert.deepEqual(state().slice.history.pages, [], "a page of a superseded log is dropped");
    assert.equal(state().slice.history.loading, false);
  });

  it("renders a turn split across the page and the window as prompt → early work → later work", async () => {
    const { fake, state } = await open();
    // Turn 5 outgrew the window: the window still holds its prompt and its
    // later work; the page just below holds the same prompt and the early
    // tool calls the window has already evicted.
    const windowPrompt = message("user", "fix the bug", { id: "u5", createdAt: stamp(50) });
    const tool = (id: string, summary: string, at: number) =>
      activity("tool.completed", { status: "completed" }, { id, turnId: "t5", summary, createdAt: stamp(at) });
    synchronize(
      fake,
      windowSnapshot({
        items: [
          windowPrompt,
          tool("x7", "Edit src/a.ts", 57),
          message("assistant", "fixed", { id: "a5", turnId: "t5", createdAt: stamp(58) })
        ],
        turns: [foldTurn("t4", "u4"), foldTurn("t5", "u5")]
      })
    );
    const loading = state().actions.loadOlderHistory();
    fake.answer(
      historyPage({
        items: [
          message("user", "fix the bug", { id: "u5", createdAt: stamp(50) }),
          tool("x5", "Read src/a.ts", 51),
          tool("x6", "Grep bug", 52)
        ],
        turns: [historyTurn("t5", 2, { userMessageId: "u5" })]
      })
    );
    await loading;

    // Settled: one "Worked for …" fold, right under the prompt.
    assert.deepEqual(rowIds(state()), ["u5", "turn-fold:t5", "a5"]);

    state().actions.setDisclosure({ expandedTurnIds: ["t5"] });
    assert.deepEqual(
      rowIds(state()),
      ["u5", "turn-fold:t5", "work-toggle:x5", "x7", "a5"],
      "the prompt once and first, then the page's early work, then the window's later work"
    );
    const first = state().rows[0];
    assert.equal(
      first?.kind === "message" ? first.message : null,
      windowPrompt,
      "at the page's position, with the window's copy"
    );
  });

  describe("a call or a task begun on a page and finished in the window", () => {
    /** Turn 5: its prompt and the START of one lifecycle on the page, the rest in the window. */
    async function straddling(pageStart: ReturnType<typeof activity>, windowEnd: ReturnType<typeof activity>) {
      const opened = await open();
      const prompt = () => message("user", "fix the bug", { id: "u5", createdAt: stamp(50) });
      synchronize(
        opened.fake,
        windowSnapshot({
          items: [
            prompt(),
            windowEnd,
            activity("tool.completed", { toolUseId: "U", status: "completed" }, {
              id: "x7",
              turnId: "t5",
              summary: "Edit src/a.ts",
              createdAt: stamp(57)
            }),
            message("assistant", "fixed", { id: "a5", turnId: "t5", createdAt: stamp(58) })
          ],
          turns: [foldTurn("t4", "u4"), foldTurn("t5", "u5")]
        })
      );
      const loading = opened.state().actions.loadOlderHistory();
      opened.fake.answer(
        historyPage({
          items: [prompt(), pageStart],
          turns: [historyTurn("t5", 2, { userMessageId: "u5" })]
        })
      );
      await loading;
      opened.state().actions.setDisclosure({ expandedTurnIds: ["t5"] });
      return opened;
    }

    it("renders a call once, at the page's position, with the window's completion", async () => {
      const { state } = await straddling(
        activity("tool.started", { toolUseId: "T" }, {
          id: "ts",
          turnId: "t5",
          summary: "Read src/a.ts",
          createdAt: stamp(51)
        }),
        activity("tool.completed", { toolUseId: "T", status: "completed" }, {
          id: "tc",
          turnId: "t5",
          summary: "Read src/a.ts",
          createdAt: stamp(55)
        })
      );

      assert.deepEqual(rowIds(state()), ["u5", "turn-fold:t5", "tc", "x7", "a5"]);
      const calls = state().rows.flatMap((row) =>
        row.kind === "work" || row.kind === "work-live"
          ? (row.kind === "work" ? row.groupedEntries : [row.entry]).filter((entry) => entry.toolCallId === "T")
          : []
      );
      assert.equal(calls.length, 1, "exactly one row for the call");
      assert.equal(calls[0]?.toolLifecycleStatus, "completed");
    });

    it("renders a task once, at the page's position, with the window's completion", async () => {
      const { state } = await straddling(
        activity("task.started", { taskId: "K", agentKind: "agent", status: "running" }, {
          id: "ks",
          turnId: "t5",
          summary: "Research the bug",
          createdAt: stamp(51)
        }),
        activity("task.completed", { taskId: "K", agentKind: "agent", status: "completed" }, {
          id: "kc",
          turnId: "t5",
          summary: "Research the bug",
          createdAt: stamp(55)
        })
      );

      const tasks = state().rows.flatMap((row) =>
        row.kind === "work"
          ? row.groupedEntries.filter((entry) => entry.agentSpawn?.agentTaskIds.includes("K"))
          : []
      );
      assert.equal(tasks.length, 1, "exactly one row for the task");
      assert.equal(tasks[0]?.toolLifecycleStatus, "completed");
      const ids = rowIds(state());
      assert.ok(
        ids.indexOf(tasks[0]!.id) < ids.indexOf("x7"),
        "at the page's position — above the window's later work"
      );
      assert.equal(ids[0], "u5");
    });
  });

  it("offers rewind on a page prompt, numbered by turn order", async () => {
    providersStore.setState({
      providers: [
        {
          id: "claude",
          refIds: ["claude"],
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: stamp(0),
          models: [],
          slashCommands: [],
          skills: [],
          capabilities
        } as unknown as ProviderSnapshot
      ]
    });
    const { fake, state } = await open();
    synchronize(fake);
    const loading = state().actions.loadOlderHistory();
    fake.answer(
      turnsOneAndTwo({
        turns: [
          historyTurn("t1", 1, { userMessageId: "u1", rewindable: false }),
          historyTurn("t2", 2, { userMessageId: "u2" })
        ]
      })
    );
    await loading;

    const counts = Object.fromEntries(
      state().rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "user" ? [[row.id, row.revertTurnCount]] : []
      )
    );
    assert.deepEqual(counts, { u1: undefined, u2: 1, u3: 2 });
  });
});

describe("a compaction the pages share with the window", () => {
  it("gates history rewinds by its position, not wholesale", async () => {
    providersStore.setState({
      providers: [
        {
          id: "claude",
          refIds: ["claude"],
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: stamp(0),
          models: [],
          slashCommands: [],
          skills: [],
          capabilities
        } as unknown as ProviderSnapshot
      ]
    });
    const compacted = () =>
      activity("context-compaction", { state: "compacted" }, { id: "c1", tone: "info", createdAt: stamp(40) });
    const { fake, state } = await open();
    synchronize(
      fake,
      windowSnapshot({
        items: [
          compacted(),
          message("user", "fifth", { id: "u5", createdAt: stamp(50) }),
          message("assistant", "five", { id: "a5", turnId: "t5", createdAt: stamp(51) })
        ],
        turns: [foldTurn("t4", "u4"), foldTurn("t5", "u5")]
      })
    );
    const loading = state().actions.loadOlderHistory();
    fake.answer(
      historyPage({
        items: [
          compacted(),
          message("user", "fourth", { id: "u4", createdAt: stamp(45) }),
          message("assistant", "four", { id: "a4", turnId: "t4", createdAt: stamp(46) })
        ],
        turns: [historyTurn("t4", 1, { userMessageId: "u4" })]
      })
    );
    await loading;

    const counts = Object.fromEntries(
      state().rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "user" ? [[row.id, row.revertTurnCount]] : []
      )
    );
    assert.deepEqual(
      counts,
      { u4: 0, u5: 1 },
      "a prompt after the shared compaction stays rewindable, on either side of the boundary"
    );
  });
});

describe("a rewind and the loaded pages", () => {
  async function withPageLoaded() {
    const opened = await open();
    synchronize(opened.fake);
    const loading = opened.state().actions.loadOlderHistory();
    opened.fake.answer(turnsOneAndTwo());
    await loading;
    return opened;
  }

  const reverted = (turnCount: number): AgentChatStreamFrame => ({
    kind: "event",
    seq: 11,
    event: ev("thread.reverted", { turnCount }, { seq: 11 })
  });

  it("keeps the pages when it lands inside the window", async () => {
    const { fake, state } = await withPageLoaded();
    fake.push(reverted(2));
    assert.equal(state().slice.history.pages.length, 1);
  });

  it("drops them once it reaches into a page", async () => {
    const { fake, state } = await withPageLoaded();
    fake.push(reverted(1));
    assert.deepEqual(state().slice.history.pages, []);
  });

  it("rewinds to a prompt only a page holds, and hands it back once it is gone", async () => {
    const { fake, state } = await withPageLoaded();

    const rewinding = state().actions.rewindTo({ messageId: "u2", targetTurnCount: 1 });
    await settle();
    assert.deepEqual(
      fake.posted.map((posted) => [posted.name, posted.body.targetTurnCount]),
      [["revert", 1]]
    );
    assert.equal(state().reverting, true, "still waiting: the prompt is still on a page");

    fake.push(reverted(1));
    await rewinding;
    assert.equal(state().reverting, false);
    assert.equal(state().draft.text, "second");
  });
});

describe("revealTurn", () => {
  it("scrolls to a turn the window already holds, without a request", async () => {
    const { fake, state } = await open();
    synchronize(fake);

    assert.equal(await state().actions.revealTurn("t3"), true);
    assert.deepEqual(state().reveal, { turnId: "t3", rowId: "u3", nonce: 1 });
    assert.equal(fake.historyCalls.length, 0);
  });

  it("loads older pages until the turn is on screen, then reveals it", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const pageAbove = historyPage({
      items: [message("user", "second", { id: "u2", createdAt: stamp(20) })],
      turns: [historyTurn("t2", 2, { userMessageId: "u2" })],
      page: { beforeCursor: "cursor-t2" }
    });
    const pageWithTurn = historyPage({
      items: [
        message("user", "first", { id: "u1", createdAt: stamp(10) }),
        message("assistant", "one", { id: "a1", turnId: "t1", createdAt: stamp(11) })
      ],
      turns: [historyTurn("t1", 1, { userMessageId: "u1" })],
      page: { beforeCursor: null }
    });

    const revealing = state().actions.revealTurn("t1");
    await until(() => fake.waiting === 1, "the first page request");
    fake.answer(pageAbove);
    await until(() => fake.waiting === 1 && fake.historyCalls.length === 2, "the second request");
    assert.equal(fake.historyCalls[1]?.query.before, "cursor-t2");
    fake.answer(pageWithTurn);

    assert.equal(await revealing, true);
    assert.equal(state().reveal?.rowId, "u1");
  });

  it("gives up at once on a turn the thread no longer has", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    assert.equal(await state().actions.revealTurn("t-reverted"), false);
    assert.equal(fake.historyCalls.length, 0);
    assert.equal(state().reveal, null);
  });

  it("gives up when nothing older is left to hold the turn", async () => {
    const { fake, state } = await open();
    synchronize(fake, windowSnapshot({ history: bounds({ hasOlder: false }) }));
    assert.equal(await state().actions.revealTurn("t1"), false);
    assert.equal(fake.historyCalls.length, 0);
  });

  it("gives up after 25 pages", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    const revealing = state().actions.revealTurn("t1");
    for (let page = 1; page <= 25; page += 1) {
      await until(() => fake.waiting === 1, `request ${page}`);
      fake.answer(
        historyPage({
          turns: [historyTurn(`filler-${page}`, 100 - page)],
          page: { beforeCursor: `cursor-${page}` }
        })
      );
    }
    assert.equal(await revealing, false);
    assert.equal(fake.historyCalls.length, 25);
  });

  it("waits for the thread to synchronize before looking", async () => {
    const { fake, state } = await open();
    const revealing = state().actions.revealTurn("t3");
    await settle();
    assert.equal(state().reveal, null, "nothing to look at yet");

    synchronize(fake);
    assert.equal(await revealing, true);
    assert.equal(state().reveal?.rowId, "u3");
  });

  it("drops an unhandled reveal whose row a new snapshot no longer has", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    await state().actions.revealTurn("t3");

    fake.push({ kind: "snapshot", thread: windowSnapshot({ seq: 11 }) });
    assert.equal(state().reveal?.rowId, "u3", "the row survived the resync, so the request stands");

    fake.push({
      kind: "snapshot",
      thread: windowSnapshot({ seq: 12, items: [], turns: [foldTurn("t1", "u1")] })
    });
    assert.equal(state().reveal, null, "a row that is gone can never be scrolled to later");
  });

  it("clears the reveal only for the nonce the timeline handled", async () => {
    const { fake, state } = await open();
    synchronize(fake);
    await state().actions.revealTurn("t3");

    state().actions.acknowledgeReveal(99);
    assert.notEqual(state().reveal, null, "a stale acknowledgement clears nothing");
    state().actions.acknowledgeReveal(1);
    assert.equal(state().reveal, null);
  });
});

describe("retention", () => {
  it("brings a thread back with its pages, and never with a dead request's spinner", async () => {
    const first = await open();
    synchronize(first.fake);
    const loaded = first.state().actions.loadOlderHistory();
    first.fake.answer(turnsOneAndTwo({ page: { beforeCursor: "cursor-page-1" } }));
    await loaded;
    void first.state().actions.loadOlderHistory();
    assert.equal(first.state().slice.history.loading, true);
    first.store.destroy?.();

    const second = await open();
    assert.equal(second.state().slice.history.loading, false);
    assert.equal(second.state().slice.history.pages.length, 1);
    assert.deepEqual(rowIds(second.state()), ["u1", "a1", "u2", "a2", "u3", "a3"]);

    void second.state().actions.loadOlderHistory();
    assert.equal(second.fake.historyCalls.length, 1, "the new generation can page again");
    second.store.destroy?.({ retain: false });
  });
});

// ---------------------------------------------------------------------------
// The history bridge (design 2026-09-23 fold performance, "Client — the
// history bridge"). Every drop below comes from the REAL fold the store
// applies, and is read back from the fold state — never assumed: retention
// trims one row at a time at its exact limits, or a whole batch once a class
// outgrows its slack, and every test holds under either.
// ---------------------------------------------------------------------------

describe("the history bridge", () => {
  const ids = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);

  /**
   * Every item a row renders. Every turn is expanded and every tool row is an
   * error — hoisted as a row of its own, never folded into a group — so each
   * item on screen is exactly one entry here, in screen order.
   */
  const renderedItemIds = (rows: readonly AgentChatTimelineRow[]): string[] =>
    rows.flatMap((row) => {
      switch (row.kind) {
        case "message":
          return [row.message.id];
        case "work":
        case "work-live":
          return row.groupedEntries.map((entry) => entry.id);
        case "activity-group":
          return row.entries.map((entry) => entry.id);
        case "context-compaction":
          return [row.id];
        default:
          return [];
      }
    });

  /** The label the row rendering `id` shows. */
  const labelOf = (rows: readonly AgentChatTimelineRow[], id: string): string | undefined =>
    rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : [])).find((entry) => entry.id === id)
      ?.label;

  /** A parent tool row the timeline renders on its own. */
  const toolRow = (id: string, at: number, turnId: string | null, summary = `ran ${id}`): ThreadActivityItem =>
    activity("tool.completed", { toolUseId: `call-${id}`, status: "failed" }, {
      id,
      turnId,
      tone: "error",
      summary,
      createdAt: stamp(at)
    });

  /** As many parent rows as the fold holds before it trims: the next one makes it drop some. */
  const FULL = ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK;
  const TURN_ROWS = 10;

  /** Turn `k` as a snapshot or a page holds it: its prompt, TURN_ROWS rows, its answer. */
  const turnItems = (k: number, clock: { at: number }): ThreadItem[] => [
    message("user", `prompt ${k}`, { id: `u${k}`, createdAt: stamp((clock.at += 1)) }),
    ...Array.from({ length: TURN_ROWS }, (_, index) => toolRow(`x${k}-${index}`, (clock.at += 1), `t${k}`)),
    message("assistant", `answer ${k}`, { id: `a${k}`, turnId: `t${k}`, createdAt: stamp((clock.at += 1)) })
  ];

  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  const WINDOW_SEQ = 10_000;
  let seq = WINDOW_SEQ;
  const eventFrame = (event: DomainEvent): AgentChatStreamFrame => ({ kind: "event", seq: event.seq, event });

  /** Turn `k` as the live stream delivers it — one frame per item, stamped after everything held. */
  function* turnFrames(k: number): Generator<{ id: string; frame: AgentChatStreamFrame }> {
    seq += 1;
    yield {
      id: `u${k}`,
      frame: eventFrame(
        ev("thread.message-sent", { messageId: `u${k}`, role: "user", text: `prompt ${k}`, streaming: false, turnId: null }, { seq })
      )
    };
    for (let index = 0; index < TURN_ROWS; index += 1) {
      seq += 1;
      const row = toolRow(`x${k}-${index}`, seq, `t${k}`);
      yield { id: row.id, frame: eventFrame(ev("thread.activity-appended", { activity: row }, { seq })) };
    }
    seq += 1;
    yield {
      id: `a${k}`,
      frame: eventFrame(
        ev("thread.message-sent", { messageId: `a${k}`, role: "assistant", text: `answer ${k}`, streaming: false, turnId: `t${k}` }, { seq })
      )
    };
  }

  /** One turn-less parent row as the live stream delivers it. */
  const rowFrame = (id: string, summary?: string): { id: string; frame: AgentChatStreamFrame } => {
    seq += 1;
    const row = toolRow(id, seq, null, summary);
    return { id, frame: eventFrame(ev("thread.activity-appended", { activity: row }, { seq })) };
  };

  /** Rows the window no longer holds after `push` — read off the fold state itself. */
  function evictedBy(state: () => AgentChatThreadState, push: () => void): string[] {
    const held = state().slice.entries;
    push();
    const now = new Set(ids(state().slice.entries));
    return ids(held.filter((item) => !now.has(item.id)));
  }

  /** Push turn-less rows until `done`, or fail — never a sleep, never a guessed batch size. */
  function streamRowsUntil(
    fake: ReturnType<typeof fakeTransport>,
    done: () => boolean,
    onFrame: (id: string) => void = () => {}
  ): void {
    for (let guard = 0; guard < 4 * FULL && !done(); guard += 1) {
      const { id, frame } = rowFrame(`live${guard}-${seq}`);
      fake.push(frame);
      onFrame(id);
    }
    assert.ok(done(), "the stream never got there");
  }

  /**
   * The turn thread: turns 1–2 on the page just below the window, turns
   * 3… in the window with the fold full, every turn expanded.
   */
  async function turnThreadWithPage(overrides: Partial<Omit<ThreadStoreDeps, "transport">> = {}) {
    const clock = { at: 0 };
    const pageItems = [...turnItems(1, clock), ...turnItems(2, clock)];
    const windowTurns = Math.ceil(FULL / TURN_ROWS);
    const windowItems = range(3, 2 + windowTurns).flatMap((k) => turnItems(k, clock));
    const turns: Turn[] = range(1, 2 + windowTurns + 40).map((k) => foldTurn(`t${k}`, `u${k}`));
    seq = WINDOW_SEQ;
    const opened = await open("s1", overrides);
    synchronize(opened.fake, snapshot({ items: windowItems, turns, seq, history: bounds() }));
    opened.state().actions.setDisclosure({ expandedTurnIds: turns.map((turn) => turn.turnId!) });
    const loading = opened.state().actions.loadOlderHistory();
    opened.fake.answer(
      historyPage({
        items: pageItems,
        turns: [historyTurn("t1", 1, { userMessageId: "u1" }), historyTurn("t2", 2, { userMessageId: "u2" })],
        page: { beforeCursor: null },
        seq
      })
    );
    await loading;
    return { ...opened, pageItems, windowItems, firstLiveTurn: 3 + windowTurns };
  }

  /** A turn-less window of FULL rows `w0…`, synchronized, nothing loaded. */
  async function rowThread(
    overrides: Partial<Omit<ThreadStoreDeps, "transport">> = {},
    before: ThreadItem[] = [],
    turns: Turn[] = []
  ) {
    seq = WINDOW_SEQ;
    const windowItems = [
      ...before,
      ...Array.from({ length: FULL }, (_, index) => toolRow(`w${index}`, 1_000 + index, null))
    ];
    const opened = await open("s1", overrides);
    synchronize(opened.fake, snapshot({ items: windowItems, turns, seq, history: bounds() }));
    return { ...opened, windowItems };
  }

  /** A page of `count` turn-less rows `<name>0…`, stamped below the window. */
  const rowPage = (name: string, count: number, beforeCursor: string | null, firstAt: number): ThreadHistoryPage =>
    historyPage({
      items: Array.from({ length: count }, (_, index) => toolRow(`${name}${index}`, firstAt + index, null)),
      page: { beforeCursor },
      seq: WINDOW_SEQ
    });

  it("keeps pages, bridge and window ONE contiguous stretch while retention trims under them — nothing lost, nothing twice, in order", async () => {
    const { fake, state, pageItems, windowItems, firstLiveTurn } = await turnThreadWithPage();
    const expected = [...ids(pageItems), ...ids(windowItems)];
    assert.deepEqual(renderedItemIds(state().rows), expected, "the page lands above the window");

    let trims = 0;
    for (const k of range(firstLiveTurn, firstLiveTurn + 10)) {
      for (const { id, frame } of turnFrames(k)) {
        if (evictedBy(state, () => fake.push(frame)).length > 0) {
          trims += 1;
        }
        expected.push(id);
        // Everything ever on screen — the page, every row the window held,
        // every row since — exactly once, in the log's order.
        assert.deepEqual(renderedItemIds(state().rows), expected, `after ${id}`);
      }
    }

    assert.ok(trims >= 3, `retention trimmed ${trims} times`);
    const { history } = state().slice;
    assert.ok(history.bridge.length > 0, "the evicted rows sit on the bridge");
    assert.ok(
      history.windowCut > 0,
      "the prompts and answers the window kept past their rows render with them, in place"
    );
    assert.equal(history.pages.length, 1);
  });

  it("renders the rows the first page repeats from the window ONCE — at the page's place, with the newest content — before and after the window evicts them to the bridge", async () => {
    // The host bounds the window positionally — its newest LIMIT parent rows —
    // while the window holds up to its slack more between trims, so the first
    // page repeats the window's oldest rows. The next trim takes those rows
    // (the ones the window outgrew since, too) onto the bridge, although a
    // page already holds them.
    const overlap = FULL - ACTIVITY_RETENTION_LIMIT;
    const olderOnly = Array.from({ length: 5 }, (_, index) => toolRow(`p${index}`, 1 + index, null));
    const { fake, state, windowItems } = await rowThread();
    const repeated = windowItems.slice(0, overlap);
    assert.ok(repeated.length > 0, "the fixture repeats rows");
    const loading = state().actions.loadOlderHistory();
    fake.answer(
      historyPage({
        items: [
          ...olderOnly,
          ...repeated.map((row) => ({ ...(row as ThreadActivityItem), summary: `as the page saw ${row.id}` }))
        ],
        page: { beforeCursor: null },
        seq: WINDOW_SEQ
      })
    );
    await loading;
    const expected = [...ids(olderOnly), ...ids(windowItems)];
    assert.deepEqual(renderedItemIds(state().rows), expected, "once each, at the page's place");
    assert.equal(labelOf(state().rows, repeated[0]!.id), `ran ${repeated[0]!.id}`, "with the window's content");

    // One of them changes in place while the window still holds it.
    const changed = repeated[1]!;
    seq += 1;
    fake.push(
      eventFrame(
        ev("thread.activity-appended", { activity: { ...(changed as ThreadActivityItem), summary: "changed since the page" } }, { seq })
      )
    );
    assert.deepEqual(renderedItemIds(state().rows), expected);

    const stillHeld = (): boolean =>
      repeated.some((row) => state().slice.entries.some((item) => item.id === row.id));
    streamRowsUntil(fake, () => !stillHeld(), (id) => expected.push(id));
    const onBridge = new Set(ids(state().slice.history.bridge));
    assert.ok(
      ids(repeated).every((id) => onBridge.has(id)),
      "every repeated row went to the bridge, though a page holds it"
    );

    const rows = state().rows;
    assert.deepEqual(renderedItemIds(rows), expected, "still once each, in the page's place");
    assert.equal(labelOf(rows, changed.id), "changed since the page", "the newest content");
    assert.equal(labelOf(rows, repeated[0]!.id), `ran ${repeated[0]!.id}`);
  });

  it("drops the OLDEST pages first past the cap, and 'load older' then asks right below the oldest page left", async () => {
    const { fake, state, windowItems } = await rowThread({ historyRowCap: 120 });
    const newest = rowPage("n", 30, "below-newest", 700);
    const middle = rowPage("m", 30, "below-middle", 400);
    const oldest = rowPage("o", 30, "below-oldest", 100);
    for (const page of [newest, middle, oldest]) {
      const loading = state().actions.loadOlderHistory();
      fake.answer(page);
      await loading;
    }
    assert.deepEqual(state().slice.history.pages, [oldest, middle, newest]);

    const expected = [...ids(oldest.items), ...ids(middle.items), ...ids(newest.items), ...ids(windowItems)];
    streamRowsUntil(fake, () => state().slice.history.pages.length < 3, (id) => expected.push(id));

    const { history } = state().slice;
    assert.equal(history.pages.at(-1), newest, "the newest page stays: it is where the bridge meets the cursors");
    assert.ok(!history.pages.includes(oldest), "the oldest went first");
    assert.ok(
      history.bridge.length + history.pages.reduce((rows, page) => rows + page.items.length, 0) <= 120
    );
    const oldestLeft = history.pages[0]!;
    const shown = new Set(ids(history.pages.flatMap((page) => page.items)));
    assert.deepEqual(
      renderedItemIds(state().rows),
      expected.filter((id) => !id.startsWith("o") && (!id.startsWith("m") || shown.has(id))),
      "the rest stays one contiguous stretch"
    );

    const loading = state().actions.loadOlderHistory();
    assert.equal(
      fake.historyCalls.at(-1)?.query.before,
      oldestLeft.page.beforeCursor,
      "right below the oldest page left — exactly the block that went"
    );
    fake.answer(historyPage({ page: { beforeCursor: null } }));
    await loading;
  });

  it("drops pages and bridge once the bridge no longer fits beside the newest page, and reads fresh bounds — the stream stays live", async () => {
    const { fake, state } = await rowThread({ historyRowCap: 30 });
    const loading = state().actions.loadOlderHistory();
    fake.answer(rowPage("p", 10, "below-page", 100));
    await loading;
    fake.answerReadsWith(() => ({
      kind: "snapshot",
      thread: snapshot({
        items: state().slice.entries,
        seq: state().slice.seq,
        history: bounds({ beforeCursor: "cursor-fresh" })
      })
    }));

    streamRowsUntil(fake, () => state().slice.history.pages.length === 0);

    assert.deepEqual(state().slice.history.bridge, []);
    assert.equal(state().slice.history.windowCut, 0);
    await until(() => state().slice.history.bounds?.beforeCursor === "cursor-fresh", "the fresh snapshot");
    assert.equal(fake.reads, 1, "one re-read");
    assert.equal(state().slice.connection, "synchronized", "a re-read is not a reconnect");
    assert.deepEqual(renderedItemIds(state().rows), ids(state().slice.entries), "the window alone");
  });

  it("refuses a re-read older than what the stream has folded since, and the next load asks without a cursor", async () => {
    const { fake, state } = await rowThread({ historyRowCap: 30 });
    const loading = state().actions.loadOlderHistory();
    fake.answer(rowPage("p", 10, "below-page", 100));
    await loading;
    fake.answerReadsWith(() => ({
      kind: "snapshot",
      thread: snapshot({ seq: WINDOW_SEQ, history: bounds({ beforeCursor: "stale" }) })
    }));

    streamRowsUntil(fake, () => state().slice.history.pages.length === 0);
    await until(() => fake.reads === 1, "the re-read");
    await settle();

    const entries = state().slice.entries;
    assert.ok(entries.length > 0, "the fold was not rolled back to an older snapshot");
    assert.equal(state().slice.history.bounds?.beforeCursor, "cursor-window");
    void state().actions.loadOlderHistory();
    assert.equal(
      fake.historyCalls.at(-1)?.query.before,
      undefined,
      "the old snapshot's cursor no longer meets the window: the host bounds it as it stands"
    );
  });

  it("drops pages AND bridge for a rewind that removes a bridge row's turn, and keeps both for one confined to the window", async () => {
    const confined = await turnThreadWithPage();
    let last = 0;
    for (const k of range(confined.firstLiveTurn, confined.firstLiveTurn + 1)) {
      for (const { frame } of turnFrames(k)) {
        confined.fake.push(frame);
      }
      last = k;
    }
    assert.ok(confined.state().slice.history.bridge.length > 0);
    seq += 1;
    confined.fake.push(eventFrame(ev("thread.reverted", { turnCount: last - 1 }, { seq })));
    assert.equal(confined.state().slice.history.pages.length, 1, "only the newest turn went, and the window held it");
    assert.ok(confined.state().slice.history.bridge.length > 0);
    assert.ok(!renderedItemIds(confined.state().rows).includes(`a${last}`));

    const reaching = await turnThreadWithPage();
    for (const { frame } of turnFrames(reaching.firstLiveTurn)) {
      reaching.fake.push(frame);
    }
    const bridgeTurns = reaching
      .state()
      .slice.history.bridge.flatMap((item) => (item.turnId === null ? [] : [Number(item.turnId.slice(1))]));
    const newestBridgeTurn = Math.max(...bridgeTurns);
    seq += 1;
    reaching.fake.push(eventFrame(ev("thread.reverted", { turnCount: newestBridgeTurn - 1 }, { seq })));
    assert.deepEqual(reaching.state().slice.history.pages, []);
    assert.deepEqual(reaching.state().slice.history.bridge, []);
    assert.equal(reaching.state().slice.history.windowCut, 0);
  });

  it("reveals a turn only the bridge still shows, without loading a page", async () => {
    // Turn `tb` is nothing but tool rows, the window's oldest: once they go to
    // the bridge the window holds nothing of it.
    const onlyRows = Array.from({ length: 5 }, (_, index) => toolRow(`xb${index}`, 10 + index, "tb"));
    const { fake, state } = await rowThread({}, onlyRows, [foldTurn("tb")]);
    const loading = state().actions.loadOlderHistory();
    fake.answer(rowPage("p", 5, null, 1));
    await loading;
    streamRowsUntil(fake, () => !state().slice.entries.some((item) => item.turnId === "tb"));
    assert.ok(state().slice.history.bridge.some((item) => item.turnId === "tb"), "the turn sits on the bridge");
    const calls = fake.historyCalls.length;

    assert.equal(await state().actions.revealTurn("tb"), true);
    assert.equal(
      state().reveal?.rowId,
      "turn-fold:tb",
      "the first row the turn owns — its settled \"Worked for …\" fold, built from the bridge"
    );
    assert.ok(state().rows.some((row) => row.id === "turn-fold:tb"));
    assert.equal(fake.historyCalls.length, calls, "nothing was paged in for it");
  });

  it("keeps what the window evicts while the FIRST page is on its way, and joins it to the page once it lands", async () => {
    const { fake, state, windowItems } = await rowThread();
    const expected = ids(windowItems);
    const loading = state().actions.loadOlderHistory();
    let evicted = 0;
    streamRowsUntil(
      fake,
      () => evicted > 0,
      (id) => {
        expected.push(id);
        evicted = expected.length - state().slice.entries.length;
      }
    );
    assert.deepEqual(renderedItemIds(state().rows), expected, "the evicted rows stay on screen above the window");

    const page = rowPage("p", 5, null, 1);
    fake.answer(page);
    await loading;
    assert.deepEqual(renderedItemIds(state().rows), [...ids(page.items), ...expected]);
  });

  it("lets that bridge go when the first page fails, and the retry asks without the snapshot's cursor", async () => {
    const { fake, state, windowItems } = await rowThread();
    const failing = state().actions.loadOlderHistory();
    assert.equal(fake.historyCalls.at(-1)?.query.before, "cursor-window", "nothing evicted yet: the snapshot's cursor");
    streamRowsUntil(fake, () => state().slice.history.bridge.length > 0);
    fake.fail(new AgentChatCommandError(503, "INDEX_UNAVAILABLE", "index is rebuilding"));
    await failing;

    assert.deepEqual(state().slice.history.bridge, []);
    assert.equal(state().slice.history.windowCut, 0);
    assert.deepEqual(renderedItemIds(state().rows), ids(state().slice.entries), "as if nothing had been asked");
    assert.ok(windowItems.length > state().slice.entries.length);

    const retry = state().actions.loadOlderHistory();
    assert.equal(fake.historyCalls.at(-1)?.query.before, undefined);
    fake.answer(historyPage({ page: { beforeCursor: null } }));
    await retry;
  });

  it("asks for the first page without the snapshot's cursor once the window has evicted since that snapshot", async () => {
    const { fake, state, windowItems } = await rowThread();
    streamRowsUntil(fake, () => state().slice.entries.length < windowItems.length);
    assert.deepEqual(state().slice.history.bridge, [], "nothing is kept while nothing is loaded");
    void state().actions.loadOlderHistory();
    assert.deepEqual(fake.historyCalls.at(-1)?.query, { turns: 20 });
  });

  it("drops pages, bridge and cut on a new snapshot", async () => {
    const { fake, state } = await turnThreadWithPage();
    streamRowsUntil(fake, () => state().slice.history.bridge.length > 0);
    fake.push({ kind: "snapshot", thread: windowSnapshot({ seq: seq + 1 }) });
    assert.deepEqual(state().slice.history.pages, []);
    assert.deepEqual(state().slice.history.bridge, []);
    assert.equal(state().slice.history.windowCut, 0);
    assert.deepEqual(rowIds(state()), ["u3", "a3"]);
  });

  it("brings the bridge back with its pages on a remount — and a first page's orphan bridge never", async () => {
    const first = await turnThreadWithPage();
    streamRowsUntil(first.fake, () => first.state().slice.history.bridge.length > 0);
    const shown = renderedItemIds(first.state().rows);
    first.store.destroy?.();
    const second = await open();
    assert.deepEqual(renderedItemIds(second.state().rows), shown);
    assert.ok(second.state().slice.history.bridge.length > 0);
    second.store.destroy?.({ retain: false });

    const orphan = await rowThread();
    void orphan.state().actions.loadOlderHistory();
    streamRowsUntil(orphan.fake, () => orphan.state().slice.history.bridge.length > 0);
    orphan.store.destroy?.();
    const back = await open();
    assert.equal(back.state().slice.history.loading, false);
    assert.deepEqual(back.state().slice.history.bridge, [], "its page will never land in this generation");
    back.store.destroy?.({ retain: false });
  });

  // -------------------------------------------------------------------------
  // Older history after live evictions; the page's end; a running turn.
  // -------------------------------------------------------------------------

  it("offers 'Load older' as soon as the window evicts a row, though the snapshot said nothing was older — and asks without a cursor", async () => {
    seq = WINDOW_SEQ;
    const { fake, state } = await open();
    const windowItems = Array.from({ length: FULL }, (_, index) => toolRow(`w${index}`, 1_000 + index, null));
    synchronize(
      fake,
      snapshot({ items: windowItems, seq, history: bounds({ hasOlder: false, beforeCursor: null }) })
    );
    assert.equal(canLoadOlderHistory(state().slice.history), false, "nothing older, the snapshot said");

    streamRowsUntil(fake, () => !state().slice.entries.some((item) => item.id === "w0"));

    assert.equal(canLoadOlderHistory(state().slice.history), true, "the evicted rows are older history now");
    void state().actions.loadOlderHistory();
    assert.deepEqual(
      fake.historyCalls.at(-1)?.query,
      { turns: 20 },
      "the block just below the window as it stands — the snapshot had no cursor to give"
    );
  });

  it("renders the window's old prompts and answers in log order above a page — with no bridge yet", async () => {
    // The log: turns 1–8. The window kept every message (2 000 of them are
    // retained) but the tool rows of turns 7–8 only (500 are); the page is the
    // block just below its first retained tool row: turn 5, turn 6, and turn
    // 7's prompt.
    const clock = { at: 0 };
    const log = range(1, 8).map((k) => turnItems(k, clock));
    const isMessage = (item: ThreadItem): boolean => item.kind === "message";
    const windowItems = [
      ...log.slice(0, 6).flatMap((turn) => turn.filter(isMessage)),
      ...log[6]!,
      ...log[7]!
    ];
    const pageItems = [...log[4]!, ...log[5]!, log[6]![0]!];
    const turns = range(1, 8).map((k) => foldTurn(`t${k}`, `u${k}`));
    seq = WINDOW_SEQ;
    const { fake, state } = await open();
    synchronize(fake, snapshot({ items: windowItems, turns, seq, history: bounds() }));
    state().actions.setDisclosure({ expandedTurnIds: turns.map((turn) => turn.turnId!) });

    const loading = state().actions.loadOlderHistory();
    fake.answer(
      historyPage({
        items: pageItems,
        turns: range(5, 7).map((k) => historyTurn(`t${k}`, k, { userMessageId: `u${k}` })),
        page: { beforeCursor: "below-turn-5" },
        seq
      })
    );
    await loading;

    assert.deepEqual(state().slice.history.bridge, [], "no bridge: nothing was evicted since");
    assert.deepEqual(
      renderedItemIds(state().rows),
      ids(log.flatMap((turn, index) => (index < 4 ? turn.filter(isMessage) : turn))),
      "turns 1–4 as the window kept them, then the page's turns whole, then the window — the log's order"
    );
  });

  it("renders the window's older rows above a page that shares NONE of them — a prompt, an agent's launch, a compaction marker — in log order", async () => {
    // The log: a prompt, an agent launched, a compaction, then a stretch of
    // tool rows — the page's block, none of it left in the window — and the
    // window's own rows. Messages, launch rows and compaction markers outlive
    // every tool row, so the window still holds the first three: only the
    // page's `endItemId` says where they belong.
    const prompt = message("user", "fix everything", { id: "u1", createdAt: stamp(1) });
    const launch = activity("task.started", { taskId: "K", agentKind: "agent", status: "running" }, {
      id: "ks",
      turnId: "t1",
      summary: "Research",
      createdAt: stamp(2)
    });
    const compaction = activity("context-compaction", { state: "compacted" }, {
      id: "c1",
      tone: "info",
      createdAt: stamp(3)
    });
    const block = Array.from({ length: 10 }, (_, index) => toolRow(`p${index}`, 10 + index, "t1"));
    const own = Array.from({ length: 5 }, (_, index) => toolRow(`w${index}`, 100 + index, "t1"));
    const answer = message("assistant", "done", { id: "a1", turnId: "t1", createdAt: stamp(200) });
    seq = WINDOW_SEQ;
    const { fake, state } = await open();
    synchronize(
      fake,
      snapshot({
        items: [prompt, launch, compaction, ...own, answer],
        turns: [foldTurn("t1", "u1")],
        seq,
        history: bounds()
      })
    );
    state().actions.setDisclosure({ expandedTurnIds: ["t1"] });

    const loading = state().actions.loadOlderHistory();
    fake.answer(historyPage({ items: block, page: { beforeCursor: null, endItemId: "w0" }, seq }));
    await loading;

    assert.deepEqual(state().slice.history.bridge, [], "no bridge: nothing was evicted since");
    assert.equal(state().slice.history.windowCut, 3, "the window's three older rows lie below the page's end");
    assert.deepEqual(
      renderedItemIds(state().rows),
      ["u1", "ks", "c1", ...ids(block), ...ids(own), "a1"],
      "the prompt, the launch and the marker above the page's rows, in the log's order"
    );
  });

  it("renders a running turn whose early rows went to the history live — exactly as one window holding everything would", async () => {
    const clock = { at: 0 };
    const pageItems = [...turnItems(1, clock), ...turnItems(2, clock)];
    const prompt = message("user", "go", { id: "uR", createdAt: stamp((clock.at += 1)) });
    const word = message("assistant", "on it", { id: "aR", turnId: "tR", createdAt: stamp((clock.at += 1)) });
    const inFlight = activity("tool.updated", { toolUseId: "call-live", status: "inProgress" }, {
      id: "xR-live",
      turnId: "tR",
      summary: "Read src/a.ts",
      createdAt: stamp((clock.at += 1))
    });
    const rows = Array.from({ length: FULL }, (_, index) => toolRow(`xR-${index}`, (clock.at += 1), "tR"));
    const runningTurn: Turn = {
      turnId: "tR",
      state: "running",
      turnCount: null,
      requestedAt: stamp(0),
      startedAt: stamp(1),
      completedAt: null,
      assistantMessageId: null,
      userMessageId: "uR"
    };
    const turns = [foldTurn("t1", "u1"), foldTurn("t2", "u2"), runningTurn];
    seq = WINDOW_SEQ;
    const { fake, state } = await open();
    synchronize(
      fake,
      snapshot({
        head: head({ session: { status: "running", activeTurnId: "tR" } }),
        items: [prompt, word, inFlight, ...rows],
        turns,
        seq,
        history: bounds()
      })
    );
    state().actions.setDisclosure({ expandedTurnIds: ["t1", "t2"] });
    const loading = state().actions.loadOlderHistory();
    fake.answer(historyPage({ items: pageItems, page: { beforeCursor: null }, seq }));
    await loading;

    const streamed: ThreadItem[] = [];
    for (let guard = 0; guard < 4 * FULL && state().slice.entries.some((item) => item.id === "xR-live"); guard += 1) {
      seq += 1;
      const row = toolRow(`xR-live-${guard}`, seq, "tR");
      streamed.push(row);
      fake.push(eventFrame(ev("thread.activity-appended", { activity: row }, { seq })));
    }
    const { history } = state().slice;
    assert.ok(history.bridge.some((item) => item.id === "xR-live"), "the call in flight went to the bridge");
    assert.ok(history.windowCut >= 2, "the prompt and the agent's word render with the history");

    // One window holding every row, as if nothing had been evicted.
    const reference = deriveTimelineRows({
      timelineEntries: deriveTimelineEntriesFromItems([
        ...pageItems,
        prompt,
        word,
        inFlight,
        ...rows,
        ...streamed
      ]).entries,
      latestTurn: { turnId: "tR", state: "running", startedAt: stamp(1), completedAt: null },
      runningTurnId: "tR",
      expandedTurnIds: new Set(["t1", "t2"]),
      expandedWorkGroupIds: new Set(),
      isWorking: true,
      isCompacting: false,
      activeTurnStartedAt: stamp(1),
      checkpoints: [],
      turns,
      supportsConversationRollback: false,
      liveAgentTaskIds: new Set(),
      queuedMessages: []
    });
    const shape = (list: readonly AgentChatTimelineRow[]): string[] =>
      list.map((row) => `${row.kind}:${renderedItemIds([row]).join(",")}`);
    assert.deepEqual(shape(state().rows), shape(reference));

    const shown = state().rows;
    assert.ok(!shown.some((row) => row.id === "turn-fold:tR"), "never a settled \"Worked for …\" group");
    const at = (id: string): number => shown.findIndex((row) => row.id === id);
    assert.equal(shown[at("uR") + 1]?.kind, "working", "its header right after its prompt, up in the history");
    assert.equal(shown.filter((row) => row.kind === "working").length, 1);
    const call = shown.find(
      (row) => row.kind === "work-live" && row.groupedEntries.some((entry) => entry.id === "xR-live")
    );
    assert.equal(call?.kind === "work-live" ? call.active : null, true, "the call in flight is live");
    const answer = shown.find((row) => row.id === "aR");
    assert.equal(answer?.kind === "message" ? answer.showAssistantMeta : null, false);

    // And once it settles, it folds like any settled turn — once.
    seq += 1;
    fake.push(
      eventFrame(ev("thread.session-set", { session: { status: "ready", activeTurnId: null } }, { seq }))
    );
    const settled = state().rows;
    assert.equal(settled.filter((row) => row.id === "turn-fold:tR").length, 1);
    assert.ok(!settled.some((row) => row.kind === "working" || row.kind === "thinking" || row.kind === "work-live"));
  });
});
