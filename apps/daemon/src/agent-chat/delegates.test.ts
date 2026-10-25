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
  DelegateStopCascade,
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
  it("tells the reply router every delegate link of the stopped tree before any interrupt — even with nothing left to interrupt", async () => {
    const w = world(tree());
    const heard: Array<{ links: string[]; interruptsBefore: number }> = [];
    w.cascade.setListener({
      async delegatesStopped(links) {
        heard.push({ links: links.map((link) => `${link.parentId}>${link.childId}`).sort(), interruptsBefore: w.interrupts.length });
      }
    });
    w.cascade.commandAccepted("root", "interrupt", { commandId: "c1" });
    await w.cascade.whenIdle();
    assert.deepEqual(heard, [{ links: ["a>a1", "b>b1", "root>a", "root>b"], interruptsBefore: 0 }], "forks and opened chats are not followed");
    assert.deepEqual(w.interrupted(), ["a", "a1", "b1"]);
    // Every delegate finished: no interrupt, but the router still hears the stop (replies may be waiting).
    const idleTree = world([tab("root", null, RUNNING), tab("d", { parentThreadId: "root" }, DONE)]);
    const idleHeard: string[] = [];
    idleTree.cascade.setListener({ async delegatesStopped(links) { idleHeard.push(...links.map((link) => link.childId)); } });
    idleTree.cascade.commandAccepted("root", "session/stop", { commandId: "c2" });
    await idleTree.cascade.whenIdle();
    assert.deepEqual(idleHeard, ["d"]);
    assert.deepEqual(idleTree.interrupted(), []);
    // The cascade's own interrupts and housekeeping ones start nothing.
    idleTree.cascade.commandAccepted("root", "interrupt", { commandId: "c3", cascade: false });
    await idleTree.cascade.whenIdle();
    assert.deepEqual(idleHeard, ["d"]);
  });

  it("holds replies to a chat while its stop is on the way, never for the cascade's own interrupts", () => {
    const w = world(tree());
    const log: string[] = [];
    w.cascade.setListener({
      delegatesStopped: async () => undefined,
      stopRequested: (id) => log.push(`hold ${id}`),
      stopResolved: (id) => log.push(`release ${id}`)
    });
    const done = w.cascade.commandRequested("root", "interrupt", { commandId: "c1" });
    done();
    done();
    w.cascade.commandRequested("a", "interrupt", { commandId: "c2", cause: { kind: "parent-stopped", parentSessionId: "root", parentTitle: "", action: "interrupted" } })();
    w.cascade.commandRequested("a", "interrupt", { commandId: "c3", cascade: false })();
    assert.deepEqual(log, ["hold root", "release root"], "released once; cascaded and housekeeping interrupts hold nothing");
  });

  it("a router that fails to record the stop never keeps the children running", async () => {
    const w = world(tree());
    w.cascade.setListener({ delegatesStopped: async () => { throw new Error("disk full"); } });
    w.cascade.commandAccepted("root", "interrupt", { commandId: "c1" });
    await w.cascade.whenIdle();
    assert.deepEqual(w.interrupted(), ["a", "a1", "b1"]);
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
    const pending = world([tab("root", null, RUNNING), tab("pending", { parentThreadId: "root" }, { chatPending: true, chatSessionStatus: "starting" })]);
    pending.cascade.commandAccepted("root", "interrupt", { commandId: "s" });
    await pending.cascade.whenIdle();
    assert.deepEqual(pending.interrupted(), []);
    const continuing = world([tab("root", null, RUNNING), tab("goal", { parentThreadId: "root" }, { goal: { objective: "o", status: "active", continuing: true } })]);
    continuing.cascade.commandAccepted("root", "interrupt", { commandId: "s" });
    await continuing.cascade.whenIdle();
    assert.deepEqual(continuing.interrupted(), ["goal"]);
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
