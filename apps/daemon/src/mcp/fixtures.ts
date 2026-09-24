import type { SessionSummary } from "@orquester/api";
import type { ThreadActivityItem, ThreadHead, ThreadMessageItem, ThreadSnapshotPayload, Turn } from "@orquester/api/agent-chat";

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
