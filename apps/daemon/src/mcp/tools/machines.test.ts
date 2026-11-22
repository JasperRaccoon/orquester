/**
 * `wake_machine` through the executor: what the daemon shows the chat decides it — a machine the
 * daemon does not show this chat (Hidden answers 404 like an unknown id) is refused with no card, an Ask-first one wakes
 * only after its card, a Free-use one without one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { machineRoutes, type MachineSummary, type MachineVisibility } from "@orquester/api";

import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

const STUDIO = "ts:nSTUDIO";
const MINIPC = "ts:nMINIPC";

function summary(id: string, name: string, visibility: MachineVisibility, state: MachineSummary["state"]): MachineSummary {
  return {
    id, name, hostname: name, dnsName: `${name}.tail0000.ts.net`, os: "linux", tailnetIps: [], online: state !== "asleep", lastSeenAt: null, state,
    visibility, capabilities: { devices: false, commands: true, chats: false }, boxId: `byo-${name}`, wake: { canWake: state === "asleep", ...(state === "asleep" ? { via: MINIPC } : {}) }, sudo: {}, problems: []
  };
}

const chat: ThreadCaller = {
  kind: "thread", threadId: "me", title: "Lab", projectPath: "/w/acme/lab", workspace: "acme", cwd: "/w/acme/lab", agentId: "claude", callId: "c1",
  runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null
};

/** The daemon as this chat sees it: `visibility` null = the studio is Hidden (404, like an unknown id). */
function daemon(visibility: MachineVisibility | null): FakeDaemonApi {
  const api = new FakeDaemonApi();
  const studio = visibility === null ? null : summary(STUDIO, "studio", visibility, "asleep");
  const minipc = summary(MINIPC, "minipc", "free", "ready");
  api
    .on("GET", machineRoutes.list, { status: 200, body: { machines: [...(studio ? [studio] : []), minipc], problems: [] } })
    .on("GET", machineRoutes.machine(STUDIO), studio ? { status: 200, body: { machine: studio } } : { status: 404, body: { code: "MACHINE_NOT_FOUND", message: "No such machine." } })
    .on("POST", machineRoutes.wake(STUDIO), { status: 200, body: { sent: true, via: MINIPC } });
  return api;
}

async function wake(api: FakeDaemonApi, port: FakeApprovalPort) {
  const result: CallToolResult = await executeToolCall({ approvals: port }, { name: "wake_machine", arguments: { machine_id: STUDIO } }, { caller: chat, api, signal: new AbortController().signal });
  return { isError: result.isError === true, body: result.structuredContent as Record<string, unknown> };
}

const wakes = (api: FakeDaemonApi) => api.calls.filter((call) => call.method === "POST" && call.path === machineRoutes.wake(STUDIO)).length;

test("wake_machine: a Hidden machine (the daemon answers it as unknown) is refused with no card and no wake", async () => {
  const api = daemon(null);
  const port = new FakeApprovalPort();
  const hidden = await wake(api, port);
  assert.ok(hidden.isError);
  assert.equal(hidden.body.code, "MACHINE_NOT_FOUND");
  assert.equal(port.cards.length, 0);
  assert.equal(wakes(api), 0);
});

test("wake_machine: an Ask-first machine wakes only after the owner approves its card; a Free-use one without a card", async () => {
  const denied = daemon("ask");
  const deny = new FakeApprovalPort({ outcome: "denied", approvalId: "" });
  assert.ok((await wake(denied, deny)).isError);
  assert.equal(deny.cards.length, 1);
  assert.equal(deny.cards[0]!.family, "machines");
  assert.match(deny.cards[0]!.title, /studio/);
  assert.equal(wakes(denied), 0);

  const asked = daemon("ask");
  const approve = new FakeApprovalPort();
  const woken = await wake(asked, approve);
  assert.ok(!woken.isError, JSON.stringify(woken.body));
  assert.equal(approve.cards.length, 1);
  assert.deepEqual([woken.body.sent, woken.body.sent_via], [true, "minipc"]);
  assert.equal(wakes(asked), 1);

  const free = daemon("free");
  const none = new FakeApprovalPort();
  assert.equal((await wake(free, none)).body.sent, true);
  assert.equal(none.cards.length, 0);
  assert.equal(wakes(free), 1);
});
