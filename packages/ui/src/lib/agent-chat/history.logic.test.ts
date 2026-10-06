/**
 * The indexed-history half of the client (design 2026-09-23 §C "History page",
 * "Client"; fold performance, "Client — the history bridge"): the page cache,
 * the bridge and its window cut, the memory cap, the "load older" cursor, the
 * reveal planner and the history rows that sit above the live window.
 *
 * Wherever a drop matters it comes from the REAL fold and is read back through
 * `itemsDroppedByRetention` or the fold's own items — never assumed: the fold
 * trims one row at a time at its exact limits, or a whole batch once a class
 * outgrows its slack, and every assertion here holds under either.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  applyDomainEvent,
  itemsDroppedByRetention,
  messageStreamingContext,
  type ThreadActivityItem,
  type ThreadFoldState,
  type ThreadHistoryBounds,
  type ThreadHistoryPage,
  type ThreadItem
} from "@orquester/api/agent-chat";

import type { AgentChatHistoryState, AgentChatTimelineRow } from "./contracts";
import {
  canLoadOlderHistory,
  collectHistoryItems,
  EMPTY_HISTORY,
  EMPTY_HISTORY_ITEMS,
  EMPTY_HISTORY_ROWS,
  EMPTY_LIVE_SPLIT,
  historyAfterEvent,
  historyAfterRevert,
  historyBoundsFromSnapshot,
  historyWithinCap,
  nextHistoryCursor,
  historyWithPage,
  projectHistoryRows,
  rowIdForTurn,
  splitLiveItems,
  windowHasDropped,
  type HistoryFoldStep,
  type HistoryRowsInput
} from "./history.logic";
import { deriveTimelineEntriesFromItems } from "./entries.logic";
import { applyFrame, createReducerState } from "./reducer.logic";
import { deriveTimelineRowsWithState } from "./rows.logic";

import {
  activity,
  ev,
  foldTurn,
  historyPage,
  historyTurn,
  message,
  resetBuilders,
  snapshot,
  stamp
} from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

const bounds = (overrides: Partial<ThreadHistoryBounds> = {}): ThreadHistoryBounds => ({
  indexed: true,
  hasOlder: true,
  beforeCursor: "cursor-window",
  oldestRetainedOrdinal: 41,
  totalTurns: 60,
  ...overrides
});

const history = (overrides: Partial<AgentChatHistoryState> = {}): AgentChatHistoryState => ({
  ...EMPTY_HISTORY,
  ...overrides
});

const ids = (items: readonly { id: string }[]): string[] => items.map((item) => item.id);

// ---------------------------------------------------------------------------
// The real fold, driven one step at a time
// ---------------------------------------------------------------------------

/** A parent tool row the timeline renders as a row of its own (an error is never grouped). */
const toolRow = (
  id: string,
  at: number,
  overrides: Partial<ThreadActivityItem> = {}
): ThreadActivityItem =>
  activity("tool.completed", { toolUseId: `call-${id}`, status: "failed" }, {
    id,
    turnId: "t9",
    tone: "error",
    createdAt: stamp(at),
    ...overrides
  });

/**
 * A window as a snapshot seeds it: `before` first, then as many parent rows as
 * the fold holds before it trims — whichever way it trims, the next parent row
 * appended makes it drop some.
 */
function fullWindow(before: ThreadItem[] = []): ThreadFoldState {
  const rows = Array.from({ length: ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK }, (_, index) =>
    toolRow(`w${index}`, 1_000 + index)
  );
  return applyFrame(createReducerState("s1"), { kind: "snapshot", thread: snapshot({ items: [...before, ...rows], seq: 10_000 }) }).fold;
}

let nextRow = 0;
let nextSeq = 10_000;

/** One step of the real fold: a new parent row appended. */
function appendStep(fold: ThreadFoldState, row?: ThreadActivityItem): HistoryFoldStep {
  nextRow += 1;
  nextSeq += 1;
  const event = ev(
    "thread.activity-appended",
    { activity: row ?? toolRow(`live${nextRow}`, 50_000 + nextRow) },
    { seq: nextSeq }
  );
  return { event, before: fold, after: applyDomainEvent(fold, event) };
}

