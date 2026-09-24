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
  HISTORY_REVEAL_PAGE_CAP,
  HISTORY_ROW_CAP,
  historyAfterEvent,
  historyAfterRevert,
  historyBoundsFromSnapshot,
  historyErrorMessage,
  historyRowCount,
  historyTurns,
  historyWithinCap,
  historyWithPage,
  lifecycleKeyOf,
  liveTurnIdsOf,
  mergeHistoryPage,
  mergeTimelineRows,
  nextHistoryCursor,
  pageEndCut,
  pageEndItemId,
  planReveal,
  projectHistoryRows,
  resetHistory,
  rowIdForTurn,
  spawnGroupKeyOf,
  splitLiveItems,
  withoutOrphanBridge,
  type HistoryFoldStep,
  type HistoryRowsInput
} from "./history.logic";
import { deriveTimelineEntriesFromItems, workLogEntryFromActivity } from "./entries.logic";
import { foldStateFromSnapshot } from "./reducer.logic";
import { deriveTimelineRows } from "./rows.logic";
import { AgentChatCommandError } from "./transport";
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
  return foldStateFromSnapshot(snapshot({ items: [...before, ...rows], seq: 10_000 }));
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
  it("reads the bounds a snapshot carries", () => {
    const carried = bounds({ beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 3 });
    assert.deepEqual(historyBoundsFromSnapshot(snapshot({ history: carried })), {
      indexed: true,
      hasOlder: true,
      beforeCursor: null,
      oldestRetainedOrdinal: null,
      totalTurns: 3
    });
  });

  it("offers nothing for a host that predates the index", () => {
    assert.equal(historyBoundsFromSnapshot(snapshot()), null);
  });

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

describe("resetHistory", () => {
  it("drops every page, keeps the new bounds and clears the error", () => {
    const next = bounds({ beforeCursor: "fresh" });
    const reset = resetHistory(
      next,
      history({ bounds: bounds(), pages: [historyPage()], error: "boom" })
    );
    assert.equal(reset.bounds, next);
    assert.deepEqual(reset.pages, []);
    assert.equal(reset.error, null);
  });

  it("mints a fresh pages array every time, so an in-flight page can tell it was superseded", () => {
    const previous = history({ bounds: bounds() });
    const first = resetHistory(bounds(), previous);
    const second = resetHistory(bounds(), first);
    assert.notEqual(first.pages, previous.pages);
    assert.notEqual(second.pages, first.pages);
  });

  it("keeps a request's spinner until that request settles", () => {
    assert.equal(resetHistory(bounds(), history({ loading: true })).loading, true);
    assert.equal(resetHistory(bounds(), history()).loading, false);
  });

  it("drops the bridge and its window cut with the pages: they joined a window that is gone", () => {
    const reset = resetHistory(
      bounds(),
      history({ pages: [historyPage()], bridge: [toolRow("b1", 1)], windowCut: 3 })
    );
    assert.deepEqual(reset.bridge, []);
    assert.equal(reset.windowCut, 0);
  });
});

// ---------------------------------------------------------------------------
// The page cache
// ---------------------------------------------------------------------------

