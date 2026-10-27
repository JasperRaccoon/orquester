import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary, ThreadItem } from "@orquester/api";
import { NOTHING_STREAMS } from "@orquester/api/agent-chat";

import {
  ForkRetryKeys,
  defaultMergeBackText,
  lineageChildStatus,
  lineageChildren,
  lineageParent,
  lineageChildrenLabel,
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

  it("shows a child's work, pending input and settled status", () => {
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
      ], { sessionLive: true, activeTurnId: "t", activeAgentIds: new Set() }),
      "the answer"
    );
    assert.equal(defaultMergeBackText([msg("u", "user", "q")], NOTHING_STREAMS), "");
  });

  it("offers a reply whose stream a dead host or an ended turn left open", () => {
    const stale = [msg("u", "user", "q"), msg("a", "assistant", "left open", { streaming: true })];
    assert.equal(defaultMergeBackText(stale, NOTHING_STREAMS), "left open", "the session is not live");
    assert.equal(
      defaultMergeBackText(stale, { sessionLive: true, activeTurnId: "next", activeAgentIds: new Set() }),
      "left open",
      "its turn is not the running one"
    );
  });

  describe("fork retry keys", () => {
    const unknown = { status: 503 };
    const keep = (keys: ForkRetryKeys, sessionId: string, point: { messageId?: string; turnId?: string; role?: string }) => {
      const key = ForkRetryKeys.keyFor(sessionId, point);
      keys.settle(key, `cmd-${sessionId}-${point.messageId ?? "whole"}`, unknown);
      return key;
    };

    it("closing a fork forgets only the kept id of the point it was forked from", () => {
      const keys = new ForkRetryKeys();
      const fromM1 = keep(keys, "p", { messageId: "m1", turnId: "t1", role: "assistant" });
      const fromM2 = keep(keys, "p", { messageId: "m2", turnId: "t2", role: "assistant" });
      const whole = keep(keys, "p", {});
      keys.forgetTab({
        id: "child",
        lineage: { parentThreadId: "p", relation: "fork", forkedFrom: { messageId: "m1", turnId: "t1" }, createdAt: "x" }
      });
      assert.equal(keys.commandIdFor(fromM1, () => "fresh"), "fresh");
      assert.equal(keys.commandIdFor(fromM2, () => "fresh"), "cmd-p-m2");
      assert.equal(keys.commandIdFor(whole, () => "fresh"), "cmd-p-whole");
    });

    it("a fork with no recorded point forgets every kept id of its parent; a delegate forgets none", () => {
      const keys = new ForkRetryKeys();
      const fromM1 = keep(keys, "p", { messageId: "m1", turnId: "t1" });
      const whole = keep(keys, "p", {});
      const other = keep(keys, "q", {});
      keys.forgetTab({ id: "task", lineage: { parentThreadId: "p", relation: "delegate", createdAt: "x" } });
      assert.equal(keys.commandIdFor(whole, () => "fresh"), "cmd-p-whole");
      keys.forgetTab({ id: "child", lineage: { parentThreadId: "p", relation: "fork", createdAt: "x" } });
      assert.equal(keys.commandIdFor(whole, () => "fresh"), "fresh");
      assert.equal(keys.commandIdFor(fromM1, () => "fresh"), "fresh");
      assert.equal(keys.commandIdFor(other, () => "fresh"), "cmd-q-whole");
    });

    it("closing the parent forgets every kept id taken from it", () => {
      const keys = new ForkRetryKeys();
      const fromM1 = keep(keys, "p", { messageId: "m1", turnId: "t1" });
      const other = keep(keys, "q", { messageId: "m1", turnId: "t1" });
      keys.forgetTab({ id: "p" });
      assert.equal(keys.commandIdFor(fromM1, () => "fresh"), "fresh");
      assert.equal(keys.commandIdFor(other, () => "fresh"), "cmd-q-m1");
    });

  });
});

describe("opened chats (unified MCP §4.1)", () => {
  it("a parent counts its children by relation", () => {
    const child = (relation: "fork" | "delegate" | "opened") => ({ lineage: { parentThreadId: "p", relation, createdAt: "t" } }) as Pick<SessionSummary, "lineage">;
    assert.equal(lineageChildrenLabel([child("fork"), child("opened"), child("opened")]), "1 fork · 2 opened chats");
    assert.equal(lineageChildrenLabel([child("delegate")]), "1 task");
    // A newer daemon's relation is counted, in a neutral bucket.
    const future = { lineage: { parentThreadId: "p", relation: "adopted", createdAt: "t" } } as unknown as Pick<SessionSummary, "lineage">;
    assert.equal(lineageChildrenLabel([child("fork"), future, future]), "1 fork · 2 other chats");
  });
});
