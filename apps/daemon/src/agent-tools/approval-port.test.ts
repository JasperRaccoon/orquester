import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { AgentChatToolApprovalEventPayload, RuntimeMode } from "@orquester/api/agent-chat";

import { ToolApprovalRegistry, type ToolApprovalClock } from "../agent-chat/tool-approvals.ts";
import type { ApprovalRequest } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { AgentToolsApprovalPort, callerTraitsFromDaemon, workflowOwnedFromTabs, type CallerTraits } from "./approval-port.ts";
import { AgentToolsService } from "./service.ts";

class FakeClock implements ToolApprovalClock {
  t = Date.parse("2026-10-15T10:00:00.000Z");
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now(): number {
    return this.t;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.t) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

const PROJECT = "/w/ws/p";

async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "orq-approval-port-"));
  const clock = new FakeClock();
  const events: AgentChatToolApprovalEventPayload[] = [];
  const logs: string[] = [];
  // Cards opened and not yet taken by `opened()`; waiters for the next one (event-driven, no polling).
  const openedIds: string[] = [];
  const openWaiters: ((id: string) => void)[] = [];
  let n = 0;
  const registry = new ToolApprovalRegistry({
    publish: (e) => {
      events.push(e);
      if (!e.opened) return;
      const waiter = openWaiters.shift();
      if (waiter) waiter(e.opened.approvalId);
      else openedIds.push(e.opened.approvalId);
    },
    log: (l) => logs.push(l),
    clock,
    newId: () => `a${++n}`
  });
  /** The next card the registry opens (the port reads the caller's traits first). */
  const opened = (): Promise<string> =>
    openedIds.length > 0 ? Promise.resolve(openedIds.shift()!) : new Promise<string>((resolve) => openWaiters.push(resolve));
  let g = 0;
  const tools = new AgentToolsService({ file: join(dir, "agent-tools.json"), now: () => clock.now(), newId: () => `g${++g}` });
  await tools.load();
  t.after(async () => {
    await registry.shutdown();
    await tools.flush();
    await rm(dir, { recursive: true, force: true });
  });
  const traits = new Map<string, CallerTraits>([["t1", { runtimeMode: "full-access", workflowOwned: false, agent: "claude" }]]);
  const owned = new Set<string>();
  const port = new AgentToolsApprovalPort({
    registry,
    tools,
    callerTraits: async (id) => traits.get(id) ?? null,
    workflowOwned: (id) => owned.has(id)
  });
  const setMode = (mode: RuntimeMode | null) => traits.set("t1", { ...traits.get("t1")!, runtimeMode: mode });
  return { registry, tools, port, clock, events, logs, traits, owned, setMode, opened };
}

function card(over: Partial<ApprovalRequest> & { toolset?: string } = {}): ApprovalRequest & { toolset?: string } {
  return {
    threadId: "t1",
    callerProjectPath: PROJECT,
    tool: "control_desktop",
    kind: "admin",
    family: "desktops",
    title: "Claude wants to open a desktop",
    scope: { label: "Project ws/p", projects: [{ path: PROJECT, workspace: "ws" }] },
    sections: [{ kind: "fields", rows: [{ label: "Command", value: "xterm" }] }],
    secretFields: [],
    grantOptions: ["chat", "project"],
    ...over
  };
}