describe("mergeHistoryPage", () => {
  it("puts an older page before every page already held, exactly as the host sent it", () => {
    const newer = historyPage({ items: [message("user", "b", { id: "b1" })], turns: [historyTurn("t2", 2)] });
    const older = historyPage({
      items: [message("user", "a", { id: "a1" }), message("user", "b", { id: "b1" })],
      turns: [historyTurn("t1", 1), historyTurn("t2", 2)]
    });

    const pages = mergeHistoryPage([newer], older);

    assert.equal(pages[0], older, "nothing is filtered on the way in — a turn may span pages");
    assert.equal(pages[1], newer, "the held page is untouched");
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
    assert.deepEqual([...collected.ids].sort(), ["p1", "u1", "u2"]);
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

  it("knows every call and every task its pages began", () => {
    const page = historyPage({
      items: [
        message("user", "go", { id: "u5" }),
        activity("tool.started", { toolUseId: "T" }, { id: "ts", turnId: "t5" }),
        activity("task.started", { taskId: "K" }, { id: "ks", turnId: "t5" })
      ]
    });
    assert.deepEqual(
      [...collectHistoryItems(EMPTY_HISTORY_ITEMS, [page]).lifecycleKeys].sort(),
      ["task:K", "tool:t5:T"]
    );
  });

  it("is memoised by the pages array", () => {
    const pages = [historyPage({ items: [message("user", "one", { id: "u1" })] })];
    const first = collectHistoryItems(EMPTY_HISTORY_ITEMS, pages);
    assert.equal(collectHistoryItems(first, pages), first);
    assert.equal(collectHistoryItems(first, []), EMPTY_HISTORY_ITEMS);
  });

  describe("with the bridge", () => {
    it("lists the bridge after the newest page", () => {
      const page = historyPage({ items: [message("user", "one", { id: "u1" })] });
      const collected = collectHistoryItems(EMPTY_HISTORY_ITEMS, [page], [toolRow("b1", 5), toolRow("b2", 6)]);
      assert.deepEqual(ids(collected.items), ["u1", "b1", "b2"]);
      assert.deepEqual([...collected.pageIds], ["u1"], "only a page's rows answer to the index's rewind gate");
    });

    it("renders a row the first page repeats from the window once — at the page's place, with the newest content", () => {
      // The host's first page overlaps the window's oldest rows; the window
      // later hands exactly those rows to the bridge.
      const page = historyPage({
        items: [toolRow("p1", 1), toolRow("o1", 2, { summary: "as the page saw it" }), toolRow("o2", 3)]
      });
      const bridge = [toolRow("o1", 2, { summary: "as the window left it" }), toolRow("o2", 3), toolRow("b3", 4)];

      const collected = collectHistoryItems(EMPTY_HISTORY_ITEMS, [page], bridge);

      assert.deepEqual(ids(collected.items), ["p1", "o1", "o2", "b3"], "once each, in the page's order");
      const o1 = collected.items[1]!;
      assert.equal(o1.kind === "activity" ? o1.summary : null, "as the window left it");
    });

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

    it("keeps the longer text of a message a page cut short", () => {
      const page = historyPage({ items: [message("assistant", "the whole answer", { id: "m1", turnId: "t1" })] });
      const bridge = [message("assistant", "the whole", { id: "m1", turnId: "t1" })];
      const item = collectHistoryItems(EMPTY_HISTORY_ITEMS, [page], bridge).items[0];
      assert.equal(item?.kind === "message" ? item.text : null, "the whole answer");
    });

    it("is memoised by the pages and the bridge arrays together", () => {
      const pages = [historyPage({ items: [toolRow("p1", 1)] })];
      const bridge = [toolRow("b1", 2)];
      const first = collectHistoryItems(EMPTY_HISTORY_ITEMS, pages, bridge);
      assert.equal(collectHistoryItems(first, pages, bridge), first);
      const grown = collectHistoryItems(first, pages, [...bridge, toolRow("b2", 3)]);
      assert.notEqual(grown, first);
      assert.deepEqual(ids(grown.items), ["p1", "b1", "b2"]);
      assert.equal(collectHistoryItems(grown, [], []), EMPTY_HISTORY_ITEMS);
    });
  });
});

describe("spawnGroupKeyOf", () => {
  const launch = (taskId: string, payload: Record<string, unknown> = {}, turnId: string | null = "t5") =>
    activity("task.started", { taskId, agentKind: "agent", ...payload }, { turnId });

  it("batches an agent's launch rows as the timeline does: per turn, or per workflow", () => {
    assert.equal(spawnGroupKeyOf(launch("K")), "spawn:direct:t5");
    assert.equal(spawnGroupKeyOf(launch("K", {}, null)), "spawn:direct:task:K");
    assert.equal(spawnGroupKeyOf(launch("W:wf:2")), "spawn:wf:W");
    assert.equal(spawnGroupKeyOf(launch("W", { taskType: "local_workflow" })), "spawn:wf:W");
  });

  it("keys nothing but an agent's launch row", () => {
    assert.equal(spawnGroupKeyOf(activity("task.started", { taskId: "S", agentKind: "background" })), null);
    assert.equal(spawnGroupKeyOf(activity("task.completed", { taskId: "K", agentKind: "agent" })), null);
    assert.equal(spawnGroupKeyOf(message("user", "K")), null);
  });
});

describe("lifecycleKeyOf", () => {
  it("keys a call's lifecycle rows by turn and tool use id", () => {
    for (const kind of ["tool.started", "tool.updated", "tool.completed", "tool.output"]) {
      assert.equal(
        lifecycleKeyOf(activity(kind, { toolUseId: " T " }, { turnId: "t5" })),
        "tool:t5:T",
        kind
      );
    }
  });

  it("keys a task's rows by task id", () => {
    for (const kind of ["task.started", "task.progress", "task.completed"]) {
      assert.equal(lifecycleKeyOf(activity(kind, { taskId: "K", toolUseId: "T" }, { turnId: "t5" })), "task:K", kind);
    }
  });

  it("keys nothing else", () => {
    assert.equal(lifecycleKeyOf(activity("tool.completed", {}, { turnId: "t5" })), null, "no tool use id");
    assert.equal(lifecycleKeyOf(activity("approval.requested", { toolUseId: "T" }, { turnId: "t5" })), null);
    assert.equal(lifecycleKeyOf(message("assistant", "T", { turnId: "t5" })), null);
  });
});

describe("splitLiveItems", () => {
  const windowItems = (): ThreadItem[] => [
    message("user", "prompt", { id: "u5" }),
    activity("tool.completed", {}, { id: "x7", turnId: "t5" })
  ];
  const pagesHold = (ids: string[], lifecycleKeys: string[] = []) => ({
    ids: new Set(ids),
    lifecycleKeys: new Set(lifecycleKeys)
  });

  it("leaves the window's items untouched while no page holds any of them", () => {
    const items = windowItems();
    const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold(["elsewhere"]));
    assert.equal(split.rowItems, items);
    assert.equal(split.shared.length, 0);
  });

  it("takes an item a page also holds out of the window's rows, keeping the window's copy of it", () => {
    const items = windowItems();
    const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold(["u5"]));
    assert.deepEqual(ids(split.rowItems), ["x7"]);
    assert.equal(split.shared.length, 1);
    assert.equal(split.shared[0], items[0], "the window's own object — its content is the newer");
  });

  it("also hands over the window's later rows of a call or a task a page began — and only those", () => {
    const items: ThreadItem[] = [
      activity("tool.completed", { toolUseId: "T" }, { id: "tc", turnId: "t5" }),
      activity("tool.completed", { toolUseId: "U" }, { id: "uc", turnId: "t5" }),
      activity("task.completed", { taskId: "K" }, { id: "kc", turnId: "t5" }),
      activity("task.completed", { taskId: "J" }, { id: "jc", turnId: "t5" }),
      message("assistant", "done", { id: "a5", turnId: "t5" })
    ];
    const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold([], ["tool:t5:T", "task:K"]));
    assert.deepEqual(ids(split.shared), ["tc", "kc"]);
    assert.deepEqual(ids(split.rowItems), ["uc", "jc", "a5"]);
  });

  it("keeps the shared list's identity while its items did not move", () => {
    const items = windowItems();
    const history = pagesHold(["u5"]);
    const first = splitLiveItems(EMPTY_LIVE_SPLIT, items, history);
    const next = splitLiveItems(
      first,
      [...items, message("assistant", "streaming", { id: "a9", turnId: "t5" })],
      history
    );
    assert.equal(next.shared, first.shared, "a row streaming elsewhere never re-projects the history");
    assert.equal(splitLiveItems(next, next.source, history), next);
  });

  describe("with a window cut", () => {
    it("hands every item before the cut to the history, whatever it is", () => {
      const items: ThreadItem[] = [
        message("user", "old prompt", { id: "u1" }),
        activity("context-compaction", { state: "compacted" }, { id: "c1", tone: "info" }),
        message("user", "newer prompt", { id: "u9" })
      ];
      const split = splitLiveItems(EMPTY_LIVE_SPLIT, items, pagesHold(["elsewhere"]), 2);
      assert.deepEqual(ids(split.shared), ["u1", "c1"]);
      assert.deepEqual(ids(split.rowItems), ["u9"]);
    });

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

    it("is part of the memo key", () => {
      const items = windowItems();
      const history = pagesHold(["elsewhere"]);
      const uncut = splitLiveItems(EMPTY_LIVE_SPLIT, items, history, 0);
      const cut = splitLiveItems(uncut, items, history, 1);
      assert.notEqual(cut, uncut);
      assert.deepEqual(ids(cut.shared), ["u5"]);
      assert.equal(splitLiveItems(cut, items, history, 1), cut);
    });
  });
});

