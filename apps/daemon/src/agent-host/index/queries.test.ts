/**
 * The index's reads (design 2026-09-23 §C "History page", "Search"): paging by
 * cursor and by turn, the rewind gate, and search that can never be a query
 * syntax error.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { THREAD_SEARCH_MAX_RESULTS } from "@orquester/api/agent-chat";

import { createThreadIndex, type IndexedTurn, type ThreadIndex } from "./index.ts";
import { toFtsQuery } from "./queries.ts";
import {
  activity,
  checkpoint,
  compaction,
  created,
  delta,
  done,
  liveTurn,
  recordingLogger,
  reverted,
  session,
  stampAt,
  TestLog,
  turnStart,
  userMessage,
  type Draft
} from "./testing.ts";

let dir: string;
let index: ThreadIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  index = createThreadIndex({ filePath: join(dir, "index.sqlite"), logger: recordingLogger() });
});

afterEach(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

async function indexed(
  log: TestLog,
  drafts: Draft[],
  meta = { projectPath: "/w/p", title: "Thread" }
): Promise<void> {
  index.observe({ threadId: log.threadId, ...meta, ...log.append(...drafts) });
  await index.drain();
}

function ordinals(turns: IndexedTurn[]): number[] {
  return turns.map((turn) => turn.ordinal);
}

function sevenTurns(): Draft[] {
  return [
    created(),
    ...[1, 2, 3, 4, 5, 6, 7].flatMap((n) => liveTurn({ n, prompt: `prompt number ${n}` }))
  ];
}

describe("thread index: turnsBefore", () => {
  it("pages from the newest turns down, oldest first within a page", async () => {
    const log = new TestLog();
    await indexed(log, sevenTurns());
    const id = log.threadId;

    const newest = index.turnsBefore(id, { before: null, limit: 3 });
    assert.deepEqual(ordinals(newest), [5, 6, 7]);

    const byTurn = index.turnsBefore(id, { before: null, beforeTurn: newest[0]!, limit: 3 });
    assert.deepEqual(ordinals(byTurn), [2, 3, 4]);

    const third = index.turnByOrdinal(id, 3)!;
    const byCursor = index.turnsBefore(id, {
      before: { threadId: id, beforeAnchorAt: third.requestedAt, beforeTurnId: third.turnId },
      limit: 3
    });
    assert.deepEqual(ordinals(byCursor), [1, 2], "a short last page");

    const first = index.turnByOrdinal(id, 1)!;
    assert.deepEqual(
      index.turnsBefore(id, {
        before: { threadId: id, beforeAnchorAt: first.requestedAt, beforeTurnId: first.turnId },
        limit: 3
      }),
      []
    );
    assert.deepEqual(index.turnsBefore(id, { before: null, limit: 0 }), []);
    assert.deepEqual(index.turnsBefore("no-such-thread", { before: null, limit: 3 }), []);
  });

  it("the cursor wins over beforeTurn, and a foreign cursor reads as none", async () => {
    const log = new TestLog();
    await indexed(log, sevenTurns());
    const id = log.threadId;
    const second = index.turnByOrdinal(id, 2)!;
    const sixth = index.turnByOrdinal(id, 6)!;
    const cursor = { threadId: id, beforeAnchorAt: second.requestedAt, beforeTurnId: second.turnId };

    assert.deepEqual(
      ordinals(index.turnsBefore(id, { before: cursor, beforeTurn: sixth, limit: 3 })),
      [1]
    );
    assert.deepEqual(
      ordinals(
        index.turnsBefore(id, {
          before: { ...cursor, threadId: "another-thread" },
          beforeTurn: sixth,
          limit: 2
        })
      ),
      [4, 5]
    );
  });

  it("a cursor whose turn is gone still means 'older than its anchor'", async () => {
    const log = new TestLog();
    await indexed(log, sevenTurns());
    const id = log.threadId;
    const fourth = index.turnByOrdinal(id, 4)!;
    const page = index.turnsBefore(id, {
      before: { threadId: id, beforeAnchorAt: fourth.requestedAt, beforeTurnId: "t-reverted" },
      limit: 10
    });
    assert.deepEqual(ordinals(page), [1, 2, 3]);
  });

  it("pages by the log's order even when turn timestamps tie or run backwards", async () => {
    const log = new TestLog();
    const sameInstant = "2026-01-01T00:00:00.000Z";
    const replayed = (prompt: string, turnId: string): Draft[] => [
      { ...userMessage(`u-${turnId}`, prompt), occurredAt: sameInstant },
      { ...turnStart(`u-${turnId}`, turnId), occurredAt: sameInstant },
      { ...session("ready", null, turnId), occurredAt: sameInstant }
    ];
    // Ordinal order is t-z, t-a, t-m; (requested_at, turn_id) order is not.
    await indexed(log, [
      created(),
      ...replayed("zulu", "t-z"),
      ...replayed("alpha", "t-a"),
      ...replayed("mike", "t-m")
    ]);
    const id = log.threadId;
    const newest = index.turnsBefore(id, { before: null, limit: 1 });
    assert.deepEqual(newest.map((turn) => turn.turnId), ["t-m"]);
    const rest = index.turnsBefore(id, { before: null, beforeTurn: newest[0]!, limit: 5 });
    assert.deepEqual(rest.map((turn) => turn.turnId), ["t-z", "t-a"]);
    assert.ok(
      rest[0]!.endByte === rest[1]!.firstByte && rest[1]!.endByte === newest[0]!.firstByte,
      "the three ranges meet in ordinal order"
    );
  });
});

describe("thread index: rewindable", () => {
  it("withholds exactly the turns a settled compaction lies after — mid-turn included", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      // An auto-compaction INSIDE turn 2: rewinding to turn 2 cuts before it.
      ...liveTurn({ n: 2, prompt: "two", extra: [compaction("auto", "t2")] }),
      ...liveTurn({ n: 3, prompt: "three" })
    ]);
    const id = log.threadId;
    const [one, two, three] = [1, 2, 3].map((n) => index.turnByOrdinal(id, n)!);
    assert.equal(index.rewindable(id, one!), false);
    assert.equal(index.rewindable(id, two!), false);
    assert.equal(index.rewindable(id, three!), true);
  });

  it("an in-flight or failed compaction dropped nothing and withholds nothing", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      compaction("running", null, "compacting"),
      compaction("failed", null, "compaction-failed")
    ]);
    assert.equal(index.rewindable(log.threadId, index.turnByOrdinal(log.threadId, 1)!), true);
  });
});

describe("thread index: search", () => {
  it("quotes every token, so query syntax is only ever text", () => {
    assert.equal(toFtsQuery("  "), null);
    assert.equal(toFtsQuery(""), null);
    assert.equal(toFtsQuery("fix parser"), '"fix" "parser"');
    assert.equal(toFtsQuery('say "hi"'), '"say" """hi"""');
    assert.equal(toFtsQuery("NEAR(a b) OR c*"), '"NEAR(a" "b)" "OR" "c*"');
    assert.equal(toFtsQuery("x".repeat(250)), `"${"x".repeat(200)}"`);
    // Clamped by code point: an astral character is never cut in half.
    assert.equal(toFtsQuery("😀".repeat(201)), `"${"😀".repeat(200)}"`);
  });

  it("matches operators, quotes and punctuation as plain text, never as syntax", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      done("m-quote", null, 'She said "ship it" twice'),
      done("m-near", null, "the NEAR operator and OR and AND"),
      done("m-dash", null, "a foo-bar refactor"),
      done("m-star", null, "glob with star * only"),
      done("m-cafe", null, "Meet at the CAFÉ tomorrow"),
      done("m-jp", null, "日本語 テキスト"),
      done("m-colon", null, "the text:hello note"),
      done("m-caret", null, "we say hello later"),
      done("m-first", null, "hello first")
    ]);
    const ids = (q: string): string[] =>
      index
        .search({ q, limit: 10 })
        .map((hit) => hit.id)
        .sort();

    assert.deepEqual(ids('"ship it"'), ["m-quote"]);
    assert.deepEqual(ids('said "ship'), ["m-quote"]);
    assert.deepEqual(ids("NEAR"), ["m-near"]);
    assert.deepEqual(ids("OR AND"), ["m-near"]);
    assert.deepEqual(ids("NEAR(operator"), ["m-near"]);
    assert.deepEqual(ids("foo-bar"), ["m-dash"]);
    assert.deepEqual(ids("-bar"), ["m-dash"]);
    assert.deepEqual(ids("star*"), ["m-star"]);
    assert.deepEqual(ids("*"), []);
    assert.deepEqual(ids("-"), []);
    assert.deepEqual(ids('"'), []);
    assert.deepEqual(ids("cafe"), ["m-cafe"], "diacritics fold");
    assert.deepEqual(ids("café"), ["m-cafe"]);
    assert.deepEqual(ids("日本語"), ["m-jp"]);
    assert.deepEqual(ids("テキスト"), ["m-jp"]);
    // `text` is the FTS column's name: parsed, `text:hello` is a column filter
    // matching every "hello"; as text it is the phrase "text hello".
    assert.deepEqual(ids("text:hello"), ["m-colon"]);
    assert.deepEqual(ids("text:"), ["m-colon"]);
    assert.deepEqual(ids(":"), []);
    // Parsed, `^hello` matches "hello" only as a row's FIRST token.
    assert.deepEqual(ids("^hello"), ["m-caret", "m-colon", "m-first"]);
    assert.deepEqual(ids("^"), []);
  });

  it("an empty or whitespace query finds nothing", async () => {
    const log = new TestLog();
    await indexed(log, [created(), done("m1", null, "anything at all")]);
    assert.deepEqual(index.search({ q: "", limit: 10 }), []);
    assert.deepEqual(index.search({ q: " \t\n ", limit: 10 }), []);
  });

  it("clamps the limit to [1, THREAD_SEARCH_MAX_RESULTS] across both tables", async () => {
    const log = new TestLog();
    const drafts: Draft[] = [created()];
    for (let n = 0; n < 40; n += 1) {
      drafts.push(done(`m${n}`, null, `needle message ${n}`));
      drafts.push(done(`n${n}`, null, `needle other ${n}`));
    }
    await indexed(log, drafts);
    assert.equal(index.search({ q: "needle", limit: 1000 }).length, THREAD_SEARCH_MAX_RESULTS);
    assert.equal(index.search({ q: "needle", limit: 5 }).length, 5);
    assert.equal(index.search({ q: "needle", limit: 0 }).length, 1);
    assert.equal(index.search({ q: "needle", limit: Number.NaN }).length, THREAD_SEARCH_MAX_RESULTS);
  });

  it("ranks messages and activities in one list", async () => {
    const log = new TestLog();
    const fillers: Draft[] = [];
    for (let n = 0; n < 10; n += 1) {
      fillers.push(done(`filler-${n}`, null, `filler message ${n}`));
      fillers.push(activity(`filler-act-${n}`, "tool.completed", { summary: "filler activity" }));
    }
    await indexed(log, [
      created(),
      ...fillers,
      done("weak", null, "rocket " + "padding ".repeat(40)),
      activity("act-rocket", "tool.completed", { summary: "rocket launch" }),
      ...liveTurn({ n: 1, prompt: "rocket rocket rocket" })
    ]);
    const hits = index.search({ q: "rocket", limit: 10 });
    assert.deepEqual(
      hits.map((hit) => [hit.kind, hit.id]),
      [
        ["message", "u1"],
        ["activity", "act-rocket"],
        ["message", "weak"]
      ]
    );
  });

  it("filters by project and names each hit's thread", async () => {
    const one = new TestLog("thread-one");
    const two = new TestLog("thread-two");
    await indexed(one, [created("/w/alpha"), done("m1", null, "shared keyword")], {
      projectPath: "/w/alpha",
      title: "Alpha work"
    });
    await indexed(two, [created("/w/beta"), done("m2", null, "shared keyword")], {
      projectPath: "/w/beta",
      title: "Beta work"
    });

    const all = index.search({ q: "keyword", limit: 10 });
    assert.deepEqual(all.map((hit) => hit.threadId).sort(), ["thread-one", "thread-two"]);
    const beta = index.search({ q: "keyword", limit: 10, projectPath: "/w/beta" });
    assert.deepEqual(
      beta.map((hit) => [hit.threadId, hit.projectPath, hit.title]),
      [["thread-two", "/w/beta", "Beta work"]]
    );
    assert.deepEqual(index.search({ q: "keyword", limit: 10, projectPath: "/w/none" }), []);
    assert.equal(index.search({ q: "keyword", limit: 10, projectPath: "" }).length, 2);
  });

  it("follows a renamed thread", async () => {
    const log = new TestLog();
    await indexed(log, [created(), done("m1", null, "renamed content")], {
      projectPath: "/w/p",
      title: "Old title"
    });
    await indexed(log, [done("m2", null, "more content")], {
      projectPath: "/w/p",
      title: "New title"
    });
    const [hit] = index.search({ q: "renamed", limit: 1 });
    assert.equal(hit!.title, "New title");
  });
});

describe("thread index: activity paging", () => {
  /**
   * seq: 1 created · 2 u1 · 3 row · 4 running t1 · 5 x1 · 6 x2 · 7 a1 · 8 settle · 9 diff
   *      10 u2 · 11 row · 12 running t2 · 13 x3 · 14 x1 AGAIN (names t1) · 15 x4 · 16 a2 · 17 settle
   * Items (latest writes): x2@6, x3@13, x1@14, x4@15. Turns: t1 [2, 14] (grown over the late
   * x1), t2 [10, 17].
   */
  async function pagedThread(): Promise<TestLog> {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("u1", "one"),
      turnStart("u1"),
      session("running", "t1"),
      activity("x1", "tool.started", { turnId: "t1" }),
      activity("x2", "tool.completed", { turnId: "t1" }),
      done("a1", "t1", "answer one"),
      session("ready", null, "t1"),
      checkpoint("t1", 1),
      userMessage("u2", "two"),
      turnStart("u2"),
      session("running", "t2"),
      activity("x3", "tool.started", { turnId: "t2" }),
      activity("x1", "tool.completed", { turnId: "t1" }),
      activity("x4", "tool.completed", { turnId: "t2" }),
      done("a2", "t2", "answer two"),
      session("ready", null, "t2")
    ]);
    return log;
  }

  it("itemPosition: an activity's latest line", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    assert.deepEqual(index.itemPosition(id, "x1"), { seq: 14, ...line(log, 14) });
    assert.deepEqual(index.itemPosition(id, "x2"), { seq: 6, ...line(log, 6) });
    assert.equal(index.itemPosition(id, "a1"), null, "messages are not items");
    assert.equal(index.itemPosition(id, "nope"), null);
    assert.equal(index.itemPosition("other-thread", "x1"), null);
  });

  it("itemPositionBySeq: only an activity's latest line answers", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    assert.deepEqual(index.itemPositionBySeq(id, 6), { seq: 6, ...line(log, 6) });
    assert.deepEqual(index.itemPositionBySeq(id, 14), { seq: 14, ...line(log, 14) });
    assert.equal(index.itemPositionBySeq(id, 5), null, "x1 was rewritten at 14");
    assert.equal(index.itemPositionBySeq(id, 7), null, "a message line");
    assert.equal(index.itemPositionBySeq(id, 99), null);
    assert.equal(index.itemPositionBySeq(id, -1), null);
  });

  it("hasItemsBefore", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    assert.equal(index.hasItemsBefore(id, 6), false, "x1 no longer sits at 5");
    assert.equal(index.hasItemsBefore(id, 7), true);
    assert.equal(index.hasItemsBefore(id, 0), false);
    assert.equal(index.hasItemsBefore(id, Number.POSITIVE_INFINITY), true);
    assert.equal(index.hasItemsBefore("other-thread", 100), false);
  });

  it("activitySeqBefore: `count` back, else the oldest, else null", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    // Items below 16, walking down: 15, 14, 13, 6.
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 16, count: 1 }), 15);
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 16, count: 2 }), 14);
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 16, count: 4 }), 6);
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 16, count: 400 }), 6, "fewer remain: the oldest");
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 14, count: 1 }), 13, "exclusive");
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 7, count: 400 }), 6);
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 6, count: 400 }), null, "nothing precedes");
    assert.equal(
      index.activitySeqBefore(id, { beforeSeq: Number.POSITIVE_INFINITY, count: 1 }),
      15,
      "no bound: the newest"
    );
    assert.equal(index.activitySeqBefore(id, { beforeSeq: 16, count: 0 }), 15, "count < 1 reads as 1");
    assert.equal(index.activitySeqBefore("other-thread", { beforeSeq: 100, count: 5 }), null);
  });

  it("turnsInSeqRange: every turn whose range meets [from, to), ordinal order", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    const ids = (fromSeq: number, toSeq: number): Array<string> =>
      index.turnsInSeqRange(id, { fromSeq, toSeq }).map((turn) => turn.turnId);
    assert.deepEqual(ids(1, 2), [], "before the first turn");
    assert.deepEqual(ids(1, 3), ["t1"]);
    assert.deepEqual(ids(3, 9), ["t1"]);
    assert.deepEqual(ids(10, 12), ["t1", "t2"], "t1's late row overlaps t2");
    assert.deepEqual(ids(15, 18), ["t2"]);
    assert.deepEqual(ids(1, 100), ["t1", "t2"]);
    assert.deepEqual(ids(18, 30), []);
    assert.deepEqual(ids(5, 5), [], "an empty range");
    assert.deepEqual(ids(9, 4), [], "a reversed range");
  });

  it("turnOfSeq: the containing turn, the newest start when ranges overlap", async () => {
    const log = await pagedThread();
    const id = log.threadId;
    const of = (seq: number): string | null => index.turnOfSeq(id, seq)?.turnId ?? null;
    assert.equal(of(1), null, "before the first turn");
    assert.equal(of(2), "t1", "the prompt opens the turn");
    assert.equal(of(9), "t1");
    assert.equal(of(11), "t2", "inside both ranges: the newer start");
    assert.equal(of(14), "t2");
    assert.equal(of(17), "t2");
    assert.equal(index.turnOfSeq("other-thread", 5), null);
  });

  it("turnOfSeq: a row a revert left between its survivor and the next turn gets the survivor", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two" }),
      reverted(1),
      activity("after", "info", { summary: "Rewound" })
    ]);
    const id = log.threadId;
    const after = index.itemPosition(id, "after")!;
    const survivor = index.turnByOrdinal(id, 1)!;
    assert.ok(after.seq > survivor.lastSeq, "the row is in no turn's range");
    assert.equal(index.turnOfSeq(id, after.seq)?.turnId, "t1");
    assert.deepEqual(
      index.turnsInSeqRange(id, { fromSeq: after.seq, toSeq: after.seq + 1 }),
      [],
      "and no range meets it"
    );
  });

  it("walks one fleet turn of 1 000 activities back in contiguous 400-activity blocks", async () => {
    const log = new TestLog();
    const fleet: Draft[] = [];
    for (let n = 0; n < 1_000; n += 1) {
      fleet.push(activity(`task-${n}`, "task.progress", { summary: `agent step ${n}`, turnId: "t1" }));
    }
    await indexed(log, [
      created(),
      userMessage("u1", "run the fleet"),
      turnStart("u1"),
      session("running", "t1"),
      ...fleet,
      session("ready", null, "t1")
    ]);
    const id = log.threadId;

    const pages: Array<{ startSeq: number; endSeq: number; fromByte: number; toByte: number }> = [];
    let endSeq = Number.POSITIVE_INFINITY;
    let toByte = log.size;
    for (;;) {
      const startSeq = index.activitySeqBefore(id, { beforeSeq: endSeq, count: 400 });
      if (startSeq === null) {
        break;
      }
      const fromByte = index.itemPositionBySeq(id, startSeq)!.byteOffset;
      pages.push({ startSeq, endSeq, fromByte, toByte });
      endSeq = startSeq;
      toByte = fromByte;
    }

    const activitiesIn = (page: { fromByte: number; toByte: number }): number =>
      log.slice(page.fromByte, page.toByte).filter((event) => event.type === "thread.activity-appended")
        .length;
    assert.deepEqual(pages.map(activitiesIn), [400, 400, 200]);
    for (let n = 1; n < pages.length; n += 1) {
      assert.equal(pages[n]!.toByte, pages[n - 1]!.fromByte, "consecutive blocks meet");
    }
    assert.equal(index.hasItemsBefore(id, pages[pages.length - 1]!.startSeq), false, "the last block is the oldest");
    for (const page of pages) {
      assert.deepEqual(
        index
          .turnsInSeqRange(id, { fromSeq: page.startSeq, toSeq: Math.min(page.endSeq, log.lastSeq + 1) })
          .map((turn) => turn.turnId),
        ["t1"]
      );
      assert.equal(index.turnOfSeq(id, page.startSeq)?.turnId, "t1");
    }
  });
});