/** Append until a step drops something, and hand that step back. */
function untilTrim(fold: ThreadFoldState): HistoryFoldStep {
  for (let guard = 0; guard < 2 * ACTIVITY_RETENTION_LIMIT; guard += 1) {
    const step = appendStep(fold);
    if (itemsDroppedByRetention(step.after).length > 0) {
      return step;
    }
    fold = step.after;
  }
  throw new Error("the fold never trimmed");
}

beforeEach(() => {
  nextRow = 0;
  nextSeq = 10_000;
});

// ---------------------------------------------------------------------------
// Bounds and resets
// ---------------------------------------------------------------------------

describe("historyBoundsFromSnapshot", () => {

  it("offers nothing for a malformed bounds block rather than a broken button", () => {
    for (const malformed of [
      { ...bounds(), hasOlder: "yes" },
      { ...bounds(), beforeCursor: 7 },
      { ...bounds(), indexed: undefined },
      { ...bounds(), totalTurns: "60" },
      { ...bounds(), oldestRetainedOrdinal: "41" },
      null,
      "bounds"
    ]) {
      const payload = snapshot({ history: malformed as unknown as ThreadHistoryBounds });
      assert.equal(historyBoundsFromSnapshot(payload), null, JSON.stringify(malformed));
    }
  });
});

describe("collectHistoryItems", () => {
  it("lists every page's items once, oldest page first — the newest page's copy of anything but a message", () => {
    const older = historyPage({
      items: [
        message("user", "one", { id: "u1" }),
        activity("task.progress", { detail: "1/5" }, { id: "p1", summary: "old" })
      ]
    });
    const newer = historyPage({
      items: [
        activity("task.progress", { detail: "4/5" }, { id: "p1", summary: "new" }),
        message("user", "two", { id: "u2" })
      ]
    });

    const collected = collectHistoryItems(EMPTY_HISTORY_ITEMS, [older, newer]);

    assert.deepEqual(ids(collected.items), ["u1", "p1", "u2"]);
    const p1 = collected.items.find((item) => item.id === "p1");
    assert.equal(p1?.kind === "activity" ? p1.summary : null, "new");
  });

  it("keeps the LONGER text of a message two pages share — never a concatenation", () => {
    const whole = historyPage({ items: [message("assistant", "the whole answer", { id: "m1", turnId: "t1" })] });
    const cut = historyPage({ items: [message("assistant", "the whole", { id: "m1", turnId: "t1" })] });
    const text = (pages: ThreadHistoryPage[]) => {
      const item = collectHistoryItems(EMPTY_HISTORY_ITEMS, pages).items[0];
      return item?.kind === "message" ? item.text : null;
    };
    assert.equal(text([whole, cut]), "the whole answer");
    assert.equal(text([cut, whole]), "the whole answer", "whichever page holds the longer copy");
  });

  describe("with the bridge", () => {

    it("renders a stable-id row the bridge received twice at its first place, with its last content", () => {
      const bridge = [
        toolRow("progress", 1, { summary: "1/5" }),
        toolRow("b2", 2),
        toolRow("progress", 3, { summary: "4/5" })
      ];
      const collected = collectHistoryItems(EMPTY_HISTORY_ITEMS, [], bridge);
      assert.deepEqual(ids(collected.items), ["progress", "b2"]);
      const progress = collected.items[0]!;
      assert.equal(progress.kind === "activity" ? progress.summary : null, "4/5");
    });

  });
});