describe("historyTurns", () => {
  it("lists a turn two pages share once, with the newest page's fields", () => {
    const older = historyPage({
      turns: [
        historyTurn("t1", 1),
        historyTurn("t2", 2, { rewindable: true, completedAt: null })
      ]
    });
    const newer = historyPage({
      turns: [historyTurn("t2", 2, { rewindable: false, completedAt: stamp(99) }), historyTurn("t3", 3)]
    });

    const turns = historyTurns([older, newer]);

    assert.deepEqual(turns.map((turn) => turn.turnId), ["t1", "t2", "t3"], "oldest first, once each");
    assert.equal(turns[1]?.rewindable, false);
    assert.equal(turns[1]?.completedAt, stamp(99));
  });
});

describe("the load-older cursor", () => {
  it("offers the first page below the window when the snapshot says there is one", () => {
    const state = history({ bounds: bounds({ beforeCursor: "cursor-window" }) });
    assert.equal(canLoadOlderHistory(state), true);
    assert.equal(nextHistoryCursor(state), "cursor-window");
  });

  it("asks without a cursor when the snapshot names none", () => {
    const state = history({ bounds: bounds({ beforeCursor: null }) });
    assert.equal(canLoadOlderHistory(state), true);
    assert.equal(nextHistoryCursor(state), undefined);
  });

  it("offers nothing without bounds, without an index, or with nothing older", () => {
    assert.equal(canLoadOlderHistory(history()), false);
    assert.equal(canLoadOlderHistory(history({ bounds: bounds({ indexed: false }) })), false);
    assert.equal(canLoadOlderHistory(history({ bounds: bounds({ hasOlder: false }) })), false);
  });

  it("follows the oldest page's cursor and stops at turn 1", () => {
    const newest = historyPage({ page: { beforeCursor: "cursor-newest" } });
    const oldest = historyPage({ page: { beforeCursor: "cursor-oldest" } });
    const more = history({ bounds: bounds(), pages: [oldest, newest] });
    assert.equal(canLoadOlderHistory(more), true);
    assert.equal(nextHistoryCursor(more), "cursor-oldest");

    const done = history({
      bounds: bounds(),
      pages: [historyPage({ page: { beforeCursor: null } }), newest]
    });
    assert.equal(canLoadOlderHistory(done), false, "the snapshot's own hasOlder no longer applies");
  });

  it("asks without a cursor once the window has evicted since its snapshot — that cursor no longer meets it", () => {
    const fresh = history({ bounds: bounds({ beforeCursor: "cursor-window" }) });
    assert.equal(nextHistoryCursor(fresh), "cursor-window");
    const evicted = history({ bounds: bounds({ beforeCursor: "cursor-window" }), windowEvicted: true });
    assert.equal(nextHistoryCursor(evicted), undefined);
    assert.equal(canLoadOlderHistory(evicted), true, "still offered: only the cursor changes");
  });

  it("keeps following the oldest page's cursor whatever the window evicted", () => {
    const state = history({
      bounds: bounds(),
      pages: [historyPage({ page: { beforeCursor: "cursor-oldest" } })],
      windowEvicted: true
    });
    assert.equal(nextHistoryCursor(state), "cursor-oldest");
  });

  it("offers older history once the window evicted a row, whatever the snapshot's hasOlder said", () => {
    const nothingOlder = bounds({ hasOlder: false, beforeCursor: null });
    assert.equal(canLoadOlderHistory(history({ bounds: nothingOlder })), false);
    const evicted = history({ bounds: nothingOlder, windowEvicted: true });
    assert.equal(canLoadOlderHistory(evicted), true);
    assert.equal(nextHistoryCursor(evicted), undefined, "the block just below the window as it stands");
    assert.equal(
      canLoadOlderHistory(history({ bounds: bounds({ indexed: false, hasOlder: false }), windowEvicted: true })),
      false,
      "never without an index"
    );
  });
});

