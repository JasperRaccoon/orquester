import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Checkpoint } from "@orquester/api/agent-chat";

import { foldTurn, historyPage, stamp } from "../agent-chat/test-helpers";
import {
  checkpointRewindPrompt,
  checkpointsByTurnId,
  deriveCheckpointEntries,
  diffSummaryOf,
  filterCheckpointsBySearch,
  promptCheckpoint,
  readyCheckpoints
} from "./checkpoints.logic";
import { turnOrdinalsOf, type HistoryPrompt, type UnlistedPromptKind } from "./prompts.logic";

function checkpoint(
  turnId: string | null,
  turnCount: number,
  overrides: Partial<Checkpoint> = {}
): Checkpoint {
  return {
    turnId,
    checkpointTurnCount: turnCount,
    checkpointRef: `refs/orquester/checkpoints/x/turn/${turnCount}`,
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: stamp(turnCount * 10),
    ...overrides
  };
}

function prompt(messageId: string, turnId: string | null, turnOrdinal: number | null): HistoryPrompt {
  return {
    messageId,
    text: `prompt ${messageId}`,
    truncated: false,
    turnId,
    turnOrdinal,
    createdAt: stamp(1),
    source: "loaded",
    indexRewindable: null
  };
}

describe("readyCheckpoints", () => {
  it("lists only ready checkpoints, newest turn first", () => {
    const ready = readyCheckpoints([
      checkpoint("t1", 1),
      checkpoint("t2", 2, { status: "missing" }),
      checkpoint("t3", 3, { status: "error" }),
      checkpoint("t4", 4)
    ]);
    assert.deepEqual(
      ready.map((entry) => entry.turnId),
      ["t4", "t1"]
    );
  });

  it("adds the older ones only a loaded history page carries; the fold's copy wins", () => {
    const ready = readyCheckpoints(
      [checkpoint("t5", 5), checkpoint("t4", 4, { status: "error" })],
      [historyPage({ checkpoints: [checkpoint("t1", 1), checkpoint("t4", 4), checkpoint("t5", 5, { files: [] })] })]
    );
    assert.deepEqual(
      ready.map((entry) => entry.turnId),
      ["t5", "t1"],
      "a page's stale ready copy never overrides what the fold says now"
    );
  });
});

describe("the prompt's checkpoint", () => {
  const byTurn = checkpointsByTurnId(readyCheckpoints([checkpoint("t1", 1), checkpoint("t2", 2)]));

  it("is its turn's, for a prompt that started one", () => {
    assert.equal(promptCheckpoint(prompt("u1", "t1", 1), byTurn)?.checkpointTurnCount, 1);
  });

  it("is none for a steer — it rides a turn another prompt opened", () => {
    assert.equal(promptCheckpoint(prompt("s1", "t1", null), byTurn), null);
    assert.equal(promptCheckpoint(prompt("u9", null, null), byTurn), null);
  });
});

describe("diffSummaryOf", () => {
  it("counts files and sums the lines", () => {
    assert.deepEqual(
      diffSummaryOf([
        { path: "a.ts", additions: 3, deletions: 1 },
        { path: "b.png", additions: 0, deletions: 0 },
        { path: "c.ts", additions: 17, deletions: 3 }
      ]),
      { fileCount: 3, additions: 20, deletions: 4 }
    );
    assert.deepEqual(diffSummaryOf([]), { fileCount: 0, additions: 0, deletions: 0 });
  });
});

