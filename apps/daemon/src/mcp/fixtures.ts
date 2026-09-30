import type { SessionSummary } from "@orquester/api";
import type { RuntimeSubagent, ThreadActivityItem, ThreadHead, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";

let counter = 0;
/** Deterministic, strictly increasing ISO stamps: 2026-09-22T00:00:<n>Z. */
export const stamp = (n: number): string => new Date(Date.UTC(2026, 8, 22, 0, 0, n)).toISOString();

export function chatSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "c1", kind: "agent-chat", refId: "claude", title: "Claude Code", projectPath: "/w/acme/api", cwd: "/w/acme/api",
    cols: 0, rows: 0, status: "running", order: 1, createdAt: stamp(0),
    activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt: stamp(1) },
    chatSessionStatus: "ready", latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(0), completedAt: stamp(1) },
    hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false, backgroundLiveness: null,
    ...over
  } as SessionSummary;
}

export function shellSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "t1", kind: "shell", refId: "bash", title: "bash", projectPath: "/w/acme/api", cwd: "/w/acme/api",
    cols: 80, rows: 24, status: "running", order: 2, createdAt: stamp(0),
    activity: { state: "idle", attention: null, lastOutputAt: null, needsAttentionAt: null },
    ...over
  } as SessionSummary;
}

export function head(over: Partial<ThreadHead> = {}): ThreadHead {
  return {
    id: "c1", projectPath: "/w/acme/api", cwd: "/w/acme/api", title: "Claude Code", adapter: "claude", refId: "claude",
    accountId: "", home: "system", modelSelection: { model: "claude-fable-5-1[1m]", options: [{ id: "effort", value: "high" }] },
    runtimeMode: "full-access", session: { status: "ready", activeTurnId: null }, turnCount: 1, seq: 10,
    createdAt: stamp(0), updatedAt: stamp(1), ...over
  };
}

export function message(role: ThreadMessageItem["role"], text: string, over: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  counter += 1;
  return { kind: "message", id: `${role}:${counter}`, role, text, turnId: "t1", streaming: false, createdAt: stamp(counter), updatedAt: stamp(counter), ...over };
}

export function activity(activityKind: string, payload: unknown, over: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  counter += 1;
  return { kind: "activity", id: `${activityKind}:${counter}`, tone: "info", activityKind, summary: activityKind, payload, turnId: "t1", createdAt: stamp(counter), updatedAt: stamp(counter), ...over };
}

export function turn(over: Partial<Turn> = {}): Turn {
  return { turnId: "t1", state: "completed", turnCount: 1, requestedAt: stamp(0), startedAt: stamp(0), completedAt: stamp(1), assistantMessageId: null, ...over };
}

export function snapshot(over: Partial<ThreadSnapshotPayload> = {}): ThreadSnapshotPayload {
  return { head: head(), items: [], turns: [turn()], checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 10, ...over };
}

/** A roster row as the host folds it, every field present; `over` sets what a test is about. */
export function rosterAgent(id: string, over: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return { id, kind: "subagent", agentKind: "agent", title: id, role: null, model: "sonnet", effort: null, status: "completed", activationCount: 1, usage: null, progress: null, lastToolName: null, result: null, error: null, outputFile: null, exitCode: null,
    isBackgrounded: false, parentAgentId: null, agentIndex: null, phaseIndex: null, phaseTitle: null, attempt: null, workflowName: null, phases: [], runHandles: null, recentActivity: [], firstSeenAt: stamp(0), startedAt: stamp(0), completedAt: null, updatedAt: stamp(0), ...over };
}

/** The workflow run's coordinator task id in `workflowRoster`. */
export const WF = "wf-7";

/**
 * A Claude workflow run as the roster folds it, between two direct subagents: its coordinator (the run's whole usage,
 * two declared phases, run handles with host paths) and three agents — slot 1 completed on its second attempt, slot 2
 * failed, slot 3 still running in phase 2. `task-late` was first seen between the members.
 */
export function workflowRoster(): RuntimeSubagent[] {
  const member = (slot: number, phase: number, over: Partial<RuntimeSubagent>) => rosterAgent(`${WF}:wf:${slot}`, {
    kind: "workflow_agent", parentAgentId: WF, agentIndex: slot, phaseIndex: phase, phaseTitle: phase === 1 ? "Analyze" : "Synthesize", attempt: 1, firstSeenAt: stamp(10 + slot), startedAt: stamp(10 + slot), ...over
  });
  return [
    rosterAgent("task-early", { title: "Explore the repo", status: "completed", firstSeenAt: stamp(1), completedAt: stamp(2) }),
    rosterAgent(WF, { kind: "workflow", agentKind: "background", title: "Audit the frame pipeline", status: "running", workflowName: "frame-audit", model: null,
      phases: [{ index: 1, title: "Analyze" }, { index: 2, title: "Synthesize" }], runHandles: { runId: "run-3f9a", scriptPath: "/home/u/.claude/workflows/frame-audit.js", transcriptDir: "/home/u/.claude/projects/p/wf-7" },
      usage: { totalTokens: 90_000, toolUses: 41, durationMs: 120_000 }, firstSeenAt: stamp(10), startedAt: stamp(10) }),
    member(1, 1, { title: "analyze:fframes", attempt: 2, status: "completed", result: "Found 3 dropped frames in decoder.ts", usage: { totalTokens: 30_000, inputTokens: 20_000, toolUses: 12, durationMs: 40_000 }, completedAt: stamp(20) }),
    rosterAgent("task-late", { title: "Check the CI logs", status: "running", firstSeenAt: stamp(12) }),
    member(2, 1, { title: "analyze:audio", status: "failed", error: "Timed out reading the capture", usage: { totalTokens: 12_000, toolUses: 5, durationMs: 60_000 }, completedAt: stamp(21) }),
    member(3, 2, { title: "synthesize:report", status: "running", lastToolName: "Read", progress: "Merging findings", usage: { totalTokens: 8_000, toolUses: 3, durationMs: 9_000 } })
  ];
}
