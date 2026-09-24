/**
 * Events → rows (design 2026-09-23 §C "Maintenance"): turn rows, ordinals and
 * byte ranges, message and activity text, markers, idempotency, gaps, reverts
 * and a restart in the middle of a thread; what is in flight across losing the
 * memory (a restart, the LRU); the text cap. A real SQLite file in a temp dir.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";
import type BetterSqlite3 from "better-sqlite3";

import { systemClock } from "../orchestration/runtime-seams.ts";
import { createThreadIndex, type IndexedTurn, type ThreadIndex } from "./index.ts";
import {
  capText,
  createThreadIndexer,
  MAX_INDEXED_TEXT_CHARS,
  MAX_LATE_REFERENCE_BYTES,
  MAX_RESIDENT_THREADS,
  type ThreadIndexer
} from "./indexer.ts";
import { createThreadIndexQueries, type ThreadIndexQueries } from "./queries.ts";
import { defaultSqliteDriver, openIndexFile } from "./sqlite.ts";
import {
  activity,
  checkpoint,
  compaction,
  created,
  deleted,
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
  type AppendedBatch,
  type RecordingLogger
} from "./testing.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

let dir: string;
let filePath: string;
let logger: RecordingLogger;
let index: ThreadIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  filePath = join(dir, "index.sqlite");
  logger = recordingLogger();
  index = createThreadIndex({ filePath, logger });
});

afterEach(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

const META = { projectPath: "/w/p", title: "Parser work" };

function feed(target: ThreadIndex, log: TestLog, batch: AppendedBatch): void {
  target.observe({ threadId: log.threadId, ...META, ...batch });
}

function inspect<T>(query: (db: BetterSqlite3.Database) => T): T {
  const db = new Database(filePath, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function turn(target: ThreadIndex, threadId: string, ordinal: number): IndexedTurn {
  const found = target.turnByOrdinal(threadId, ordinal);
  assert.ok(found !== null, `no turn ${ordinal}`);
  return found;
}

/** Two live turns, appended the way the host appends them. */
function twoLiveTurns(log: TestLog): AppendedBatch[] {
  return [
    log.append(created()), // 1
    log.append(userMessage("u1", "Fix the parser please"), turnStart("u1")), // 2, 3
    log.append(session("running", "t1")), // 4
    log.append(delta("a1", "I will ", "t1")), // 5
    log.append(delta("a1", "fix the lexer.", "t1")), // 6
    log.append(
      activity("act1", "tool.completed", {
        summary: "Ran tests",
        payload: { detail: "npm test passed" },
        turnId: "t1"
      })
    ), // 7
    log.append(compaction("cmp1", "t1")), // 8
    log.append(done("a1", "t1")), // 9
    log.append(session("ready", null, "t1")), // 10
    log.append(checkpoint("t1", 1)), // 11 — the capture lands after the settle
    log.append(userMessage("u2", "Now add tests"), turnStart("u2")), // 12, 13
    log.append(session("running", "t2")), // 14
    log.append(done("a2", "t2", "Done with the tests")), // 15
    log.append(session("ready", null, "t2")) // 16
  ];
}

