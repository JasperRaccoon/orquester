/**
 * Thread lineage — Claude's native fork (spec 2026-10-14 §6): the SDK's
 * `forkSession`, cut by turn id through the rewind planner, against a fake
 * history reader.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLAUDE_FORK_EMPTY_HISTORY, forkClaudeConversation } from "./fork.ts";
import type { ClaudeHistoryReader } from "./history.ts";
import type { ClaudeHistoryMessage } from "./rollback.ts";

const human = (uuid: string, text: string): ClaudeHistoryMessage => ({
  type: "user",
  uuid,
  parent_tool_use_id: null,
  message: { role: "user", content: text }
});
const reply = (uuid: string): ClaudeHistoryMessage => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content: [{ type: "text", text: uuid }] }
});

const TRANSCRIPT = [human("t1", "one"), reply("a1"), human("t2", "two"), reply("a2"), human("t3", "three"), reply("a3")];

function fakeHistory(messages: ClaudeHistoryMessage[] = TRANSCRIPT) {
  const forks: Array<{ sessionId: string; upToMessageId: string; cwd?: string }> = [];
  const history: ClaudeHistoryReader = {
    async readMessages() {
      return messages;
    },
    async fork(input) {
      forks.push(input);
      return { sessionId: "forked-session" };
    }
  };
  return { history, forks };
}

describe("forkClaudeConversation", () => {
  it("forks at the last message before the first removed turn", async () => {
    const { history, forks } = fakeHistory();
    const cursor = await forkClaudeConversation({
      history,
      cursor: { threadId: "parent", resume: "source-session" },
      threadId: "child",
      cwd: "/work/project",
      firstRemovedTurnId: "t3"
    });
    assert.deepEqual(forks, [{ sessionId: "source-session", upToMessageId: "a2", cwd: "/work/project" }]);
    // The child's minimal create-time cursor, never the parent's.
    assert.deepEqual(cursor, { threadId: "child", resume: "forked-session" });
  });

  it("resolves a turn through the cursor's boundary pairs after a rewind re-minted the uuids", async () => {
    const { history, forks } = fakeHistory([human("x1", "one"), reply("y1"), human("x2", "two"), reply("y2")]);
    await forkClaudeConversation({
      history,
      cursor: {
        threadId: "parent",
        resume: "source-session",
        turnBoundaries: [
          { turnId: "t1", uuid: "x1" },
          { turnId: "t2", uuid: "x2" }
        ]
      },
      threadId: "child",
      cwd: "/work/project",
      firstRemovedTurnId: "t2"
    });
    assert.equal(forks[0]!.upToMessageId, "y1");
  });

  it("copies the whole conversation when nothing is removed, up to a resume-at point", async () => {
    const { history, forks } = fakeHistory();
    await forkClaudeConversation({
      history,
      cursor: { threadId: "parent", resume: "s", resumeSessionAt: "a2" },
      threadId: "child",
      cwd: "/w",
      firstRemovedTurnId: null
    });
    assert.equal(forks[0]!.upToMessageId, "a2");
  });

  it("refuses a turn the transcript cannot place, before any fork exists", async () => {
    const { history, forks } = fakeHistory();
    await assert.rejects(
      forkClaudeConversation({
        history,
        cursor: { resume: "s" },
        threadId: "child",
        cwd: "/w",
        firstRemovedTurnId: "unknown"
      }),
      /boundary is unavailable/
    );
    assert.equal(forks.length, 0);
  });

  it("refuses an empty transcript", async () => {
    const { history } = fakeHistory([]);
    await assert.rejects(
      forkClaudeConversation({
        history,
        cursor: { resume: "s" },
        threadId: "child",
        cwd: "/w",
        firstRemovedTurnId: null
      }),
      new RegExp(CLAUDE_FORK_EMPTY_HISTORY.slice(0, 30))
    );
  });
});