describe("splitLiveItems", () => {
  const pagesHold = (ids: string[], lifecycleKeys: string[] = []) => ({
    ids: new Set(ids),
    lifecycleKeys: new Set(lifecycleKeys)
  });

  it("hands over a denial that closes a call a page began, so its start never renders running in the history", () => {
    // The call's only close is a denial: it must join the start's input, where it supersedes the start.
    const items: ThreadItem[] = [
      activity("tool.denied", { toolUseId: "T", toolName: "Bash" }, { id: "td", turnId: "t5", tone: "error" }),
      message("assistant", "denied", { id: "a5", turnId: "t5" })
    ];
    const page = historyPage({ items: [activity("tool.started", { toolUseId: "T" }, { id: "ts", turnId: "t5" })] });
    const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, collectHistoryItems(EMPTY_HISTORY_ITEMS, [page]));
    assert.deepEqual(ids(split.shared), ["td"]);
    assert.deepEqual(ids(split.rowItems), ["a5"]);
  });

  describe("with a window cut", () => {

    it("hands over the later rows of a task whose launch row lies before the cut", () => {
      const items: ThreadItem[] = [
        activity("task.started", { taskId: "K", agentKind: "agent" }, { id: "ks", turnId: "t5" }),
        message("assistant", "meanwhile", { id: "a5", turnId: "t5" }),
        activity("task.progress", { taskId: "K" }, { id: "kp", turnId: "t5" }),
        activity("task.completed", { taskId: "J", agentKind: "agent" }, { id: "jc", turnId: "t5" })
      ];
      const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold(["elsewhere"]), 1);
      assert.deepEqual(ids(split.shared), ["ks", "kp"], "the task's own rows, and only those");
      assert.deepEqual(ids(split.rowItems), ["a5", "jc"]);
    });

    it("keeps a spawn batch whole when the cut falls between its launch rows", () => {
      const launch = (taskId: string, id: string, turnId: string) =>
        activity("task.started", { taskId, agentKind: "agent" }, { id, turnId });
      const items: ThreadItem[] = [
        launch("K", "ks", "t5"),
        launch("L", "ls", "t5"),
        activity("task.completed", { taskId: "L", agentKind: "agent" }, { id: "lc", turnId: "t7" }),
        launch("M", "ms", "t8")
      ];
      const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold(["elsewhere"]), 1);
      assert.deepEqual(
        ids(split.shared),
        ["ks", "ls", "lc"],
        "the batch's other launch and its completion under a later turn follow; another turn's batch does not"
      );
    });

  });
});

describe("historyAfterRevert", () => {
  const pages = [
    historyPage({ turns: [historyTurn("t1", 1), historyTurn("t2", 2)] }),
    historyPage({ turns: [historyTurn("t3", 3)] })
  ];
  /** The fold's turns before the rewind: t1…t12, each opened by u1…u12. */
  const FOLD = Array.from({ length: 12 }, (_, index) => foldTurn(`t${index + 1}`, `u${index + 1}`));

  it("drops them for a bridge prompt whose turn the rewind removes — a prompt carries no turn id", () => {
    const state = history({
      bounds: bounds(),
      pages,
      bridge: [message("user", "six", { id: "u6", createdAt: stamp(60) })]
    });
    assert.deepEqual(historyAfterRevert(state, 5, FOLD).bridge, []);
    assert.deepEqual(historyAfterRevert(state, 6, FOLD), state, "turn 6 survives a rewind to six turns");
  });

  it("drops them for a turn-less prompt a page shows that no kept turn claims — the fold's fallback may drop it", () => {
    const withNote = [
      historyPage({
        turns: [historyTurn("t1", 1)],
        items: [message("user", "a note", { id: "note", createdAt: stamp(15) })]
      }),
      ...pages.slice(1)
    ];
    const state = history({ bounds: bounds(), pages: withNote });
    assert.deepEqual(historyAfterRevert(state, 5, FOLD).pages, []);
  });

  it("drops them for such a prompt on the bridge too", () => {
    const state = history({
      bounds: bounds(),
      pages,
      bridge: [message("user", "a note", { id: "note", createdAt: stamp(45) })]
    });
    const after = historyAfterRevert(state, 5, FOLD);
    assert.deepEqual(after.pages, []);
    assert.deepEqual(after.bridge, []);
  });

  it("keeps them for a page's prompt a kept turn claims, and for a subagent's turn-less words", () => {
    const state = history({
      bounds: bounds(),
      pages: [
        historyPage({
          turns: [historyTurn("t1", 1), historyTurn("t2", 2)],
          items: [
            message("user", "two", { id: "u2", createdAt: stamp(20) }),
            message("assistant", "still exploring", { id: "agent-words", agentId: "agent-1", createdAt: stamp(21) })
          ]
        })
      ]
    });
    assert.deepEqual(ids(historyAfterRevert(state, 5, FOLD).pages.flatMap((page) => page.items)), ["u2", "agent-words"]);
  });
});

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