describe("thread index: observe", () => {
  it("never applies inside the caller: rows appear once the queue drains", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created()));
    assert.equal(index.cursor(log.threadId), null);
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 1, lastByte: log.size });
  });

  it("derives turn rows: ordinals, timestamps, prompt, and byte ranges that tile the log", async () => {
    const log = new TestLog();
    for (const batch of twoLiveTurns(log)) {
      feed(index, log, batch);
    }
    await index.drain();

    assert.equal(index.totalTurns(log.threadId), 2);
    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    assert.deepEqual(first, {
      turnId: "t1",
      ordinal: 1,
      userMessageId: "u1",
      requestedAt: stampAt(3),
      startedAt: stampAt(4),
      completedAt: stampAt(10),
      // Opens at its PROMPT (seq 2), which precedes the turn row (seq 3)…
      firstSeq: 2,
      firstByte: log.at(2).byteOffset,
      // …and keeps the checkpoint appended after its settle (seq 11).
      lastSeq: 11,
      endByte: log.at(12).byteOffset
    });
    assert.deepEqual(second, {
      turnId: "t2",
      ordinal: 2,
      userMessageId: "u2",
      requestedAt: stampAt(13),
      startedAt: stampAt(14),
      completedAt: stampAt(16),
      firstSeq: 12,
      firstByte: log.at(12).byteOffset,
      lastSeq: 16,
      endByte: log.size
    });
    assert.equal(first.endByte, second.firstByte, "consecutive turns meet exactly");
    assert.deepEqual(index.turnById(log.threadId, "t2"), second);
    assert.equal(index.turnById(log.threadId, "nope"), null);
    assert.equal(index.turnByOrdinal(log.threadId, 3), null);
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 16, lastByte: log.size });
  });

  it("indexes finished messages and every activity write, with item positions and markers", async () => {
    const log = new TestLog();
    for (const batch of twoLiveTurns(log)) {
      feed(index, log, batch);
    }
    await index.drain();

    const [prompt] = index.search({ q: "parser", limit: 10 });
    assert.deepEqual(
      { ...prompt!, snippet: undefined },
      {
        threadId: log.threadId,
        projectPath: "/w/p",
        title: "Parser work",
        // The prompt was written before its turn existed; the hit names it anyway.
        turnId: "t1",
        ordinal: 1,
        kind: "message",
        id: "u1",
        role: "user",
        activityKind: null,
        snippet: undefined,
        at: stampAt(2),
        seq: 2
      }
    );
    assert.match(prompt!.snippet, /«parser»/);

    const [answer] = index.search({ q: "lexer", limit: 10 });
    assert.equal(answer!.id, "a1");
    assert.equal(answer!.role, "assistant");
    assert.equal(answer!.seq, 9, "indexed when it finished");
    assert.equal(answer!.at, stampAt(5), "stamped when it started");
    assert.match(answer!.snippet, /I will fix the «lexer»/);

    const [tool] = index.search({ q: "npm", limit: 10 });
    assert.equal(tool!.kind, "activity");
    assert.equal(tool!.id, "act1");
    assert.equal(tool!.activityKind, "tool.completed");
    assert.equal(tool!.role, null);
    assert.equal(tool!.turnId, "t1");
    assert.equal(tool!.ordinal, 1);

    assert.deepEqual(
      index
        .search({ q: "tests", limit: 10 })
        .map((hit) => hit.id)
        .sort(),
      ["a2", "act1", "u2"]
    );

    const { items, markers } = inspect((db) => ({
      items: db.prepare("SELECT item_id, seq, byte_offset, byte_length FROM items ORDER BY seq").all(),
      markers: db.prepare("SELECT seq, kind FROM markers").all()
    }));
    assert.deepEqual(items, [
      { item_id: "act1", seq: 7, byte_offset: log.at(7).byteOffset, byte_length: log.at(7).byteLength },
      { item_id: "cmp1", seq: 8, byte_offset: log.at(8).byteOffset, byte_length: log.at(8).byteLength }
    ]);
    assert.deepEqual(markers, [{ seq: 8, kind: "compacted" }]);
  });

  it("is idempotent: a replayed batch changes nothing", async () => {
    const log = new TestLog();
    const batches = twoLiveTurns(log);
    for (const batch of batches) {
      feed(index, log, batch);
    }
    await index.drain();
    const before = [turn(index, log.threadId, 1), turn(index, log.threadId, 2)];

    for (const batch of batches) {
      feed(index, log, batch);
    }
    feed(index, log, log.all());
    await index.drain();

    assert.deepEqual([turn(index, log.threadId, 1), turn(index, log.threadId, 2)], before);
    assert.equal(index.totalTurns(log.threadId), 2);
    assert.equal(index.search({ q: "parser", limit: 10 }).length, 1);
    assert.equal(
      inspect((db) => (db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }).n),
      4
    );
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 16, lastByte: log.size });
  });

  it("drops a batch that skips ahead of the cursor, and resumes once the hole is filled", async () => {
    const log = new TestLog();
    const first = log.append(created(), userMessage("u1", "alpha"));
    const hole = log.append(turnStart("u1"), session("running", "t1"));
    const ahead = log.append(done("a1", "t1", "bravo"), session("ready", null, "t1"));

    feed(index, log, first);
    feed(index, log, ahead);
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 2, lastByte: log.at(3).byteOffset });
    assert.deepEqual(index.search({ q: "bravo", limit: 5 }), []);
    assert.ok(
      logger.entries.some((entry) => /behind/.test(entry.message)),
      "the hole is reported"
    );

    feed(index, log, hole);
    feed(index, log, ahead);
    await index.drain();
    assert.deepEqual(index.cursor(log.threadId), { lastSeq: 6, lastByte: log.size });
    assert.equal(index.search({ q: "bravo", limit: 5 }).length, 1);
    assert.equal(turn(index, log.threadId, 1).firstSeq, 2);
  });

  it("anchors a replayed history turn at its prompt, though its row is minted at its end", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        userMessage("hu1", "first question", "h1"), // 2
        done("ha1", "h1", "first answer"), // 3
        activity("hact1", "tool.completed", { summary: "Read a file", turnId: "h1" }), // 4
        replayedTurn("hu1", "h1", stampAt(4)), // 5
        userMessage("hu2", "second question", "h2"), // 6
        done("ha2", "h2", "second answer"), // 7
        replayedTurn("hu2", "h2", stampAt(7)) // 8
      )
    );
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    assert.equal(first.turnId, "h1");
    assert.equal(first.userMessageId, "hu1");
    assert.equal(first.completedAt, stampAt(4));
    assert.deepEqual(
      [first.firstSeq, first.lastSeq, first.firstByte, first.endByte],
      [2, 5, log.at(2).byteOffset, log.at(6).byteOffset]
    );
    assert.deepEqual(
      [second.firstSeq, second.lastSeq, second.firstByte, second.endByte],
      [6, 8, log.at(6).byteOffset, log.size]
    );
  });

  it("follows the fold's text rule: a final text replaces, an empty one keeps, a reopened message continues", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        delta("m1", "draft wording", null),
        done("m1", null, "polished wording"),
        done("m2", null, "Hello"),
        delta("m2", " world", null),
        done("m2", null),
        done("m3", null, ""),
        delta("r1", "thinking very hard", null, "reasoning"),
        done("r1", null, "", "reasoning")
      )
    );
    await index.drain();

    assert.deepEqual(index.search({ q: "draft", limit: 5 }), []);
    assert.deepEqual(
      index.search({ q: "polished", limit: 5 }).map((hit) => hit.id),
      ["m1"]
    );
    const world = index.search({ q: "world", limit: 5 });
    assert.deepEqual(world.map((hit) => hit.id), ["m2"]);
    assert.match(world[0]!.snippet, /Hello «world»/);
    assert.equal(index.search({ q: "Hello", limit: 5 }).length, 1);
    const [reasoning] = index.search({ q: "thinking", limit: 5 });
    assert.equal(reasoning!.role, "reasoning");
    assert.equal(
      inspect((db) => (db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }).n),
      3,
      "an empty message is not indexed"
    );
  });

  it("keeps the last write of an activity, and moves its marker with it", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        activity("x1", "tool.started", { summary: "Running build", payload: { detail: "tsc -p" } }),
        activity("x1", "tool.completed", {
          summary: "Build finished",
          payload: { detail: "no errors", title: "Build" }
        }),
        compaction("c1", null, "compacting"),
        compaction("c1", null, "compaction-failed")
      )
    );
    await index.drain();

    assert.deepEqual(index.search({ q: "Running", limit: 5 }), []);
    const [build] = index.search({ q: "finished errors", limit: 5 });
    assert.equal(build!.id, "x1");
    assert.equal(build!.activityKind, "tool.completed");
    assert.equal(build!.seq, 3);
    const { items, markers } = inspect((db) => ({
      items: db.prepare("SELECT item_id, seq FROM items ORDER BY seq").all(),
      markers: db.prepare("SELECT seq, kind FROM markers").all()
    }));
    assert.deepEqual(items, [
      { item_id: "x1", seq: 3 },
      { item_id: "c1", seq: 5 }
    ]);
    assert.deepEqual(markers, [{ seq: 5, kind: "compaction-failed" }]);
  });

  it("a hidden goal progress row keeps its place in the log but never reaches the search", async () => {
    // Every progress row reads "Goal progress": indexing them flooded the
    // palette's search. Its POSITION is still indexed — history pages walk
    // rows by it — and its one stable id moves to the latest write, as any
    // row replaced in place does.
    const log = new TestLog();
    const goalRow = (id: string, change: string, rounds: number) =>
      activity(id, "goal.updated", {
        summary: change === "progress" ? "Goal progress" : "Goal set: Ship the parser rewrite",
        payload: { goal: { objective: "Ship the parser rewrite", status: "active", rounds }, change }
      });
    feed(
      index,
      log,
      log.append(
        created(),
        goalRow("g-set", "set", 0),
        goalRow("goal-progress:t1", "progress", 1),
        goalRow("goal-progress:t1", "progress", 2)
      )
    );
    await index.drain();

    assert.deepEqual(index.search({ q: "progress", limit: 5 }), []);
    const [set] = index.search({ q: "parser rewrite", limit: 5 });
    assert.equal(set!.id, "g-set", "only the row the timeline shows is searchable");
    const items = inspect((db) =>
      db.prepare("SELECT item_id, seq FROM items ORDER BY seq").all()
    );
    assert.deepEqual(items, [
      { item_id: "g-set", seq: 2 },
      { item_id: "goal-progress:t1", seq: 4 }
    ]);
    const ftsRows = inspect(
      (db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM activities_fts WHERE activity_id = 'goal-progress:t1'")
          .get() as { n: number }
    );
    assert.equal(ftsRows.n, 0);
  });

  it("leaves a marker exactly for the conversation's own compaction rows, either spelling, its phase as the kind", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(), // 1
        compaction("settled", null), // 2
        compaction("running", null, "compacting"), // 3
        compaction("failed", null, "compaction-failed"), // 4
        legacyCompaction("legacy", null), // 5
        activity("state", "thread.state.changed", { payload: { state: "running" } }), // 6
        subagentCompaction("on-row", null, { agentId: "sub-1", on: "row" }), // 7
        subagentCompaction("on-payload", null, { agentId: "sub-1", on: "payload" }), // 8
        // A blank agentId names no agent: the quiet-timeline rule trims it.
        activity("blank", "context-compaction", { payload: { state: "compacted" }, agentId: "  " }) // 9
      )
    );
    await index.drain();

    const { items, markers } = inspect((db) => ({
      items: db.prepare("SELECT item_id FROM items ORDER BY seq").all(),
      markers: db.prepare("SELECT seq, kind FROM markers ORDER BY seq").all()
    }));
    assert.deepEqual(markers, [
      { seq: 2, kind: "compacted" },
      { seq: 3, kind: "compacting" },
      { seq: 4, kind: "compaction-failed" },
      { seq: 5, kind: "compacted" },
      { seq: 9, kind: "compacted" }
    ]);
    // A row that leaves no marker is still indexed as an activity.
    assert.equal(items.length, 8);
  });

  it("a revert drops the removed turns and everything from their first line on, and closes every range", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created()));
    feed(index, log, log.append(...liveTurn({ n: 1, prompt: "prompt alpha" })));
    const secondStart = log.lastSeq + 1;
    feed(
      index,
      log,
      log.append(...liveTurn({ n: 2, prompt: "prompt bravo", extra: [compaction("cmp2", "t2")] }))
    );
    feed(index, log, log.append(...liveTurn({ n: 3, prompt: "prompt charlie" })));
    await index.drain();
    const firstBefore = turn(index, log.threadId, 1);
    assert.equal(firstBefore.endByte, log.at(secondStart).byteOffset);
    assert.equal(index.rewindable(log.threadId, firstBefore), false, "a compaction lies after it");

    const revert = log.append(reverted(1));
    const revertSeq = revert.events[0]!.seq;
    feed(index, log, revert);
    feed(index, log, log.append(activity("after", "info", { summary: "Rewound the thread" })));
    await index.drain();

    assert.equal(index.totalTurns(log.threadId), 1);
    assert.equal(index.turnById(log.threadId, "t2"), null);
    assert.deepEqual(turn(index, log.threadId, 1), firstBefore, "the survivor keeps its bytes");
    assert.equal(index.rewindable(log.threadId, firstBefore), true, "the compaction went with t2");
    assert.deepEqual(index.search({ q: "bravo", limit: 5 }), []);
    assert.deepEqual(index.search({ q: "charlie", limit: 5 }), []);
    assert.equal(index.search({ q: "alpha", limit: 5 }).length, 1);
    const rewound = index.search({ q: "Rewound", limit: 5 });
    assert.equal(rewound.length, 1, "rows after the revert are indexed");
    assert.equal(rewound[0]!.ordinal, null);
    assert.deepEqual(
      inspect((db) => db.prepare("SELECT item_id FROM items ORDER BY seq").all()),
      [{ item_id: "after" }]
    );

    // A restart right here must not reopen the survivor either.
    index.close();
    index = createThreadIndex({ filePath, logger });
    const fourthStart = log.lastSeq + 1;
    feed(index, log, log.append(...liveTurn({ n: 4, prompt: "prompt delta" })));
    await index.drain();

    assert.deepEqual(turn(index, log.threadId, 1), firstBefore);
    const fourth = turn(index, log.threadId, 2);
    assert.equal(fourth.turnId, "t4");
    assert.equal(fourth.firstSeq, fourthStart);
    assert.ok(fourth.firstByte > log.at(revertSeq).byteOffset, "the revert is nobody's");
    assert.equal(fourth.endByte, log.size);
  });

  it("thread.deleted removes every row of the thread", async () => {
    const log = new TestLog();
    const other = new TestLog("thread-2");
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "doomed words" })));
    feed(index, other, other.append(created(), ...liveTurn({ n: 1, prompt: "surviving words" })));
    feed(index, log, log.append(deleted()));
    await index.drain();

    assert.equal(index.cursor(log.threadId), null);
    assert.equal(index.totalTurns(log.threadId), 0);
    assert.deepEqual(
      index.search({ q: "words", limit: 5 }).map((hit) => hit.threadId),
      ["thread-2"]
    );
  });

  it("a restart mid-turn resumes the open turn from its rows", async () => {
    const single = new TestLog();
    const drafts = [
      created(),
      ...liveTurn({ n: 1, prompt: "one" }),
      ...liveTurn({ n: 2, prompt: "two" })
    ];
    // Split after turn 2's answer finished, before its settle and checkpoint.
    const split = drafts.length - 2;
    const before = single.append(...drafts.slice(0, split));
    const after = single.append(...drafts.slice(split));

    feed(index, single, before);
    await index.drain();
    index.close();
    index = createThreadIndex({ filePath, logger });
    feed(index, single, after);
    await index.drain();

    const reference = createThreadIndex({ filePath: join(dir, "reference.sqlite"), logger });
    reference.observe({ threadId: single.threadId, ...META, ...single.all() });
    await reference.drain();
    for (const ordinal of [1, 2]) {
      assert.deepEqual(turn(index, single.threadId, ordinal), turn(reference, single.threadId, ordinal));
    }
    assert.equal(turn(index, single.threadId, 2).endByte, single.size);
    reference.close();
  });

  it("a message's first line survives a restart in the middle of its stream", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), userMessage("u1", "go"), turnStart("u1")));
    feed(index, log, log.append(session("running", "t1"), delta("m1", "before the restart ", "t1")));
    await index.drain();
    index.close();
    index = createThreadIndex({ filePath, logger });
    feed(index, log, log.append(delta("m1", "after it", "t1"), done("m1", "t1")));
    await index.drain();

    assert.deepEqual(index.messageSpan(log.threadId, "m1"), {
      firstSeq: 5,
      firstByte: log.at(5).byteOffset,
      lastSeq: log.lastSeq
    });
  });

  it("a turn the provider never started leaves its rows with the turn before it", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "works" })));
    // A send the provider refused: its row never gets a turn id.
    feed(index, log, log.append(userMessage("u-failed", "refused words"), turnStart("u-failed")));
    feed(index, log, log.append(session("error")));
    feed(index, log, log.append(session("ready")));
    const thirdStart = log.lastSeq + 1;
    feed(index, log, log.append(...liveTurn({ n: 2, prompt: "works again" })));
    await index.drain();

    assert.equal(index.totalTurns(log.threadId), 2);
    assert.equal(turn(index, log.threadId, 1).endByte, log.at(thirdStart).byteOffset);
    assert.equal(turn(index, log.threadId, 2).firstSeq, thirdStart);
    const [refused] = index.search({ q: "refused", limit: 5 });
    assert.equal(refused!.turnId, null);
  });
});

