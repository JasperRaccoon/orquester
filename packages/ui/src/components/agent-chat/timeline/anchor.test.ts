import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { promptIdOfTurn, restoreTurnOf } from "./anchor";

const messageRow = (id: string, turnId: string | null): AgentChatTimelineRow =>
  ({ kind: "message", id, message: { id, turnId } }) as unknown as AgentChatTimelineRow;

const rows = [messageRow("a6", "t6"), messageRow("a7", "t7")];

test("a restore whose whole turn left the list pages that turn back in", () => {
  assert.equal(restoreTurnOf({ turnId: "t2" }, rows, undefined), "t2");
});

test("a turn the list still shows keeps the pixel offset", () => {
  assert.equal(restoreTurnOf({ turnId: "t7" }, rows, undefined), null);
});

test("nothing to page for a drill-in, an unpainted list, or a row of no remembered turn", () => {
  assert.equal(restoreTurnOf({ turnId: "t2" }, rows, "agent-1"), null);
  assert.equal(restoreTurnOf({ turnId: "t2" }, [], undefined), null);
  assert.equal(restoreTurnOf({}, rows, undefined), null);
});

test("a turn shown only by rows kept out of it, without its prompt, is paged back in too", () => {
  const kept = [messageRow("plan-2", "t2"), ...rows];
  const promptOf = (turnId: string) => (turnId === "t2" ? "u2" : null);
  assert.equal(restoreTurnOf({ turnId: "t2" }, kept, undefined, promptOf), "t2");
  assert.equal(restoreTurnOf({ turnId: "t2" }, [messageRow("u2", null), ...kept], undefined, promptOf), null);
  assert.equal(restoreTurnOf({ turnId: "t2" }, kept, undefined), null, "a turn without a known prompt keeps the offset");
});

test("the prompt of a turn, as the fold names it", () => {
  const turns = [{ turnId: "t1", userMessageId: "u1" }, { turnId: "t2" }] as never;
  assert.equal(promptIdOfTurn(turns, "t1"), "u1");
  assert.equal(promptIdOfTurn(turns, "t2"), null);
  assert.equal(promptIdOfTurn(turns, "t9"), null);
});
