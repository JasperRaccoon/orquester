/**
 * What an empty drill-in says (§7.6, the controller's three tiers): a live
 * agent has not reported anything yet; a settled one's rows have LEFT the
 * window only with evidence that it had rows and the window dropped some;
 * otherwise a neutral line that is true whatever happened. A shell follows the
 * same rule.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeSubagent } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { didToolWork, drillInEmptyNotice } from "./empty-notice";

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
  it("a live agent with no rows has not reported anything yet — whatever its roster row says", () => {
    const live = row({ status: "running", lastToolName: "Bash", usage: { totalTokens: 9_000 } });
    assert.equal(text({ rows: LIVE_ROWS, agent: live, retentionDropped: true }), NOT_YET);
    assert.equal(drillInEmptyNotice({ rows: LIVE_ROWS, agent: live, retentionDropped: false })?.at, 0, "above its working row");
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
    // A Grok shell owned by a subagent never had rows of its own; nothing says one left.
    assert.equal(text({ rows: [], agent: shell({ exitCode: 0, result: "ready" }), retentionDropped: true }), SHELL_NONE);
    assert.equal(text({ rows: [], agent: shell({ exitCode: 0 }), retentionDropped: false }), SHELL_NONE);
    assert.equal(text({ rows: [], agent: shell({ lastToolName: "Bash" }), retentionDropped: true }), SHELL_LEFT);
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
