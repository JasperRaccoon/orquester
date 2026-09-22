import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import {
  ROSTER_COLLAPSED_ROWS,
  isFinishedRow,
  isLiveBackgroundRow,
  rosterDisplayOrder,
  rosterRowTicks,
  rosterStatusVisual,
  selectRosterRows
} from "./roster-rows.ts";
import {
  agentActivityText,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  rosterRoleChip,
  rosterRowMetrics
} from "./format.ts";

function agent(
  id: string,
  overrides: Partial<RuntimeSubagent> & { status?: RuntimeSubagentStatus } = {}
): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    agentKind: "agent",
    title: id,
    role: null,
    model: null,
    effort: null,
    status: "running",
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

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 21, 10, 0, seconds)).toISOString();
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("display order is first-seen order and never moves when a status changes", () => {
  const agents = [
    agent("c", { firstSeenAt: at(3) }),
    agent("a", { firstSeenAt: at(1) }),
    agent("b", { firstSeenAt: at(2) })
  ];
  assert.deepEqual(
    rosterDisplayOrder(agents).map((row) => row.id),
    ["a", "b", "c"]
  );

  const settled = agents.map((row) =>
    row.id === "a" ? { ...row, status: "completed" as const, completedAt: at(9) } : row
  );
  assert.deepEqual(
    rosterDisplayOrder(settled).map((row) => row.id),
    ["a", "b", "c"]
  );
});

test("display order keeps incoming position for equal or unparseable stamps", () => {
  const agents = [
    agent("x", { firstSeenAt: "not-a-date" }),
    agent("y", { firstSeenAt: at(1) }),
    agent("z", { firstSeenAt: "not-a-date" })
  ];
  assert.deepEqual(
    rosterDisplayOrder(agents).map((row) => row.id),
    ["x", "y", "z"]
  );
});

// ---------------------------------------------------------------------------
// Collapse
// ---------------------------------------------------------------------------

test("rows past five collapse behind an N-more count", () => {
  const agents = Array.from({ length: 8 }, (_, index) =>
    agent(`a${index}`, { firstSeenAt: at(index) })
  );
  const collapsed = selectRosterRows({ agents, expanded: false, finished: "visible" });
  assert.equal(collapsed.rows.length, ROSTER_COLLAPSED_ROWS);
  assert.equal(collapsed.hiddenCount, 3);
  assert.deepEqual(
    collapsed.rows.map((row) => row.agent.id),
    ["a0", "a1", "a2", "a3", "a4"]
  );

  const expanded = selectRosterRows({ agents, expanded: true, finished: "visible" });
  assert.equal(expanded.rows.length, 8);
  assert.equal(expanded.hiddenCount, 0);
});

test("expanding only adds rows — it never reorders the ones already visible", () => {
  const agents = Array.from({ length: 9 }, (_, index) =>
    agent(`a${index}`, { firstSeenAt: at(index), status: index % 2 === 0 ? "completed" : "running" })
  );
  const collapsed = selectRosterRows({ agents, expanded: false, finished: "visible" });
  const expanded = selectRosterRows({ agents, expanded: true, finished: "visible" });
  assert.deepEqual(
    expanded.rows.slice(0, collapsed.rows.length).map((row) => row.agent.id),
    collapsed.rows.map((row) => row.agent.id)
  );
});

// ---------------------------------------------------------------------------
// The live-background exemption
// ---------------------------------------------------------------------------

