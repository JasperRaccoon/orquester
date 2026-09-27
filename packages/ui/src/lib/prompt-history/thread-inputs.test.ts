import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  PendingApproval,
  ThreadHistoryBounds,
  ThreadHistoryPage,
  ThreadItem,
  Turn,
  TurnState
} from "@orquester/api/agent-chat";

import type { AgentChatActions, AgentChatTimelineRow } from "../agent-chat/contracts";
import type { AgentChatThreadState } from "../agent-chat/store";
import { activity, foldTurn, head, historyPage, message, resetBuilders } from "../agent-chat/test-helpers";
import { createHistoryThreadSelector } from "./thread-inputs";

beforeEach(() => resetBuilders());

const ACTIONS = {} as AgentChatActions;

function userRow(item: ThreadItem & { kind: "message" }, revertTurnCount?: number): AgentChatTimelineRow {
  return {
    kind: "message",
    id: item.id,
    createdAt: item.createdAt,
    message: item,
    durationStart: item.createdAt,
    showAssistantMeta: false,
    ...(revertTurnCount === undefined ? {} : { revertTurnCount })
  };
}

/** Only the fields the selector reads; the rest of the state is irrelevant to it. */
function threadState(input: {
  entries: ThreadItem[];
  turns: Turn[];
  rows: AgentChatTimelineRow[];
  turnStatus?: TurnState | null;
  approvals?: PendingApproval[];
  reverting?: boolean;
  withHead?: boolean;
  pages?: ThreadHistoryPage[];
  bridge?: ThreadItem[];
  bounds?: ThreadHistoryBounds | null;
}): AgentChatThreadState {
  return {
    slice: {
      head: input.withHead === false ? null : head({ refId: "codex", cwd: "/w/p/sub" }),
      entries: input.entries,
      turns: input.turns,
      checkpoints: CHECKPOINTS,
      pending: { approvals: input.approvals ?? [], userInputs: [] },
      turnStatus: input.turnStatus ?? "completed",
      history:
        input.pages === undefined && input.bridge === undefined && input.bounds === undefined
          ? HISTORY
          : {
              ...HISTORY,
              pages: input.pages ?? HISTORY.pages,
              bridge: input.bridge ?? HISTORY.bridge,
              bounds: input.bounds ?? null
            }
    },
    rows: input.rows,
    reverting: input.reverting ?? false,
    actions: ACTIONS
  } as unknown as AgentChatThreadState;
}

const CHECKPOINTS: never[] = [];
const HISTORY = {
  bounds: null,
  pages: [] as ThreadHistoryPage[],
  bridge: [] as ThreadItem[],
  windowCut: 0,
  windowEvicted: false,
  loading: false,
  error: null
};

describe("createHistoryThreadSelector", () => {
  it("hands back the same value while a turn's answer streams", () => {
    const select = createHistoryThreadSelector();
    const prompt = message("user", "do it", { id: "u1" });
    const turns = [foldTurn("t1", "u1")];
    const first = select(
      threadState({
        entries: [prompt, message("assistant", "Wor", { id: "a1", streaming: true })],
        turns,
        rows: [userRow(prompt, 0)],
        turnStatus: "running"
      })
    );
    const second = select(
      threadState({
        entries: [prompt, message("assistant", "Working", { id: "a1", streaming: true })],
        turns,
        rows: [userRow(prompt, 0)],
        turnStatus: "running"
      })
    );
    assert.equal(second, first);
    assert.deepEqual([first.hasHead, first.refId, first.cwd], [true, "codex", "/w/p/sub"]);
    assert.deepEqual(first.loaded.prompts.map((item) => item.messageId), ["u1"]);
    assert.equal(first.rewind.targets.get("u1"), 0);
    assert.equal(first.rewind.latestCompactionAt, null);
  });

  it("moves when what the panel shows moves: the turn settling, a request docking, a rewind", () => {
    const select = createHistoryThreadSelector();
    const prompt = message("user", "do it", { id: "u1" });
    const base = { entries: [prompt], turns: [foldTurn("t1", "u1")], rows: [userRow(prompt, 0)] };
    const running = select(threadState({ ...base, turnStatus: "running" }));
    assert.equal(running.busy.isTurnActive, true);
    const settled = select(threadState({ ...base, turnStatus: "completed" }));
    assert.notEqual(settled, running);
    assert.deepEqual(settled.busy, { isTurnActive: false, reverting: false, hasPendingRequest: false });
    const approval = { requestId: "r1", requestKind: "command", createdAt: prompt.createdAt } as PendingApproval;
    assert.equal(select(threadState({ ...base, approvals: [approval] })).busy.hasPendingRequest, true);
    assert.equal(select(threadState({ ...base, reverting: true })).busy.reverting, true);
  });

  it("reads no head as nothing to judge by yet", () => {
    const select = createHistoryThreadSelector();
    const inputs = select(threadState({ entries: [], turns: [], rows: [], withHead: false, turnStatus: null }));
    assert.deepEqual([inputs.hasHead, inputs.refId, inputs.cwd], [false, "", null]);
    assert.equal(inputs.busy.isTurnActive, false);
  });

  it("reads the settled compaction off the items and the loaded history, keeping it across tokens", () => {
    const select = createHistoryThreadSelector();
    const prompt = message("user", "go", { id: "u1" });
    const onPage = activity("context-compaction", { state: "compacted" }, { id: "c-page" });
    const pages = [historyPage({ items: [onPage] })];
    const turns = [foldTurn("t1", "u1")];
    const first = select(
      threadState({ entries: [prompt, message("assistant", "a", { id: "a1", streaming: true })], turns, rows: [], pages })
    );
    assert.equal(first.rewind.latestCompactionAt, onPage.createdAt, "a compaction only a page holds");
    const second = select(
      threadState({ entries: [prompt, message("assistant", "ab", { id: "a1", streaming: true })], turns, rows: [], pages })
    );
    assert.equal(second, first, "same facts: same value");
    const inWindow = activity("context-compaction", { state: "compacted" }, { id: "c-live", createdAt: "2026-02-01T00:00:00.000Z" });
    const third = select(threadState({ entries: [prompt, inWindow], turns, rows: [], pages }));
    assert.equal(third.rewind.latestCompactionAt, inWindow.createdAt, "the newest one wins");
  });

  it("reads the snapshot's word on the host's index", () => {
    const select = createHistoryThreadSelector();
    const bounds = (indexed: boolean): ThreadHistoryBounds => ({
      indexed,
      hasOlder: false,
      beforeCursor: null,
      oldestRetainedOrdinal: null,
      totalTurns: 0
    });
    assert.equal(select(threadState({ entries: [], turns: [], rows: [] })).historyIndexed, null);
    assert.equal(select(threadState({ entries: [], turns: [], rows: [], bounds: bounds(false) })).historyIndexed, false);
    assert.equal(select(threadState({ entries: [], turns: [], rows: [], bounds: bounds(true) })).historyIndexed, true);
  });
});
