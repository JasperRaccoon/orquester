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

import { createThreadIndex, type IndexedTurn, type ThreadIndex } from "./index.ts";

import {
  activity,
  checkpoint,
  compaction,
  created,
  deleted,
  delta,
  done,
  liveTurn,
  testLogger,
  replayedTurn,
  reverted,
  session,
  stampAt,
  TestLog,
  turnStart,
  userMessage,
  type AppendedBatch,
} from "./testing.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

let dir: string;
let filePath: string;
let logger: ReturnType<typeof testLogger>;
let index: ThreadIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-index-"));
  filePath = join(dir, "index.sqlite");
  logger = testLogger();
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
  });

  it("keeps the last searchable write of an activity", async () => {
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
        })
      )
    );
    await index.drain();

    assert.deepEqual(index.search({ q: "Running", limit: 5 }), []);
    const [build] = index.search({ q: "finished errors", limit: 5 });
    assert.equal(build!.id, "x1");
    assert.equal(build!.activityKind, "tool.completed");
    assert.equal(build!.seq, 3);
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

    const first = turn(index, single.threadId, 1);
    const second = turn(index, single.threadId, 2);
    assert.deepEqual([first.turnId, first.firstSeq, first.lastSeq], ["t1", 2, 9]);
    assert.deepEqual([second.turnId, second.firstSeq, second.lastSeq], ["t2", 10, 17]);
    assert.equal(first.endByte, second.firstByte);
    assert.equal(second.endByte, single.size);
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

    assert.deepEqual(index.messagesSpanning(log.threadId, 6), [{
      messageId: "m1",
      firstSeq: 5,
      firstByte: log.at(5).byteOffset,
      lastSeq: 7
    }]);
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

  it("a revert clips a surviving turn at the cut: a late event's stretch never brings the removed turns back", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created())); // 1
    feed(index, log, log.append(userMessage("u1", "first"), turnStart("u1"))); // 2, 3
    feed(index, log, log.append(session("running", "t1"))); // 4
    feed(index, log, log.append(done("a1", "t1", "answer one"))); // 5
    feed(index, log, log.append(session("ready", null, "t1"))); // 6
    feed(index, log, log.append(userMessage("u2", "second"), turnStart("u2"))); // 7, 8
    feed(index, log, log.append(session("running", "t2"))); // 9
    feed(index, log, log.append(done("a2", "t2", "answer two"))); // 10
    // A call a background agent started in t1 completes now, stamped with the
    // turn it started in: a late reference, which stretches t1 over t2.
    feed(
      index,
      log,
      log.append(activity("late", "tool.completed", { summary: "Command run", turnId: "t1", agentId: "agent-1" }))
    ); // 11
    feed(index, log, log.append(session("ready", null, "t2"))); // 12
    await index.drain();
    const second = turn(index, log.threadId, 2);
    assert.equal(turn(index, log.threadId, 1).lastSeq, 11, "stretched over t2's first lines");

    feed(index, log, log.append(reverted(1))); // 13
    await index.drain();
    const first = turn(index, log.threadId, 1);
    assert.deepEqual(
      [first.firstSeq, first.lastSeq, first.firstByte, first.endByte],
      [2, 6, log.at(2).byteOffset, second.firstByte],
      "t1 ends where t2 began"
    );
    const kept = page(log, first);
    assert.equal(holdsPrompt(kept, "u1"), true, "t1's page still holds its own prompt");
    assert.deepEqual(
      kept.filter((event) => event.seq >= second.firstSeq).map((event) => event.seq),
      [],
      "and nothing from t2's first line on"
    );

    // The clip is the stored row: a restart reads it back, and the seal holds.
    index.close();
    index = createThreadIndex({ filePath, logger });
    feed(index, log, log.append(activity("later", "checkpoint.captured", { summary: "Late", turnId: "t1" }))); // 14
    await index.drain();
    assert.deepEqual(turn(index, log.threadId, 1), first);
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
        done("big", "t2", "filler ".repeat(Math.ceil((2 * 1024 * 1024) / 7) + 1)),
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
  function allTurns(target: ThreadIndex, threadId: string): IndexedTurn[] {
    return target.turnsBefore(threadId, { before: null, limit: 1_000 });
  }

  /** A host restart: the file stays, the memory goes. */
  function restart(): void {
    index.close();
    index = createThreadIndex({ filePath, logger });
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

    restart();
    feed(index, log, log.append(replayedTurn("hu1", "h1", stampAt(3))));
    await index.drain();

    const only = turn(index, log.threadId, 1);
    assert.equal(only.userMessageId, "hu1");
    assert.deepEqual([only.firstSeq, only.firstByte], [2, log.at(2).byteOffset]);
  });

  it("queued turns survive restarts in order, and each adoption takes the oldest", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "first" })));
    const second = log.append(userMessage("u2", "second"), turnStart("u2"));
    const third = log.append(userMessage("u3", "third"), turnStart("u3"));
    feed(index, log, second);
    feed(index, log, third);
    await index.drain();

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
  });

  it("a turn that settled without ever starting is not kept, and moves no ordinal or range", async () => {
    const log = new TestLog();
    feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "works" })));
    feed(index, log, log.append(userMessage("u-stopped", "stopped words"), turnStart("u-stopped")));
    // Stopped before the provider started it: the pending row folds to interrupted.
    feed(index, log, log.append(session("stopped")));
    await index.drain();

    restart();
    feed(index, log, log.append(session("ready"), ...liveTurn({ n: 2, prompt: "works again" })));
    await index.drain();

    assert.equal(index.totalTurns(log.threadId), 2);
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
    }
  });
});