// ---------------------------------------------------------------------------
// What a history page reads: `[turn.firstByte, turn.endByte)` of the log
// ---------------------------------------------------------------------------

function page(log: TestLog, of: IndexedTurn): DomainEvent[] {
  return log.slice(of.firstByte, of.endByte);
}

function holdsPrompt(events: DomainEvent[], messageId: string): boolean {
  return events.some(
    (event) =>
      event.type === "thread.message-sent" &&
      event.payload.role === "user" &&
      event.payload.messageId === messageId
  );
}

function holdsDiff(events: DomainEvent[], turnId: string): boolean {
  return events.some(
    (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId
  );
}

describe("thread index: page ranges", () => {
  it("a turn's range holds its prompt (appended before its row) and its checkpoint (appended after its settle)", async () => {
    const log = new TestLog();
    for (const batch of twoLiveTurns(log)) {
      feed(index, log, batch);
    }
    await index.drain();

    for (const [ordinal, prompt, turnId] of [
      [1, "u1", "t1"],
      [2, "u2", "t2"]
    ] as const) {
      const events = page(log, turn(index, log.threadId, ordinal));
      assert.equal(holdsPrompt(events, prompt), true, `turn ${ordinal}'s page holds ${prompt}`);
      if (turnId === "t1") {
        assert.equal(holdsDiff(events, turnId), true, "turn 1's page holds its diff");
      }
    }
    // The prompt is the FIRST line of the page; the settle is not the last.
    const first = page(log, turn(index, log.threadId, 1));
    assert.equal(first[0]!.seq, 2);
    assert.equal(first[first.length - 1]!.type, "thread.turn-diff-completed");
  });

  it("a capture that lands after the next turn began still falls inside its turn: ranges overlap", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created())); // 1
    feed(index, log, log.append(userMessage("u1", "first"), turnStart("u1"))); // 2, 3
    feed(index, log, log.append(session("running", "t1"))); // 4
    feed(index, log, log.append(done("a1", "t1", "answer one"))); // 5
    feed(index, log, log.append(session("ready", null, "t1"))); // 6
    // The user is quicker than the turn-end capture.
    feed(index, log, log.append(userMessage("u2", "second"), turnStart("u2"))); // 7, 8
    feed(index, log, log.append(session("running", "t2"))); // 9
    feed(index, log, log.append(checkpoint("t1", 1))); // 10 — names t1
    feed(
      index,
      log,
      log.append(activity("cap-1", "checkpoint.captured", { summary: "Checkpoint", turnId: "t1" }))
    ); // 11 — names t1
    feed(index, log, log.append(done("a2", "t2", "answer two"))); // 12
    feed(index, log, log.append(session("ready", null, "t2"))); // 13
    feed(index, log, log.append(checkpoint("t2", 2))); // 14
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    assert.deepEqual([first.firstSeq, first.lastSeq], [2, 11]);
    assert.equal(first.endByte, log.endOf(11));
    assert.deepEqual([second.firstSeq, second.lastSeq], [7, 14]);
    assert.ok(first.endByte > second.firstByte, "the late rows overlap turn 2's range");

    const firstPage = page(log, first);
    assert.equal(holdsPrompt(firstPage, "u1"), true, "turn 1's page holds its prompt");
    assert.equal(holdsDiff(firstPage, "t1"), true, "turn 1's page holds its late diff");
    assert.equal(
      firstPage.some(
        (event) =>
          event.type === "thread.activity-appended" && event.payload.activity.id === "cap-1"
      ),
      true,
      "turn 1's page holds its late capture row"
    );
    const secondPage = page(log, second);
    assert.equal(holdsPrompt(secondPage, "u2"), true, "turn 2's page holds its prompt");
    assert.equal(holdsDiff(secondPage, "t2"), true, "turn 2's page holds its diff");

    // Restart: the overlap and the open turn come back from the rows.
    index.close();
    index = createThreadIndex({ filePath, logger });
    feed(index, log, log.append(checkpoint("t1", 1))); // 15 — t1 again, still close by
    await index.drain();
    assert.equal(turn(index, log.threadId, 1).lastSeq, 15);
    assert.equal(turn(index, log.threadId, 2).lastSeq, 15, "the open turn grows too");
  });

  it("a capture that lands between the next prompt and the next turn's start stays with its turn", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created())); // 1
    feed(index, log, log.append(userMessage("u1", "first"), turnStart("u1"))); // 2, 3
    feed(index, log, log.append(session("running", "t1"))); // 4
    feed(index, log, log.append(done("a1", "t1", "answer one"))); // 5
    feed(index, log, log.append(session("ready", null, "t1"))); // 6
    feed(index, log, log.append(userMessage("u2", "second"), turnStart("u2"))); // 7, 8 — pending
    feed(index, log, log.append(checkpoint("t1", 1))); // 9 — t1 is still the open turn
    feed(
      index,
      log,
      log.append(activity("cap-1", "checkpoint.captured", { summary: "Checkpoint", turnId: "t1" }))
    ); // 10
    feed(index, log, log.append(session("running", "t2"))); // 11 — t2 starts: t1 is cut back…
    feed(index, log, log.append(done("a2", "t2", "answer two"), session("ready", null, "t2"))); // 12, 13
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    // …to its last own row, not to turn 2's prompt.
    assert.deepEqual([first.lastSeq, first.endByte], [10, log.endOf(10)]);
    assert.deepEqual([second.firstSeq, second.firstByte], [7, log.at(7).byteOffset]);
    const firstPage = page(log, first);
    assert.equal(holdsPrompt(firstPage, "u1"), true, "turn 1's page holds its prompt");
    assert.equal(holdsDiff(firstPage, "t1"), true, "turn 1's page holds its diff");
    assert.equal(holdsPrompt(page(log, second), "u2"), true, "turn 2's page holds its prompt");
  });

  it("an unknown prompt starts the turn at its row; a turn adopted from a session-set at that event", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(), // 1
        turnStart("never-sent"), // 2
        session("running", "t1"), // 3
        done("a1", "t1", "one"), // 4
        session("ready", null, "t1"), // 5
        // A continuation after a restart: no command, no pending row.
        session("running", "t-cont"), // 6
        done("a2", "t-cont", "continued"), // 7
        session("ready", null, "t-cont") // 8
      )
    );
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const continued = turn(index, log.threadId, 2);
    assert.equal(first.turnId, "t1");
    assert.deepEqual([first.firstSeq, first.firstByte], [2, log.at(2).byteOffset]);
    assert.equal(first.endByte, log.at(6).byteOffset);
    assert.equal(continued.turnId, "t-cont");
    assert.equal(continued.userMessageId, null);
    assert.deepEqual([continued.firstSeq, continued.firstByte], [6, log.at(6).byteOffset]);
  });

  it("nothing extends a range across a revert — not even a late event naming the turn", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "one" })));
    feed(index, log, log.append(...liveTurn({ n: 2, prompt: "two" })));
    await index.drain();
    const before = turn(index, log.threadId, 1);

    feed(index, log, log.append(reverted(1)));
    feed(index, log, log.append(checkpoint("t1", 1)));
    await index.drain();
    // …and the seal survives a restart.
    index.close();
    index = createThreadIndex({ filePath, logger });
    feed(
      index,
      log,
      log.append(activity("late", "checkpoint.captured", { summary: "Late", turnId: "t1" }))
    );
    await index.drain();

    const after = turn(index, log.threadId, 1);
    assert.deepEqual(after, before);
    assert.equal(
      page(log, after).some((event) => event.type === "thread.reverted"),
      false,
      "no page ever folds the revert"
    );
  });

  it("a late event far past the next turn's start does not stretch the earlier turn", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        ...liveTurn({ n: 1, prompt: "one", checkpoint: false }),
        userMessage("u2", "two"),
        turnStart("u2"),
        session("running", "t2"),
        // More than the bound of log between turn 2's prompt and the late row.
        done("big", "t2", "filler ".repeat(Math.ceil(MAX_LATE_REFERENCE_BYTES / 7) + 1)),
        activity("bg", "task.progress", { summary: "Background task still running", turnId: "t1" })
      )
    );
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    assert.equal(first.endByte, second.firstByte, "no overlap past the bound");
    assert.equal(second.endByte, log.size);
  });
});

