import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { createLivenessRegistry, UNCHECKED_BACKGROUND_TTL_MS } from "./liveness.ts";
import { createTestClock } from "./testing/fakes.ts";

const base = { eventId: "e", threadId: "t1", createdAt: "1970-01-01T00:00:00.000Z" };

const turn = (type: "turn.started" | "turn.completed" | "turn.aborted"): RuntimeEvent =>
  ({ ...base, type, turnId: "turn-1", payload: {} }) as unknown as RuntimeEvent;

const task = (
  type: "task.started" | "task.progress" | "task.updated" | "task.completed",
  payload: Record<string, unknown>
): RuntimeEvent => ({ ...base, type, payload }) as unknown as RuntimeEvent;

describe("background liveness registry (§3.1)", () => {
  it("a status-free progress row never resurrects a finished task", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    registry.observe(task("task.updated", { taskId: "a1", taskType: "subagent", status: "idle" }));
    registry.observe(task("task.progress", { taskId: "a1", description: "still going" }));
    assert.equal(registry.liveness("t1"), null);
  });

  it("plan-mode bookkeeping is inert", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "p1", taskType: "plan" }));
    assert.equal(registry.liveness("t1"), null);
  });

  it("a subagent's own shell is covered by its owner, a nested agent is not", () => {
    const registry = createLivenessRegistry();
    registry.observe(
      task("task.started", { taskId: "s1", taskType: "shell", agentId: "agent-1" })
    );
    assert.equal(registry.liveness("t1"), null, "the owning agent covers its own shells");
    registry.observe(
      task("task.started", { taskId: "n1", taskType: "subagent", agentId: "agent-1" })
    );
    assert.equal(registry.liveness("t1"), "working", "a nested agent counts on its own");
  });

  it("classification is per transition, not sticky", () => {
    const registry = createLivenessRegistry();
    // First seen without a type: counted as an agent.
    registry.observe(task("task.started", { taskId: "x1" }));
    assert.equal(registry.liveness("t1"), "working");
    // The next row reveals it as a shell: it moves bucket rather than pinning.
    registry.observe(task("task.updated", { taskId: "x1", taskType: "shell", status: "running" }));
    assert.equal(registry.liveness("t1"), "monitoring");
  });
});

/**
 * A background shell or watch loop is live until its work ends — its terminal
 * row, its session's exit, or its adapter's word that it is gone — never until
 * it falls silent. A test suite whose output goes to a file says nothing for
 * twenty minutes; the expiry this registry used to apply (ten silent minutes,
 * or the end of any turn the user sent while it said nothing) read it as
 * finished, the tab showed "finished", and a deploy's drain killed it
 * (2026-10-23).
 */