describe("historyAfterEvent — the bridge", () => {
  const loaded = (): AgentChatHistoryState => history({ bounds: bounds(), pages: [historyPage()] });

  it("notes nothing when the window only dropped rows the parent timeline never showed", () => {
    // Parent rows well within their window, and one agent streaming its own
    // rows past its window: every trim takes agent rows only.
    const parentRows = Array.from({ length: ACTIVITY_RETENTION_LIMIT - 50 }, (_, index) =>
      toolRow(`p${index}`, 1 + index)
    );
    let fold = applyFrame(createReducerState("s1"), { kind: "snapshot", thread: snapshot({ items: parentRows, seq: 10_000 }) }).fold;
    let state = history({ bounds: bounds({ hasOlder: false }) });
    let trims = 0;
    for (let guard = 0; guard < 2_000 && trims < 3; guard += 1) {
      const step = appendStep(fold, toolRow(`agent-${guard}`, 5_000 + guard, { agentId: "agent-1" }));
      const dropped = itemsDroppedByRetention(step.after);
      if (dropped.length > 0) {
        trims += 1;
        assert.ok(dropped.every((item) => item.agentId === "agent-1"), "only agent rows left the window");
      }
      state = historyAfterEvent(state, step);
      fold = step.after;
    }
    assert.equal(trims, 3, "the agent's window trimmed");
    assert.equal(state.windowEvicted, false);
    assert.equal(canLoadOlderHistory(state), false);
  });

  it("keeps only the rows the parent timeline renders — an agent's own rows live in its drill-in", () => {
    // 260 rows one agent owns, past its window; the next parent row trims the
    // parent class AND the agent's.
    const agentRows = Array.from({ length: 260 }, (_, index) =>
      toolRow(`agent-${index}`, 100 + index, { agentId: "agent-1" })
    );
    const step = untilTrim(fullWindow(agentRows));
    const dropped = itemsDroppedByRetention(step.after);
    assert.ok(dropped.some((item) => item.agentId === "agent-1"), "the fixture drops agent rows");
    const bridge = historyAfterEvent(loaded(), step).bridge;
    assert.ok(bridge.length > 0);
    assert.deepEqual(
      ids(bridge),
      ids(dropped.filter((item) => item.agentId === undefined)),
      "every parent row, in order, and no agent row"
    );
  });

  it("recounts the cut when a rewind confined to the window removes a row before it", () => {
    const u1 = message("user", "one", { id: "u1", createdAt: stamp(1) });
    const a2 = message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(2) });
    const turnless = Array.from({ length: 5 }, (_, index) => toolRow(`n${index}`, 10 + index, { turnId: null }));
    const before = applyFrame(createReducerState("s1"), {
      kind: "snapshot",
      thread: snapshot({ items: [u1, a2, ...turnless], turns: [foldTurn("t1", "u1"), foldTurn("t2")], seq: 10_000 })
    }).fold;
    const event = ev("thread.reverted", { turnCount: 1 }, { seq: 10_001 });
    const after = applyDomainEvent(before, event);
    assert.deepEqual(ids(after.items).slice(0, 2), ["u1", "n0"], "the fold dropped turn 2's answer");
    // A turn-less bridge row no rewind reaches; `u1` and `a2` were the cut.
    const state = history({ pages: [historyPage()], bridge: [toolRow("old", 0, { turnId: null })], windowCut: 2 });
    const next = historyAfterEvent(state, { event, before, after });
    assert.deepEqual(next.bridge, state.bridge);
    assert.equal(next.windowCut, 1);
  });

});

