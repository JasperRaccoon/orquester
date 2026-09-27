import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ThreadItem, ThreadMessageItem } from "@orquester/api/agent-chat";

import { REWIND_BUSY_TITLE } from "../../components/agent-chat/composer/RewindControl";
import type { AgentChatTimelineRow } from "../agent-chat/contracts";
import { deriveTimelineEntriesFromItems } from "../agent-chat/entries.logic";
import { deriveTimelineRows } from "../agent-chat/rows.logic";
import { activity, foldTurn, historyPage, message, resetBuilders, stamp } from "../agent-chat/test-helpers";
import { createLoadedPromptsMemo, type HistoryPrompt } from "./prompts.logic";
import {
  CHAT_NOT_READY,
  createRewindTargetsMemo,
  latestLoadedCompactionAt,
  latestSettledCompactionAt,
  PROMPT_GONE,
  promptRewindTarget,
  revealMissReason,
  REWIND_NOT_OFFERED,
  REWIND_NOT_RENDERED,
  REWIND_WITHHELD,
  rewindBusyReason,
  rowsRewindTargetsOf,
  runPromptRewind,
  TURN_LOAD_FAILED,
  TURN_TOO_FAR_BACK,
  type RevealResult,
  type RewindFacts,
  type RewindSnapshot
} from "./rewind.logic";

beforeEach(() => resetBuilders());

function userRow(id: string, revertTurnCount?: number): AgentChatTimelineRow {
  const item: ThreadMessageItem = message("user", `text ${id}`, { id });
  return {
    kind: "message",
    id,
    createdAt: item.createdAt,
    message: item,
    durationStart: item.createdAt,
    showAssistantMeta: false,
    ...(revertTurnCount === undefined ? {} : { revertTurnCount })
  };
}

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
  return deriveTimelineRows({
    timelineEntries: deriveTimelineEntriesFromItems(items, null).entries,
    isWorking: false,
    activeTurnStartedAt: null,
    turns,
    supportsConversationRollback: true
  });
}

const IDLE = { isTurnActive: false, reverting: false, hasPendingRequest: false };