// ---------------------------------------------------------------------------
// In flight: what the memory held that no `turns` row can
// ---------------------------------------------------------------------------

describe("thread index: in-flight turns across a memory loss", () => {
  /** The same log observed in one batch into a fresh file: nothing lost along the way. */
  async function referenceTurns(log: TestLog): Promise<IndexedTurn[]> {
    const reference = createThreadIndex({
      filePath: join(dir, `reference-${log.threadId}.sqlite`),
      logger
    });
    try {
      reference.observe({ threadId: log.threadId, ...META, ...log.all() });
      await reference.drain();
      return reference.turnsBefore(log.threadId, { before: null, limit: 1_000 });
    } finally {
      reference.close();
    }
  }

  function allTurns(target: ThreadIndex, threadId: string): IndexedTurn[] {
    return target.turnsBefore(threadId, { before: null, limit: 1_000 });
  }

  /** A host restart: the file stays, the memory goes. */
  function restart(): void {
    index.close();
    index = createThreadIndex({ filePath, logger });
  }

  function inflightOf(threadId: string): unknown {
    return inspect(
      (db) =>
        (db.prepare("SELECT inflight FROM threads WHERE thread_id = ?").get(threadId) as {
          inflight: unknown;
        }).inflight
    );
  }

  function writeInflight(threadId: string, value: unknown): void {
    const db = new Database(filePath);
    try {
      db.prepare("UPDATE threads SET inflight = ? WHERE thread_id = ?").run(value, threadId);
    } finally {
      db.close();
    }
  }

  it("a restart between a turn's request and its adoption keeps the turn at its prompt", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "first words" })));
    const request = log.append(userMessage("u2", "second words"), turnStart("u2"));
    const promptSeq = request.events[0]!.seq;
    feed(index, log, request);
    await index.drain();
    // What the restart finds: the pending turn, its range anchored at its prompt.
    assert.deepEqual(JSON.parse(String(inflightOf(log.threadId))), {
      pending: [
        {
          startedBefore: 1,
          requestedAt: stampAt(promptSeq + 1),
          userMessageId: "u2",
          span: {
            firstSeq: promptSeq,
            firstByte: log.at(promptSeq).byteOffset,
            lastSeq: promptSeq + 1,
            endByte: log.endOf(promptSeq + 1)
          }
        }
      ],
      prompts: []
    });

    restart();
    feed(
      index,
      log,
      log.append(
        session("running", "t2"),
        done("a2", "t2", "second answer"),
        session("ready", null, "t2"),
        checkpoint("t2", 2)
      )
    );
    await index.drain();

    const first = turn(index, log.threadId, 1);
    const second = turn(index, log.threadId, 2);
    assert.equal(second.turnId, "t2");
    assert.equal(second.userMessageId, "u2", "adopted, not minted at the session-set");
    assert.deepEqual([second.firstSeq, second.firstByte], [promptSeq, log.at(promptSeq).byteOffset]);
    assert.equal(first.endByte, log.at(promptSeq).byteOffset, "turn 1 stops at turn 2's prompt");
    assert.equal(holdsPrompt(page(log, first), "u2"), false, "turn 1's page does not swallow it");
    assert.equal(holdsPrompt(page(log, second), "u2"), true);
    assert.deepEqual(allTurns(index, log.threadId), await referenceTurns(log));
    assert.equal(inflightOf(log.threadId), "", "nothing is in flight once the turn started");
  });

  it("a prompt remembered before a restart still anchors the turn that claims it after", async () => {
    const log = new TestLog();
    // A replayed history turn: its prompt comes long before its row, minted at its end.
    feed(
      index,
      log,
      log.append(created(), userMessage("hu1", "old question", "h1"), done("ha1", "h1", "old answer"))
    );
    await index.drain();
    assert.deepEqual(JSON.parse(String(inflightOf(log.threadId))), {
      pending: [],
      prompts: [{ messageId: "hu1", seq: 2, byteOffset: log.at(2).byteOffset }]
    });

    restart();
    feed(index, log, log.append(replayedTurn("hu1", "h1", stampAt(3))));
    await index.drain();

    const only = turn(index, log.threadId, 1);
    assert.equal(only.userMessageId, "hu1");
    assert.deepEqual([only.firstSeq, only.firstByte], [2, log.at(2).byteOffset]);
    assert.deepEqual(allTurns(index, log.threadId), await referenceTurns(log));
  });

  it("queued turns survive restarts in order, and each adoption takes the oldest", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "first" })));
    const second = log.append(userMessage("u2", "second"), turnStart("u2"));
    const third = log.append(userMessage("u3", "third"), turnStart("u3"));
    feed(index, log, second);
    feed(index, log, third);
    await index.drain();
    const queued = JSON.parse(String(inflightOf(log.threadId))) as {
      pending: Array<{ userMessageId?: string; startedBefore: number }>;
    };
    assert.deepEqual(
      queued.pending.map((entry) => [entry.userMessageId, entry.startedBefore]),
      [
        ["u2", 1],
        ["u3", 1]
      ]
    );

    restart();
    feed(index, log, log.append(session("running", "t2")));
    await index.drain();
    const adopted = turn(index, log.threadId, 2);
    assert.equal(adopted.turnId, "t2");
    assert.equal(adopted.userMessageId, "u2");
    assert.equal(adopted.firstSeq, second.events[0]!.seq);

    // The one still queued survives a second loss too.
    restart();
    feed(
      index,
      log,
      log.append(
        done("a2", "t2", "second answer"),
        session("running", "t3"),
        done("a3", "t3", "third answer"),
        session("ready", null, "t3")
      )
    );
    await index.drain();
    const next = turn(index, log.threadId, 3);
    assert.equal(next.turnId, "t3");
    assert.equal(next.userMessageId, "u3");
    assert.equal(next.firstSeq, third.events[0]!.seq);
    assert.deepEqual(allTurns(index, log.threadId), await referenceTurns(log));
  });

  it("a turn requested before a replayed history keeps its place among the replayed turns", async () => {
    const log = new TestLog();
    // A resumed thread's first prompt is committed before the session that
    // replays the provider's history has opened.
    feed(index, log, log.append(created(), userMessage("u1", "live question"), turnStart("u1")));
    feed(
      index,
      log,
      log.append(
        userMessage("hu1", "old question", "h1"),
        done("ha1", "h1", "old answer"),
        replayedTurn("hu1", "h1", stampAt(5)),
        userMessage("hu2", "older question", "h2"),
        done("ha2", "h2", "older answer"),
        replayedTurn("hu2", "h2", stampAt(8))
      )
    );
    await index.drain();
    const queued = JSON.parse(String(inflightOf(log.threadId))) as {
      pending: Array<{ startedBefore: number }>;
    };
    assert.deepEqual(
      queued.pending.map((entry) => entry.startedBefore),
      [0],
      "before every replayed turn"
    );

    restart();
    feed(
      index,
      log,
      log.append(session("running", "t1"), done("a1", "t1", "live answer"), session("ready", null, "t1"))
    );
    await index.drain();

    // The fold numbers the adopted turn FIRST — it was requested first — and
    // `/revert` counts that way; appended after the history, every ordinal
    // would be off by one.
    assert.deepEqual(
      allTurns(index, log.threadId).map((row) => row.turnId),
      ["t1", "h1", "h2"]
    );
    assert.deepEqual(allTurns(index, log.threadId), await referenceTurns(log));
  });

  it("a turn that settled without ever starting is not kept, and moves no ordinal or range", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "works" })));
    feed(index, log, log.append(userMessage("u-stopped", "stopped words"), turnStart("u-stopped")));
    // Stopped before the provider started it: the pending row folds to interrupted.
    feed(index, log, log.append(session("stopped")));
    await index.drain();
    assert.equal(inflightOf(log.threadId), "", "nothing left in flight");

    restart();
    feed(index, log, log.append(session("ready"), ...liveTurn({ n: 2, prompt: "works again" })));
    await index.drain();

    assert.equal(index.totalTurns(log.threadId), 2);
    assert.deepEqual(allTurns(index, log.threadId), await referenceTurns(log));
  });

  it("an in-flight state that does not read back is ignored whole: an empty one, never a crash", async () => {
    const setup = (log: TestLog): { promptSeq: number } => {
      feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "first" })));
      const request = log.append(userMessage("u2", "second"), turnStart("u2"));
      feed(index, log, request);
      return { promptSeq: request.events[0]!.seq };
    };
    /** What this build writes for `setup`'s log, for the variants to break one field of. */
    const valid = (log: TestLog, promptSeq: number) => ({
      pending: [
        {
          startedBefore: 1,
          requestedAt: stampAt(promptSeq + 1),
          userMessageId: "u2",
          span: {
            firstSeq: promptSeq,
            firstByte: log.at(promptSeq).byteOffset,
            lastSeq: promptSeq + 1,
            endByte: log.endOf(promptSeq + 1)
          }
        }
      ],
      prompts: [] as unknown[]
    });
    type Valid = ReturnType<typeof valid>;
    const withTurn = (state: Valid, patch: Record<string, unknown>): string =>
      JSON.stringify({ ...state, pending: [{ ...state.pending[0]!, ...patch }] });
    const withSpan = (state: Valid, patch: Record<string, unknown>): string =>
      withTurn(state, { span: { ...state.pending[0]!.span, ...patch } });

    const variants: Array<[string, (state: Valid, log: TestLog) => unknown]> = [
      ["not JSON", () => '{"pending": ['],
      ["not an object", () => "[]"],
      ["not text at all", () => Buffer.from('{"pending":[],"prompts":[]}')],
      ["no arrays", () => '{"pending": {}, "prompts": []}'],
      ["a count of the wrong type", (state) => withTurn(state, { startedBefore: "1" })],
      ["a negative count", (state) => withTurn(state, { startedBefore: -1 })],
      ["an empty prompt id", (state) => withTurn(state, { userMessageId: "" })],
      ["a span past the cursor", (state, log) => withSpan(state, { lastSeq: log.lastSeq + 1 })],
      ["a span that ends before it starts", (state) => withSpan(state, { endByte: 0 })],
      [
        "pending turns out of order",
        (state) =>
          JSON.stringify({
            ...state,
            pending: [{ ...state.pending[0]!, startedBefore: 1 }, { ...state.pending[0]!, startedBefore: 0 }]
          })
      ],
      ["a prompt with no id", (state) => JSON.stringify({ ...state, prompts: [{ seq: 2, byteOffset: 0 }] })]
    ];

    for (const [name, corrupt] of variants) {
      const log = new TestLog(`corrupt ${name}`);
      const { promptSeq } = setup(log);
      await index.drain();
      index.close();
      writeInflight(log.threadId, corrupt(valid(log, promptSeq), log));
      logger.entries.length = 0;

      index = createThreadIndex({ filePath, logger });
      const adoption = log.append(session("running", "t2"), done("a2", "t2", "answer"));
      feed(index, log, adoption);
      await index.drain();

      // Exactly what the index did before the column existed: the adoption
      // found no pending row, so the fold minted the turn at the session-set.
      const second = index.turnByOrdinal(log.threadId, 2);
      assert.ok(second !== null, `${name}: the batch applied`);
      assert.equal(second.turnId, "t2", name);
      assert.equal(second.userMessageId, null, name);
      assert.equal(second.firstSeq, adoption.events[0]!.seq, name);
      assert.deepEqual(
        index.cursor(log.threadId),
        { lastSeq: log.lastSeq, lastByte: log.size },
        name
      );
      assert.equal(
        logger.entries.filter(
          (entry) => entry.level === "debug" && /unreadable in-flight state/.test(entry.message)
        ).length,
        1,
        `${name}: said once`
      );
      assert.deepEqual(
        logger.entries.filter((entry) => entry.level === "warn"),
        [],
        `${name}: not a failure`
      );
      assert.equal(inflightOf(log.threadId), "", `${name}: rewritten by the next batch`);
    }
  });
});