describe("a silent background shell stays live (2026-10-23)", () => {
  const HOUR = 60 * 60_000;

  it("a shell silent for 17 minutes — and through the user's own turns — still runs", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "suite", taskType: "local_bash", title: "pnpm test" }));
    clock.set(1_000);
    registry.observe(turn("turn.started"));
    clock.set(2_000);
    registry.observe(turn("turn.completed"));
    clock.set(17 * 60_000);
    assert.equal(registry.liveness("t1"), "monitoring", "silence is not an end");
    registry.observe(turn("turn.aborted"));
    assert.equal(registry.liveness("t1"), "monitoring");
    assert.deepEqual(registry.liveTasks("t1"), [
      { taskId: "suite", kind: "background", since: new Date(0).toISOString(), taskType: "local_bash", title: "pnpm test" }
    ]);
  });

  it("leaves on its own terminal row, or with its session", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "s1", taskType: "shell" }));
    registry.observe(task("task.completed", { taskId: "s1", taskType: "shell", status: "completed" }));
    assert.equal(registry.liveness("t1"), null);
    registry.observe(task("task.started", { taskId: "s2", taskType: "shell" }));
    registry.observe({ ...base, type: "session.exited", payload: {} } as unknown as RuntimeEvent);
    assert.equal(registry.liveness("t1"), null, "the provider process that ran it is gone");
  });

  it("an adapter that says the shell still runs keeps it live however long it is quiet", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock, probe: () => true });
    registry.observe(task("task.started", { taskId: "dev", taskType: "shell" }));
    clock.set(48 * HOUR);
    assert.equal(registry.liveness("t1"), "monitoring");
  });

  it("an adapter that says the work is gone ends it at once, shell or agent", () => {
    let alive = true;
    const registry = createLivenessRegistry({ probe: () => alive });
    registry.observe(task("task.started", { taskId: "sh", taskType: "shell" }));
    registry.observe(task("task.started", { taskId: "ag", taskType: "local_agent" }));
    assert.equal(registry.liveness("t1"), "working");
    alive = false;
    assert.equal(registry.liveness("t1"), null);
    assert.deepEqual(registry.liveTasks("t1"), []);
  });

  it("a probe installed later, and one that throws, are both honoured safely", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "sh", taskType: "shell" }));
    registry.setProbe(() => {
      throw new Error("probe failed");
    });
    assert.equal(registry.liveness("t1"), "monitoring", "a failing probe knows nothing");
    registry.setProbe((_threadId, taskId) => (taskId === "sh" ? false : undefined));
    assert.equal(registry.liveness("t1"), null);
  });

  it("only a shell its adapter cannot answer for is bounded — by hours, not minutes", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock, probe: () => undefined });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    clock.set(UNCHECKED_BACKGROUND_TTL_MS - 1);
    assert.equal(registry.liveness("t1"), "monitoring");
    clock.set(UNCHECKED_BACKGROUND_TTL_MS);
    assert.equal(registry.liveness("t1"), null, "the guard against a provider that never reports an end");
  });

  it("a subagent with no bound of its own counts until its end", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    clock.set(30 * HOUR);
    assert.equal(registry.liveness("t1"), "working");
  });
});

/**
 * An `agentId` names the agent a task belongs to. Grok stamps a background
 * shell with ITSELF (`adapters/grok/background-tasks.ts`, every `task.*` of a
 * shell carries `agentId: taskId`), so the "a subagent's internal work is
 * covered by its owner" rule read every Grok shell as some agent's and dropped
 * it: a dev server left running in the background neither kept the tab
 * "monitoring" nor held a deploy's drain.
 */
describe("a task stamped with its own id is its own row (Grok)", () => {
  it("a self-stamped Grok shell is monitoring work, not an owned shell or agent", () => {
    const registry = createLivenessRegistry();
    registry.observe(
      task("task.started", {
        taskId: "01a0c1a7-3335",
        taskType: "shell",
        agentKind: "background",
        agentId: "01a0c1a7-3335",
        toolUseId: "call-1"
      })
    );
    assert.equal(registry.liveness("t1"), "monitoring");
    assert.equal(registry.liveAgentCount("t1"), 0, "a shell is not an agent");
  });

  it("…and leaves on its own terminal row", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "bg-1", taskType: "shell", agentId: "bg-1" }));
    assert.equal(registry.liveness("t1"), "monitoring");
    registry.observe(
      task("task.completed", { taskId: "bg-1", taskType: "shell", agentId: "bg-1", status: "stopped" })
    );
    assert.equal(registry.liveness("t1"), null);
  });

  it("Claude's shapes are unchanged: an agent's shell is its owner's, the parent's monitors", () => {
    const registry = createLivenessRegistry();
    // `claude/normalize.ts` stamps a task's OWNER (the agent whose tool call
    // launched it), never the task itself.
    registry.observe(
      task("task.started", { taskId: "shell-in-agent", taskType: "local_bash", agentId: "agent-1" })
    );
    assert.equal(registry.liveness("t1"), null, "covered by the owning agent's entry");
    registry.observe(task("task.started", { taskId: "parent-shell", taskType: "local_bash" }));
    assert.equal(registry.liveness("t1"), "monitoring");
    registry.observe(task("task.started", { taskId: "agent-1", taskType: "local_agent" }));
    assert.equal(registry.liveness("t1"), "working");
    assert.equal(registry.liveAgentCount("t1"), 1);
  });

  it("Codex's and OpenCode's shapes are unchanged: a self-stamped agent works, rests, stops", () => {
    const registry = createLivenessRegistry();
    // Every Codex/OpenCode task row carries `taskType: "subagent"` and the
    // child's own id as `agentId` (`codex/normalise.ts`, `opencode/normalize.ts`).
    const child = { taskId: "child-1", taskType: "subagent", agentId: "child-1" };
    registry.observe(task("task.started", { ...child, toolUseId: "codex-launch:item-1" }));
    assert.equal(registry.liveness("t1"), "working");
    registry.observe(task("task.updated", { ...child, status: "idle" }));
    assert.equal(registry.liveness("t1"), null, "a resting child is not live");
    const progress = { ...child, description: "agent child-1", status: "running" };
    registry.observe(task("task.progress", progress));
    assert.equal(registry.liveness("t1"), "working");
    // Codex's Stop/exit closer names no taskType at all.
    const closer = { taskId: "child-1", agentId: "child-1", status: "stopped" };
    registry.observe(task("task.completed", closer));
    assert.equal(registry.liveness("t1"), null);
  });
});