describe("historyAfterRevert", () => {
  const pages = [
    historyPage({ turns: [historyTurn("t1", 1), historyTurn("t2", 2)] }),
    historyPage({ turns: [historyTurn("t3", 3)] })
  ];
  /** The fold's turns before the rewind: t1…t12, each opened by u1…u12. */
  const FOLD = Array.from({ length: 12 }, (_, index) => foldTurn(`t${index + 1}`, `u${index + 1}`));

  it("keeps every page when the rewind lands inside the live window", () => {
    const state = history({ bounds: bounds(), pages });
    assert.equal(historyAfterRevert(state, 3, FOLD), state);
    assert.equal(historyAfterRevert(state, 12, FOLD), state);
  });

  it("drops every page once the rewind reaches into one, so no gap can open", () => {
    const state = history({ bounds: bounds(), pages, error: "stale" });
    const after = historyAfterRevert(state, 2, FOLD);
    assert.deepEqual(after.pages, []);
    assert.equal(after.bounds, state.bounds, "the content-derived cursor still pages correctly");
  });

  it("has nothing to drop when nothing is loaded", () => {
    const state = history({ bounds: bounds() });
    assert.equal(historyAfterRevert(state, 0, FOLD), state);
  });

  it("keeps pages and bridge when every bridge row's turn survives the rewind", () => {
    const state = history({
      bounds: bounds(),
      pages,
      bridge: [
        toolRow("x4", 40, { turnId: "t4" }),
        message("user", "five", { id: "u5", createdAt: stamp(50) }),
        toolRow("x-turnless", 51, { turnId: null })
      ],
      windowCut: 2
    });
    assert.equal(historyAfterRevert(state, 5, FOLD), state);
  });

  it("drops pages AND bridge once the rewind removes a bridge row's turn", () => {
    const state = history({
      bounds: bounds(),
      pages,
      bridge: [toolRow("x4", 40, { turnId: "t4" }), toolRow("x6", 60, { turnId: "t6" })],
      windowCut: 2
    });
    const after = historyAfterRevert(state, 5, FOLD);
    assert.deepEqual(after.pages, []);
    assert.deepEqual(after.bridge, []);
    assert.equal(after.windowCut, 0);
    assert.notEqual(after.pages, state.pages, "a fresh array: a page in flight sees it was superseded");
  });

  it("drops them for a bridge prompt whose turn the rewind removes — a prompt carries no turn id", () => {
    const state = history({
      bounds: bounds(),
      pages,
      bridge: [message("user", "six", { id: "u6", createdAt: stamp(60) })]
    });
    assert.deepEqual(historyAfterRevert(state, 5, FOLD).bridge, []);
    assert.equal(historyAfterRevert(state, 6, FOLD), state, "turn 6 survives a rewind to six turns");
  });
});

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

