import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { BACKGROUND_LIVENESS_TTL_MS, createLivenessRegistry } from "./liveness.ts";
import { createTestClock } from "./testing/fakes.ts";

const base = { eventId: "e", threadId: "t1", createdAt: "1970-01-01T00:00:00.000Z" };

const turn = (type: "turn.started" | "turn.completed" | "turn.aborted"): RuntimeEvent =>
  ({ ...base, type, turnId: "turn-1", payload: {} }) as unknown as RuntimeEvent;

const task = (
  type: "task.started" | "task.progress" | "task.updated" | "task.completed",
  payload: Record<string, unknown>
): RuntimeEvent => ({ ...base, type, payload }) as unknown as RuntimeEvent;

describe("background liveness registry (§3.1)", () => {
  it("is null for an untouched thread", () => {
    const registry = createLivenessRegistry();
    assert.equal(registry.liveness("t1"), null);
    assert.equal(registry.liveAgentCount("t1"), 0);
  });

  it("any live agent work reads as working", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    assert.equal(registry.liveness("t1"), "working");
    assert.equal(registry.liveAgentCount("t1"), 1);
  });

  it("watch loops alone read as monitoring", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    assert.equal(registry.liveness("t1"), "monitoring");
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    assert.equal(registry.liveness("t1"), "working", "agent work outranks a watch loop");
  });

  it("idle and every terminal status drop out", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    registry.observe(task("task.updated", { taskId: "a1", taskType: "subagent", status: "idle" }));
    assert.equal(registry.liveness("t1"), null);
    registry.observe(task("task.started", { taskId: "a2", taskType: "subagent" }));
    registry.observe(task("task.completed", { taskId: "a2", status: "completed" }));
    assert.equal(registry.liveness("t1"), null);
  });

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

  it("session.exited clears the thread", () => {
    const registry = createLivenessRegistry();
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    registry.observe({
      ...base,
      type: "session.exited",
      payload: { recoverable: false, exitKind: "error" }
    } as unknown as RuntimeEvent);
    assert.equal(registry.liveness("t1"), null);
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
 * Grok reports a backgrounded task's end only in a snapshot or a poll the
 * model asks for (fixtures README observation 29), so without a bound
 * `backgroundLiveness` could read `"monitoring"` for the rest of the host's
 * life and the §6.4 ladder would keep the tab out of "finished" forever.
 */
describe("background liveness expiry (Grok: tasks that never complete)", () => {
  it("drops a watch loop that has been silent for the TTL", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    assert.equal(registry.liveness("t1"), "monitoring");

    clock.set(BACKGROUND_LIVENESS_TTL_MS - 1);
    assert.equal(registry.liveness("t1"), "monitoring", "still inside the window");

    clock.set(BACKGROUND_LIVENESS_TTL_MS);
    assert.equal(registry.liveness("t1"), null, "silent for the whole window");
  });

  it("a transition refreshes the window", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    clock.set(BACKGROUND_LIVENESS_TTL_MS - 1);
    registry.observe(task("task.progress", { taskId: "m1", taskType: "monitor", status: "running" }));
    clock.set(BACKGROUND_LIVENESS_TTL_MS + 1);
    assert.equal(registry.liveness("t1"), "monitoring");
    clock.set(BACKGROUND_LIVENESS_TTL_MS * 2);
    assert.equal(registry.liveness("t1"), null);
  });

  it("never expires an agent — a subagent that runs for hours is real work", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    clock.set(BACKGROUND_LIVENESS_TTL_MS * 100);
    assert.equal(registry.liveness("t1"), "working");
    assert.equal(registry.liveAgentCount("t1"), 1);
  });

  it("a turn ending drops a watch loop that reported nothing during it", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));

    clock.set(1_000);
    registry.observe(turn("turn.started"));
    clock.set(2_000);
    registry.observe(turn("turn.completed"));
    assert.equal(registry.liveness("t1"), null, "silent for the whole turn");
  });

  it("…but keeps one that did report during the turn", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(turn("turn.started"));
    clock.set(500);
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    clock.set(1_000);
    registry.observe(turn("turn.completed"));
    assert.equal(registry.liveness("t1"), "monitoring");
  });

  it("an aborted turn sweeps the same way", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    clock.set(1_000);
    registry.observe(turn("turn.started"));
    clock.set(2_000);
    registry.observe(turn("turn.aborted"));
    assert.equal(registry.liveness("t1"), null);
  });

  it("a turn end with no turn start recorded leaves the registry alone", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "m1", taskType: "monitor" }));
    registry.observe(turn("turn.completed"));
    assert.equal(registry.liveness("t1"), "monitoring");
  });

  it("an agent survives the turn-boundary sweep", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { taskId: "a1", taskType: "subagent" }));
    clock.set(1_000);
    registry.observe(turn("turn.started"));
    clock.set(2_000);
    registry.observe(turn("turn.completed"));
    assert.equal(registry.liveness("t1"), "working");
  });
});

/**
 * An `agentId` names the agent a task belongs to. Grok stamps a background
 * shell with ITSELF (`adapters/grok/normalize.ts`, every `task.*` of a shell
 * carries `agentId: taskId`), so the "a subagent's internal work is covered by
 * its owner" rule read every Grok shell as some agent's and dropped it: a dev
 * server left running in the background neither kept the tab "monitoring" nor
 * held a deploy's drain.
 */
describe("a task stamped with its own id is its own row (Grok)", () => {
  it("a Grok background shell is live monitoring work, bounded by the TTL", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
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

    clock.set(BACKGROUND_LIVENESS_TTL_MS - 1);
    assert.equal(registry.liveness("t1"), "monitoring");
    clock.set(BACKGROUND_LIVENESS_TTL_MS);
    assert.equal(registry.liveness("t1"), null, "silent for the whole window, like any watch loop");
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

  it("a Grok subagent — stamped with itself, typed subagent — is working until its end", () => {
    const registry = createLivenessRegistry();
    const agent = { taskId: "call-9", taskType: "subagent", agentId: "call-9" };
    registry.observe(task("task.started", { ...agent, toolUseId: "call-9" }));
    assert.equal(registry.liveness("t1"), "working");
    registry.observe(task("task.completed", { ...agent, status: "completed" }));
    assert.equal(registry.liveness("t1"), null);
  });
});

/**
 * A Grok agent's end is reported only when the model polls it or kills it, so
 * an agent nobody polls again would hold "working" — and every code-only
 * deploy — for as long as its chat stays open. Every Grok subagent row carries
 * `livenessTtlMs`, and the registry counts the agent live for at most that long
 * after the latest row naming it. Only liveness expires: the roster keeps the
 * row, and a later end is recorded as any end is.
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

  it("its end drops it, and an end after expiry changes nothing", () => {
    const clock = createTestClock(0);
    const registry = createLivenessRegistry({ clock });
    registry.observe(task("task.started", { ...grokAgent, toolUseId: "call-9" }));
    clock.set(HOUR);
    assert.equal(registry.liveness("t1"), null);
    registry.observe(task("task.completed", { ...grokAgent, status: "completed" }));
    assert.equal(registry.liveness("t1"), null);
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
