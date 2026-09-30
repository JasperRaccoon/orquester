import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ThreadItem } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../agent-chat/contracts";
import { deriveTimelineEntriesFromItems } from "../agent-chat/entries.logic";
import { deriveTimelineRowsWithState } from "../agent-chat/rows.logic";
import { activity, foldTurn, historyPage, message, resetBuilders, stamp } from "../agent-chat/test-helpers";
import type { HistoryPrompt } from "./prompts.logic";
import {
  latestLoadedCompactionAt,
  promptRewindTarget,
  rowsRewindTargetsOf,
  runPromptRewind,
  type RevealResult,
  type RewindFacts,
  type RewindSnapshot
} from "./rewind.logic";

beforeEach(() => resetBuilders());

function facts(targets: Record<string, number | null>, latestCompactionAt: string | null = null): RewindFacts {
  return { targets: new Map(Object.entries(targets)), latestCompactionAt };
}

function historyPrompt(overrides: Partial<HistoryPrompt> = {}): HistoryPrompt {
  return {
    messageId: "u1",
    text: "prompt",
    truncated: false,
    turnId: "t1",
    turnOrdinal: 1,
    createdAt: stamp(10),
    source: "loaded",
    indexRewindable: null,
    ...overrides
  };
}

function rowsOf(items: ThreadItem[], turns = [foldTurn("t1", "u1")]): AgentChatTimelineRow[] {
  return deriveTimelineRowsWithState({
    timelineEntries: deriveTimelineEntriesFromItems(items, null).entries,
    isWorking: false,
    activeTurnStartedAt: null,
    turns,
    supportsConversationRollback: true
  }).rows;
}

const IDLE = { isTurnActive: false, reverting: false, hasPendingRequest: false };

describe("the compaction that bounds a rewind is read off the items, never the rows", () => {
  it("finds a compaction the settled turn's fold hides from the rows", () => {
    // A long turn the provider compacted in the middle of, then settled.
    const marker = activity("context-compaction", { state: "compacted" }, { id: "c1", turnId: "t1", tone: "info" });
    const items = [
      message("user", "a long job", { id: "u1" }),
      message("assistant", "working on it", { id: "a0", turnId: "t1" }),
      marker,
      activity("tool.completed", { itemType: "command_execution", command: "ls" }, { id: "x1", turnId: "t1" }),
      message("assistant", "done", { id: "a1", turnId: "t1" })
    ];
    const rows = rowsOf(items);
    const compactedAt = latestLoadedCompactionAt({ pages: [], bridge: [], entries: items });
    assert.equal(compactedAt, marker.createdAt, "the items still hold it");
    // So an index-only prompt from before it is not offered a rewind.
    const older = historyPrompt({
      messageId: "old",
      turnId: "t0",
      turnOrdinal: 1,
      source: "index",
      indexRewindable: true,
      createdAt: stamp(-5)
    });
    assert.equal(
      promptRewindTarget({
        prompt: older,
        facts: { targets: rowsRewindTargetsOf(rows), latestCompactionAt: compactedAt },
        rollbackSupported: true
      }),
      null
    );
  });

  it("takes the newest across the loaded pages, the bridge and the window", () => {
    const onPage = activity("context-compaction", { state: "compacted" }, { createdAt: stamp(10) });
    const inBridge = activity("context-compaction", { state: "compacted" }, { createdAt: stamp(30) });
    const inWindow = activity("context-compaction", { state: "compacted" }, { createdAt: stamp(20) });
    const pages = [historyPage({ items: [onPage] })];
    assert.equal(latestLoadedCompactionAt({ pages, bridge: [inBridge], entries: [inWindow] }), stamp(30));
    assert.equal(latestLoadedCompactionAt({ pages, bridge: [], entries: [inWindow] }), stamp(20));
    assert.equal(latestLoadedCompactionAt({ pages: [], bridge: [], entries: [] }), null);
  });
});

describe("promptRewindTarget", () => {
  it("reads a rendered prompt's verdict off its row", () => {
    const known = facts({ u1: 0, u2: null });
    assert.equal(promptRewindTarget({ prompt: historyPrompt(), facts: known, rollbackSupported: true }), 0);
    assert.equal(
      promptRewindTarget({
        prompt: historyPrompt({ messageId: "u2", turnOrdinal: 2 }),
        facts: known,
        rollbackSupported: true
      }),
      null,
      "the row withholds it"
    );
  });

  it("is never offered where the adapter cannot roll back, or for a prompt that started no turn", () => {
    const known = facts({ u1: 0 });
    assert.equal(promptRewindTarget({ prompt: historyPrompt(), facts: known, rollbackSupported: false }), null);
    assert.equal(
      promptRewindTarget({ prompt: historyPrompt({ turnOrdinal: null }), facts: known, rollbackSupported: true }),
      null
    );
  });

  it("vouches for an index-only prompt by its page's `rewindable`, unless a compaction came since", () => {
    const indexOnly = historyPrompt({
      messageId: "old",
      turnId: "t3",
      turnOrdinal: 3,
      source: "index",
      indexRewindable: true,
      createdAt: stamp(30)
    });
    assert.equal(promptRewindTarget({ prompt: indexOnly, facts: facts({}), rollbackSupported: true }), 2);
    assert.equal(
      promptRewindTarget({
        prompt: { ...indexOnly, indexRewindable: false },
        facts: facts({}),
        rollbackSupported: true
      }),
      null
    );
    assert.equal(
      promptRewindTarget({ prompt: indexOnly, facts: facts({}, stamp(40)), rollbackSupported: true }),
      null,
      "a compaction the chat holds after it"
    );
    assert.equal(
      promptRewindTarget({ prompt: indexOnly, facts: facts({}, stamp(20)), rollbackSupported: true }),
      2,
      "a compaction before it takes nothing away"
    );
    assert.equal(
      promptRewindTarget({
        prompt: { ...indexOnly, source: "loaded", indexRewindable: null },
        facts: facts({}),
        rollbackSupported: true
      }),
      null,
      "a loaded prompt the rows do not render has no verdict"
    );
  });
});

