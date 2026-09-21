import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeSubagent } from "@orquester/api";

import type { AgentChatTimelineRow, QueuedComposerMessage, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { deriveAgentSpawnSummary } from "../roster/spawn-summary";
import {
  compactionLabel,
  formatTokenCount,
  looksLikeUnifiedDiff,
  planFileName,
  proposedPlanTitle,
  queuedStatusLabel,
  rowBottomPadding,
  shouldClampUserMessage
} from "./row-format";
import { formatRowTimestamp, formatRowTimestampTooltip } from "./timestamp";

// ---------------------------------------------------------------------------
// Row rhythm
// ---------------------------------------------------------------------------

type MessageRow = Extract<AgentChatTimelineRow, { kind: "message" }>;

function messageRow(
  role: MessageRow["message"]["role"] = "assistant",
  showAssistantMeta = false
): MessageRow {
  return {
    kind: "message",
    id: "m1",
    createdAt: "2026-09-21T10:00:00.000Z",
    durationStart: "2026-09-21T10:00:00.000Z",
    showAssistantMeta,
    message: {
      kind: "message",
      id: "m1",
      role,
      text: "hi",
      turnId: "t1",
      streaming: false,
      createdAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:00:00.000Z"
    }
  };
}

test("activity rows cling together at 8px and conversation turns breathe at 16px", () => {
  // A stream of tool calls must read as one block of work.
  assert.equal(
    rowBottomPadding({
      kind: "activity-group",
      id: "g",
      createdAt: "",
      turnId: "t",
      groupId: "g",
      entries: [],
      expanded: false,
      active: false
    }),
    "pb-2"
  );
  assert.equal(rowBottomPadding({ kind: "thinking", id: "th", createdAt: null }), "pb-2");
  // …and a conversation turn breathes.
  assert.equal(rowBottomPadding(messageRow("user")), "pb-4");
});

test("an assistant message with a meta strip breathes; one without clings", () => {
  assert.equal(rowBottomPadding(messageRow("assistant", false)), "pb-2");
  assert.equal(rowBottomPadding(messageRow("assistant", true)), "pb-4");
});

test("an expanded group header has NO bottom padding, its members have 4px", () => {
  assert.equal(
    rowBottomPadding({
      kind: "work-toggle",
      id: "wt",
      createdAt: "",
      turnId: "t",
      groupId: "g",
      hiddenCount: 3,
      expanded: true,
      summary: "Read 3 files",
      summaryKind: "read",
      hasFailure: false
    }),
    "pb-0"
  );
  assert.equal(
    rowBottomPadding({
      kind: "work",
      id: "w",
      createdAt: "",
      groupedEntries: [],
      isExpandedToolGroup: true
    }),
    "pb-1"
  );
  assert.equal(
    rowBottomPadding({
      kind: "work",
      id: "w",
      createdAt: "",
      groupedEntries: [],
      isExpandedToolGroup: false
    }),
    "pb-2"
  );
});

test("a `/compact` submission takes the marker's spacing, not a bubble's", () => {
  // R2-4: it renders as a compaction marker (§4.6.5(b)), so a 16px
  // conversation gap around a hairline would read as a turn boundary.
  const row = messageRow("user");
  row.message.text = "/compact";
  assert.equal(rowBottomPadding(row), "pb-2");
  row.message.text = "/compact the thread";
  assert.equal(rowBottomPadding(row), "pb-4");
});

test("the turn fold and the working row sit at 6px", () => {
  assert.equal(
    rowBottomPadding({ kind: "turn-fold", id: "f", createdAt: "", turnId: "t", label: "Worked for 3s", expanded: false }),
    "pb-1.5"
  );
  assert.equal(rowBottomPadding({ kind: "working", id: "wk", createdAt: null }), "pb-1.5");
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test("a same-day stamp is just the clock time", () => {
  const now = new Date(2026, 8, 21, 18, 0, 0);
  const then = new Date(2026, 8, 21, 9, 5, 0);
  assert.equal(formatRowTimestamp(then.toISOString(), now), "09:05");
});

test("yesterday is named, an older day carries its date", () => {
  const now = new Date(2026, 8, 21, 18, 0, 0);
  assert.equal(formatRowTimestamp(new Date(2026, 8, 20, 9, 5).toISOString(), now), "Yesterday 09:05");
  assert.ok(formatRowTimestamp(new Date(2026, 8, 12, 9, 5).toISOString(), now).startsWith("12 "));
  assert.ok(formatRowTimestamp(new Date(2025, 8, 12, 9, 5).toISOString(), now).includes("2025"));
});

test("an unparseable stamp renders as nothing, never 'Invalid Date'", () => {
  assert.equal(formatRowTimestamp("not-a-date"), "");
  assert.equal(formatRowTimestamp(""), "");
  assert.equal(formatRowTimestampTooltip("nope"), "");
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

test("formatTokenCount", () => {
  assert.equal(formatTokenCount(840), "840");
  assert.equal(formatTokenCount(12_400), "12.4k");
  assert.equal(formatTokenCount(128_000), "128k");
  assert.equal(formatTokenCount(2000), "2k");
  assert.equal(formatTokenCount(Number.NaN), "0");
  assert.equal(formatTokenCount(-5), "0");
});

test("the compaction label carries before/after tokens when they are known", () => {
  assert.equal(
    compactionLabel({ label: "Compacted", beforeTokens: 128_000, afterTokens: 12_400 }),
    "Compacted · 128k → 12.4k tokens"
  );
  // An older row without the numbers still reads correctly.
  assert.equal(compactionLabel({ label: "Compacted" }), "Compacted");
  assert.equal(compactionLabel({ label: "Compacted", beforeTokens: 100 }), "Compacted");
});

// ---------------------------------------------------------------------------
// Plan card
// ---------------------------------------------------------------------------

test("the plan title comes from the first heading, then the first line", () => {
  assert.equal(proposedPlanTitle("## Ship the thing\n\nbody"), "Ship the thing");
  assert.equal(proposedPlanTitle("\n\nJust a line\nmore"), "Just a line");
  assert.equal(proposedPlanTitle("   "), "Proposed plan");
});

test("the plan file name is a slug of the title", () => {
  assert.equal(planFileName("# Ship the thing!"), "ship-the-thing.md");
  assert.equal(planFileName("***"), "plan.md");
});

// ---------------------------------------------------------------------------
// Queued ghost bubble
// ---------------------------------------------------------------------------

test("the queued chip names its own trigger", () => {
  assert.equal(queuedStatusLabel(true, true), "Waits for Send now");
  assert.equal(queuedStatusLabel(false, true), "Sends after the next tool call or when the turn ends");
  assert.equal(queuedStatusLabel(false, false), "Sends after the messages above it");
});

// ---------------------------------------------------------------------------
// User message clamp
// ---------------------------------------------------------------------------

test("a user message clamps past 8 lines or 600 characters", () => {
  assert.ok(!shouldClampUserMessage("short"));
  assert.ok(shouldClampUserMessage("x".repeat(601)));
  assert.ok(shouldClampUserMessage("a\n".repeat(9)));
  assert.ok(!shouldClampUserMessage("a\n".repeat(3)));
});

// ---------------------------------------------------------------------------
// Inline diff detection
// ---------------------------------------------------------------------------

test("looksLikeUnifiedDiff recognises a patch and rejects ordinary output", () => {
  assert.ok(looksLikeUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"));
  assert.ok(looksLikeUnifiedDiff("@@ -1,2 +1,3 @@\n a\n+b"));
  assert.ok(!looksLikeUnifiedDiff("Everything is fine\nno patch here"));
  assert.ok(!looksLikeUnifiedDiff(""));
});

// ---------------------------------------------------------------------------
// Spawn summary
// ---------------------------------------------------------------------------

function agent(over: Partial<RuntimeSubagent> = {}): Pick<RuntimeSubagent, "kind" | "status"> {
  return { kind: "subagent", status: "running", ...over } as Pick<RuntimeSubagent, "kind" | "status">;
}

test("a live batch reads as kicked off, a settled one as ran", () => {
  assert.equal(
    deriveAgentSpawnSummary({ agents: [agent(), agent()], agentCount: 2 }).lead,
    "Kicked off 2 subagents"
  );
  assert.equal(
    deriveAgentSpawnSummary({ agents: [agent({ status: "completed" })], agentCount: 1 }).lead,
    "Ran 1 subagent"
  );
});

test("the spawn status never reads a missing agent as completed", () => {
  assert.equal(deriveAgentSpawnSummary({ agents: [], agentCount: 3 }).status, "Status unavailable");
  assert.equal(
    deriveAgentSpawnSummary({ agents: [agent({ status: "completed" })], agentCount: 1 }).status,
    "✓ completed"
  );
  assert.equal(
    deriveAgentSpawnSummary({ agents: [agent({ status: "idle" })], agentCount: 1 }).status,
    "1 idle"
  );
});

test("a failed member tones the row failed; a running one tones it working", () => {
  assert.equal(
    deriveAgentSpawnSummary({ agents: [agent({ status: "failed" })], agentCount: 1 }).tone,
    "failed"
  );
  assert.equal(deriveAgentSpawnSummary({ agents: [agent()], agentCount: 1 }).tone, "working");
  assert.equal(deriveAgentSpawnSummary({ agents: [agent()], agentCount: 1 }).status, "1 working");
});

test("a workflow coordinator's own status wins over the member count", () => {
  const settledMembers = [agent({ status: "completed" }), agent({ status: "completed" })];
  // The coordinator keeps running between dynamic member launches.
  const live = deriveAgentSpawnSummary({
    agents: settledMembers,
    agentCount: 2,
    coordinatorStatus: "running"
  });
  assert.equal(live.live, true);
  assert.equal(live.status, "working");
  const failed = deriveAgentSpawnSummary({
    agents: settledMembers,
    agentCount: 2,
    coordinatorStatus: "failed"
  });
  assert.equal(failed.status, "Workflow failed");
  assert.equal(failed.tone, "failed");
});

// ---------------------------------------------------------------------------
// Type-level guards that the row model still fits what the rows read
// ---------------------------------------------------------------------------

test("the row model shapes the rows depend on are still present", () => {
  const entry: WorkLogEntry = {
    id: "a1",
    createdAt: "2026-09-21T10:00:00.000Z",
    turnId: "t1",
    label: "Read file",
    tone: "tool",
    truncated: true
  };
  assert.equal(entry.truncated, true);
  const queued: QueuedComposerMessage = {
    id: "q1",
    text: "hello",
    attachments: [],
    context: [],
    interactionMode: "default",
    queuedAfterToolActivityId: null,
    holdUntilUserAction: false,
    queuedAt: "2026-09-21T10:00:00.000Z"
  };
  assert.equal(queued.holdUntilUserAction, false);
});