// ---------------------------------------------------------------------------
// Resident threads: the LRU over the per-thread memory
// ---------------------------------------------------------------------------

describe("thread index: resident threads", () => {
  interface Parts {
    indexer: ThreadIndexer;
    queries: ThreadIndexQueries;
    close(): void;
  }

  const parts: Parts[] = [];
  afterEach(() => {
    for (const part of parts.splice(0)) {
      part.close();
    }
  });

  /** The writer and the reads over one file, without the queue: `applyBatch` is synchronous. */
  function openParts(name: string): Parts {
    const opened = openIndexFile({ filePath: join(dir, name), driver: defaultSqliteDriver!, logger });
    assert.ok(opened !== null);
    const part: Parts = {
      indexer: createThreadIndexer({ db: opened.db, logger, clock: systemClock }),
      queries: createThreadIndexQueries(opened.db),
      close: () => opened.db.close()
    };
    parts.push(part);
    return part;
  }

  function apply(target: Parts, log: TestLog, batch: AppendedBatch): string {
    return target.indexer.applyBatch(
      { threadId: log.threadId, ...META },
      batch.events,
      batch.positions
    );
  }

  const ids = (logs: TestLog[]): string[] => logs.map((log) => log.threadId);
  const quietThread = (log: TestLog): AppendedBatch =>
    log.append(created(), ...liveTurn({ n: 1, prompt: `words of ${log.threadId}` }));

  it(`keeps at most ${MAX_RESIDENT_THREADS} quiet threads, dropping the least recently used first`, () => {
    const target = openParts("lru.sqlite");
    const logs = Array.from({ length: MAX_RESIDENT_THREADS + 2 }, (_, n) => new TestLog(`lru-${n}`));
    for (const log of logs.slice(0, MAX_RESIDENT_THREADS)) {
      apply(target, log, quietThread(log));
    }
    assert.deepEqual(target.indexer.residentThreadIds(), ids(logs.slice(0, MAX_RESIDENT_THREADS)));

    // One more: the least recently used goes.
    apply(target, logs[16]!, quietThread(logs[16]!));
    assert.deepEqual(target.indexer.residentThreadIds(), ids(logs.slice(1, 17)));

    // A batch makes its thread the most recently used…
    apply(target, logs[1]!, logs[1]!.append(...liveTurn({ n: 2, prompt: "again" })));
    assert.deepEqual(target.indexer.residentThreadIds(), [...ids(logs.slice(2, 17)), "lru-1"]);

    // …so the next newcomer pushes out the one after it.
    apply(target, logs[17]!, quietThread(logs[17]!));
    assert.deepEqual(target.indexer.residentThreadIds(), [
      ...ids(logs.slice(3, 17)),
      "lru-1",
      "lru-17"
    ]);

    // A batch that applies nothing still loads its thread — and keeps the bound.
    assert.equal(apply(target, logs[0]!, logs[0]!.all()), "noop");
    assert.deepEqual(target.indexer.residentThreadIds(), [
      ...ids(logs.slice(4, 17)),
      "lru-1",
      "lru-17",
      "lru-0"
    ]);
  });

  it("never drops a thread with a turn not started yet or a message mid-stream, however many pass", () => {
    const target = openParts("busy.sqlite");
    const waiting = new TestLog("waiting");
    const streaming = new TestLog("streaming");
    apply(target, waiting, waiting.append(created(), userMessage("u1", "go"), turnStart("u1")));
    apply(
      target,
      streaming,
      streaming.append(
        created(),
        userMessage("u1", "go"),
        turnStart("u1"),
        session("running", "t1"),
        delta("a1", "a streamed ans", "t1")
      )
    );

    const quiet = Array.from({ length: 3 * MAX_RESIDENT_THREADS }, (_, n) => new TestLog(`quiet-${n}`));
    for (const log of quiet) {
      apply(target, log, quietThread(log));
    }
    assert.deepEqual(target.indexer.residentThreadIds(), [
      "waiting",
      "streaming",
      ...ids(quiet.slice(-(MAX_RESIDENT_THREADS - 2)))
    ]);

    // When nothing else can go, the bound gives way: in-flight state is never dropped by count.
    const busy = Array.from({ length: MAX_RESIDENT_THREADS }, (_, n) => new TestLog(`busy-${n}`));
    for (const log of busy) {
      apply(target, log, log.append(created(), userMessage("u1", "go"), turnStart("u1")));
    }
    assert.deepEqual(target.indexer.residentThreadIds(), ["waiting", "streaming", ...ids(busy)]);

    // What that kept: the whole streamed text, and the turn's prompt.
    apply(target, streaming, streaming.append(delta("a1", "wer", "t1"), done("a1", "t1")));
    assert.deepEqual(
      target.queries.search({ q: "streamed answer", limit: 5 }).map((hit) => hit.id),
      ["a1"]
    );
    apply(target, waiting, waiting.append(session("running", "t1")));
    const adopted = target.queries.turnByOrdinal("waiting", 1);
    assert.equal(adopted?.userMessageId, "u1");
    assert.equal(adopted?.firstSeq, 2);
  });

  it("a thread dropped from memory reloads from its rows with nothing visible changed", () => {
    const target = openParts("evicted.sqlite");
    const kept = openParts("kept.sqlite");
    const log = new TestLog("evicted");
    const both = (batch: AppendedBatch): void => {
      apply(target, log, batch);
      apply(kept, log, batch);
    };
    const rows = (from: Parts): IndexedTurn[] =>
      from.queries.turnsBefore(log.threadId, { before: null, limit: 100 });

    both(log.append(created(), ...liveTurn({ n: 1, prompt: "first" })));
    // Mid-turn, but quiet: turn 2 running, its answer finished, nothing streaming.
    both(
      log.append(
        userMessage("u2", "second"),
        turnStart("u2"),
        session("running", "t2"),
        done("a2", "t2", "second answer")
      )
    );
    const before = rows(target);
    const beforeByOrdinal = [1, 2].map((ordinal) => target.queries.turnByOrdinal(log.threadId, ordinal));

    const others = Array.from({ length: MAX_RESIDENT_THREADS }, (_, n) => new TestLog(`other-${n}`));
    for (const other of others) {
      apply(target, other, quietThread(other));
    }
    assert.equal(target.indexer.residentThreadIds().includes(log.threadId), false, "dropped");

    // Touched again by a batch it already has: reloaded from its rows, unchanged.
    assert.equal(apply(target, log, log.all()), "noop");
    assert.equal(target.indexer.residentThreadIds().at(-1), log.threadId, "resident again");
    assert.deepEqual(rows(target), before);
    assert.deepEqual(
      [1, 2].map((ordinal) => target.queries.turnByOrdinal(log.threadId, ordinal)),
      beforeByOrdinal
    );

    // …and it goes on exactly as a thread that never left memory.
    both(
      log.append(
        activity("cap-2", "checkpoint.captured", { summary: "Checkpoint", turnId: "t2" }),
        session("ready", null, "t2"),
        checkpoint("t2", 2)
      )
    );
    both(log.append(...liveTurn({ n: 3, prompt: "third" })));
    assert.deepEqual(rows(target), rows(kept));
    assert.equal(rows(target).length, 3);
    assert.deepEqual(target.indexer.cursor(log.threadId), kept.indexer.cursor(log.threadId));
  });
});