describe("deriveCheckpointEntries", () => {
  const turns = [
    foldTurn("t1", "u1"), // a listed prompt
    foldTurn("t2"), // started by the agent: no prompt at all
    foldTurn("t3", "internal"), // the CLI answering a task notification
    foldTurn("t4", "plan"), // Implement on a proposed plan
    foldTurn("t5", "old") // a prompt the list does not hold
  ];
  const unlisted = new Map<string, UnlistedPromptKind>([
    ["internal", "agent"],
    ["plan", "plan"]
  ]);
  const listed = prompt("u1", "t1", 1);

  it("names what opened each turn, newest first", () => {
    const entries = deriveCheckpointEntries({
      ready: readyCheckpoints([
        checkpoint("t1", 1, { files: [{ path: "a.ts", additions: 2, deletions: 0 }] }),
        checkpoint("t2", 2),
        checkpoint("t3", 3),
        checkpoint("t4", 4),
        checkpoint("t5", 5),
        checkpoint(null, 6)
      ]),
      turns,
      ordinals: turnOrdinalsOf(turns),
      prompts: [listed],
      unlisted
    });
    assert.deepEqual(
      entries.map((entry) => [entry.checkpoint.checkpointTurnCount, entry.origin.kind]),
      [
        [6, "unlisted"],
        [5, "unlisted"],
        [4, "plan"],
        [3, "agent"],
        [2, "agent"],
        [1, "prompt"]
      ]
    );
    const first = entries.at(-1)!;
    assert.equal(first.origin.kind === "prompt" ? first.origin.prompt : null, listed);
    assert.deepEqual(first.summary, { fileCount: 1, additions: 2, deletions: 0 });
    assert.equal(new Set(entries.map((entry) => entry.key)).size, entries.length, "keys are unique");
  });

  it("goes back to whichever user message opened the turn, and to none the agent opened", () => {
    const entries = deriveCheckpointEntries({
      ready: readyCheckpoints([
        checkpoint("t1", 1),
        checkpoint("t2", 2),
        checkpoint("t3", 3),
        checkpoint("t4", 4),
        checkpoint("t5", 5),
        checkpoint(null, 6)
      ]),
      turns,
      ordinals: turnOrdinalsOf(turns),
      prompts: [listed],
      unlisted
    });
    const openers = new Map(
      entries.map((entry) => [entry.checkpoint.checkpointTurnCount, checkpointRewindPrompt(entry.origin)])
    );
    assert.equal(openers.get(1), listed, "a listed prompt is its own opener");
    assert.equal(openers.get(2), null, "no prompt opened it");
    assert.equal(openers.get(3), null, "the CLI's own row is never gone back to");
    assert.equal(openers.get(6), null, "a checkpoint with no turn names no message");
    // The plan's Implement and a message the list does not hold: the rows
    // alone decide (a `loaded` opener, never vouched for by the index).
    for (const [count, messageId, turnId] of [
      [4, "plan", "t4"],
      [5, "old", "t5"]
    ] as const) {
      const opener = openers.get(count);
      assert.equal(opener?.messageId, messageId);
      assert.equal(opener?.turnId, turnId);
      assert.equal(opener?.turnOrdinal, count);
      assert.equal(opener?.source, "loaded");
      assert.equal(opener?.indexRewindable, null);
    }
  });

  it("numbers a card by its turn's ordinal, falling back to the checkpoint's own count", () => {
    const entries = deriveCheckpointEntries({
      // A legacy checkpoint numbered off by one from the turn it belongs to.
      ready: [checkpoint("t2", 7), checkpoint(null, 9)],
      turns,
      ordinals: turnOrdinalsOf(turns),
      prompts: [],
      unlisted
    });
    assert.deepEqual(
      entries.map((entry) => entry.turnNumber),
      [2, 9]
    );
  });
});

describe("filterCheckpointsBySearch", () => {
  it("matches the opening prompt and the changed paths together", () => {
    const turns = [foldTurn("t1", "u1"), foldTurn("t2")];
    const entries = deriveCheckpointEntries({
      ready: readyCheckpoints([
        checkpoint("t1", 1, { files: [{ path: "src/auth.ts", additions: 1, deletions: 0 }] }),
        checkpoint("t2", 2, { files: [{ path: "README.md", additions: 1, deletions: 0 }] })
      ]),
      turns,
      ordinals: turnOrdinalsOf(turns),
      prompts: [prompt("u1", "t1", 1)],
      unlisted: new Map()
    });
    const matching = (words: string[]) =>
      filterCheckpointsBySearch(entries, (text) => words.every((word) => text.toLowerCase().includes(word))).map(
        (entry) => entry.checkpoint.turnId
      );
    assert.deepEqual(matching(["prompt", "auth"]), ["t1"]);
    assert.deepEqual(matching(["readme"]), ["t2"]);
    assert.deepEqual(matching(["nothing"]), []);
  });
});
