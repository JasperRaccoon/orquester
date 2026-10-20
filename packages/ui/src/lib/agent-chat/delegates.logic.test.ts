import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { SessionSummary } from "@orquester/api";
import { DELEGATE_PREVIEW_CHARS, type ThreadItem } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import {
  delegateCallOf,
  delegateChildStatus,
  delegateChildView,
  delegateGroupLabel,
  delegateGroupTiming,
  delegatePillLabel,
  delegatePreviewText,
  delegatedChildrenOf,
  delegatesNeedingInput,
  delegateTabView,
  mergeDelegateRefs,
  summarizeDelegateStatuses,
  type DelegateChildRef
} from "./delegates.logic";
import { deriveTimelineEntriesFromItems, deriveWorkLogEntries, EMPTY_TIMELINE_PROJECTION } from "./entries.logic";
import { deriveTimelineRowsWithState, type TimelineRowsInput } from "./rows.logic";
import { activity, message, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

const tab = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    kind: "agent-chat",
    refId: "codex",
    title: `Task ${id}`,
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: "2026-10-20T10:00:00.000Z",
    lineage: { parentThreadId: "parent", relation: "delegate", createdAt: "2026-10-20T10:00:00.000Z", agentCreated: true },
    ...extra
  }) as SessionSummary;

/**
 * One `create_session` call as the host ingests it (slimmed: the references the UI reads kept at
 * `data.sessionTool.references`): its start, and — once it opened the chat — its completion.
 */
function createCall(
  callId: string,
  at: number,
  options: { delegate?: boolean; threadId?: string; relation?: "delegate" | "opened"; turnId?: string; prompt?: string; failed?: boolean } = {}
): ThreadItem[] {
  const input = { prompt: options.prompt ?? "Audit the parser", ...(options.delegate !== false ? { delegate: true } : {}) };
  const turnId = options.turnId ?? "t1";
  const started = activity(
    "tool.started",
    { itemType: "mcp_tool_call", toolUseId: callId, status: "inProgress", data: { sessionTool: { name: "create_session" }, input } },
    { turnId, createdAt: stamp(at) }
  );
  if (options.threadId === undefined && !options.failed) return [started];
  const status = options.failed ? "failed" : "completed";
  const references =
    options.threadId === undefined
      ? {}
      : { threadRef: { threadId: options.threadId, title: `Task ${options.threadId}`, relation: options.relation ?? "delegate" } };
  return [
    started,
    activity(
      "tool.completed",
      { itemType: "mcp_tool_call", toolUseId: callId, status, data: { sessionTool: { name: "create_session", references }, input } },
      { turnId, createdAt: stamp(at + 0.5), status }
    )
  ];
}

const rowsOf = (items: readonly ThreadItem[], overrides: Partial<TimelineRowsInput> = {}): AgentChatTimelineRow[] =>
  deriveTimelineRowsWithState({
    timelineEntries: deriveTimelineEntriesFromItems(items, EMPTY_TIMELINE_PROJECTION).entries,
    latestTurn: null,
    runningTurnId: null,
    isWorking: false,
    activeTurnStartedAt: null,
    supportsConversationRollback: false,
    ...overrides
  }).rows;

const groups = (rows: readonly AgentChatTimelineRow[]) =>
  rows.filter((row): row is Extract<AgentChatTimelineRow, { kind: "delegate-group" }> => row.kind === "delegate-group");

