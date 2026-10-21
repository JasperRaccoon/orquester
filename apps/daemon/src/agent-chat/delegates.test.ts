/**
 * The delegate stop cascade: a chat interrupted, stopped or closed interrupts the unfinished chats
 * it delegated tasks to — and theirs — through the daemon's own command route, marked with why;
 * forks and opened chats are never touched; a repeat posts nothing twice.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary, ThreadLineage } from "@orquester/api";
import { parseInterruptCause, type InterruptCause } from "@orquester/api/agent-chat";

import type { DaemonApi, DaemonResponse } from "../mcp/daemon-api.ts";
import {
  cascadeCommandId,
  delegateDescendants,
  DelegateStopCascade,
  delegateUnfinished,
  REPEAT_INTERRUPT_WINDOW_MS
} from "./delegates.ts";

const RUNNING = { chatSessionStatus: "running", latestTurn: { turnId: "turn-1", state: "running", startedAt: "t", completedAt: null } } as const;
const DONE = { chatSessionStatus: "ready", latestTurn: { turnId: "turn-1", state: "completed", startedAt: "t", completedAt: "t" } } as const;

function tab(id: string, lineage: Partial<ThreadLineage> | null, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    kind: "agent-chat",
    refId: "claude",
    title: `Chat ${id}`,
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    ...(lineage ? { lineage: { createdAt: "2026-10-20T00:00:00.000Z", relation: "delegate", parentThreadId: "root", ...lineage } as ThreadLineage } : {}),
    ...extra
  } as SessionSummary;
}

/** The daemon's own routes, faked: heads by session (running ones name their turn), interrupts recorded. */
function world(tabs: SessionSummary[]) {
  const sessions = new Map(tabs.map((summary) => [summary.id, summary]));
  const interrupts: Array<{ sessionId: string; body: { commandId: string; turnId?: string; cause?: InterruptCause } }> = [];
  const api: DaemonApi = {
    fsRoot: "/",
    workspacesDir: "/w",
    async request(method, path, opts): Promise<DaemonResponse> {
      const head = /^\/api\/sessions\/([^/]+)\/head$/.exec(path);
      if (method === "GET" && head) {
        const summary = sessions.get(decodeURIComponent(head[1]!));
        if (!summary) return { status: 404, body: null };
        const running = summary.chatSessionStatus === "running";
        return {
          status: 200,
          body: { head: { session: { status: running ? "running" : "ready", activeTurnId: running ? `active-${summary.id}` : null } }, pending: { approvals: [], userInputs: [] }, recentTurns: [] }
        };
      }
      const interrupt = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(path);
      if (method === "POST" && interrupt) {
        interrupts.push({ sessionId: decodeURIComponent(interrupt[1]!), body: opts?.body as never });
        return { status: 200, body: { seq: 1 } };
      }
      return { status: 404, body: null };
    },
    async uploadAttachment() {
      return { status: 503, value: null };
    },
    async publishHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "none" };
    },
    async previewHtmlRender() {
      return { ok: false, code: "UNAVAILABLE", message: "none" };
    },
    subscribe() {
      return () => undefined;
    }
  };
  let now = 1_000_000;
  const cascade = new DelegateStopCascade({
    sessions: { get: (id) => sessions.get(id), list: () => [...sessions.values()] },
    now: () => now
  });
  cascade.attachApi(api);
  return {
    cascade,
    sessions,
    interrupts,
    advance: (ms: number) => {
      now += ms;
    },
    interrupted: () => interrupts.map((entry) => entry.sessionId).sort()
  };
}

/**
 * root ─ delegate a (running) ─ delegate a1 (running)
 *      │                      └ fork a2 (running)
 *      ├ delegate b (done) ─ delegate b1 (running)
 *      ├ fork f (running) ─ delegate f1 (running)
 *      └ opened o (running)
 */
function tree(): SessionSummary[] {
  return [
    tab("root", null, RUNNING),
    tab("a", { parentThreadId: "root" }, RUNNING),
    tab("a1", { parentThreadId: "a" }, RUNNING),
    tab("a2", { parentThreadId: "a", relation: "fork" }, RUNNING),
    tab("b", { parentThreadId: "root" }, DONE),
    tab("b1", { parentThreadId: "b" }, { hasPendingUserInput: true }),
    tab("f", { parentThreadId: "root", relation: "fork" }, RUNNING),
    tab("f1", { parentThreadId: "f" }, RUNNING),
    tab("o", { parentThreadId: "root", relation: "opened" }, RUNNING)
  ];
}

