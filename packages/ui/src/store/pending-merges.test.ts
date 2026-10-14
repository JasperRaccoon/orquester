/**
 * Thread lineage (spec 2026-10-14 §6): a tab's pending merges reach the store
 * through the ordinary `session.updated` path, and the daemon's clearing
 * update — `pendingMerges: []` — clears them there too (the store merges a
 * summary into the one it holds field by field, so a dropped key would leave
 * the last list and its buttons up).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { EventMessage, PendingMergeBack, ProjectSummary, SessionSummary } from "@orquester/api";

import { useAppStore } from "./app.ts";

const P = "/w/acme/app";
const store = () => useAppStore.getState();

const tab = (extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "fork", kind: "agent-chat", refId: "claude", title: "Fork", projectPath: P, cwd: P, cols: 0, rows: 0, status: "running", order: 0, createdAt: "t", ...extra }) as SessionSummary;

const updated = (summary: SessionSummary): EventMessage =>
  ({ id: `e-${Math.random()}`, channel: "sessions", type: "session.updated", createdAt: "t", payload: summary }) as EventMessage;

const merge: PendingMergeBack = {
  mergeId: "m1",
  parentSessionId: "parent",
  childSessionId: "fork",
  queuedAt: "t",
  state: "queued",
  preview: "B works",
  attempts: 0
};

beforeEach(() => {
  useAppStore.setState({
    currentProject: { path: P, name: "app" } as ProjectSummary,
    sessions: [tab()],
    activeTabByProject: {}
  });
});

describe("pending merges in the store", () => {
  it("arrive with a session update and are cleared by the next one's empty list", () => {
    store().applyEvent(updated(tab({ pendingMerges: [merge] })));
    assert.deepEqual(store().sessions[0]?.pendingMerges, [merge]);

    store().applyEvent(updated(tab({ pendingMerges: [] })));
    assert.deepEqual(store().sessions[0]?.pendingMerges, [], "the last merge's row goes away");
  });
});