describe("the subagent strip's grouping", () => {
  it("collapses consecutive delegating calls of one turn into one group, each child once", () => {
    const rows = rowsOf([
      message("user", "Split the work", { turnId: "t1", createdAt: stamp(0) }),
      ...createCall("c1", 1, { threadId: "k1" }),
      ...createCall("c2", 2, { threadId: "k2" }),
      ...createCall("c3", 3, { threadId: "k3" })
    ]);
    const strip = groups(rows);
    assert.equal(strip.length, 1);
    assert.deepEqual(
      strip[0]!.children.map((child) => child.threadId),
      ["k1", "k2", "k3"]
    );
    // The generic "Opened a chat" rows are gone: the strip stands for them.
    assert.equal(rows.filter((row) => row.kind === "work" || row.kind === "work-toggle").length, 0);
  });

  it("splits groups at another tool call and across turns", () => {
    const rows = rowsOf([
      message("user", "Go", { turnId: "t1", createdAt: stamp(0) }),
      ...createCall("c1", 1, { threadId: "k1" }),
      activity("tool.completed", { itemType: "command_execution", command: "ls", status: "completed" }, { turnId: "t1", createdAt: stamp(2) }),
      ...createCall("c2", 3, { threadId: "k2" }),
      message("user", "Again", { turnId: "t2", createdAt: stamp(4) }),
      ...createCall("c3", 5, { threadId: "k3", turnId: "t2" })
    ]);
    assert.deepEqual(
      groups(rows).map((group) => group.children.map((child) => child.threadId)),
      [["k1"], ["k2"], ["k3"]]
    );
  });

  it("shows a delegating call still opening its chat as a starting child, and the same call once it opened it", () => {
    const running = { isWorking: true, runningTurnId: "t1", activeTurnStartedAt: stamp(0) } as const;
    const before = groups(rowsOf([message("user", "Go", { turnId: "t1", createdAt: stamp(0) }), ...createCall("c1", 1)], running));
    assert.equal(before.length, 1);
    assert.equal(before[0]!.children[0]!.threadId, null);
    assert.equal(before[0]!.children[0]!.title, "Task: Audit the parser");
    const after = groups(rowsOf([message("user", "Go", { turnId: "t1", createdAt: stamp(0) }), ...createCall("c1", 1, { threadId: "k1" })], running));
    assert.equal(after[0]!.children.length, 1);
    assert.equal(after[0]!.children[0]!.threadId, "k1");
  });

  it("leaves a plain create_session, and a failed delegating call, as ordinary tool rows", () => {
    const opened = rowsOf([message("user", "Go", { turnId: "t1", createdAt: stamp(0) }), ...createCall("c1", 1, { delegate: false, threadId: "k1", relation: "opened" })]);
    assert.equal(groups(opened).length, 0);
    const failed = rowsOf([message("user", "Go", { turnId: "t1", createdAt: stamp(0) }), ...createCall("c1", 1, { failed: true })]);
    assert.equal(groups(failed).length, 0);
  });

  it("keeps the strip visible after its turn settles (never hidden in the 'Worked for' fold)", () => {
    const items: ThreadItem[] = [
      message("user", "Go", { turnId: "t1", createdAt: stamp(0) }),
      activity("tool.completed", { itemType: "command_execution", command: "ls", status: "completed" }, { turnId: "t1", createdAt: stamp(1) }),
      ...createCall("c1", 2, { threadId: "k1" }),
      message("assistant", "Delegated.", { turnId: "t1", createdAt: stamp(3) })
    ];
    const rows = rowsOf(items, {
      latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(4) }
    });
    assert.ok(rows.some((row) => row.kind === "turn-fold"), "the turn folds its other work");
    assert.equal(groups(rows).length, 1);
  });

  it("reads delegate: true from the arguments however the provider lays them out", () => {
    const entryWith = (data: unknown) =>
      deriveWorkLogEntries([
        activity("tool.started", { itemType: "mcp_tool_call", toolUseId: "x", status: "inProgress", data }, { turnId: "t1" })
      ])[0]!;
    const marker = { sessionTool: { name: "create_session" } };
    assert.notEqual(delegateCallOf(entryWith({ ...marker, input: { delegate: true, title: "Docs" } })), null);
    assert.equal(delegateCallOf(entryWith({ ...marker, item: { arguments: JSON.stringify({ delegate: true, title: "Docs" }) } }))?.title, "Docs");
    assert.equal(delegateCallOf(entryWith({ ...marker, input: { prompt: "x" } })), null);
    // A partial stream of the arguments says nothing yet.
    assert.equal(delegateCallOf(entryWith({ ...marker, item: { arguments: '{"delegate": tr' } })), null);
  });

  it("merges a call's lifecycle rows into one child, its completed row winning", () => {
    const ref = (callId: string, threadId: string | null, title = "t"): DelegateChildRef => ({ entryId: callId, callId, threadId, title, createdAt: stamp(0) });
    assert.deepEqual(
      mergeDelegateRefs([ref("c1", null, "Task: x"), ref("c2", "k2"), ref("c1", "k1", "Task: x (open)")]).map((child) => [child.callId, child.threadId, child.title]),
      [
        ["c1", "k1", "Task: x (open)"],
        ["c2", "k2", "t"]
      ]
    );
  });
});