test("approve with a grant: the grant is recorded and honoured for the next call while the caller is full-access", async (t) => {
  const h = await harness(t);
  const waiting = h.port.request(card(), new AbortController().signal);
  const id = await h.opened();
  assert.deepEqual(h.registry.list("t1")[0]!.grantOptions, ["chat", "project"]);
  const answer = await h.registry.answer("t1", id, { decision: "approve", grant: "chat" });
  assert.ok(answer.ok);
  const outcome = await waiting;
  assert.equal(outcome.outcome, "approved");
  const grantId = outcome.outcome === "approved" ? outcome.grantId : undefined;
  assert.equal(grantId, "g1");
  const query = { family: "desktops", callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t1", projectPath: PROJECT, projects: [PROJECT] };
  assert.equal((await h.port.findGrant(query))?.id, "g1");
  assert.equal(await h.port.findGrant({ ...query, callerRuntimeMode: "auto" }), null, "honoured only while full-access");
  h.owned.add("t1");
  assert.equal(await h.port.findGrant(query), null, "never for a workflow-owned caller (the port's own look)");
  h.owned.delete("t1");
  h.tools.revokeGrant("g1");
  assert.equal(await h.port.findGrant(query), null, "revocation is effective for the next call");
});

test("grants are never offered to a caller below full-access, nor for cross-project Admin, whatever the card says", async (t) => {
  const h = await harness(t);
  h.setMode("auto");
  void h.port.request(card(), new AbortController().signal);
  const id = await h.opened();
  assert.deepEqual(h.registry.list("t1")[0]!.grantOptions, []);
  const refused = await h.registry.answer("t1", id, { decision: "approve", grant: "chat" });
  assert.equal(refused.ok, false);
  assert.equal((await h.registry.answer("t1", id, { decision: "deny" })).ok, true);

  h.setMode("full-access");
  void h.port.request(card({ scope: { label: "Two projects", projects: [{ path: PROJECT, workspace: "ws" }, { path: "/w/ws/other", workspace: "ws" }] } }), new AbortController().signal);
  await h.opened();
  assert.deepEqual(h.registry.list("t1")[0]!.grantOptions, [], "cross-project Admin: no grant");
  h.registry.cancelThread("t1");

  h.setMode(null);
  void h.port.request(card(), new AbortController().signal);
  await h.opened();
  assert.deepEqual(h.registry.list("t1")[0]!.grantOptions, [], "mode unknown: fail closed");
  h.registry.cancelThread("t1");

  h.setMode("full-access");
  void h.port.request(card({ family: "agent-profile", tool: "edit_agent_profile", grantOptions: ["chat"] }), new AbortController().signal);
  await h.opened();
  assert.deepEqual(h.registry.list("t1")[0]!.grantOptions, [], "agent-profile: never grantable");
});

test("a caller that left full-access while the card was open cannot attach a grant (approve without one still works)", async (t) => {
  const h = await harness(t);
  const waiting = h.port.request(card(), new AbortController().signal);
  const id = await h.opened();
  h.setMode("approval-required");
  const refused = await h.registry.answer("t1", id, { decision: "approve", grant: "project" });
  assert.deepEqual(refused.ok ? null : [refused.status, refused.message], [400, "This chat is no longer in Full access: approve without a grant."]);
  assert.ok((await h.registry.answer("t1", id, { decision: "approve" })).ok);
  assert.deepEqual(await waiting, { outcome: "approved", approvalId: id });
  assert.equal(h.tools.settingsView().grants.length, 0);
});

test("workflow-owned callers never get a card: Admin → ADMIN_NOT_AVAILABLE, boundary/toolset → PERMISSION_DENIED", async (t) => {
  const h = await harness(t);
  h.owned.add("t1");
  await assert.rejects(h.port.request(card(), new AbortController().signal), (e: Error & { code?: string }) => e.code === "ADMIN_NOT_AVAILABLE");
  await assert.rejects(
    h.port.request(card({ kind: "boundary", family: "cross-project", grantOptions: [] }), new AbortController().signal),
    (e: Error & { code?: string }) => e.code === "PERMISSION_DENIED"
  );
  h.owned.delete("t1");
  h.traits.set("t1", { runtimeMode: "full-access", workflowOwned: true, agent: "claude" });
  await assert.rejects(h.port.request(card(), new AbortController().signal), (e: Error & { code?: string }) => e.code === "ADMIN_NOT_AVAILABLE");
  assert.equal(h.events.length, 0, "no card was ever shown");
  await assert.rejects(h.port.request(card({ threadId: "gone" }), new AbortController().signal), (e: Error & { code?: string }) => e.code === "THREAD_NOT_FOUND");
});

test("toolset cards: approval turns the toolset on for the chat (persisted, toolsetsChanged); a denial blocks asking for 30 min", async (t) => {
  const h = await harness(t);
  const changed: (string | null)[] = [];
  h.tools.onToolsetsChanged((id) => changed.push(id));
  const toolsetCard = card({ tool: "request_toolset", kind: "toolset", family: "toolset", grantOptions: [], title: "Claude asks to enable Workflow authoring for this chat", toolset: "workflow-authoring" });
  const waiting = h.port.request(toolsetCard, new AbortController().signal);
  const id = await h.opened();
  await assert.rejects(h.port.request(toolsetCard, new AbortController().signal), (e: Error & { code?: string }) => e.code === "PERMISSION_DENIED", "one pending per toolset per chat");
  assert.ok((await h.registry.answer("t1", id, { decision: "approve" })).ok);
  assert.equal((await waiting).outcome, "approved");
  assert.deepEqual(h.tools.resolvedToolsets("t1", "claude"), ["core", "reads", "workflow-authoring"]);
  assert.deepEqual(changed, ["t1"]);
  // Already on: no card.
  const before = h.events.length;
  assert.deepEqual(await h.port.request(toolsetCard, new AbortController().signal), { outcome: "approved", approvalId: "" });
  assert.equal(h.events.length, before);

  const desktops = { ...toolsetCard, toolset: "desktops", title: "Claude asks to enable Desktops for this chat" };
  const denied = h.port.request(desktops, new AbortController().signal);
  const deniedId = await h.opened();
  assert.ok((await h.registry.answer("t1", deniedId, { decision: "deny", reason: "no" })).ok);
  assert.deepEqual(await denied, { outcome: "denied", approvalId: deniedId, reason: "no" });
  await assert.rejects(h.port.request(desktops, new AbortController().signal), (e: Error & { code?: string; detail?: { toolset: string } }) => e.code === "TOOLSET_DECLINED" && e.detail?.toolset === "desktops");
  h.clock.advance(30 * 60 * 1000);
  void h.port.request(desktops, new AbortController().signal);
  await h.opened();
  const unnamed: ApprovalRequest = { ...toolsetCard };
  delete (unnamed as { toolset?: string }).toolset;
  await assert.rejects(h.port.request(unnamed, new AbortController().signal), (e: Error & { code?: string }) => e.code === "INVALID_ARGUMENT");
});

test("workflows chat grants cover only workflows created or approved in that chat", async (t) => {
  const h = await harness(t);
  const wfCard = (workflowId?: string) =>
    card({ tool: workflowId ? "run_workflow" : "create_workflow", family: "workflows", grantOptions: ["chat"], ...(workflowId ? { workflowId } : {}) });
  // A create approved with the chat grant: the grant starts empty, the new id is added after the create ran.
  const create = h.port.request(wfCard(), new AbortController().signal);
  await h.registry.answer("t1", await h.opened(), { decision: "approve", grant: "chat" });
  const created = await create;
  assert.equal(created.outcome, "approved");
  const grantId = created.outcome === "approved" ? created.grantId : undefined;
  await h.port.recordWorkflowInGrant({ threadId: "t1", callerProjectPath: PROJECT, workflowId: "wf1", ...(grantId ? { grantId } : {}) });
  const query = { family: "workflows", callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t1", projectPath: PROJECT, projects: [PROJECT] };
  assert.equal((await h.port.findGrant({ ...query, workflowId: "wf1" }))?.id, grantId);
  assert.equal(await h.port.findGrant({ ...query, workflowId: "wf-elsewhere" }), null);
  // Approving a run of another workflow in this chat (no grant chosen) adds it to the chat's grant.
  const run = h.port.request(wfCard("wf2"), new AbortController().signal);
  await h.registry.answer("t1", await h.opened(), { decision: "approve" });
  assert.equal((await run).outcome, "approved");
  assert.equal((await h.port.findGrant({ ...query, workflowId: "wf2" }))?.id, grantId);
  // Not recorded for a caller no longer in full access.
  h.setMode("auto");
  await h.port.recordWorkflowInGrant({ threadId: "t1", callerProjectPath: PROJECT, workflowId: "wf3" });
  h.setMode("full-access");
  assert.equal(await h.port.findGrant({ ...query, workflowId: "wf3" }), null);
});

test("cancellation reaches the card: the call's signal and the 30-min deadline", async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  const waiting = h.port.request(card(), controller.signal);
  await h.opened();
  controller.abort();
  assert.equal((await waiting).outcome, "cancelled");
  const expiring = h.port.request(card(), new AbortController().signal);
  await h.opened();
  h.clock.advance(30 * 60 * 1000);
  assert.equal((await expiring).outcome, "timed_out");
});

test("traits from the daemon: tab presence, workflow ownership along lineage, the snapshot's mode (unknown on a failed read)", async () => {
  const tabs = new Map<string, { owner?: { kind: "workflow"; workflowId: string; runId: string; nodeId: string }; lineage?: { parentThreadId: string } }>([
    ["root", { owner: { kind: "workflow", workflowId: "w", runId: "r", nodeId: "n" } }],
    ["child", { lineage: { parentThreadId: "root" } }],
    ["grandchild", { lineage: { parentThreadId: "child" } }],
    ["free", {}],
    ["loop-a", { lineage: { parentThreadId: "loop-b" } }],
    ["loop-b", { lineage: { parentThreadId: "loop-a" } }]
  ]);
  const tab = (id: string) => tabs.get(id) as never;
  assert.equal(workflowOwnedFromTabs("grandchild", tab), true);
  assert.equal(workflowOwnedFromTabs("free", tab), false);
  assert.equal(workflowOwnedFromTabs("loop-a", tab), false);
  let fail = false;
  const api = {
    request: async () => {
      if (fail) throw new Error("down");
      return { status: 200, body: { kind: "snapshot", thread: { head: { runtimeMode: "full-access" } } } };
    }
  } as unknown as DaemonApi;
  const read = callerTraitsFromDaemon({ tab, agentOf: () => "codex", api: () => api });
  assert.deepEqual(await read("free"), { runtimeMode: "full-access", workflowOwned: false, agent: "codex" });
  assert.equal(await read("missing"), null);
  fail = true;
  assert.deepEqual(await read("child"), { runtimeMode: null, workflowOwned: true, agent: "codex" });
});