test("a live background row renders past the cap, is not counted, and keeps its place", () => {
  const agents = [
    ...Array.from({ length: 6 }, (_, index) => agent(`a${index}`, { firstSeenAt: at(index) })),
    agent("bg", { firstSeenAt: at(3.5 * 2), agentKind: "background", status: "running" })
  ];
  // Place the background row in the middle of the stable order.
  agents[6] = { ...agents[6], firstSeenAt: at(2.5) };

  const collapsed = selectRosterRows({ agents, expanded: false, finished: "visible" });
  const ids = collapsed.rows.map((row) => row.agent.id);
  assert.ok(ids.includes("bg"), "the live background row is always rendered");
  // Five non-exempt rows plus the exempt one.
  assert.equal(collapsed.rows.filter((row) => !row.exempt).length, ROSTER_COLLAPSED_ROWS);
  assert.equal(collapsed.hiddenCount, 1);
  // Its neighbours are unchanged: it sits between a2 and a3 whether or not the
  // rest is collapsed.
  assert.deepEqual(ids, ["a0", "a1", "a2", "bg", "a3", "a4"]);

  const expanded = selectRosterRows({ agents, expanded: true, finished: "visible" });
  assert.deepEqual(
    expanded.rows.map((row) => row.agent.id),
    ["a0", "a1", "a2", "bg", "a3", "a4", "a5"]
  );
  assert.equal(
    expanded.rows.findIndex((row) => row.agent.id === "bg"),
    3,
    "showing the rest does not move the exempt row"
  );
});

