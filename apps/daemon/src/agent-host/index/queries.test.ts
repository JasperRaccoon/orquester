/**
 * The index's reads (design 2026-09-23 §C "History page", "Search"): paging by
 * cursor and by turn, the rewind gate, search that can never be a query
 * syntax error, and the thread's own prompts (the right rail's History).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  THREAD_PROMPTS_DEFAULT_LIMIT,
  THREAD_PROMPTS_MAX_LIMIT,
  THREAD_PROMPT_TEXT_MAX_CHARS,
  THREAD_SEARCH_MAX_RESULTS,
  applyDomainEvent,
  buildPlanImplementationPrompt,
  createEmptyThreadState,
  recallablePromptText,
  type ThreadMessageItem,
  type ThreadPromptEntry
} from "@orquester/api/agent-chat";

import {
  createThreadIndex,
  createUnavailableThreadIndex,
  type IndexedPrompt,
  type IndexedPromptsPage,
  type IndexedTurn,
  type ThreadIndex
} from "./index.ts";
import { MAX_INDEXED_TEXT_CHARS } from "./indexer.ts";
import {
  PROMPTS_MIN_BATCH,
  PROMPTS_SCAN_BUDGET,
  decodePromptsCursor,
  encodePromptsCursor,
  readPromptsPage,
  toFtsQuery,
  type PromptCandidate
} from "./queries.ts";
import {
  activity,
  checkpoint,
  compaction,
  created,
  delta,
  done,
  legacyCompaction,
  liveTurn,
  recordingLogger,
  replayedTurn,
  reverted,
  session,
  stampAt,
  subagentCompaction,
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

  it("the legacy marker — thread.state.changed {state: compacted} — withholds the turns before it", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two", extra: [legacyCompaction("legacy", "t2")] }),
      ...liveTurn({ n: 3, prompt: "three" }),
      // Any other thread state is no marker at all.
      activity("state", "thread.state.changed", { payload: { state: "running" }, turnId: "t3" })
    ]);
    const id = log.threadId;
    assert.deepEqual(
      [1, 2, 3].map((n) => index.rewindable(id, index.turnByOrdinal(id, n)!)),
      [false, false, true]
    );
  });

  it("a subagent's own compaction withholds nothing, whether the row or its payload names the agent", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({
        n: 2,
        prompt: "two",
        extra: [
          subagentCompaction("on-row", "t2", { agentId: "sub-1", on: "row" }),
          subagentCompaction("on-payload", "t2", { agentId: "sub-1", on: "payload" })
        ]
      }),
      ...liveTurn({ n: 3, prompt: "three" })
    ]);
    const id = log.threadId;
    assert.deepEqual(
      [1, 2, 3].map((n) => index.rewindable(id, index.turnByOrdinal(id, n)!)),
      [true, true, true]
    );
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

  it("latestRevertSeq and firstBoundaryAfter: where a page may end just past the latest revert", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two" })
    ]);
    const id = log.threadId;
    assert.equal(index.latestRevertSeq(id), 0, "never rewound");

    await indexed(log, [reverted(1)]);
    const firstRevert = log.lastSeq;
    assert.equal(index.latestRevertSeq(id), firstRevert);
    // Nothing a page may end at comes after it yet: no activity, no message.
    await indexed(log, [session("ready", null)]);
    assert.equal(index.firstBoundaryAfter(id, firstRevert), null);

    // A prompt's first line, then an activity: the lower of the two answers.
    await indexed(log, [userMessage("u3", "three"), activity("after", "info", { summary: "Rewound" })]);
    const prompt = log.at(firstRevert + 2);
    assert.deepEqual(index.firstBoundaryAfter(id, firstRevert), prompt);
    assert.deepEqual(index.firstBoundaryAfter(id, prompt.seq), log.at(prompt.seq + 1));

    await indexed(log, [reverted(1)]);
    assert.equal(index.latestRevertSeq(id), log.lastSeq, "the latest one");
    assert.equal(index.latestRevertSeq("another-thread"), 0);
  });

  it("turnByPrompt: the turn that names a message as its opening prompt", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two" })
    ]);
    const id = log.threadId;
    assert.equal(index.turnByPrompt(id, "u2")?.turnId, "t2");
    assert.equal(index.turnByPrompt(id, "a1"), null, "an answer opens no turn");
    await indexed(log, [reverted(1)]);
    assert.equal(index.turnByPrompt(id, "u2"), null, "a removed turn's prompt opens nothing any more");
    assert.equal(index.turnByPrompt(id, "u1")?.turnId, "t1");
  });

  it("keepsUserMessage: a user message until a revert drops it by the fold's rule", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      userMessage("note", "an idle note no turn claims"),
      ...liveTurn({ n: 2, prompt: "two" })
    ]);
    const id = log.threadId;
    assert.equal(index.keepsUserMessage(id, "u1"), true);
    assert.equal(index.keepsUserMessage(id, "note"), true, "not judged yet");
    assert.equal(index.keepsUserMessage(id, "a1"), false, "an answer is no user message");
    assert.equal(index.keepsUserMessage(id, "missing"), false);
    assert.equal(index.keepsUserMessage("another-thread", "u1"), false);
    // t1 keeps its own prompt, so the fold's fallback restores nothing: the note goes with u2.
    await indexed(log, [reverted(1)]);
    assert.equal(index.keepsUserMessage(id, "u1"), true);
    assert.equal(index.keepsUserMessage(id, "u2"), false, "a removed turn's prompt");
    assert.equal(index.keepsUserMessage(id, "note"), false, "a prompt no kept turn claims, past the fallback");
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

describe("thread index: the thread's prompts", () => {
  /** The seq of the line that first named `messageId`. */
  function seqOf(log: TestLog, messageId: string): number {
    const event = log
      .all()
      .events.find(
        (candidate) =>
          candidate.type === "thread.message-sent" && candidate.payload.messageId === messageId
      );
    assert.ok(event !== undefined, `no message ${messageId}`);
    return event.seq;
  }

  function page(
    threadId: string,
    input: { before?: string | null; limit?: number } = {}
  ): IndexedPromptsPage {
    const answer = index.prompts(threadId, {
      limit: input.limit ?? THREAD_PROMPTS_DEFAULT_LIMIT,
      ...(input.before !== undefined ? { before: input.before } : {})
    });
    assert.ok(answer !== null, "an open index answers");
    return answer;
  }

  const ids = (answer: IndexedPromptsPage): string[] =>
    answer.prompts.map((entry) => entry.messageId);

  /** `prompt()`'s answer: the prompt, null for `absent`; a failed read fails the test. */
  function promptOf(threadId: string, messageId: string): IndexedPrompt | null {
    const lookup = index.prompt(threadId, messageId);
    assert.notEqual(lookup.status, "failed", "an open index reads");
    return lookup.status === "found" ? lookup.prompt : null;
  }

  it("lists the parent's prompts newest first, each with the turn it opened", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...[1, 2, 3].flatMap((n) => liveTurn({ n, prompt: `prompt number ${n}` }))
    ]);
    const answer = page(log.threadId);
    assert.deepEqual(
      answer.prompts,
      [3, 2, 1].map(
        (n): ThreadPromptEntry => ({
          messageId: `u${n}`,
          turnId: `t${n}`,
          turnOrdinal: n,
          rewindable: true,
          text: `prompt number ${n}`,
          truncated: false,
          createdAt: stampAt(seqOf(log, `u${n}`)),
          seq: seqOf(log, `u${n}`)
        })
      )
    );
    assert.equal(answer.before, null);
  });

  it("lists a steer on the turn it steered, and a prompt no turn has started yet, with no ordinal", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one", extra: [userMessage("steer", "and this too", "t1")] }),
      userMessage("u2", "two"),
      turnStart("u2")
    ]);
    assert.deepEqual(
      page(log.threadId).prompts.map((entry) => [
        entry.messageId,
        entry.turnId,
        entry.turnOrdinal,
        entry.rewindable
      ]),
      [
        ["u2", null, null, null],
        ["steer", "t1", null, null],
        ["u1", "t1", 1, true]
      ]
    );
  });

  it("a replayed prompt opens the replayed turn that names it", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("user:h1", "from the transcript", "h1"),
      replayedTurn("user:h1", "h1", stampAt(3)),
      ...liveTurn({ n: 2, prompt: "live" })
    ]);
    assert.deepEqual(
      page(log.threadId).prompts.map((entry) => [entry.messageId, entry.turnId, entry.turnOrdinal]),
      [
        ["u2", "t2", 2],
        ["user:h1", "h1", 1]
      ]
    );
  });

  it("refuses what the user did not type, and strips image placeholders from what they did", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("internal", "<task-notification>agent done</task-notification>"),
      userMessage("command", "  <command-name>/clear</command-name>"),
      userMessage("compact", " /compact "),
      userMessage("implement", buildPlanImplementationPrompt("# Plan\n- a")),
      userMessage("images", "[Image #1] [Image #2]"),
      userMessage("blank", "   "),
      userMessage("typed", "look at [Image #1] this one"),
      userMessage("slash", "/goal pause"),
      done("answer", null, "an assistant's text is never a prompt")
    ]);
    assert.deepEqual(
      page(log.threadId).prompts.map((entry) => [entry.messageId, entry.text]),
      [
        ["slash", "/goal pause"],
        ["typed", "look at this one"]
      ]
    );
    for (const messageId of ["internal", "command", "compact", "implement", "images", "blank", "answer"]) {
      assert.equal(promptOf(log.threadId, messageId), null, messageId);
    }
  });

  it("never lists a subagent's user message; an empty owner is the parent's own", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("parent", "mine"),
      userMessage("owned", "the subagent's brief", null, "sub-1"),
      userMessage("unowned", "also mine", null, ""),
      // The author is the first line's, as the fold keeps it: a later line
      // naming an owner, or none, moves neither message.
      userMessage("parent", "mine, restated", null, "sub-2"),
      userMessage("owned", "restated")
    ]);
    const id = log.threadId;
    assert.deepEqual(
      page(id).prompts.map((entry) => [entry.messageId, entry.text, entry.seq]),
      [
        ["unowned", "also mine", seqOf(log, "unowned")],
        ["parent", "mine, restated", seqOf(log, "parent")]
      ]
    );
    assert.equal(promptOf(id, "owned"), null);
  });

  it("a revert takes the reverted turns' prompts and their steers with it", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two", extra: [userMessage("steer-2", "steer two", "t2")] }),
      ...liveTurn({ n: 3, prompt: "three" }),
      reverted(1),
      ...liveTurn({ n: 4, prompt: "four" })
    ]);
    const id = log.threadId;
    assert.deepEqual(
      page(id).prompts.map((entry) => [entry.messageId, entry.turnId, entry.turnOrdinal]),
      [
        ["u4", "t4", 2],
        ["u1", "t1", 1]
      ]
    );
    for (const messageId of ["u2", "steer-2", "u3"]) {
      assert.equal(promptOf(id, messageId), null, messageId);
    }
  });

  it("gives each prompt the history page's rewind rule for the turn it opened", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two", extra: [compaction("auto", "t2")] }),
      ...liveTurn({ n: 3, prompt: "three" })
    ]);
    const id = log.threadId;
    const entries = page(id).prompts;
    assert.deepEqual(
      entries.map((entry) => [entry.turnOrdinal, entry.rewindable]),
      [
        [3, true],
        [2, false],
        [1, false]
      ]
    );
    for (const entry of entries) {
      const turn = index.turnByOrdinal(id, entry.turnOrdinal!)!;
      assert.equal(entry.rewindable, index.rewindable(id, turn), "one rule");
    }
  });

  it("pages by its cursor, and refused rows never cost a page a slot", async () => {
    const log = new TestLog();
    const drafts: Draft[] = [created()];
    for (let n = 1; n <= 7; n += 1) {
      drafts.push(...liveTurn({ n, prompt: `prompt ${n}` }));
      // Refused rows next to every prompt, and so at every page's boundary.
      drafts.push(
        userMessage(`notice-${n}`, `<task-notification>${n}</task-notification>`),
        userMessage(`compact-${n}`, "/compact")
      );
    }
    await indexed(log, drafts);
    const id = log.threadId;

    const first = page(id, { limit: 3 });
    assert.deepEqual(ids(first), ["u7", "u6", "u5"]);
    assert.equal(decodePromptsCursor(first.before!, id), seqOf(log, "u5"));
    const second = page(id, { limit: 3, before: first.before });
    assert.deepEqual(ids(second), ["u4", "u3", "u2"]);
    assert.notEqual(second.before, null);
    const third = page(id, { limit: 3, before: second.before });
    assert.deepEqual(ids(third), ["u1"]);
    assert.equal(third.before, null);

    const whole = page(id, { limit: 7 });
    assert.equal(whole.prompts.length, 7);
    assert.equal(whole.before, null, "a page ending on the first prompt has nothing below it");
  });

  it("walks past more refused rows than one read holds, to fill the page and find the next", async () => {
    const log = new TestLog();
    const notices = (tag: string): Draft[] =>
      Array.from({ length: 10 }, (_unused, n) =>
        userMessage(`notice-${tag}-${n}`, "<task-notification>x</task-notification>")
      );
    await indexed(log, [
      created(),
      userMessage("p1", "one"),
      ...notices("a"),
      userMessage("p2", "two"),
      ...notices("b"),
      userMessage("p3", "three"),
      ...notices("c")
    ]);
    const id = log.threadId;
    const first = page(id, { limit: 2 });
    assert.deepEqual(ids(first), ["p3", "p2"]);
    assert.notEqual(first.before, null, "p1 lies ten refused rows further down");
    const second = page(id, { limit: 2, before: first.before });
    assert.deepEqual(ids(second), ["p1"]);
    assert.equal(second.before, null);
  });

  it("clamps the limit to [1, THREAD_PROMPTS_MAX_LIMIT], and anything not a number is the default", async () => {
    const log = new TestLog();
    const drafts: Draft[] = [created()];
    for (let n = 0; n < THREAD_PROMPTS_MAX_LIMIT + 5; n += 1) {
      drafts.push(userMessage(`m${n}`, `prompt ${n}`));
    }
    await indexed(log, drafts);
    const id = log.threadId;
    assert.equal(page(id, { limit: 0 }).prompts.length, 1);
    assert.equal(page(id, { limit: -7 }).prompts.length, 1);
    assert.equal(page(id, { limit: 2.9 }).prompts.length, 2);
    const max = page(id, { limit: 10_000 });
    assert.equal(max.prompts.length, THREAD_PROMPTS_MAX_LIMIT);
    assert.notEqual(max.before, null);
    assert.equal(page(id, { limit: Number.NaN }).prompts.length, THREAD_PROMPTS_DEFAULT_LIMIT);
    assert.equal(
      page(id, { limit: Number.POSITIVE_INFINITY }).prompts.length,
      THREAD_PROMPTS_DEFAULT_LIMIT
    );
  });

  it("cuts an entry's text at THREAD_PROMPT_TEXT_MAX_CHARS, never inside a surrogate pair", async () => {
    const max = THREAD_PROMPT_TEXT_MAX_CHARS;
    const exact = "a".repeat(max);
    const long = "b".repeat(max + 10);
    const astral = `${"c".repeat(max - 1)}😀 tail`;
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("exact", exact),
      userMessage("long", long),
      userMessage("astral", astral)
    ]);
    const id = log.threadId;
    const byId = new Map(page(id).prompts.map((entry) => [entry.messageId, entry]));
    assert.deepEqual([byId.get("exact")!.text, byId.get("exact")!.truncated], [exact, false]);
    assert.deepEqual([byId.get("long")!.text, byId.get("long")!.truncated], ["b".repeat(max), true]);
    assert.deepEqual(
      [byId.get("astral")!.text, byId.get("astral")!.truncated],
      ["c".repeat(max - 1), true],
      "the pair is left out whole"
    );
    assert.equal(promptOf(id, "long")!.text, long, "by id, the whole text");
    assert.equal(promptOf(id, "astral")!.text, astral);
  });

  it("reads a malformed or foreign cursor as a first page", async () => {
    const log = new TestLog();
    await indexed(log, [created(), ...[1, 2, 3].flatMap((n) => liveTurn({ n, prompt: `p${n}` }))]);
    const id = log.threadId;
    const firstPage = ids(page(id, { limit: 2 }));
    assert.deepEqual(firstPage, ["u3", "u2"]);
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const valid = encodePromptsCursor(id, seqOf(log, "u2"));
    for (const before of [
      "",
      "!! not base64 !!",
      "abcde",
      `${valid}=`,
      encode({ t: id }),
      encode({ t: id, s: 0 }),
      encode({ t: id, s: -3 }),
      encode({ t: id, s: 2.5 }),
      encode({ t: id, s: "9" }),
      encode([id, 9]),
      encodePromptsCursor("another-thread", seqOf(log, "u2"))
    ]) {
      assert.deepEqual(ids(page(id, { limit: 2, before })), firstPage, before);
    }
    assert.deepEqual(ids(page(id, { limit: 2, before: valid })), ["u1"]);
    // A cursor names a seq and nothing else: past the log's end, everything is older.
    assert.deepEqual(ids(page(id, { limit: 2, before: encodePromptsCursor(id, 10_000) })), firstPage);
    assert.equal(decodePromptsCursor(encodePromptsCursor(id, 42), id), 42);
    assert.equal(decodePromptsCursor(encode({ t: id, s: 42, later: "field" }), id), 42);
  });

  it("answers a read it cannot make with null or failed — never an empty page; no prompts is an empty page", async () => {
    const unavailable = createUnavailableThreadIndex();
    assert.equal(unavailable.prompts("thread-1", { limit: 5 }), null);
    assert.deepEqual(unavailable.prompt("thread-1", "u1"), { status: "failed" });
    assert.equal(await unavailable.coverage("thread-1", 5), "unavailable");

    const quiet = new TestLog("thread-quiet");
    await indexed(quiet, [created(), done("a1", null, "an assistant speaks first")]);
    assert.equal(await index.coverage(quiet.threadId, quiet.lastSeq), "complete");
    assert.deepEqual(page(quiet.threadId), { prompts: [], before: null });

    const log = new TestLog();
    await indexed(log, [created(), userMessage("u1", "hello")]);
    assert.deepEqual(ids(page(log.threadId)), ["u1"]);
    index.close();
    assert.equal(index.prompts(log.threadId, { limit: 5 }), null, "a closed index answers nothing");
    assert.deepEqual(index.prompt(log.threadId, "u1"), { status: "failed" });
    assert.equal(await index.coverage(log.threadId, log.lastSeq), "unavailable");
  });

  it("coverage: whole once every line is indexed; catching up while a catch-up will close the gap; behind when none will", async () => {
    const catchUpOf = (log: TestLog): Promise<void> =>
      index.catchUp({
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "Thread",
        logSeq: log.lastSeq,
        read: log.readEventsFrom
      });
    // Written while the index saw nothing of it — a rebuilt file.
    const rebuilt = new TestLog("thread-rebuilt");
    rebuilt.append(created(), ...liveTurn({ n: 1, prompt: "before the rebuild" }));
    const unreached = new TestLog("thread-unreached");
    unreached.append(created(), userMessage("x1", "never caught up"));
    assert.equal(await index.coverage(rebuilt.threadId, rebuilt.lastSeq), "behind", "no catch-up is coming");

    const sweep = index.beginCatchUpSweep();
    assert.equal(await index.coverage(rebuilt.threadId, rebuilt.lastSeq), "catching-up", "the sweep has not reached it");
    const running = catchUpOf(rebuilt);
    assert.equal(await index.coverage(rebuilt.threadId, rebuilt.lastSeq), "catching-up", "its catch-up is queued");
    await running;
    assert.equal(await index.coverage(rebuilt.threadId, rebuilt.lastSeq), "complete");
    assert.deepEqual(ids(page(rebuilt.threadId)), ["u1"]);

    // A thread born during the sweep is indexed from its first line.
    const born = new TestLog("thread-born");
    await indexed(born, [created(), userMessage("b1", "new")]);
    assert.equal(await index.coverage(born.threadId, born.lastSeq), "complete");
    // A live append still queued is waited for — a moment's lag is no gap.
    index.observe({
      threadId: born.threadId,
      projectPath: "/w/p",
      title: "Thread",
      ...born.append(userMessage("b2", "newer"))
    });
    assert.equal(await index.coverage(born.threadId, born.lastSeq), "complete");

    assert.equal(await index.coverage(unreached.threadId, unreached.lastSeq), "catching-up");
    sweep.end();
    sweep.end();
    assert.equal(await index.coverage(unreached.threadId, unreached.lastSeq), "behind", "the sweep is over");

    // A live write the index cannot apply — a line it never got — leaves the
    // thread behind for good: no catch-up will read it before a restart.
    born.append(userMessage("b3", "lost"));
    index.observe({
      threadId: born.threadId,
      projectPath: "/w/p",
      title: "Thread",
      ...born.append(userMessage("b4", "after the hole"))
    });
    assert.equal(await index.coverage(born.threadId, born.lastSeq), "behind");
  });

  it("prompt(): a listed prompt by id, with its line; null for anything the list would not show", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "  first prompt [Image #1] " }),
      userMessage("owned", "brief", null, "sub-1"),
      ...liveTurn({ n: 2, prompt: "second" }),
      reverted(1)
    ]);
    const id = log.threadId;
    const seq = seqOf(log, "u1");
    assert.deepEqual(promptOf(id, "u1"), {
      messageId: "u1",
      text: "first prompt",
      cut: false,
      line: { seq, ...line(log, seq) },
      lastSeq: seq
    });
    for (const messageId of ["a1", "owned", "u2", "nope", ""]) {
      assert.equal(promptOf(id, messageId), null, messageId);
    }
    assert.equal(promptOf("other-thread", "u1"), null);
  });

  it("prompt(): says when the index's copy may be only the head of a longer prompt", async () => {
    const whole = `${"x".repeat(MAX_INDEXED_TEXT_CHARS)} and more`;
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("long", whole),
      userMessage("below", "y".repeat(MAX_INDEXED_TEXT_CHARS - 2)),
      userMessage("twice", "z".repeat(MAX_INDEXED_TEXT_CHARS + 1)),
      userMessage("twice", "z".repeat(MAX_INDEXED_TEXT_CHARS + 2))
    ]);
    const id = log.threadId;
    const long = promptOf(id, "long")!;
    assert.equal(long.cut, true);
    assert.equal(long.text, "x".repeat(MAX_INDEXED_TEXT_CHARS));
    assert.equal(long.lastSeq, long.line.seq, "one line: the host can read it whole");
    assert.equal(promptOf(id, "below")!.cut, false, "a copy below the cap is whole");
    const twice = promptOf(id, "twice")!;
    assert.equal(twice.cut, true);
    assert.ok(twice.lastSeq > twice.line.seq, "written twice: no one line holds it");
    assert.equal(page(id).prompts.find((entry) => entry.messageId === "long")!.truncated, true);
  });

  it("a rebuild from the log lists exactly what the live index listed", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one", extra: [userMessage("steer", "steer", "t1")] }),
      userMessage("owned", "brief", null, "sub-1"),
      ...liveTurn({ n: 2, prompt: "two", extra: [compaction("auto", "t2")] }),
      ...liveTurn({ n: 3, prompt: "three" }),
      reverted(2),
      userMessage("u4", "pending"),
      turnStart("u4")
    ]);
    const rebuilt = createThreadIndex({
      filePath: join(dir, "rebuilt.sqlite"),
      logger: recordingLogger()
    });
    try {
      await rebuilt.catchUp({
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "Thread",
        logSeq: log.lastSeq,
        read: log.readEventsFrom
      });
      assert.deepEqual(rebuilt.prompts(log.threadId, { limit: 100 }), page(log.threadId));
      assert.deepEqual(ids(page(log.threadId)), ["u4", "u2", "steer", "u1"]);
    } finally {
      rebuilt.close();
    }
  });

  /** The prompts the fold itself still shows: its parent user messages the recall rule accepts. */
  function foldedPromptIds(log: TestLog): string[] {
    let state = createEmptyThreadState();
    for (const event of log.all().events) {
      state = applyDomainEvent(state, event);
    }
    return state.items
      .filter(
        (item): item is ThreadMessageItem =>
          item.kind === "message" &&
          item.role === "user" &&
          (item.agentId === undefined || item.agentId.length === 0) &&
          recallablePromptText(item.text) !== null
      )
      .map((item) => item.id);
  }

  it("a revert drops a turn-less prompt no turn claims, before the cut — as the fold does", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      // Sent while idle: the host starts no turn for it, and no turn claims it.
      userMessage("goal-idle", "/goal pause"),
      ...liveTurn({ n: 2, prompt: "two" }),
      reverted(1)
    ]);
    assert.deepEqual(ids(page(log.threadId)), ["u1"]);
    assert.deepEqual(foldedPromptIds(log), ["u1"], "the fold agrees");
    assert.equal(promptOf(log.threadId, "goal-idle"), null);
  });

  it("…unless the fold's fallback restores it, for retained turns that have no prompt", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      // A turn the provider started by itself: no prompt claims it.
      session("running", "p1"),
      session("ready", null, "p1"),
      userMessage("goal-idle", "/goal status"),
      ...liveTurn({ n: 2, prompt: "two" }),
      reverted(1)
    ]);
    assert.deepEqual(ids(page(log.threadId)), ["goal-idle"]);
    assert.deepEqual(foldedPromptIds(log), ["goal-idle"], "the fold agrees");
  });

  it("a resumed thread's first live prompt, requested before the replay, goes with its turn", async () => {
    // The live turn is numbered FIRST, but `openTurn` begins its range at its
    // adoption, after the replay: the position of its prompt is before every
    // removed row, and only the claim says whose it is.
    const resumed = (): Draft[] => [
      created(),
      userMessage("u-live", "carry on"),
      turnStart("u-live"),
      userMessage("user:h1", "from the transcript", "h1"),
      replayedTurn("user:h1", "h1", stampAt(4)),
      session("running", "t-live"),
      delta("a-live", "Carrying on.", "t-live"),
      done("a-live", "t-live"),
      session("ready", null, "t-live")
    ];
    const toZero = new TestLog("thread-to-zero");
    await indexed(toZero, [...resumed(), reverted(0)]);
    assert.deepEqual(ids(page(toZero.threadId)), []);
    assert.deepEqual(foldedPromptIds(toZero), [], "the fold agrees");

    const toOne = new TestLog("thread-to-one");
    await indexed(toOne, [...resumed(), reverted(1)]);
    assert.deepEqual(ids(page(toOne.threadId)), ["u-live"]);
    assert.deepEqual(foldedPromptIds(toOne), ["u-live"], "the fold agrees");
  });

  it("lists after a revert exactly the prompts the fold keeps", async () => {
    const scenarios: Array<{ name: string; drafts: Draft[] }> = [
      {
        name: "steers and a second revert",
        drafts: [
          created(),
          ...liveTurn({ n: 1, prompt: "one", extra: [userMessage("s1", "steer one", "t1")] }),
          ...liveTurn({ n: 2, prompt: "two", extra: [userMessage("s2", "steer two", "t2")] }),
          userMessage("idle", "/goal pause"),
          ...liveTurn({ n: 3, prompt: "three" }),
          reverted(2),
          ...liveTurn({ n: 4, prompt: "four" }),
          reverted(1)
        ]
      },
      {
        name: "a send no turn ever started",
        drafts: [
          created(),
          ...liveTurn({ n: 1, prompt: "one" }),
          userMessage("u-refused", "never started"),
          turnStart("u-refused"),
          session("ready"),
          ...liveTurn({ n: 2, prompt: "two" }),
          reverted(1)
        ]
      },
      {
        name: "a revert to where it already is",
        drafts: [
          created(),
          ...liveTurn({ n: 1, prompt: "one" }),
          userMessage("idle", "/goal resume"),
          reverted(1)
        ]
      }
    ];
    for (const { name, drafts } of scenarios) {
      const log = new TestLog(`thread-${name.replaceAll(" ", "-")}`);
      await indexed(log, drafts);
      assert.deepEqual(ids(page(log.threadId)).sort(), foldedPromptIds(log).sort(), name);
    }
  });

  it("reads max(limit + 1, PROMPTS_MIN_BATCH) rows at a time, and stops at its scan budget with a cursor", () => {
    // One prompt under 3 000 rows the recall rule refuses.
    const rows: PromptCandidate[] = [
      { messageId: "p", seq: 1, text: "the one prompt", turnId: null, createdAt: stampAt(1) }
    ];
    for (let seq = 2; seq <= 3_001; seq += 1) {
      rows.push({
        messageId: `n${seq}`,
        seq,
        text: "<task-notification>done</task-notification>",
        turnId: null,
        createdAt: stampAt(seq)
      });
    }
    rows.sort((left, right) => right.seq - left.seq);
    const reads: number[] = [];
    const source = {
      olderThan(beforeSeq: number, count: number) {
        reads.push(count);
        const read = rows.filter((row) => row.seq < beforeSeq).slice(0, count);
        return { candidates: read, scanned: read.length };
      },
      turnOpenedBy: () => null,
      rewindable: () => true
    };

    const first = readPromptsPage("thread-1", { limit: 1 }, source);
    assert.deepEqual(first.prompts, [], "the budget ran out first");
    assert.equal(reads[0], PROMPTS_MIN_BATCH, "a page of one reads a whole batch");
    assert.equal(
      reads.reduce((sum, count) => sum + count, 0),
      PROMPTS_SCAN_BUDGET,
      "and walks exactly its budget"
    );
    assert.equal(decodePromptsCursor(first.before!, "thread-1"), 3_001 - PROMPTS_SCAN_BUDGET + 1);

    const second = readPromptsPage("thread-1", { limit: 1, before: first.before }, source);
    assert.deepEqual(second.prompts.map((entry) => entry.messageId), ["p"]);
    assert.equal(second.before, null, "the thread is exhausted");

    reads.length = 0;
    readPromptsPage("thread-1", { limit: 500 }, source);
    assert.equal(reads[0], 501, "a page bigger than the batch reads itself plus one");
  });

  it("counts a read by every row it scanned, placed or not, before it calls the thread exhausted", () => {
    // Rows 300…1, newest first; of 300…45, only 250 can be placed.
    const source = {
      olderThan(beforeSeq: number, count: number) {
        const seqs: number[] = [];
        for (let seq = Math.min(300, beforeSeq - 1); seq >= 1 && seqs.length < count; seq -= 1) {
          seqs.push(seq);
        }
        const candidates = seqs
          .filter((seq) => seq <= 45 || seq === 250)
          .map((seq) => ({
            messageId: `m${seq}`,
            seq,
            text: `prompt ${seq}`,
            turnId: null,
            createdAt: stampAt(seq)
          }));
        return { candidates, scanned: seqs.length };
      },
      turnOpenedBy: () => null,
      rewindable: () => true
    };
    const answer = readPromptsPage("thread-1", { limit: 3 }, source);
    assert.deepEqual(
      answer.prompts.map((entry) => entry.seq),
      [250, 45, 44]
    );
    assert.equal(decodePromptsCursor(answer.before!, "thread-1"), 44, "there is more below");
  });

  it("walks past a user message that never had text, counting it", async () => {
    const log = new TestLog();
    await indexed(log, [
      created(),
      userMessage("p1", "older"),
      userMessage("empty", ""),
      userMessage("p2", "newer")
    ]);
    assert.deepEqual(ids(page(log.threadId)), ["p2", "p1"]);
    assert.equal(promptOf(log.threadId, "empty"), null);
  });
});