describe("rowsRewindTargetsOf", () => {
  it("reads every user message row's verdict", () => {
    const assistant: AgentChatTimelineRow = {
      kind: "message",
      id: "a1",
      createdAt: stamp(3),
      message: message("assistant", "answer", { id: "a1" }),
      durationStart: stamp(3),
      showAssistantMeta: true
    };
    const targets = rowsRewindTargetsOf([userRow("u1", 0), assistant, userRow("u2"), userRow("u3", 2)]);
    assert.deepEqual(Object.fromEntries(targets), { u1: 0, u2: null, u3: 2 });
  });

  it("hands the same map back until a verdict changes", () => {
    const memo = createRewindTargetsMemo();
    const first = memo([userRow("u1", 0), userRow("u2", 1)]);
    assert.equal(memo([userRow("u1", 0), userRow("u2", 1)]), first, "a new rows array, same verdicts");
    assert.notEqual(memo([userRow("u1", 0), userRow("u2")]), first);
  });
});

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
    assert.ok(rows.some((row) => row.kind === "turn-fold"), "the settled turn is folded");
    assert.ok(
      !rows.some((row) => row.kind === "context-compaction"),
      "the fold of the settled turn hides the marker from the rows"
    );
    const compactedAt = latestSettledCompactionAt(items);
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

  it("never takes a legacy state row that is not `compacted` for a compaction", () => {
    const running = activity("thread.state.changed", { state: "running" }, { id: "s1", tone: "info" });
    const compacted = activity("thread.state.changed", { state: "compacted" }, { id: "s2", tone: "info" });
    // The rows draw any legacy state row as a compaction divider…
    const rows = rowsOf([message("user", "go", { id: "u1" }), running]);
    assert.ok(rows.some((row) => row.kind === "context-compaction"), "the over-strict signal the rows give");
    // …the one rule does not.
    assert.equal(latestSettledCompactionAt([running]), null);
    assert.equal(latestSettledCompactionAt([running, compacted]), compacted.createdAt);
  });

  it("ignores a compaction still running, a failed one, and a subagent's own", () => {
    const items = [
      activity("context-compaction", { state: "compacting" }, { tone: "info" }),
      activity("context-compaction", { state: "compaction-failed" }, { tone: "error" }),
      activity("context-compaction", { state: "compacted" }, { tone: "info", agentId: "sub-1" })
    ];
    assert.equal(latestSettledCompactionAt(items), null);
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

describe("the count is the timeline's own", () => {
  it("equals the prompt's turn ordinal minus one — the number `/revert` keeps", () => {
    // Four started turns, one of them the agent's own, one prompt a steer.
    const items = [
      message("user", "first", { id: "u1" }),
      message("assistant", "one", { id: "a1", turnId: "t1" }),
      message("assistant", "the agent went on", { id: "a2", turnId: "t2" }),
      message("user", "second", { id: "u3" }),
      message("user", "a steer", { id: "s3", turnId: "t3" }),
      message("assistant", "three", { id: "a3", turnId: "t3" }),
      message("user", "third", { id: "u4" }),
      message("assistant", "four", { id: "a4", turnId: "t4" })
    ];
    const turns = [foldTurn("t1", "u1"), foldTurn("t2"), foldTurn("t3", "u3"), foldTurn("t4", "u4")];
    const verdicts = rowsRewindTargetsOf(rowsOf(items, turns));
    const prompts = createLoadedPromptsMemo()({ pages: [], bridge: [], entries: items, turns }).prompts;
    for (const prompt of prompts) {
      const fromRows = verdicts.get(prompt.messageId);
      if (prompt.turnOrdinal === null) {
        assert.equal(fromRows, null, `${prompt.messageId} opened no turn: no rewind`);
      } else {
        assert.equal(fromRows, prompt.turnOrdinal - 1, `${prompt.messageId}`);
      }
    }
    assert.deepEqual(
      prompts.map((prompt) => [prompt.messageId, prompt.turnOrdinal]),
      [
        ["u4", 4],
        ["s3", null],
        ["u3", 3],
        ["u1", 1]
      ]
    );
  });

  it("is withheld before a settled compaction, as the timeline withholds it", () => {
    const items = [
      message("user", "before", { id: "u1" }),
      message("assistant", "one", { id: "a1", turnId: "t1" }),
      activity("context-compaction", { state: "compacted" }, { id: "c1", turnId: null, tone: "info" }),
      message("user", "after", { id: "u2" }),
      message("assistant", "two", { id: "a2", turnId: "t2" })
    ];
    const verdicts = rowsRewindTargetsOf(rowsOf(items, [foldTurn("t1", "u1"), foldTurn("t2", "u2")]));
    assert.equal(verdicts.get("u1"), null);
    assert.equal(verdicts.get("u2"), 1);
    assert.notEqual(latestSettledCompactionAt(items), null);
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

describe("rewindBusyReason", () => {
  it("is the composer picker's own gate", () => {
    assert.equal(rewindBusyReason(IDLE), null);
    assert.equal(rewindBusyReason({ ...IDLE, isTurnActive: true }), REWIND_BUSY_TITLE);
    assert.equal(rewindBusyReason({ ...IDLE, reverting: true }), REWIND_BUSY_TITLE);
    assert.equal(rewindBusyReason({ ...IDLE, hasPendingRequest: true }), REWIND_BUSY_TITLE);
  });
});

describe("revealMissReason", () => {
  const known = [foldTurn("t1", "u1"), foldTurn("t2", "u2")];
  const miss = (over: Partial<Parameters<typeof revealMissReason>[0]>) =>
    revealMissReason({ turnId: "t1", connection: "synchronized", turns: known, historyError: null, ...over });

  it("says 'no longer in this chat' only when the fold no longer knows the turn", () => {
    assert.equal(miss({ turnId: "t-reverted" }), PROMPT_GONE);
    assert.notEqual(miss({}), PROMPT_GONE);
  });

  it("tells a turn too far back from a page that failed and a chat not connected", () => {
    assert.equal(miss({}), TURN_TOO_FAR_BACK, "past the reveal's page cap, or nothing older to page");
    assert.equal(
      miss({ historyError: "Older turns are unavailable on this host right now." }),
      "Older turns are unavailable on this host right now.",
      "the page's own words"
    );
    assert.equal(miss({ historyError: " " }), TURN_LOAD_FAILED);
    assert.equal(miss({ connection: "reconnecting" }), CHAT_NOT_READY);
    assert.equal(miss({ connection: "connecting", turnId: "t-reverted" }), CHAT_NOT_READY, "unsynced says so first");
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

  const ready = (targets: Record<string, number | null>, busy = IDLE): RewindSnapshot => ({
    targets: new Map(Object.entries(targets)),
    busy,
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
    assert.deepEqual(
      await run(historyPrompt({ messageId: "old", turnId: "t5", turnOrdinal: 5, source: "index", indexRewindable: true })),
      { ok: false, reason: REWIND_NOT_RENDERED }
    );
    assert.deepEqual(calls, ["reveal t5"], "nothing posted");
  });

  it("says why the reveal could not bring the prompt in, or that its row withholds it", async () => {
    const tooFar = harness([ready({})], { reveal: { shown: false, reason: TURN_TOO_FAR_BACK } });
    assert.deepEqual(await tooFar.run(historyPrompt()), { ok: false, reason: TURN_TOO_FAR_BACK });
    assert.deepEqual(tooFar.calls, ["reveal t1"]);

    const gone = harness([ready({})], { reveal: { shown: false, reason: PROMPT_GONE } });
    assert.deepEqual(await gone.run(historyPrompt()), { ok: false, reason: PROMPT_GONE });

    const withheld = harness([ready({}), ready({ u1: null })]);
    assert.deepEqual(await withheld.run(historyPrompt()), { ok: false, reason: REWIND_WITHHELD });
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
    assert.deepEqual(outcome, { ok: false, reason: TURN_LOAD_FAILED });
    assert.deepEqual(calls, []);
  });

  it("waits for the agent to be idle — before it starts, and again after paging in", async () => {
    const busy = harness([ready({ u1: 0 }, { ...IDLE, isTurnActive: true })]);
    assert.deepEqual(await busy.run(historyPrompt()), { ok: false, reason: REWIND_BUSY_TITLE });
    assert.deepEqual(busy.calls, []);

    const late = harness([ready({}), ready({ u1: 0 }, { ...IDLE, hasPendingRequest: true })]);
    assert.deepEqual(await late.run(historyPrompt()), { ok: false, reason: REWIND_BUSY_TITLE });
    assert.deepEqual(late.calls, ["reveal t1"]);
  });

  it("never offers what the adapter cannot do, nor a prompt that started no turn", async () => {
    const unsupported = harness([{ ...ready({ u1: 0 }), rollbackSupported: false }]);
    assert.deepEqual(await unsupported.run(historyPrompt()), { ok: false, reason: REWIND_NOT_OFFERED });
    const steer = harness([ready({ u1: 0 })]);
    assert.deepEqual(await steer.run(historyPrompt({ turnOrdinal: null })), {
      ok: false,
      reason: REWIND_NOT_OFFERED
    });
    assert.deepEqual([...unsupported.calls, ...steer.calls], []);
  });

  it("says why the rewind failed", async () => {
    const { run } = harness([ready({ u1: 0 })], { rewindError: new Error("The provider refused.") });
    assert.deepEqual(await run(historyPrompt()), { ok: false, reason: "The provider refused." });
  });
});