test("a settled background row is an ordinary row again", () => {
  const done = agent("bg", { agentKind: "background", status: "completed" });
  assert.equal(isLiveBackgroundRow(done), false);
  assert.equal(isFinishedRow(done), true);
  const selection = selectRosterRows({ agents: [done], expanded: false, finished: "removed" });
  assert.equal(selection.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Fade on turn end
// ---------------------------------------------------------------------------

test("finished rows fade, then disappear, while live and idle rows stay", () => {
  const agents = [
    agent("done", { firstSeenAt: at(1), status: "completed" }),
    agent("failed", { firstSeenAt: at(2), status: "failed" }),
    agent("idle", { firstSeenAt: at(3), status: "idle" }),
    agent("bg", { firstSeenAt: at(4), agentKind: "background", status: "running" })
  ];

  const working = selectRosterRows({ agents, expanded: true, finished: "visible" });
  assert.equal(working.rows.length, 4);
  assert.ok(working.rows.every((row) => !row.fading));

  const fading = selectRosterRows({ agents, expanded: true, finished: "fading" });
  assert.deepEqual(
    fading.rows.filter((row) => row.fading).map((row) => row.agent.id),
    ["done", "failed"]
  );

  const gone = selectRosterRows({ agents, expanded: true, finished: "removed" });
  assert.deepEqual(
    gone.rows.map((row) => row.agent.id),
    ["idle", "bg"]
  );
});

test("removed rows free their slot instead of holding an N-more count over an empty list", () => {
  const agents = [
    ...Array.from({ length: 5 }, (_, index) =>
      agent(`done${index}`, { firstSeenAt: at(index), status: "completed" })
    ),
    agent("live", { firstSeenAt: at(9), status: "running" })
  ];
  const collapsed = selectRosterRows({ agents, expanded: false, finished: "removed" });
  assert.deepEqual(
    collapsed.rows.map((row) => row.agent.id),
    ["live"]
  );
  assert.equal(collapsed.hiddenCount, 0);
});

test("counts report the whole fold, not the visible slice", () => {
  const agents = [
    agent("a", { firstSeenAt: at(1), status: "running" }),
    agent("b", { firstSeenAt: at(2), status: "waiting" }),
    agent("c", { firstSeenAt: at(3), status: "completed" }),
    agent("d", { firstSeenAt: at(4), status: "idle" }),
    agent("e", { firstSeenAt: at(5), status: "running" }),
    agent("f", { firstSeenAt: at(6), status: "running" }),
    agent("g", { firstSeenAt: at(7), status: "failed" })
  ];
  const selection = selectRosterRows({ agents, expanded: false, finished: "visible" });
  assert.equal(selection.rows.length, ROSTER_COLLAPSED_ROWS);
  assert.equal(selection.totalCount, 7);
  assert.equal(selection.liveCount, 4);
  assert.equal(selection.finishedCount, 2);
  assert.equal(selection.hiddenCount, 2);
});

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

test("the three in-flight statuses present as one steady Working look", () => {
  for (const status of ["pending", "running", "waiting"] as const) {
    const visual = rosterStatusVisual(status);
    assert.equal(visual.label, "Working");
    assert.equal(visual.tone, "info");
    assert.equal(visual.pulse, true);
  }
});

test("idle reads as settled and muted, and stopped is not a failure", () => {
  assert.equal(rosterStatusVisual("idle").tone, "muted");
  assert.equal(rosterStatusVisual("idle").pulse, false);
  assert.equal(rosterStatusVisual("cancelled").label, "Stopped");
  assert.equal(rosterStatusVisual("interrupted").tone, "muted");
  assert.equal(rosterStatusVisual("completed").tone, "ok");
  assert.equal(rosterStatusVisual("failed").tone, "danger");
});

test("the ticker runs for running and waiting only", () => {
  assert.equal(rosterRowTicks("running"), true);
  assert.equal(rosterRowTicks("waiting"), true);
  assert.equal(rosterRowTicks("pending"), false);
  assert.equal(rosterRowTicks("completed"), false);
});

// ---------------------------------------------------------------------------
// Row text
// ---------------------------------------------------------------------------

test("activity text leads with progress while live and with the outcome once settled", () => {
  const live = agent("a", {
    status: "running",
    progress: "Reading files",
    lastToolName: "Grep",
    result: "done",
    error: "boom"
  });
  assert.equal(agentActivityText(live), "Reading files");
  assert.equal(agentActivityText({ ...live, progress: null }), "▸ Grep");
  assert.equal(agentActivityText({ ...live, progress: null, lastToolName: null }), "done");
  assert.equal(
    agentActivityText({ ...live, progress: null, lastToolName: null, result: null }),
    "boom"
  );

  const settled = { ...live, status: "failed" as const };
  assert.equal(agentActivityText(settled), "boom");
  assert.equal(agentActivityText({ ...settled, error: null }), "done");
  assert.equal(agentActivityText({ ...settled, error: null, result: null }), "Reading files");
  assert.equal(
    agentActivityText({ ...settled, error: null, result: null, progress: null }),
    "▸ Grep"
  );
  assert.equal(
    agentActivityText({
      ...settled,
      error: null,
      result: null,
      progress: null,
      lastToolName: null
    }),
    null
  );
});

test("token counts step from exact to k to M", () => {
  assert.equal(formatSubagentTokenCount(0), "0");
  assert.equal(formatSubagentTokenCount(999), "999");
  assert.equal(formatSubagentTokenCount(1_000), "1.0k");
  assert.equal(formatSubagentTokenCount(12_345), "12.3k");
  assert.equal(formatSubagentTokenCount(123_456), "123k");
  assert.equal(formatSubagentTokenCount(2_500_000), "2.5M");
  assert.equal(formatSubagentTokenCount(null), "0");
  assert.equal(formatSubagentTokenCount(Number.NaN), "0");
});

test("the model label strips provider noise and appends effort", () => {
  assert.equal(formatSubagentModelLabel("claude-opus-4-20250514", null), "opus-4");
  assert.equal(formatSubagentModelLabel("gpt-5-codex-latest", "high"), "gpt-5-codex · high");
  assert.equal(formatSubagentModelLabel(null, "high"), null);
});

test("metrics always hold the token slot so the row's shape cannot change", () => {
  assert.deepEqual(rosterRowMetrics({ model: null, effort: null, usage: null, activationCount: 1 }), [
    "— tok"
  ]);
  assert.deepEqual(
    rosterRowMetrics({
      model: "claude-sonnet-4-20250514",
      effort: null,
      usage: { totalTokens: 4_200, toolUses: 7 },
      activationCount: 3
    }),
    ["sonnet-4", "4.2k tok", "7 tools", "run 3"]
  );
});

test("the role chip is dropped when it repeats the title", () => {
  assert.equal(rosterRoleChip({ title: "Reviewer", role: "reviewer" }), null);
  assert.equal(rosterRoleChip({ title: "Reviewer", role: "  " }), null);
  assert.equal(rosterRoleChip({ title: "Find the bug", role: "explorer" }), "explorer");
});