describe("historyAfterEvent — the bridge", () => {
  const loaded = (): AgentChatHistoryState => history({ bounds: bounds(), pages: [historyPage()] });

  it("keeps nothing while nothing is loaded or on its way — it only notes the first eviction, once", () => {
    const first = untilTrim(fullWindow());
    assert.ok(itemsDroppedByRetention(first.after).length > 0, "the step did trim");
    const idle = history({ bounds: bounds({ hasOlder: false }) });

    const noted = historyAfterEvent(idle, first);
    assert.equal(noted.windowEvicted, true, "older history exists now, whatever the snapshot said");
    assert.deepEqual(noted.bridge, [], "and nothing is kept");
    assert.equal(canLoadOlderHistory(noted), true);

    const second = untilTrim(first.after);
    assert.equal(historyAfterEvent(noted, second), noted, "noted once: the very same history after that");
  });

  it("hands back the very same history on a host without an index", () => {
    const step = untilTrim(fullWindow());
    const unindexed = history({ bounds: bounds({ indexed: false, hasOlder: false }) });
    assert.equal(historyAfterEvent(unindexed, step), unindexed);
  });

  it("notes nothing when the window only dropped rows the parent timeline never showed", () => {
    // Parent rows well within their window, and one agent streaming its own
    // rows past its window: every trim takes agent rows only.
    const parentRows = Array.from({ length: ACTIVITY_RETENTION_LIMIT - 50 }, (_, index) =>
      toolRow(`p${index}`, 1 + index)
    );
    let fold = foldStateFromSnapshot(snapshot({ items: parentRows, seq: 10_000 }));
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

  it("puts every row a step dropped onto the end of the bridge, oldest first, while a page is loaded", () => {
    let fold = fullWindow();
    const initial = loaded();
    let state = initial;
    const handed: string[] = [];
    // Three trims, however many rows each one takes.
    for (let trim = 0; trim < 3; trim += 1) {
      const step = untilTrim(fold);
      handed.push(...ids(itemsDroppedByRetention(step.after)));
      state = historyAfterEvent(state, step);
      fold = step.after;
    }
    assert.deepEqual(ids(state.bridge), handed);
    assert.equal(state.pages, initial.pages, "the pages are untouched");
    const onBridge = new Set(ids(state.bridge));
    assert.ok(
      fold.items.every((item) => !onBridge.has(item.id)),
      "a bridge row is one the window no longer holds"
    );
  });

  it("leaves the history alone on a step that dropped nothing", () => {
    const state = loaded();
    const quiet = appendStep(foldStateFromSnapshot(snapshot({ items: [toolRow("a", 1)], seq: 10_000 })));
    assert.equal(itemsDroppedByRetention(quiet.after).length, 0);
    assert.equal(historyAfterEvent(state, quiet), state);
  });

  it("collects while the FIRST page is still on its way: that page ends where the window stood when asked", () => {
    const step = untilTrim(fullWindow());
    const asking = history({ bounds: bounds(), loading: true });
    assert.deepEqual(ids(historyAfterEvent(asking, step).bridge), ids(itemsDroppedByRetention(step.after)));
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

  it("cuts the window before the newest bridge row: an old message outlives the rows around it", () => {
    // Messages are retained four times longer than parent rows, so `u0` and
    // `mid` stay in the window while the rows around them go to the bridge.
    const u0 = message("user", "zeroth", { id: "u0", createdAt: stamp(1) });
    const mid = message("assistant", "between", { id: "mid", createdAt: stamp(1_010), turnId: "t9" });
    const rows = fullWindow().items as ThreadItem[];
    let fold = foldStateFromSnapshot(
      snapshot({ items: [u0, ...rows.slice(0, 10), mid, ...rows.slice(10)], seq: 10_000 })
    );
    let state = loaded();
    // Until the row right after `mid` has left the window — one trim or many.
    const after = rows[10]!.id;
    while (fold.items.some((item) => item.id === after)) {
      const step = appendStep(fold);
      state = historyAfterEvent(state, step);
      fold = step.after;
    }
    assert.equal(state.windowCut, 2);
    assert.deepEqual(ids(fold.items.slice(0, state.windowCut)), ["u0", "mid"]);
  });

  it("recounts the cut when a rewind confined to the window removes a row before it", () => {
    const u1 = message("user", "one", { id: "u1", createdAt: stamp(1) });
    const a2 = message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(2) });
    const turnless = Array.from({ length: 5 }, (_, index) => toolRow(`n${index}`, 10 + index, { turnId: null }));
    const before = foldStateFromSnapshot(
      snapshot({ items: [u1, a2, ...turnless], turns: [foldTurn("t1", "u1"), foldTurn("t2")], seq: 10_000 })
    );
    const event = ev("thread.reverted", { turnCount: 1 }, { seq: 10_001 });
    const after = applyDomainEvent(before, event);
    assert.deepEqual(ids(after.items).slice(0, 2), ["u1", "n0"], "the fold dropped turn 2's answer");
    // A turn-less bridge row no rewind reaches; `u1` and `a2` were the cut.
    const state = history({ pages: [historyPage()], bridge: [toolRow("old", 0, { turnId: null })], windowCut: 2 });
    const next = historyAfterEvent(state, { event, before, after });
    assert.equal(next.bridge, state.bridge);
    assert.equal(next.windowCut, 1);
  });

  it("drops pages, bridge and cut for a rewind that reaches a bridge row", () => {
    const before = foldStateFromSnapshot(
      snapshot({
        items: [message("user", "one", { id: "u1" })],
        turns: [foldTurn("t1", "u1"), foldTurn("t2", "u2")],
        seq: 10_000
      })
    );
    const event = ev("thread.reverted", { turnCount: 1 }, { seq: 10_001 });
    const state = history({
      pages: [historyPage()],
      bridge: [toolRow("x2", 5, { turnId: "t2" })],
      windowCut: 1
    });
    const next = historyAfterEvent(state, { event, before, after: applyDomainEvent(before, event) });
    assert.deepEqual([next.pages, next.bridge, next.windowCut], [[], [], 0]);
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

  it("cuts the window just after the last row the page also holds — everything before it lies below the page's end", () => {
    const page = historyPage({
      items: [
        message("user", "five", { id: "u5" }),
        toolRow("x5", 50, { turnId: "t5" }),
        message("assistant", "five", { id: "a5", turnId: "t5" })
      ]
    });
    assert.equal(pageEndCut(window(), page), 4, "turn 1's words too, though the page never held them");
  });

  it("moves nothing when the page shares no row with the window", () => {
    assert.equal(pageEndCut(window(), historyPage({ items: [toolRow("x5", 50)] })), 0);
    assert.equal(pageEndCut(window(), historyPage()), 0);
  });

  it("cuts the window just before the row the page names as its end, sharing nothing with it", () => {
    const page = historyPage({ items: [toolRow("x5", 50)], page: { beforeCursor: null, endItemId: "x7" } });
    assert.equal(pageEndCut(window(), page), 4, "turn 1's and turn 5's words lie below the page's end");
  });

  it("takes whichever rule reaches further, and falls back when the window no longer holds that row", () => {
    const shared = [message("assistant", "five", { id: "a5", turnId: "t5" })];
    const endsEarlier = historyPage({ items: shared, page: { beforeCursor: null, endItemId: "u5" } });
    assert.equal(pageEndCut(window(), endsEarlier), 4, "the rows it shares lie further on");
    const evicted = historyPage({ items: shared, page: { beforeCursor: null, endItemId: "gone" } });
    assert.equal(pageEndCut(window(), evicted), 4, "evicted since: the shared rows still say where it ends");
    const endless = historyPage({ items: [toolRow("x5", 50)], page: { beforeCursor: null, endItemId: null } });
    assert.equal(pageEndCut(window(), endless), 0, "no row at the end, nothing shared: nothing moves");
  });

  it("reads the page's end field-wise — a string or null as sent, anything else as absent", () => {
    const withEnd = (endItemId: unknown): ThreadHistoryPage =>
      ({ ...historyPage(), page: { beforeCursor: null, endItemId } }) as unknown as ThreadHistoryPage;
    assert.equal(pageEndItemId(withEnd("x7")), "x7");
    assert.equal(pageEndItemId(withEnd(null)), null);
    assert.equal(pageEndItemId(historyPage()), undefined, "a host that predates the field");
    for (const malformed of [7, true, { id: "x7" }, ["x7"]]) {
      assert.equal(pageEndItemId(withEnd(malformed)), undefined, JSON.stringify(malformed));
      assert.equal(pageEndCut(window(), withEnd(malformed)), 0);
    }
    const noBlock = { ...historyPage(), page: "below" } as unknown as ThreadHistoryPage;
    assert.equal(pageEndItemId(noBlock), undefined);
  });

  it("only ever moves the cut on as older pages land", () => {
    const newest = historyPage({ items: [message("assistant", "five", { id: "a5", turnId: "t5" })] });
    const older = historyPage({ items: [message("assistant", "one", { id: "a1", turnId: "t1" })] });
    const once = historyWithPage(history({ bounds: bounds() }), newest, window());
    assert.equal(once.windowCut, 4);
    const twice = historyWithPage(once, older, window());
    assert.equal(twice.windowCut, 4, "an older page ends below the newest one");
    assert.deepEqual(twice.pages, [older, newest]);
  });

  it("keeps the cut on the window's rows while only pages are loaded — a rewind confined to the window recounts it", () => {
    const u1 = message("user", "one", { id: "u1", createdAt: stamp(1) });
    const a2 = message("assistant", "two", { id: "a2", turnId: "t2", createdAt: stamp(2) });
    const rest = Array.from({ length: 3 }, (_, index) => toolRow(`n${index}`, 10 + index, { turnId: null }));
    const before = foldStateFromSnapshot(
      snapshot({ items: [u1, a2, ...rest], turns: [foldTurn("t1", "u1"), foldTurn("t2")], seq: 10_000 })
    );
    const event = ev("thread.reverted", { turnCount: 1 }, { seq: 10_001 });
    const state = history({ bounds: bounds(), pages: [historyPage()], windowCut: 2 });
    const next = historyAfterEvent(state, { event, before, after: applyDomainEvent(before, event) });
    assert.deepEqual(next.pages, state.pages, "no page holds a removed turn");
    assert.equal(next.windowCut, 1, "turn 2's answer went; turn 1's prompt still lies below the page's end");
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

  it("is comfortably above normal reading: a whole reveal fits", () => {
    assert.ok(HISTORY_ROW_CAP >= HISTORY_REVEAL_PAGE_CAP * ACTIVITY_RETENTION_LIMIT);
  });

  it("hands the history back untouched while it fits", () => {
    const state = history({ pages: [page(10, "c1")], bridge: bridgeOf(10) });
    assert.deepEqual(historyWithinCap(state, 20), { history: state, resync: false });
  });

  it("drops the OLDEST pages first, and 'load older' then asks for exactly the block that went", () => {
    const oldest = page(10, "below-oldest");
    const middle = page(10, "below-middle");
    const newest = page(10, "below-newest");
    const state = history({ bounds: bounds(), pages: [oldest, middle, newest], bridge: bridgeOf(15) });

    const { history: capped, resync } = historyWithinCap(state, 40);

    assert.equal(resync, false);
    assert.deepEqual(capped.pages, [middle, newest]);
    assert.equal(capped.bridge, state.bridge);
    assert.ok(historyRowCount(capped) <= 40);
    assert.equal(
      nextHistoryCursor(capped),
      "below-middle",
      "the oldest remaining page's cursor names the block that was dropped"
    );
  });

  it("never drops the newest page on its own: past the cap with it, everything goes and fresh bounds are asked for", () => {
    const state = history({
      bounds: bounds(),
      pages: [page(10, "older"), page(10, "newest")],
      bridge: bridgeOf(15),
      windowCut: 4,
      error: "stale"
    });
    const { history: capped, resync } = historyWithinCap(state, 20);
    assert.equal(resync, true);
    assert.deepEqual([capped.pages, capped.bridge, capped.windowCut, capped.error], [[], [], 0, null]);
    assert.equal(capped.bounds, state.bounds, "the fresh snapshot replaces them");
  });

  it("drops everything when the bridge alone passes the cap", () => {
    const { history: capped, resync } = historyWithinCap(history({ bridge: bridgeOf(25) }), 20);
    assert.equal(resync, true);
    assert.deepEqual(capped.bridge, []);
  });
});

describe("withoutOrphanBridge", () => {
  it("lets a bridge begun for a first page that never landed go", () => {
    const orphan = history({ bridge: [toolRow("b", 1)], windowCut: 2 });
    const settled = withoutOrphanBridge(orphan);
    assert.deepEqual([settled.bridge, settled.windowCut], [[], 0]);
  });

  it("keeps a bridge that has a page to join", () => {
    const joined = history({ pages: [historyPage()], bridge: [toolRow("b", 1)], windowCut: 2 });
    assert.equal(withoutOrphanBridge(joined), joined);
  });
});

// ---------------------------------------------------------------------------
// Revealing a turn
// ---------------------------------------------------------------------------

describe("planReveal", () => {
  const withTurn = [historyPage({ turns: [historyTurn("t5", 5)] })];

  it("is present when the live window holds the turn", () => {
    assert.equal(
      planReveal("t9", { liveTurnIds: new Set(["t9"]), pages: [], hasOlder: true }),
      "present"
    );
  });

  it("is present when a loaded page holds the turn", () => {
    assert.equal(planReveal("t5", { liveTurnIds: new Set(), pages: withTurn, hasOlder: true }), "present");
  });

  it("is present when only the bridge holds the turn — no page load for it", () => {
    const bridgeTurnIds = liveTurnIdsOf([toolRow("x7", 1, { turnId: "t7" })], []);
    assert.equal(
      planReveal("t7", { liveTurnIds: new Set(), bridgeTurnIds, pages: withTurn, hasOlder: true }),
      "present"
    );
  });

  it("loads more while older history exists", () => {
    assert.equal(planReveal("t1", { liveTurnIds: new Set(), pages: withTurn, hasOlder: true }), "load-more");
  });

  it("is absent once nothing older exists", () => {
    assert.equal(planReveal("t1", { liveTurnIds: new Set(), pages: withTurn, hasOlder: false }), "absent");
  });

  it(`gives up after ${HISTORY_REVEAL_PAGE_CAP} pages`, () => {
    const loaded = (count: number): ThreadHistoryPage[] =>
      Array.from({ length: count }, () => historyPage());
    assert.equal(planReveal("t1", { liveTurnIds: new Set(), pages: loaded(24), hasOlder: true }), "load-more");
    assert.equal(planReveal("t1", { liveTurnIds: new Set(), pages: loaded(25), hasOlder: true }), "absent");
  });
});

describe("liveTurnIdsOf", () => {
  it("counts a turn whose rows or whose prompt the window holds, never a subagent's", () => {
    const items: ThreadItem[] = [
      message("assistant", "two", { id: "a2", turnId: "t2" }),
      message("user", "three", { id: "u3" }),
      message("assistant", "child", { id: "c4", turnId: "t4", agentId: "agent-1" })
    ];
    const turns = [foldTurn("t1", "u1"), foldTurn("t2", "u2"), foldTurn("t3", "u3"), foldTurn("t4", "u4")];
    assert.deepEqual([...liveTurnIdsOf(items, turns)].sort(), ["t2", "t3"]);
  });
});

describe("rowIdForTurn", () => {
  const rowsOf = (items: ThreadItem[], expanded: string[] = []): AgentChatTimelineRow[] =>
    deriveTimelineRows({
      timelineEntries: deriveTimelineEntriesFromItems(items).entries,
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds: new Set(expanded),
      supportsConversationRollback: false
    });

  it("lands on the turn's prompt", () => {
    const rows = rowsOf([
      message("user", "one", { id: "u1" }),
      message("assistant", "a", { id: "a1", turnId: "t1" })
    ]);
    assert.equal(rowIdForTurn(rows, "t1", "u1"), "u1");
  });

  it("falls back to the first row the turn owns when its prompt is not on screen", () => {
    const rows = rowsOf([
      message("user", "other", { id: "u0" }),
      activity("tool.completed", { status: "completed" }, { id: "x1", turnId: "t1", createdAt: stamp(20) }),
      message("assistant", "done", { id: "a1", turnId: "t1", createdAt: stamp(21) })
    ]);
    const first = rows.find(
      (row) => row.id !== "u0" && (row.kind !== "message" || row.message.turnId === "t1")
    );
    assert.ok(first, "the fixture projects a row for t1");
    assert.equal(rowIdForTurn(rows, "t1", "u-missing"), first.id);
    assert.equal(rowIdForTurn(rows, "t1", null), first.id);
  });

  it("answers null for a turn with no row", () => {
    const rows = rowsOf([message("user", "one", { id: "u1" })]);
    assert.equal(rowIdForTurn(rows, "t7", "u7"), null);
  });

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

describe("historyErrorMessage", () => {
  it("reads an unavailable index as unavailable, not as a generic failure", () => {
    const text = historyErrorMessage(
      new AgentChatCommandError(503, "INDEX_UNAVAILABLE", "index is rebuilding")
    );
    assert.match(text, /unavailable/i);
    assert.doesNotMatch(text, /INDEX_UNAVAILABLE/);
  });

  it("never surfaces a dropped connection's raw message", () => {
    const dropped = new AgentChatCommandError(0, "HOST_UNAVAILABLE", "fetch failed");
    const text = historyErrorMessage(dropped);
    assert.notEqual(text, "fetch failed");
    assert.ok(text.length > 0);
  });

  it("passes the host's own words through for anything else", () => {
    assert.equal(
      historyErrorMessage(new AgentChatCommandError(400, "INVALID_COMMAND", "turns must be ≥ 1")),
      "turns must be ≥ 1"
    );
    assert.ok(historyErrorMessage("??").length > 0, "a non-error throw still reads as something");
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
    const live = deriveTimelineRows({
      timelineEntries: deriveTimelineEntriesFromItems([
        message("user", "third", { id: "u3", createdAt: stamp(5) }),
        message("assistant", "three", { id: "a3", turnId: "t3", createdAt: stamp(6) })
      ]).entries,
      isWorking: false,
      activeTurnStartedAt: null,
      turns,
      supportsConversationRollback: true
    });
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

  it("renders the page's rows, oldest page first, before the live rows", () => {
    const { live, input, page } = conversation();
    const older = historyPage({ items: [message("user", "zeroth", { id: "u0", createdAt: stamp(0) })] });

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, withPages(input, [older, page]));

    assert.deepEqual(ids(mergeTimelineRows(rows, live)), ["u0", "u1", "a1", "u2", "a2", "u3", "a3"]);
  });

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

  it("hands the live rows back untouched when no page is loaded", () => {
    const { live, input } = conversation();
    const none = projectHistoryRows(EMPTY_HISTORY_ROWS, withPages(input, []));
    assert.equal(mergeTimelineRows(none, live), live);
  });

  it("renders an id both sides project at the page's position, with the window's object", () => {
    const { live, input } = conversation();
    const overlapping = historyPage({
      items: [
        message("user", "second", { id: "u2", createdAt: stamp(3) }),
        message("assistant", "stale three", { id: "a3", turnId: "t3", createdAt: stamp(4) })
      ]
    });

    const merged = mergeTimelineRows(
      projectHistoryRows(EMPTY_HISTORY_ROWS, withPages(input, [overlapping])),
      live
    );

    assert.deepEqual(ids(merged), ["u2", "a3", "u3"], "once, where the page put it");
    assert.equal(merged[1], live[1], "the window's object, not the page's copy");
  });

  it("shows an item a page shares with the window with the window's content", () => {
    const { input } = conversation();
    const page = historyPage({
      items: [
        message("user", "fix it", { id: "u5", createdAt: stamp(1) }),
        activity("tool.completed", { status: "completed" }, {
          id: "x5",
          turnId: "t5",
          summary: "a stale label",
          createdAt: stamp(2)
        })
      ]
    });
    const windowCopy = activity("tool.completed", { status: "completed" }, {
      id: "x5",
      turnId: "t5",
      summary: "Read src/a.ts",
      createdAt: stamp(2)
    });

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, {
      ...withPages(input, [page]),
      sharedLive: [windowCopy],
      expandedTurnIds: new Set(["t5"])
    }).rows;

    const labels = rows.flatMap((row) =>
      row.kind === "work" ? row.groupedEntries.filter((entry) => entry.id === "x5").map((entry) => entry.label) : []
    );
    assert.deepEqual(labels, ["Read src/a.ts"]);
  });

  it("folds the window's completion of a call a page began into the page's one row for it", () => {
    const { input } = conversation();
    const page = historyPage({
      items: [
        message("user", "fix it", { id: "u5", createdAt: stamp(1) }),
        activity("tool.updated", { toolUseId: "T", status: "inProgress" }, {
          id: "tu",
          turnId: "t5",
          summary: "Read src/a.ts",
          createdAt: stamp(2)
        })
      ]
    });
    const completion = activity("tool.completed", { toolUseId: "T", status: "completed" }, {
      id: "tc",
      turnId: "t5",
      summary: "Read src/a.ts",
      createdAt: stamp(3)
    });

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, {
      ...withPages(input, [page]),
      sharedLive: [completion],
      expandedTurnIds: new Set(["t5"])
    }).rows;

    const calls = rows.flatMap((row) =>
      row.kind === "work" ? row.groupedEntries.filter((entry) => entry.toolCallId === "T") : []
    );
    assert.equal(calls.length, 1, "one row for the call");
    assert.equal(calls[0]?.toolLifecycleStatus, "completed");
  });

  it("keeps the newer page's copy of a row two pages both project", () => {
    const { input } = conversation();
    const older = historyPage({ items: [message("assistant", "old copy", { id: "x1", turnId: "t0" })] });
    const newer = historyPage({ items: [message("assistant", "new copy", { id: "x1", turnId: "t0" })] });

    const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, withPages(input, [older, newer])).rows;

    assert.equal(rows.length, 1);
    const only = rows[0]!;
    assert.equal(only.kind === "message" ? only.message.text : null, "new copy");
  });

  it("reuses the projection while the pages array and its inputs did not move", () => {
    const { input, page } = conversation();
    const first = projectHistoryRows(EMPTY_HISTORY_ROWS, input);
    assert.equal(projectHistoryRows(first, { ...input }), first, "same inputs, same state");

    const older = historyPage({ items: [message("user", "zeroth", { id: "u0", createdAt: stamp(0) })] });
    const grown = projectHistoryRows(first, withPages(input, [older, page]));
    assert.notEqual(grown, first, "a new pages array is a new projection");
    assert.deepEqual(
      grown.rows.slice(1).map((row, index) => row === first.rows[index]),
      [true, true, true, true],
      "the rows that were already on screen keep their objects across the prepend"
    );
  });

  it("projects a turn split across two pages as ONE turn — never page by page", () => {
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
      rows.filter((row) => row.kind === "turn-fold").map((row) => row.id),
      ["turn-fold:t1"],
      "one \"Worked for …\" fold for the turn"
    );
    const groups = rows.filter((row) => row.kind === "activity-group");
    assert.equal(groups.length, 1, "the turn's activity group opens once");
    const group = groups[0]!;
    assert.deepEqual(
      group.kind === "activity-group" ? group.entries.map((entry) => entry.id) : [],
      ["r1", "x1", "x2"],
      "and it holds the work from both sides of the boundary"
    );
  });

  it("keeps unchanged row objects across a disclosure change", () => {
    const { input } = conversation();
    const first = projectHistoryRows(EMPTY_HISTORY_ROWS, input);
    const toggled = projectHistoryRows(first, { ...input, expandedTurnIds: new Set(["t9"]) });
    assert.notEqual(toggled, first);
    assert.deepEqual(
      toggled.rows.map((row, index) => row === first.rows[index]),
      [true, true, true, true]
    );
  });

  describe("rewind to a page row", () => {
    it("rewinds a prompt to its turn's ordinal − 1", () => {
      const { input } = conversation();
      assert.deepEqual(revertCounts(projectHistoryRows(EMPTY_HISTORY_ROWS, input).rows), { u1: 0, u2: 1 });
    });

    it("is withheld where the index says a compaction came after the turn", () => {
      const { input } = conversation([
        historyTurn("t1", 1, { userMessageId: "u1", rewindable: false }),
        historyTurn("t2", 2, { userMessageId: "u2" })
      ]);
      assert.deepEqual(revertCounts(projectHistoryRows(EMPTY_HISTORY_ROWS, input).rows), {
        u1: undefined,
        u2: 1
      });
    });

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

    it("is withheld on a prompt whose turn the page does not list", () => {
      const { input } = conversation([historyTurn("t1", 1, { userMessageId: "u1" })]);
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
      assert.equal(revertCounts(rows).u1, undefined, "the newest copy withholds it");
    });

    it("is withheld where the provider cannot roll back", () => {
      const { input } = conversation();
      const rows = projectHistoryRows(EMPTY_HISTORY_ROWS, {
        ...input,
        supportsConversationRollback: false
      }).rows;
      assert.deepEqual(revertCounts(rows), { u1: undefined, u2: undefined });
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

describe("hasSettledCompaction", () => {
  it("is what the store feeds `liveCompacted` from", async () => {
    const { hasSettledCompaction } = await import("./history.logic");
    const entry = (state: string) =>
      workLogEntryFromActivity(activity("context-compaction", { state }, { tone: "info" }));
    assert.equal(hasSettledCompaction([entry("compacted")]), true);
    assert.equal(hasSettledCompaction([entry("compacting")]), false, "a phase drops nothing");
    assert.equal(hasSettledCompaction([entry("compaction-failed")]), false, "a failure drops nothing");
    assert.equal(hasSettledCompaction([]), false);
  });
});
