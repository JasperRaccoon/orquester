import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary, ThreadItem } from "@orquester/api";

import {
  defaultMergeBackText,
  lineageChildStatus,
  lineageChildren,
  lineageParent,
  lineageVerb
} from "./lineage.logic";

const tab = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, kind: "agent-chat", refId: "claude", title: id, projectPath: "/p", cwd: "/p", cols: 0, rows: 0, status: "running", order: 0, createdAt: "2026-10-14T00:00:00.000Z", ...extra }) as SessionSummary;

const msg = (id: string, role: "user" | "assistant", text: string, extra: Partial<ThreadItem> = {}): ThreadItem =>
  ({ kind: "message", id, role, text, turnId: "t", streaming: false, createdAt: "t", updatedAt: "t", ...extra }) as ThreadItem;

describe("lineage in the client", () => {
  const parent = tab("p");
  const fork1 = tab("f1", { lineage: { parentThreadId: "p", relation: "fork", createdAt: "2026-10-14T02:00:00.000Z" } });
  const task = tab("d1", { lineage: { parentThreadId: "p", relation: "delegate", createdAt: "2026-10-14T01:00:00.000Z" } });
  const sessions = [parent, fork1, task, tab("other")];

  it("finds the parent and the children, oldest first", () => {
    assert.equal(lineageParent(sessions, fork1.lineage)?.id, "p");
    assert.equal(lineageParent(sessions, undefined), null);
    assert.equal(lineageParent([fork1], fork1.lineage), null, "a closed parent");
    assert.deepEqual(lineageChildren(sessions, "p").map((s) => s.id), ["d1", "f1"]);
    assert.deepEqual(lineageChildren(sessions, "f1"), []);
  });

  it("words the relation and a child's status", () => {
    assert.equal(lineageVerb({ relation: "fork" }), "Forked from");
    assert.equal(lineageVerb({ relation: "delegate" }), "Delegated by");
    assert.equal(lineageChildStatus(tab("x", { chatSessionStatus: "running" })), "working");
    assert.equal(lineageChildStatus(tab("x", { hasPendingUserInput: true })), "needs input");
    assert.equal(lineageChildStatus(tab("x", { latestTurn: { turnId: "t", state: "completed", startedAt: null, completedAt: null } })), "done");
    assert.equal(lineageChildStatus(tab("x")), "new");
  });

  it("offers the last finished answer of the main conversation", () => {
    assert.equal(
      defaultMergeBackText([
        msg("u", "user", "q"),
        msg("a", "assistant", " the answer "),
        msg("c", "assistant", "next I will…", { messageKind: "commentary" }),
        msg("s", "assistant", "subagent", { agentId: "x" }),
        msg("w", "assistant", "still writing", { streaming: true })
      ]),
      "the answer"
    );
    assert.equal(defaultMergeBackText([msg("u", "user", "q")]), "");
  });
});