describe("the page's end in the window (pageEndCut, historyWithPage)", () => {
  /** The window's list, in first-emission order: turn 1's words, turn 5's, turn 7 whole. */
  const window = (): ThreadItem[] => [
    message("user", "one", { id: "u1" }),
    message("assistant", "one", { id: "a1", turnId: "t1" }),
    message("user", "five", { id: "u5" }),
    message("assistant", "five", { id: "a5", turnId: "t5" }),
    toolRow("x7", 70, { turnId: "t7" }),
    message("assistant", "seven", { id: "a7", turnId: "t7" })
  ];

  it("takes whichever rule reaches further, and falls back when the window no longer holds that row", () => {
    const shared = [message("assistant", "five", { id: "a5", turnId: "t5" })];
    const endsEarlier = historyPage({ items: shared, page: { beforeCursor: null, endItemId: "u5" } });
    assert.equal(historyWithPage(history(), endsEarlier, window()).windowCut, 4, "the rows it shares lie further on");
    const evicted = historyPage({ items: shared, page: { beforeCursor: null, endItemId: "gone" } });
    assert.equal(historyWithPage(history(), evicted, window()).windowCut, 4, "evicted since: the shared rows still say where it ends");
    const endless = historyPage({ items: [toolRow("x5", 50)], page: { beforeCursor: null, endItemId: null } });
    assert.equal(historyWithPage(history(), endless, window()).windowCut, 0, "no row at the end, nothing shared: nothing moves");
  });

  it("reads the page's end field-wise — a string or null as sent, anything else as absent", () => {
    const withEnd = (endItemId: unknown): ThreadHistoryPage =>
      ({ ...historyPage(), page: { beforeCursor: null, endItemId } }) as unknown as ThreadHistoryPage;
    const cut = (page: ThreadHistoryPage) => historyWithPage(history(), page, window()).windowCut;
    assert.equal(cut(withEnd("x7")), 4);
    assert.equal(cut(historyPage()), 0, "a host that predates the field");
    for (const absentOrMalformed of [null, 7, true, { id: "x7" }, ["x7"]]) {
      assert.equal(cut(withEnd(absentOrMalformed)), 0);
    }
    const noBlock = { ...historyPage(), page: "below" } as unknown as ThreadHistoryPage;
    assert.equal(cut(noBlock), 0);
  });
});

describe("historyWithinCap", () => {
  const page = (rows: number, beforeCursor: string | null): ThreadHistoryPage =>
    historyPage({
      items: Array.from({ length: rows }, (_, index) => toolRow(`${beforeCursor}-${index}`, index)),
      page: { beforeCursor }
    });
  const bridgeOf = (rows: number): ThreadItem[] =>
    Array.from({ length: rows }, (_, index) => toolRow(`b${index}`, 900 + index));

  it("drops the OLDEST pages first, and 'load older' then asks for exactly the block that went", () => {
    const oldest = page(5_000, "below-oldest");
    const middle = page(5_000, "below-middle");
    const newest = page(5_000, "below-newest");
    const state = history({ bounds: bounds(), pages: [oldest, middle, newest], bridge: bridgeOf(7_500) });

    const { history: capped, resync } = historyWithinCap(state);

    assert.equal(resync, false);
    assert.deepEqual(capped.pages, [middle, newest]);
    assert.deepEqual(capped.bridge, state.bridge);
    assert.ok(capped.bridge.length + capped.pages.flatMap((page) => page.items).length <= 20_000);
    assert.equal(
      nextHistoryCursor(capped),
      "below-middle",
      "the oldest remaining page's cursor names the block that was dropped"
    );
  });

  it("never drops the newest page on its own: past the cap with it, everything goes and fresh bounds are asked for", () => {
    const state = history({
      bounds: bounds(),
      pages: [page(10_000, "older"), page(13_000, "newest")],
      bridge: bridgeOf(7_500),
      windowCut: 4,
      error: "stale"
    });
    const { history: capped, resync } = historyWithinCap(state);
    assert.equal(resync, true);
    assert.deepEqual([capped.pages, capped.bridge, capped.windowCut, capped.error], [[], [], 0, null]);
    assert.deepEqual(capped.bounds, state.bounds, "the fresh snapshot replaces them");
  });

  it("drops everything when the bridge alone passes the cap", () => {
    const { history: capped, resync } = historyWithinCap(history({ bridge: bridgeOf(20_001) }));
    assert.equal(resync, true);
    assert.deepEqual(capped.bridge, []);
  });
});