describe("the delegate stop cascade", () => {
  it("walks delegate links only, every depth, each chat once", () => {
    assert.deepEqual(
      delegateDescendants(tree(), "root").map((s) => s.id),
      ["a", "b", "a1", "b1"]
    );
    // A lineage cycle (no build writes one) cannot loop.
    const cycle = [tab("x", { parentThreadId: "y" }), tab("y", { parentThreadId: "x" })];
    assert.deepEqual(delegateDescendants(cycle, "x").map((s) => s.id), ["y"]);
  });

  it("interrupting a parent interrupts its unfinished delegates, recursively — never forks, opened chats or finished ones", async () => {
    const w = world(tree());
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-1" });
    await w.cascade.whenIdle();
    // a (running), a1 (its delegate, running), b1 (waiting for its user under a finished delegate).
    assert.deepEqual(w.interrupted(), ["a", "a1", "b1"]);
    const a = w.interrupts.find((entry) => entry.sessionId === "a")!;
    assert.equal(a.body.turnId, "active-a", "the running turn is named, from the child's head");
    assert.deepEqual(a.body.cause, { kind: "parent-stopped", parentSessionId: "root", parentTitle: "Chat root", action: "interrupted" });
    assert.ok(parseInterruptCause(a.body.cause), "the cause reads back");
    assert.equal(a.body.commandId, cascadeCommandId("root\u0000interrupt\u0000stop-1", "a"));
    const b1 = w.interrupts.find((entry) => entry.sessionId === "b1")!;
    assert.equal(b1.body.turnId, undefined, "a chat with no running turn is interrupted without one");
  });

  it("is idempotent: a repeat of the same stop posts nothing twice, and the cascade's own interrupts start no cascade", async () => {
    const w = world(tree());
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-1" });
    await w.cascade.whenIdle();
    const first = w.interrupts.length;
    // The same command again (a retried request the host answered from its receipt).
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-1" });
    // A second Stop while the children's summaries still read "running".
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-2" });
    // The route reporting the cascade's own interrupt of `a` (it carries a cause).
    w.cascade.commandAccepted("a", "interrupt", w.interrupts.find((entry) => entry.sessionId === "a")!.body);
    await w.cascade.whenIdle();
    assert.equal(w.interrupts.length, first, "nothing is posted again for the same turns");
    // The same command id is derived for the same stop and child, whatever the order.
    assert.equal(cascadeCommandId("k", "a"), cascadeCommandId("k", "a"));
    assert.notEqual(cascadeCommandId("k", "a"), cascadeCommandId("k", "b"));
    // Past the window, a turn that kept running is a new attempt.
    w.advance(REPEAT_INTERRUPT_WINDOW_MS + 1);
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-3" });
    await w.cascade.whenIdle();
    assert.equal(w.interrupts.length, first * 2);
  });

  it("starts nothing for a housekeeping interrupt (cascade: false — usage-limit recovery clearing a parked turn)", async () => {
    const w = world(tree());
    w.cascade.commandAccepted("root", "interrupt", { commandId: "limit-resume:root:3:1:interrupt", cascade: false });
    await w.cascade.whenIdle();
    assert.equal(w.interrupts.length, 0, "the delegates keep running");
    // A stop is still a stop, and only an explicit `false` exempts an interrupt.
    w.cascade.commandAccepted("root", "interrupt", { commandId: "stop-1", cascade: true });
    await w.cascade.whenIdle();
    assert.ok(w.interrupts.length > 0);
  });

  it("skips delegates that already finished, and does nothing for a chat with no delegates", async () => {
    const w = world([tab("root", null, RUNNING), tab("a", { parentThreadId: "root" }, DONE), tab("solo", null, RUNNING)]);
    w.cascade.commandAccepted("root", "interrupt", { commandId: "s" });
    w.cascade.commandAccepted("solo", "interrupt", { commandId: "s" });
    await w.cascade.whenIdle();
    assert.equal(w.interrupts.length, 0);
    assert.equal(delegateUnfinished(tab("x", null, DONE)), false);
    assert.equal(delegateUnfinished(tab("x", null, { chatPending: true, chatSessionStatus: "starting" })), false);
    assert.equal(delegateUnfinished(tab("x", null, { goal: { objective: "o", status: "active", continuing: true } })), true);
  });

  it("stopping a child (control_session) cascades to that child's delegates only", async () => {
    const w = world(tree());
    w.cascade.commandAccepted("a", "session/stop", { commandId: "agent-stop" });
    await w.cascade.whenIdle();
    assert.deepEqual(w.interrupted(), ["a1"]);
    assert.equal(w.interrupts[0]!.body.cause?.action, "stopped");
    assert.equal(w.interrupts[0]!.body.cause?.parentSessionId, "a");
  });

  it("closing a parent cascades with the title it had, read before its record goes", async () => {
    const w = world(tree());
    w.cascade.closing("root");
    w.sessions.delete("root");
    await w.cascade.whenIdle();
    assert.deepEqual(w.interrupted(), ["a", "a1", "b1"]);
    assert.deepEqual(w.interrupts[0]!.body.cause, { kind: "parent-stopped", parentSessionId: "root", parentTitle: "Chat root", action: "closed" });
  });

  it("does nothing before the daemon's API is bound, or once stopped", async () => {
    const w = world(tree());
    w.cascade.stop();
    w.cascade.commandAccepted("root", "interrupt", { commandId: "x" });
    await w.cascade.whenIdle();
    assert.equal(w.interrupts.length, 0);
    const unbound = new DelegateStopCascade({ sessions: { get: () => undefined, list: () => tree() } });
    unbound.commandAccepted("root", "interrupt", { commandId: "x" });
    await unbound.whenIdle();
  });
});