// ---------------------------------------------------------------------------
// The text cap
// ---------------------------------------------------------------------------

describe("thread index: text cap", () => {
  const MAX = MAX_INDEXED_TEXT_CHARS;
  /** Two UTF-16 code units: a high surrogate, then a low one. */
  const PAIR = "😀";

  it("cuts at the cap, one unit short when the cut would split a surrogate pair", () => {
    assert.equal(capText("short"), "short");
    assert.equal(capText("a".repeat(MAX)), "a".repeat(MAX));
    assert.equal(capText(`${"a".repeat(MAX)}${PAIR}`), "a".repeat(MAX));
    assert.equal(capText(`${"a".repeat(MAX - 2)}${PAIR}tail`), `${"a".repeat(MAX - 2)}${PAIR}`);
    assert.equal(capText(`${"a".repeat(MAX - 1)}${PAIR}tail`), "a".repeat(MAX - 1));
  });

  it("never indexes half a surrogate pair — not even one a chunk boundary split at the cap", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        // Whole: the final text runs past the cap, a pair straddling it.
        done("whole", null, `${"b".repeat(MAX - 1)}${PAIR} and the rest`),
        // Streamed: the first chunk fills the cap with the pair's HIGH half; the
        // low half opens the next chunk.
        delta("streamed", `${"c".repeat(MAX - 1)}${PAIR.charAt(0)}`, null),
        delta("streamed", `${PAIR.charAt(1)} and the rest`, null),
        done("streamed", null),
        activity("act", "tool.completed", { summary: `${"d".repeat(MAX - 1)}${PAIR}` })
      )
    );
    await index.drain();

    const texts = inspect((db) => [
      ...(db.prepare("SELECT message_id AS id, text FROM messages_fts").all() as Array<{
        id: string;
        text: string;
      }>),
      ...(db.prepare("SELECT activity_id AS id, text FROM activities_fts").all() as Array<{
        id: string;
        text: string;
      }>)
    ]);
    assert.deepEqual(
      texts
        .map((row) => ({ id: row.id, length: row.text.length, replaced: row.text.includes("�") }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: "act", length: MAX - 1, replaced: false },
        { id: "streamed", length: MAX - 1, replaced: false },
        { id: "whole", length: MAX - 1, replaced: false }
      ]
    );
  });
});
