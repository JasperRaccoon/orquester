import test from "node:test";
import assert from "node:assert/strict";

import type { SessionActivity, SessionSummary, WorkspaceSummary } from "@orquester/api";

import { deriveAgentSessions } from "./agent-sessions";

const workspaces = [{ name: "jaspersito", path: "/w/jaspersito" }] as unknown as WorkspaceSummary[];

const chat = (id: string, projectPath: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, kind: "agent-chat", refId: "claude", title: id, projectPath, status: "running", createdAt: "2026-10-24T10:00:00.000Z", ...extra }) as unknown as SessionSummary;

test("the Knowledge Graph indexer's worker chats are no project's agents: no row, no count, no waiting dot", () => {
  const sessions = [
    chat("user-chat", "/w/jaspersito/orquester"),
    chat("worker", "/appdir/plugins/knowledge-graph/workers", { owner: { kind: "knowledge-indexer", runId: "kr_1" } }),
    chat("workflow-chat", "/w/jaspersito/orquester", { owner: { kind: "workflow", workflowId: "wf", runId: "r", nodeId: "n" } })
  ];
  const waiting: SessionActivity = { state: "waiting", attention: "needs-input", needsAttentionAt: "2026-10-24T10:01:00.000Z" } as unknown as SessionActivity;
  const entries = deriveAgentSessions(sessions, workspaces, { worker: waiting, "user-chat": waiting });
  assert.deepEqual(entries.map((entry) => entry.session.id), ["user-chat", "workflow-chat"]);
});
