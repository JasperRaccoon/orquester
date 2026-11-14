import assert from "node:assert/strict";
import test from "node:test";

import type { EventMessage, SessionSummary } from "@orquester/api";
import { agentChatRoutes, type ChatBusySwitchState } from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonMethod, DaemonResponse } from "../../mcp/daemon-api.ts";
import type { Clock } from "../contracts.ts";
import { waitForIdle } from "./watch.ts";

const T0 = Date.parse("2026-11-14T06:00:00.000Z");

const clock: Clock = {
  now: () => new Date(T0),
  setTimeout: () => ({ cancel: () => undefined })
};

const SWITCH: ChatBusySwitchState = {
  commandId: "sw-1",
  fromAccountId: "acc1",
  toAccountId: "acc2",
  startedAt: new Date(T0).toISOString(),
  step: "settling",
  goal: null
};

/** One chat, idle on every other count: settled turn, no requests, no background work. */
function fakeApi(summary: SessionSummary): DaemonApi {
  return {
    fsRoot: "/w",
    workspacesDir: "/w",
    async request(method: DaemonMethod, path: string): Promise<DaemonResponse> {
      if (method === "GET" && path === "/api/sessions") return { status: 200, body: [summary] };
      if (method === "GET" && path === agentChatRoutes.thread(summary.id)) {
        return {
          status: 200,
          body: {
            kind: "snapshot",
            thread: { head: { session: { status: "ready", activeTurnId: null } }, turns: [], pending: { approvals: [], userInputs: [] }, items: [] }
          }
        };
      }
      return { status: 404, body: null };
    },
    subscribe: (_listener: (event: EventMessage) => void) => () => undefined
  } as unknown as DaemonApi;
}

test("a chat a busy account switch fences is not idle: a gate's message waits instead of re-posting into the fence", async () => {
  const summary: SessionSummary = {
    id: "s1",
    kind: "agent-chat",
    refId: "claude",
    title: "chat",
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: new Date(T0).toISOString(),
    chatSessionStatus: "ready",
    latestTurn: { turnId: "t1", state: "completed", startedAt: null, completedAt: null },
    backgroundLiveness: null,
    accountSwitch: SWITCH
  };
  const wait = (api: DaemonApi) => waitForIdle({ api, sessionId: "s1", clock, signal: new AbortController().signal, until: new Date(T0) });
  assert.equal(await wait(fakeApi(summary)), "timeout");
  assert.equal(await wait(fakeApi({ ...summary, accountSwitch: null })), "idle");
});