/**
 * A Grok agent reports its end (`subagent_finished`) and a heartbeat while it
 * runs, but an agent whose reports stop would hold "working" — and every
 * code-only deploy — for as long as its chat stays open. Every Grok subagent
 * row carries `livenessTtlMs`, and the registry counts the agent live for at
 * most that long after the latest row naming it. Only liveness expires: the
 * roster keeps the row, and a later end is recorded as any end is.
 */
describe("an agent row with a liveness TTL (Grok) expires; every row naming it re-arms it", () => {
  const HOUR = 60 * 60_000;
  const grokAgent = {
    taskId: "call-9",
    taskType: "subagent",
    agentId: "call-9",
    livenessTtlMs: HOUR
  };
  const poll = (status?: string) => ({ ...grokAgent, description: "find callers", status });

  it("reads working for the TTL after its start, then drops out", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { ...grokAgent, toolUseId: "call-9" }));
    assert.equal(registry.liveness("t1"), "working");
    clock.set(HOUR - 1);
    assert.equal(registry.liveness("t1"), "working", "still inside the hour");
    assert.equal(registry.liveAgentCount("t1"), 1);
    clock.set(HOUR);
    assert.equal(registry.liveness("t1"), null, "an hour with no row naming it");
    assert.equal(registry.liveAgentCount("t1"), 0);
  });

  it("a running poll re-arms the hour; a status-free row after expiry does not revive it", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { ...grokAgent, toolUseId: "call-9" }));
    clock.set(HOUR - 1);
    registry.observe(task("task.progress", poll("running")));
    clock.set(2 * HOUR - 2);
    assert.equal(registry.liveness("t1"), "working", "re-armed at the poll");
    clock.set(2 * HOUR - 1);
    assert.equal(registry.liveness("t1"), null);

    registry.observe(task("task.progress", poll()));
    assert.equal(registry.liveness("t1"), null, "no status: not a restart");
    registry.observe(task("task.progress", poll("running")));
    assert.equal(registry.liveness("t1"), "working", "a poll answering running is live work again");
  });

  it("an adapter that answers for the agent overrides its TTL", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock, probe: () => true });
    registry.observe(task("task.started", { ...grokAgent, toolUseId: "call-9" }));
    clock.set(HOUR * 3);
    assert.equal(registry.liveness("t1"), "working");
  });

  it("an agent without a TTL still never expires, beside one that does", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { ...grokAgent, toolUseId: "call-9" }));
    registry.observe(task("task.started", { taskId: "claude-agent", taskType: "local_agent" }));
    clock.set(HOUR * 5);
    assert.equal(registry.liveness("t1"), "working");
    assert.equal(registry.liveAgentCount("t1"), 1, "the Grok agent expired, the other did not");
  });
});
