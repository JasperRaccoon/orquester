import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { restoreTurnOf } from "./anchor";

const messageRow = (id: string, turnId: string | null): AgentChatTimelineRow =>
  ({ kind: "message", id, message: { id, turnId } }) as unknown as AgentChatTimelineRow;

const rows = [messageRow("a6", "t6"), messageRow("a7", "t7")];

test("nothing to page for a drill-in, an unpainted list, or a row of no remembered turn", () => {
  assert.equal(restoreTurnOf({ turnId: "t2" }, rows, "agent-1"), null);
  assert.equal(restoreTurnOf({ turnId: "t2" }, [], undefined), null);
  assert.equal(restoreTurnOf({}, rows, undefined), null);
});