describe("rowIdForTurn", () => {
  const rowsOf = (items: ThreadItem[], expanded: string[] = []): AgentChatTimelineRow[] =>
    deriveTimelineRowsWithState({
      timelineEntries: deriveTimelineEntriesFromItems(items).entries,
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set(expanded),
      supportsConversationRollback: false
    }).rows;

  it("a goal marker is a row its turn owns (goals §8.4)", () => {
    const rows = rowsOf([
      message("user", "other", { id: "u0" }),
      activity(
        "goal.updated",
        { goal: { objective: "Make CI green", status: "active" }, change: "set" },
        { id: "g1", turnId: "t1", tone: "info", summary: "Goal set: Make CI green", createdAt: stamp(20) }
      )
    ]);
    assert.equal(rowIdForTurn(rows, "t1", null), "g1");
  });
});

// ---------------------------------------------------------------------------
// Page rows
// ---------------------------------------------------------------------------

describe("page rows above the live window", () => {
  /** Turns 1–2 in a page, turn 3 live — the fold knows all three. */
  const conversation = (pageTurns = [
    historyTurn("t1", 1, { userMessageId: "u1" }),
    historyTurn("t2", 2, { userMessageId: "u2" })
  ]) => {
    const page = historyPage({
      items: [
        message("user", "first", { id: "u1", createdAt: stamp(1) }),
        message("assistant", "one", { id: "a1", turnId: "t1", createdAt: stamp(2) }),
        message("user", "second", { id: "u2", createdAt: stamp(3) }),
        message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(4) })
      ],
      turns: pageTurns
    });
    const turns = [foldTurn("t1", "u1"), foldTurn("t2", "u2"), foldTurn("t3", "u3")];
    const live = deriveTimelineRowsWithState({
      timelineEntries: deriveTimelineEntriesFromItems([
        message("user", "third", { id: "u3", createdAt: stamp(5) }),
        message("assistant", "three", { id: "a3", turnId: "t3", createdAt: stamp(6) })
      ]).entries,
      isWorking: false,
      activeTurnStartedAt: null,
      turns,
      supportsConversationRollback: true
    }).rows;
    const input: HistoryRowsInput = {
      history: collectHistoryItems(EMPTY_HISTORY_ITEMS, [page]),
      sharedLive: [],
      expandedTurnIds: new Set(),
      expandedWorkGroupIds: new Set(),
      turns,
      supportsConversationRollback: true,
      liveCompacted: false
    };
    return { page, turns, live, input };
  };

  /** The same input over a different set of loaded pages. */
  const withPages = (input: HistoryRowsInput, pages: ThreadHistoryPage[]): HistoryRowsInput => ({
    ...input,
    history: collectHistoryItems(EMPTY_HISTORY_ITEMS, pages)
  });

  const revertCounts = (rows: readonly AgentChatTimelineRow[]) =>
    Object.fromEntries(
      rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "user" ? [[row.id, row.revertTurnCount]] : []
      )
    );

  it("drops an old Claude log's re-emitted copy from the history rows when the store asks", () => {
    // The pages are where the copies older hosts wrote live (AGENTS.md "A turn
    // the CLI starts by itself…"); the store asks for the repair on a Claude
    // thread, exactly as it does for the window.
    const { input } = conversation();
    const opening = "All checks are now clean.";
    const page = historyPage({
      items: [
        message("user", "go", { id: "u9", createdAt: stamp(1) }),
        message("assistant", opening, { id: "o9", turnId: "t9", createdAt: stamp(2) }),
        message("assistant", "The real answer.", { id: "f9", turnId: "t9", createdAt: stamp(3) }),
        message("assistant", opening, { id: "c9", turnId: "t9", createdAt: stamp(4) })
      ]
    });
    const project = (dropRepeatedAssistantMessages: boolean) =>
      projectHistoryRows(EMPTY_HISTORY_ROWS, { ...withPages(input, [page]), dropRepeatedAssistantMessages }).rows;
    const answerOf = (rows: readonly AgentChatTimelineRow[]) =>
      rows.flatMap((row) =>
        (row.kind === "message" && row.showAssistantMeta) || row.kind === "assistant-meta" ? [row.message.id] : []
      );

    const repaired = project(true);
    assert.deepEqual(answerOf(repaired), ["f9"], "the real answer closes the turn");
    assert.ok(!ids(repaired).includes("c9"), "the copy is gone");
    assert.deepEqual(answerOf(project(false)), ["c9"], "unrepaired, the copy would be the answer");
  });

  it("keeps a turn's work in log order across a page boundary", () => {
    const { input } = conversation();
    // Pages are blocks of the log by activity count, so a boundary can fall
    // inside a turn: t1's reasoning and first tool call on the older page,
    // its second tool call and its answer on the newer one, t1 listed on both.
    const older = historyPage({
      items: [
        message("user", "first", { id: "u1", createdAt: stamp(1) }),
        message("reasoning", "thinking it over", { id: "r1", turnId: "t1", createdAt: stamp(2) }),
        activity("tool.completed", { status: "completed" }, { id: "x1", turnId: "t1", createdAt: stamp(3) })
      ],
      turns: [historyTurn("t1", 1, { userMessageId: "u1" })]
    });
    const newer = historyPage({
      items: [
        activity("tool.completed", { status: "completed" }, { id: "x2", turnId: "t1", createdAt: stamp(4) }),
        message("assistant", "done", { id: "a1", turnId: "t1", createdAt: stamp(5) })
      ],
      turns: [historyTurn("t1", 1, { userMessageId: "u1" })]
    });

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, {
      ...withPages(input, [older, newer]),
      expandedTurnIds: new Set(["t1"])
    }).rows;

    assert.deepEqual(
      rows.flatMap((row) => row.kind === "activity-group" ? row.entries.map((entry) => entry.id) : []),
      ["r1", "x1", "x2"],
      "work from both sides of the boundary appears once, in log order"
    );
  });

  describe("a page's words stream only while the rule says so (isMessageStreaming)", () => {
    /** Turn t1 on a page, its answer still flagged: the host streaming it was killed. */
    const stuckPage = () =>
      historyPage({
        items: [
          message("user", "first", { id: "u1", createdAt: stamp(1) }),
          activity(
            "tool.completed",
            { itemType: "command_execution", toolUseId: "call-1", title: "ls", command: "ls", status: "completed" },
            { id: "x1", turnId: "t1", createdAt: stamp(2) }
          ),
          message("assistant", "Half an answer", { id: "a1", turnId: "t1", streaming: true, createdAt: stamp(3) })
        ],
        turns: [historyTurn("t1", 1, { userMessageId: "u1" })]
      });
    const context = (activeTurnId: string | null, roster: { id: string; status: "running" | "completed" }[] = []) =>
      messageStreamingContext({ head: { session: { status: "running", activeTurnId } }, roster });
    const answer = (rows: readonly AgentChatTimelineRow[]) =>
      rows.find((row): row is Extract<AgentChatTimelineRow, { kind: "message" }> => row.kind === "message" && row.id === "a1");

    it("a running turn's answer up here still streams", () => {
      // A turn so long its early rows went to the history.
      const { input } = conversation();
      const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, {
        ...withPages(input, [stuckPage()]),
        unsettledTurnId: "t1",
        isWorking: true,
        messageStreaming: context("t1")
      }).rows;
      assert.equal(answer(rows)?.streaming, true);
    });

  });

  describe("rewind to a page row", () => {

    it("is withheld where the index and the fold disagree about the turn's place", () => {
      const { input } = conversation([
        historyTurn("t1", 1, { userMessageId: "u1" }),
        historyTurn("t2", 5, { userMessageId: "u2" })
      ]);
      assert.deepEqual(revertCounts(projectHistoryRows(EMPTY_HISTORY_ROWS, input).rows), {
        u1: 0,
        u2: undefined
      });
    });

    it("is withheld on every page once the live window holds a settled compaction", () => {
      const { input } = conversation();
      const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, { ...input, liveCompacted: true }).rows;
      assert.deepEqual(revertCounts(rows), { u1: undefined, u2: undefined });
    });

    it("reads a turn listed on two pages by the newest page's copy", () => {
      const { input, page } = conversation();
      const newer = historyPage({
        items: [message("assistant", "one, continued", { id: "a1b", turnId: "t1", createdAt: stamp(2) })],
        turns: [historyTurn("t1", 1, { userMessageId: "u1", rewindable: false })]
      });
      const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, withPages(input, [page, newer])).rows;
      const counts = revertCounts(rows);
      assert.ok(Object.hasOwn(counts, "u1"), "the prompt remains visible");
      assert.equal(counts.u1, undefined, "the newest copy withholds it");
    });
  });
});

