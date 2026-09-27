/**
 * What an empty drill-in says (§7.6, the controller's three tiers, as amended
 * in fix round 2): an agent's rows have LEFT the window only with evidence
 * that it had rows and the window dropped some — live or settled; otherwise a
 * live agent has not reported anything yet, and a settled one reads a neutral
 * line that is true whatever happened. A shell follows the same rule.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_LIFECYCLE_ITEM_TYPES, type CanonicalItemType, type RuntimeSubagent } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { createElement, type ReactElement } from "react";

import {
  didToolWork,
  drillInEmptyNotice,
  NON_TOOL_ITEM_TYPES,
  TIMELINE_NOTICE_KEY,
  timelineChildren,
  timelineSlots,
  type EmptyNotice
} from "./empty-notice";

function row(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "a1",
    kind: "subagent",
    agentKind: "agent",
    title: "Survey",
    role: null,
    model: null,
    effort: null,
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    exitCode: null,
    isBackgrounded: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-21T10:00:00.000Z",
    startedAt: "2026-09-21T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides
  };
}

const LIVE_ROWS: AgentChatTimelineRow[] = [
  { kind: "working", id: "working-indicator-row", createdAt: null },
  { kind: "thinking", id: "live-activity-row", createdAt: null }
];
const NOT_YET = "This agent has not reported anything yet.";
const LEFT = "Its earlier rows have left this thread's window.";
const NOTHING_HERE = "This agent reported nothing to show here.";
const SHELL_LEFT = "Its output has left this thread's window.";
const SHELL_NONE = "No output from this shell is in this thread.";

const text = (input: Parameters<typeof drillInEmptyNotice>[0]) => drillInEmptyNotice(input)?.text ?? null;

describe("drillInEmptyNotice: the three tiers", () => {
  it("a live agent with no rows has not reported anything yet — without the evidence that its rows left", () => {
    const live = row({ status: "running", lastToolName: "Bash", usage: { totalTokens: 9_000 } });
    assert.equal(text({ rows: LIVE_ROWS, agent: live, retentionDropped: false }), NOT_YET, "the window dropped nothing");
    assert.equal(
      text({ rows: LIVE_ROWS, agent: row({ status: "running" }), retentionDropped: true }),
      NOT_YET,
      "no tool work: nothing of its own to drop"
    );
    assert.equal(drillInEmptyNotice({ rows: LIVE_ROWS, agent: live, retentionDropped: false })?.at, 0, "above its working row");
  });

  it("a live agent whose rows the window dropped says so: both kinds of evidence, as for a settled one (fix round 2)", () => {
    const live = row({ status: "running", lastToolName: "Bash", usage: { totalTokens: 9_000 } });
    assert.equal(text({ rows: LIVE_ROWS, agent: live, retentionDropped: true }), LEFT);
    assert.equal(
      text({ rows: LIVE_ROWS, agent: row({ status: "waiting", usage: { totalTokens: 1, toolUses: 2 } }), retentionDropped: true }),
      LEFT,
      "a tool-use count is evidence too"
    );
    assert.equal(drillInEmptyNotice({ rows: LIVE_ROWS, agent: live, retentionDropped: true })?.at, 0, "still above its working row");
  });

  it("a live Codex child that has only reasoned: not yet (its thoughts are no rows)", () => {
    const codex = row({ status: "running", lastToolName: "reasoning" });
    assert.equal(text({ rows: LIVE_ROWS, agent: codex, retentionDropped: true }), NOT_YET);
  });

  it("a settled agent's rows LEFT only with evidence: the window dropped rows and it did real tool work", () => {
    assert.equal(text({ rows: [], agent: row({ lastToolName: "Bash" }), retentionDropped: true }), LEFT);
    assert.equal(
      text({ rows: [], agent: row({ usage: { totalTokens: 1, toolUses: 3 } }), retentionDropped: true }),
      LEFT,
      "a tool-use count is evidence too"
    );
  });

  it("no eviction, no claim that anything left", () => {
    assert.equal(text({ rows: [], agent: row({ lastToolName: "Bash" }), retentionDropped: false }), NOTHING_HERE);
  });

  it("a settled Codex child that only talked: its ticks name items, not tools — neutral", () => {
    for (const tick of ["assistant_message", "reasoning", "plan", "user_message", "unknown"]) {
      assert.equal(text({ rows: [], agent: row({ lastToolName: tick }), retentionDropped: true }), NOTHING_HERE, tick);
    }
  });

  it("stopped early, declined, or only its own hidden task rows: neutral, never 'left' nor 'not yet'", () => {
    for (const status of ["interrupted", "cancelled", "failed", "completed"] as const) {
      assert.equal(text({ rows: [], agent: row({ status }), retentionDropped: true }), NOTHING_HERE, status);
    }
    assert.equal(text({ rows: [], agent: undefined, retentionDropped: true }), NOTHING_HERE, "a row the roster dropped");
  });

  it("a shell follows the same rule", () => {
    const shell = (overrides: Partial<RuntimeSubagent> = {}) => row({ agentKind: "background", title: "npm run dev", ...overrides });
    assert.equal(text({ rows: [], agent: shell({ status: "running" }), retentionDropped: true }), "No output yet.");
    assert.equal(text({ rows: [], agent: shell({ status: "running", lastToolName: "Bash" }), retentionDropped: false }), "No output yet.");
    assert.equal(
      text({ rows: [], agent: shell({ status: "running", lastToolName: "Bash" }), retentionDropped: true }),
      SHELL_LEFT,
      "a live shell with both kinds of evidence: its output left (fix round 2)"
    );
    // A Grok shell owned by a subagent never had rows of its own; nothing says one left.
    assert.equal(text({ rows: [], agent: shell({ exitCode: 0, result: "ready" }), retentionDropped: true }), SHELL_NONE);
    assert.equal(text({ rows: [], agent: shell({ exitCode: 0 }), retentionDropped: false }), SHELL_NONE);
    assert.equal(text({ rows: [], agent: shell({ lastToolName: "Bash" }), retentionDropped: true }), SHELL_LEFT);
  });

  it("a shell with no roster row at all, known by its items, reads a shell's copy (final review C, M2)", () => {
    assert.equal(text({ rows: [], agent: undefined, retentionDropped: true, backgroundShell: true }), SHELL_NONE);
    assert.equal(text({ rows: [], agent: undefined, retentionDropped: true }), NOTHING_HERE, "no row and no word: an agent's");
  });

  it("a remembered row is never live: an agent the roster evicted while at work reads settled (final review C r1, m1)", () => {
    const running = row({ status: "running" });
    assert.equal(text({ rows: [], agent: running, retentionDropped: true, agentRemembered: true }), NOTHING_HERE);
    assert.equal(
      text({ rows: [], agent: row({ status: "running", lastToolName: "Bash" }), retentionDropped: true, agentRemembered: true }),
      LEFT,
      "its tool work is still evidence"
    );
    const shell = row({ agentKind: "background", title: "npm run dev", status: "running" });
    assert.equal(text({ rows: [], agent: shell, retentionDropped: true, agentRemembered: true }), SHELL_NONE, "never 'No output yet.'");
    assert.equal(text({ rows: [], agent: running, retentionDropped: true }), NOT_YET, "the roster's own running row is live");
  });

  it("a row of the agent's own is on screen: no notice at all", () => {
    const work: AgentChatTimelineRow = {
      kind: "work",
      id: "w1",
      createdAt: "2026-09-21T10:00:01.000Z",
      groupedEntries: [],
      isExpandedToolGroup: false
    };
    assert.equal(drillInEmptyNotice({ rows: [work], agent: row(), retentionDropped: true }), null);
  });
});

describe("every canonical item type is a tool or no tool, never both, never neither (surface re-review)", () => {
  it("the two sets partition the vocabulary", () => {
    // A record over the whole union: `pnpm check` names a member missing here.
    const everyItemType: Record<CanonicalItemType, true> = {
      user_message: true,
      assistant_message: true,
      reasoning: true,
      plan: true,
      command_execution: true,
      file_change: true,
      mcp_tool_call: true,
      dynamic_tool_call: true,
      collab_agent_tool_call: true,
      web_search: true,
      image_view: true,
      review_entered: true,
      review_exited: true,
      context_compaction: true,
      error: true,
      unknown: true
    };
    const tools: ReadonlySet<string> = new Set(TOOL_LIFECYCLE_ITEM_TYPES);
    for (const itemType of Object.keys(everyItemType)) {
      assert.notEqual(tools.has(itemType), NON_TOOL_ITEM_TYPES.has(itemType), `${itemType}: exactly one of the two`);
    }
    assert.equal(tools.size + NON_TOOL_ITEM_TYPES.size, Object.keys(everyItemType).length, "and nothing else in either");
  });
});

describe("didToolWork", () => {
  it("a real tool name, or a tool-use count", () => {
    assert.equal(didToolWork(row({ lastToolName: "Read" })), true);
    assert.equal(didToolWork(row({ lastToolName: "command_execution" })), true, "a Codex tool item is a tool");
    assert.equal(didToolWork(row({ usage: { totalTokens: 5, toolUses: 1 } })), true);
    assert.equal(didToolWork(row({ lastToolName: "assistant_message" })), false);
    assert.equal(didToolWork(row({ lastToolName: "  " })), false);
    assert.equal(didToolWork(row({ usage: { totalTokens: 5, toolUses: 0 } })), false);
    assert.equal(didToolWork(row()), false);
  });
});

describe("timelineSlots: the notice is spliced into ONE keyed list (surface review M2)", () => {
  const rows: AgentChatTimelineRow[] = [
    { kind: "working", id: "working-indicator-row", createdAt: null },
    { kind: "thinking", id: "live-activity-row", createdAt: null }
  ];
  const keys = (slots: ReturnType<typeof timelineSlots>) => slots.map((slot) => slot.key);

  it("the rows and the notice are siblings of one list, the notice at its place", () => {
    const slots = timelineSlots(rows, { text: "This agent has not reported anything yet.", at: 0 });
    assert.deepEqual(keys(slots), [TIMELINE_NOTICE_KEY, "working-indicator-row", "live-activity-row"]);
    // A row keeps its key whichever side of the notice it falls on, so crossing it never remounts it.
    const afterFirstRow = timelineSlots(rows, { text: "x", at: 1 });
    assert.deepEqual(keys(afterFirstRow), ["working-indicator-row", TIMELINE_NOTICE_KEY, "live-activity-row"]);
    assert.deepEqual(keys(timelineSlots(rows, { text: "x", at: 2 })), [...rows.map((row) => row.id), TIMELINE_NOTICE_KEY]);
  });

  it("no notice: the rows alone", () => {
    assert.deepEqual(keys(timelineSlots(rows, null)), rows.map((row) => row.id));
  });
});

describe("timelineChildren: with no notice the rows render directly, as the same keyed list (final review C, O1)", () => {
  const rowsOf = (count: number): AgentChatTimelineRow[] =>
    Array.from({ length: count }, (_, index) => ({ kind: "thinking", id: `row-${index}`, createdAt: null }) as AgentChatTimelineRow);
  const children = (rows: readonly AgentChatTimelineRow[], notice: EmptyNotice | null): ReactElement[] =>
    timelineChildren<ReactElement>(
      rows,
      notice,
      (row, key) => createElement("div", { key, "data-row": row.id }),
      (shown, key) => createElement("p", { key }, shown.text)
    );
  const keys = (elements: readonly ReactElement[]) => elements.map((element) => element.key);

  it("every row keeps its React key and its order whether a notice is on screen or not", () => {
    for (const count of [0, 1, 2, 7]) {
      const rows = rowsOf(count);
      const bare = keys(children(rows, null));
      assert.deepEqual(bare, rows.map((row) => row.id), `${count} rows, no notice: the rows' own ids, in order`);
      for (let at = 0; at <= count; at += 1) {
        const withNotice = keys(children(rows, { text: "x", at }));
        assert.deepEqual(
          withNotice.filter((key) => key !== TIMELINE_NOTICE_KEY),
          bare,
          `${count} rows, the notice at ${at}: the same keys, in the same order`
        );
        assert.equal(withNotice.indexOf(TIMELINE_NOTICE_KEY), at, "the notice at its place");
        assert.deepEqual(withNotice, timelineSlots(rows, { text: "x", at }).map((slot) => slot.key), "as the slots have them");
      }
    }
  });

  it("each row renders once, itself, and the notice with its own text", () => {
    const rows = rowsOf(3);
    const bare = children(rows, null);
    assert.deepEqual(bare.map((element) => (element.props as { "data-row": string })["data-row"]), ["row-0", "row-1", "row-2"]);
    const noticed = children(rows, { text: "No output yet.", at: 1 });
    assert.equal((noticed[1]!.props as { children: string }).children, "No output yet.");
  });
});