function line(log: TestLog, seq: number): { byteOffset: number; byteLength: number } {
  const position = log.at(seq);
  return { byteOffset: position.byteOffset, byteLength: position.byteLength };
}

describe("thread index: message spans", () => {
  /**
   * seq: 1 created · 2 u1 · 3 row · 4 running t1 · 5 m1 chunk 1 · 6 b1 · 7 m1 chunk 2 · 8 b2
   *      9 m1 chunk 3 · 10 m1 final · 11 settle
   */
  async function streamedAroundActivities(): Promise<TestLog> {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("u1", "go"),
      turnStart("u1"),
      session("running", "t1"),
      delta("m1", "part one, ", "t1"),
      activity("b1", "tool.started", { turnId: "t1" }),
      delta("m1", "part two, ", "t1"),
      activity("b2", "tool.completed", { turnId: "t1" }),
      delta("m1", "part three", "t1"),
      done("m1", "t1"),
      session("ready", null, "t1")
    ]);
    return log;
  }

  it("a message streamed in three chunks around activity boundaries reports its span", async () => {
    const log = await streamedAroundActivities();
    const id = log.threadId;
    assert.deepEqual(index.messageSpan(id, "m1"), {
      firstSeq: 5,
      firstByte: log.at(5).byteOffset,
      lastSeq: 10
    });
    const [hit] = index.search({ q: "three", limit: 5 });
    assert.equal(hit!.id, "m1");
    assert.match(hit!.snippet, /part one, part two, part «three»/);
    assert.equal(index.messageSpan(id, "nope"), null);
    assert.equal(index.messageSpan("other-thread", "m1"), null);
  });

  it("messagesSpanning: a boundary inside the message returns it, one outside returns nothing", async () => {
    const log = await streamedAroundActivities();
    const id = log.threadId;
    const m1 = { messageId: "m1", firstSeq: 5, firstByte: log.at(5).byteOffset, lastSeq: 10 };
    // A boundary on either activity would cut m1 in two.
    assert.deepEqual(index.messagesSpanning(id, 6), [m1]);
    assert.deepEqual(index.messagesSpanning(id, 8), [m1]);
    assert.deepEqual(index.messagesSpanning(id, 10), [m1], "its final line is still inside");
    assert.deepEqual(index.messagesSpanning(id, 5), [], "a boundary ON its first line cuts nothing");
    assert.deepEqual(index.messagesSpanning(id, 11), []);
    assert.deepEqual(index.messagesSpanning(id, 3), [], "u1 began and ended at 2");
    assert.deepEqual(index.messagesSpanning("other-thread", 6), []);
  });

  it("eventPositionBySeq answers for an activity line and a message's first line, nothing else", async () => {
    const log = await streamedAroundActivities();
    const id = log.threadId;
    assert.deepEqual(index.eventPositionBySeq(id, 6), { seq: 6, ...line(log, 6) }, "an activity");
    assert.deepEqual(index.eventPositionBySeq(id, 5), { seq: 5, ...line(log, 5) }, "m1 began here");
    assert.deepEqual(index.eventPositionBySeq(id, 2), { seq: 2, ...line(log, 2) }, "the prompt");
    assert.equal(index.eventPositionBySeq(id, 7), null, "a middle chunk");
    assert.equal(index.eventPositionBySeq(id, 10), null, "a final chunk");
    assert.equal(index.eventPositionBySeq(id, 3), null, "a turn row");
    assert.equal(index.itemPositionBySeq(id, 5), null, "itemPositionBySeq stays activities-only");
  });

  it("every message has a span, text or not; a reopened one keeps where it began", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(), // 1
      done("empty", null, ""), // 2
      done("m2", null, "Hello"), // 3
      activity("between", "info"), // 4
      delta("m2", " again", null), // 5
      done("m2", null) // 6
    ]);
    const id = log.threadId;
    assert.deepEqual(index.messageSpan(id, "empty"), {
      firstSeq: 2,
      firstByte: log.at(2).byteOffset,
      lastSeq: 2
    });
    assert.deepEqual(index.messageSpan(id, "m2"), {
      firstSeq: 3,
      firstByte: log.at(3).byteOffset,
      lastSeq: 6
    });
    assert.deepEqual(index.messagesSpanning(id, 4).map((span) => span.messageId), ["m2"]);
    const [hit] = index.search({ q: "again", limit: 5 });
    assert.equal(hit!.at, stampAt(3), "stamped where it began");
  });

  it("a revert drops the spans of the messages it removed", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two" }),
      reverted(1)
    ]);
    const id = log.threadId;
    assert.notEqual(index.messageSpan(id, "a1"), null);
    assert.equal(index.messageSpan(id, "a2"), null);
    assert.equal(index.messageSpan(id, "u2"), null);
  });
});