describe("a child's status and the group's summary", () => {
  const ref = (threadId: string | null): Pick<DelegateChildRef, "threadId"> => ({ threadId });

  it("reads each child's status off its tab", () => {
    assert.equal(delegateChildStatus(ref(null), undefined), "starting");
    assert.equal(delegateChildStatus(ref("k"), undefined), "closed");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { hasPendingUserInput: true, chatSessionStatus: "running" })), "needs-input");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { hasPendingApprovals: true })), "needs-input");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { chatPending: true })), "starting");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { chatSessionStatus: "running" })), "working");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { latestTurn: { turnId: "t", state: "running", startedAt: null, completedAt: null } })), "working");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { chatSessionStatus: "ready", latestTurn: { turnId: "t", state: "completed", startedAt: null, completedAt: null } })), "done");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { chatSessionStatus: "error" })), "failed");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { latestTurn: { turnId: "t", state: "interrupted", startedAt: null, completedAt: null } })), "stopped");
    assert.equal(delegateChildStatus(ref("k"), tab("k", { chatSessionStatus: "ready" })), "idle");
  });

  it('says "4 working · 1 done · 1 failed", what needs the user first', () => {
    assert.equal(summarizeDelegateStatuses(["working", "working", "starting", "working", "done", "failed"]), "4 working · 1 done · 1 failed");
    assert.equal(summarizeDelegateStatuses(["done", "needs-input", "working"]), "1 needs input · 1 working · 1 done");
    assert.equal(summarizeDelegateStatuses(["closed", "stopped"]), "1 stopped · 1 closed");
    assert.equal(summarizeDelegateStatuses([]), "");
    assert.equal(delegateGroupLabel(1), "1 subagent");
    assert.equal(delegateGroupLabel(3), "3 subagents");
  });

  it("times the group from its first start, live while any child works, to the latest end once none does", () => {
    const working = delegateGroupTiming([
      { status: "working", startedAt: "2026-10-20T10:00:05.000Z", endedAt: null },
      { status: "done", startedAt: "2026-10-20T10:00:01.000Z", endedAt: "2026-10-20T10:00:09.000Z" }
    ]);
    assert.deepEqual(working, { live: true, startedAt: "2026-10-20T10:00:01.000Z", endedAt: null });
    const settled = delegateGroupTiming([
      { status: "done", startedAt: "2026-10-20T10:00:01.000Z", endedAt: "2026-10-20T10:00:09.000Z" },
      { status: "failed", startedAt: "2026-10-20T10:00:02.000Z", endedAt: "2026-10-20T10:00:30.000Z" }
    ]);
    assert.deepEqual(settled, { live: false, startedAt: "2026-10-20T10:00:01.000Z", endedAt: "2026-10-20T10:00:30.000Z" });
  });

  it("counts the composer-side pill: 2/5 working, then 5 done", () => {
    assert.deepEqual(delegatePillLabel([{ status: "working" }, { status: "needs-input" }, { status: "done" }, { status: "done" }, { status: "failed" }]), {
      label: "2/5 working",
      live: true
    });
    assert.deepEqual(delegatePillLabel([{ status: "done" }, { status: "done" }, { status: "stopped" }, { status: "done" }, { status: "done" }]), {
      label: "5 done",
      live: false
    });
    assert.equal(delegatePillLabel([]), null);
  });
});

describe("a child's row", () => {
  it("cuts the live preview to one line of at most the preview length", () => {
    const long = `${"word ".repeat(120)}\n\nend`;
    const preview = delegatePreviewText(tab("k", { delegateView: { model: "gpt-5", preview: { kind: "progress", text: long, at: stamp(1) } } }));
    assert.ok(preview !== null);
    assert.ok(preview.length <= DELEGATE_PREVIEW_CHARS, `${preview.length} characters`);
    assert.ok(preview.endsWith("…"));
    assert.ok(!preview.includes("\n"));
    assert.equal(delegatePreviewText(tab("k", { delegateView: { model: null, preview: { kind: "result", text: "  Done:\n all good  ", at: stamp(1) } } })), "Done: all good");
    assert.equal(delegatePreviewText(tab("k", { delegateView: { model: null, preview: null } })), null);
    assert.equal(delegatePreviewText(tab("k")), null);
    assert.equal(delegatePreviewText(tab("k", { delegateView: { model: null, preview: { kind: "result", text: "abcdefghij", at: stamp(1) } } }), 6), "abcde…");
  });

  it("names a closed child by the call's title and an open one by its live tab", () => {
    const ref: DelegateChildRef = { entryId: "e", callId: "c", threadId: "k", title: "Task: from the call", createdAt: stamp(3) };
    const closed = delegateChildView(ref, undefined);
    assert.equal(closed.status, "closed");
    assert.equal(closed.title, "Task: from the call");
    assert.equal(closed.startedAt, stamp(3));
    assert.equal(closed.refId, null);
    const open = delegateChildView(ref, tab("k", { title: "Renamed", accountId: "acct-1", delegateView: { model: "gpt-5", preview: null } }));
    assert.equal(open.title, "Renamed");
    assert.equal(open.refId, "codex");
    assert.equal(open.model, "gpt-5");
    assert.equal(open.accountId, "acct-1");
  });
});

describe("the parent's delegated tabs", () => {
  it("lists only delegates of this parent, oldest first, and those waiting for their user", () => {
    const sessions = [
      tab("b", { lineage: { parentThreadId: "parent", relation: "delegate", createdAt: "2026-10-20T10:00:02.000Z" } }),
      tab("a", { lineage: { parentThreadId: "parent", relation: "delegate", createdAt: "2026-10-20T10:00:01.000Z" }, hasPendingUserInput: true }),
      tab("fork", { lineage: { parentThreadId: "parent", relation: "fork", createdAt: "2026-10-20T10:00:00.000Z" }, hasPendingUserInput: true }),
      tab("other", { lineage: { parentThreadId: "someone", relation: "delegate", createdAt: "2026-10-20T10:00:00.000Z" } })
    ];
    assert.deepEqual(delegatedChildrenOf(sessions, "parent").map((s) => s.id), ["a", "b"]);
    assert.deepEqual(delegatesNeedingInput(sessions, "parent").map((s) => s.id), ["a"]);
    assert.equal(delegateTabView(sessions[1]!).status, "needs-input");
  });
});
