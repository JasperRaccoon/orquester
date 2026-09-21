import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { createLivenessRegistry } from "./liveness.ts";

const base = { eventId: "e", threadId: "t1", createdAt: "1970-01-01T00:00:00.000Z" };

const task = (
  type: "task.started" | "task.progress" | "task.updated" | "task.completed",
  payload: Record<string, unknown>
): RuntimeEvent => ({ ...base, type, payload } as RuntimeEvent);

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
    } as RuntimeEvent);
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