// ---------------------------------------------------------------------------
// Resident threads: the LRU over the per-thread memory
// ---------------------------------------------------------------------------

describe("thread index: resident threads", () => {
  it("never drops a thread with a turn not started yet or a message mid-stream, however many pass", async () => {
    const waiting = new TestLog("waiting");
    const streaming = new TestLog("streaming");
    feed(index, waiting, waiting.append(created(), userMessage("u1", "go"), turnStart("u1")));
    feed(index, streaming, streaming.append(created(), userMessage("u1", "go"), turnStart("u1"), session("running", "t1"), delta("a1", "a streamed ans", "t1")));
    for (let n = 0; n < 48; n++) {
      const log = new TestLog(`quiet-${n}`);
      feed(index, log, log.append(created(), ...liveTurn({ n: 1, prompt: "quiet" })));
    }
    for (let n = 0; n < 16; n++) {
      const log = new TestLog(`busy-${n}`);
      feed(index, log, log.append(created(), userMessage("u1", "go"), turnStart("u1")));
    }
    await index.drain();
    feed(index, streaming, streaming.append(delta("a1", "wer", "t1"), done("a1", "t1")));
    feed(index, waiting, waiting.append(session("running", "t1")));
    await index.drain();
    assert.deepEqual(index.search({ q: "streamed answer", limit: 5 }).map((hit) => hit.id), ["a1"]);
    const adopted = index.turnByOrdinal("waiting", 1);
    assert.equal(adopted?.userMessageId, "u1");
    assert.equal(adopted?.firstSeq, 2);
  });
});

// ---------------------------------------------------------------------------
// The text cap
// ---------------------------------------------------------------------------

describe("thread index: text cap", () => {
  const MAX = 131_072;
  const prefix = `${"x ".repeat((MAX - 8) / 2)}needle `;
  /** Two UTF-16 code units: a high surrogate, then a low one. */
  const PAIR = "😀";

  it("never indexes half a surrogate pair — not even one a chunk boundary split at the cap", async () => {
    const log = new TestLog();
    feed(
      index,
      log,
      log.append(
        created(),
        // Whole: the final text runs past the cap, a pair straddling it.
        done("whole", null, `${prefix}${PAIR} excluded`),
        // Streamed: the first chunk fills the cap with the pair's HIGH half; the
        // low half opens the next chunk.
        delta("streamed", `${prefix}${PAIR.charAt(0)}`, null),
        delta("streamed", `${PAIR.charAt(1)} excluded`, null),
        done("streamed", null),
        activity("act", "tool.completed", { summary: `${prefix}${PAIR}` })
      )
    );
    await index.drain();
    const hits = index.search({ q: "needle", limit: 5 });
    assert.deepEqual(hits.map((hit) => hit.id).sort(), ["act", "streamed", "whole"]);
    for (const hit of hits) {
      assert.equal(hit.snippet.includes("�"), false);
      assert.equal(hit.snippet.includes("😀"), false);
    }
    assert.deepEqual(index.search({ q: "excluded", limit: 5 }), []);
  });
});
