import assert from "node:assert/strict";
import { it } from "node:test";

import type { PendingApproval, TurnState } from "@orquester/api/agent-chat";
import type { AgentChatThreadState } from "../agent-chat/store";
import { rewindBusyOf } from "./thread-inputs";

function state(turnStatus: TurnState, approvals: PendingApproval[] = [], reverting = false) {
  return {
    slice: { turnStatus, pending: { approvals, userInputs: [] } },
    reverting
  } as unknown as Pick<AgentChatThreadState, "slice" | "reverting">;
}

it("moves when what the panel shows moves: the turn settling, a request docking, a rewind", () => {
  assert.equal(rewindBusyOf(state("running")).isTurnActive, true);
  assert.deepEqual(rewindBusyOf(state("completed")), {
    isTurnActive: false, reverting: false, hasPendingRequest: false
  });
  const approval = { requestId: "r1", requestKind: "command", createdAt: "2026-09-01T00:00:00.000Z" } as PendingApproval;
  assert.equal(rewindBusyOf(state("completed", [approval])).hasPendingRequest, true);
  assert.equal(rewindBusyOf(state("completed", [], true)).reverting, true);
});