describe("runPromptRewind", () => {
  function harness(snapshots: RewindSnapshot[], options: { reveal?: RevealResult; rewindError?: Error } = {}) {
    const calls: string[] = [];
    let reads = 0;
    const run = (prompt: HistoryPrompt) =>
      runPromptRewind({
        prompt,
        read: () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
        revealTurn: async (turnId) => {
          calls.push(`reveal ${turnId}`);
          return options.reveal ?? { shown: true };
        },
        rewindTo: async (target) => {
          calls.push(`rewind ${target.messageId} ${target.targetTurnCount}`);
          if (options.rewindError) throw options.rewindError;
        }
      });
    return { calls, run };
  }

  const ready = (targets: Record<string, number | null>, busy = IDLE, isSending = false): RewindSnapshot => ({
    targets: new Map(Object.entries(targets)),
    busy,
    isSending,
    rollbackSupported: true
  });

  it("rewinds a rendered prompt to its row's count, without paging anything in", async () => {
    const { calls, run } = harness([ready({ u1: 0 })]);
    assert.deepEqual(await run(historyPrompt()), { ok: true });
    assert.deepEqual(calls, ["rewind u1 0"]);
  });

  it("brings an older prompt in first, then reads its count off the fresh rows", async () => {
    const { calls, run } = harness([ready({}), ready({ old: 4 })]);
    const outcome = await run(
      historyPrompt({ messageId: "old", turnId: "t5", turnOrdinal: 5, source: "index", indexRewindable: true })
    );
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(calls, ["reveal t5", "rewind old 4"]);
  });

  it("refuses when the reveal shows the turn but still not the prompt's row — no count the rows did not vouch for", async () => {
    const { calls, run } = harness([ready({}), ready({ other: 1 })]);
    assert.equal(
      (await run(historyPrompt({ messageId: "old", turnId: "t5", turnOrdinal: 5, source: "index", indexRewindable: true }))).ok,
      false
    );
    assert.deepEqual(calls, ["reveal t5"], "nothing posted");
  });

  it("says why the reveal could not bring the prompt in, or that its row withholds it", async () => {
    const tooFar = harness([ready({})], { reveal: { shown: false, reason: "outside the loaded window" } });
    assert.deepEqual(await tooFar.run(historyPrompt()), { ok: false, reason: "outside the loaded window" });
    assert.deepEqual(tooFar.calls, ["reveal t1"]);

    const gone = harness([ready({})], { reveal: { shown: false, reason: "message was removed" } });
    assert.deepEqual(await gone.run(historyPrompt()), { ok: false, reason: "message was removed" });

    const withheld = harness([ready({}), ready({ u1: null })]);
    assert.equal((await withheld.run(historyPrompt())).ok, false);
    assert.deepEqual(withheld.calls, ["reveal t1"]);
  });

  it("reads a reveal that threw as a history page that failed", async () => {
    const calls: string[] = [];
    const outcome = await runPromptRewind({
      prompt: historyPrompt(),
      read: () => ready({}),
      revealTurn: async () => {
        throw new Error("boom");
      },
      rewindTo: async () => {
        calls.push("rewind");
      }
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(calls, []);
  });

  it("waits for the agent to be idle — before it starts, and again after paging in", async () => {
    const busy = harness([ready({ u1: 0 }, { ...IDLE, isTurnActive: true })]);
    assert.equal((await busy.run(historyPrompt())).ok, false);
    assert.deepEqual(busy.calls, []);

    const late = harness([ready({}), ready({ u1: 0 }, { ...IDLE, hasPendingRequest: true })]);
    assert.equal((await late.run(historyPrompt())).ok, false);
    assert.deepEqual(late.calls, ["reveal t1"]);
  });

  it("waits for a composer send still on its way, read fresh at each step", async () => {
    // Its turn would start against the history the rewind is about to cut —
    // the composer picker's own rule (`rewindPickerEnabled`, §7.4).
    const sending = harness([ready({ u1: 0 }, IDLE, true)]);
    assert.equal((await sending.run(historyPrompt())).ok, false);
    assert.deepEqual(sending.calls, []);

    const late = harness([ready({}), ready({ u1: 0 }, IDLE, true)]);
    assert.equal((await late.run(historyPrompt())).ok, false);
    assert.deepEqual(late.calls, ["reveal t1"]);
  });

  it("never offers what the adapter cannot do, nor a prompt that started no turn", async () => {
    const unsupported = harness([{ ...ready({ u1: 0 }), rollbackSupported: false }]);
    assert.equal((await unsupported.run(historyPrompt())).ok, false);
    const steer = harness([ready({ u1: 0 })]);
    assert.equal((await steer.run(historyPrompt({ turnOrdinal: null }))).ok, false);
    assert.deepEqual([...unsupported.calls, ...steer.calls], []);
  });

  it("says why the rewind failed", async () => {
    const { run } = harness([ready({ u1: 0 })], { rewindError: new Error("The provider refused.") });
    assert.deepEqual(await run(historyPrompt()), { ok: false, reason: "The provider refused." });
  });
});
