/** E1 regression: a settled turn must stop the status line's live timer. */
import assert from "node:assert/strict";
import { after,before,describe,it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentChatStreamFrame,ThreadSessionStatus,Turn,TurnState } from "@orquester/api/agent-chat";

import { OrquesterProvider,type OrquesterProviderProps } from "../../context/orquester-context";
import { useAgentChatStatus } from "./hooks";
import { releaseThreadStore,retainThreadStore } from "./store";
import { head,snapshot } from "./test-helpers";
import type { AgentChatTransport } from "./transport";

const sessionId = "status-clock";
let push: (frame: AgentChatStreamFrame) => void;
let opened: () => void;
const streamReady = new Promise<void>((resolve) => { opened = resolve; });
const unused = async (): Promise<never> => { throw new Error("Unexpected transport request"); };
const transport: AgentChatTransport = {
  stream(_sessionId, _options, handlers) {
    push = handlers.onFrame;
    opened();
    return { lastSeq: 0, hostInstanceId: null, resetCursor() {}, close() {} };
  },
  command: unused,
  switchAccount: unused,
  read: unused,
  readItem: unused,
  readHistory: unused,
  search: unused,
  turnDiff: unused,
  providers: unused,
  refreshProvider: unused,
  upload: unused,
  fetchAttachment: unused
};

before(async () => {
  retainThreadStore(sessionId, { transport });
  await streamReady;
});
after(() => releaseThreadStore(sessionId));

const turn = (state: TurnState): Turn => ({
  turnId: "t1",
  state,
  turnCount: null,
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: state === "running" || state === "pending" ? null : "2026-01-01T00:01:00.000Z",
  assistantMessageId: null
});

let sequence = 0;
function at(state: TurnState, session: ThreadSessionStatus): string | null {
  push({
    kind: "snapshot",
    thread: snapshot({
      seq: ++sequence,
      head: head({ id: sessionId, session: { status: session, activeTurnId: "t1" } }),
      turns: [turn(state)]
    })
  });
  let startedAt: string | null | undefined;
  function StatusConsumer() {
    startedAt = useAgentChatStatus(sessionId).turnStartedAt;
    return null;
  }
  const context = { useTitlebar: false, api: { agentChat: transport } } as unknown as OrquesterProviderProps;
  renderToStaticMarkup(createElement(OrquesterProvider, { ...context, children: createElement(StatusConsumer) }));
  assert.notEqual(startedAt, undefined, "the status consumer rendered");
  return startedAt!;
}

describe("E1 — the status timer stops when the turn does", () => {
  it("ticks only while the turn is unsettled AND the session is live", () => {
    assert.equal(at("running", "running"), "2026-01-01T00:00:00.000Z");
    assert.equal(at("pending", "starting"), "2026-01-01T00:00:00.000Z");
  });

  it("stops on every settled turn state", () => {
    for (const state of ["completed", "failed", "interrupted", "cancelled"] as const) {
      assert.equal(at(state, "running"), null, `${state} must not tick`);
    }
  });

  it("stops when the session left `running`, even if the turn row still says running", () => {
    for (const session of ["ready", "idle", "stopped", "error"] as const) {
      assert.equal(at("running", session), null);
    }
  });
});