describe("bridge rows above the live window", () => {
  const turns = [foldTurn("t1", "u1"), foldTurn("t2", "u2"), foldTurn("t3", "u3")];
  const input = (history: HistoryRowsInput["history"], sharedLive: ThreadItem[] = []): HistoryRowsInput => ({
    history,
    sharedLive,
    expandedTurnIds: new Set(["t1", "t2", "t3", "t5"]),
    expandedWorkGroupIds: new Set(),
    turns,
    supportsConversationRollback: true,
    liveCompacted: false
  });

  it("offers rewind on a prompt that came through the bridge by the fold's own numbering; a page prompt stays gated", () => {
    const page = historyPage({
      items: [
        message("user", "first", { id: "u1", createdAt: stamp(1) }),
        message("assistant", "one", { id: "a1", turnId: "t1", createdAt: stamp(2) }),
        message("user", "second", { id: "u2", createdAt: stamp(3) })
      ],
      // The index lists turn 1 only, so turn 2's prompt is withheld.
      turns: [historyTurn("t1", 1, { userMessageId: "u1" })]
    });
    const bridge = [
      message("user", "third", { id: "u3", createdAt: stamp(5) }),
      message("assistant", "three", { id: "a3", turnId: "t3", createdAt: stamp(6) })
    ];

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, input(collectHistoryItems(EMPTY_HISTORY_ITEMS, [page], bridge))).rows;

    const counts = Object.fromEntries(
      rows.flatMap((row) =>
        row.kind === "message" && row.message.role === "user" ? [[row.id, row.revertTurnCount]] : []
      )
    );
    assert.deepEqual(counts, { u1: 0, u2: undefined, u3: 2 });
  });

  it("anchors a spawn row on the window's launch row, not on a progress row the bridge got after it", () => {
    // The agent's launch row is exempt from retention and never leaves the
    // window; its progress row, updated in place at an old position, did.
    const launch = activity("task.started", { taskId: "K", agentKind: "agent", status: "running" }, {
      id: "ks",
      turnId: "t5",
      summary: "Research",
      createdAt: stamp(50)
    });
    const progress = activity("task.progress", { taskId: "K", agentKind: "agent", status: "running" }, {
      id: "kp",
      turnId: "t5",
      summary: "Reading",
      createdAt: stamp(60)
    });
    const history = collectHistoryItems(EMPTY_HISTORY_ITEMS, [], [message("user", "go", { id: "u5", createdAt: stamp(40) }), progress]);

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, input(history, [launch])).rows;

    const spawns = rows.filter((row) => row.kind === "work" && row.groupedEntries.some((entry) => entry.agentSpawn));
    assert.deepEqual(ids(spawns), ["ks"], "one spawn row, keyed and placed by its launch");
  });
});

describe("windowHasDropped: the thread's retained window has evicted rows (§7.6)", () => {
  it("this client's fold evicted rows since that snapshot — any row, an agent's included", () => {
    assert.equal(windowHasDropped({ evicted: { activities: true, messages: false } }, EMPTY_HISTORY), true);
    assert.equal(windowHasDropped({ evicted: { activities: false, messages: true } }, EMPTY_HISTORY), true);
  });
});
