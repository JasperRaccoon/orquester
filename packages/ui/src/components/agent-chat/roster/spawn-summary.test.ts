import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import { deriveAgentSpawnSummary } from "./spawn-summary.ts";

function member(status: RuntimeSubagentStatus, kind: "subagent" | "subagent_batch" = "subagent") {
  return { kind, status } as const;
}

test("a live batch leads with the kick-off and counts the workers", () => {
  const summary = deriveAgentSpawnSummary({
    agents: [member("running"), member("waiting"), member("completed")],
    agentCount: 3
  });
  assert.equal(summary.live, true);
  assert.equal(summary.lead, "Kicked off 3 subagents");
  assert.equal(summary.status, "2 working");
  assert.equal(summary.tone, "working");
});

test("a settled batch leads with the past tense and reports its worst outcome", () => {
  const failed = deriveAgentSpawnSummary({
    agents: [member("completed"), member("failed")],
    agentCount: 2
  });
  assert.equal(failed.live, false);
  assert.equal(failed.lead, "Ran 2 subagents");
  assert.equal(failed.status, "1 failed");
  assert.equal(failed.tone, "failed");

  const done = deriveAgentSpawnSummary({
    agents: [member("completed"), member("completed")],
    agentCount: 2
  });
  assert.equal(done.status, "✓ completed");
  assert.equal(done.tone, "completed");

  const stopped = deriveAgentSpawnSummary({
    agents: [member("completed"), member("interrupted")],
    agentCount: 2
  });
  assert.equal(stopped.status, "1 stopped");

  const idle = deriveAgentSpawnSummary({
    agents: [member("completed"), member("idle")],
    agentCount: 2
  });
  assert.equal(idle.status, "1 idle");
});

test("a member the roster cannot resolve is never read as completed", () => {
  const partial = deriveAgentSpawnSummary({
    agents: [member("completed")],
    agentCount: 3
  });
  assert.equal(partial.status, "Status unavailable");
  assert.equal(partial.tone, "inactive");

  const none = deriveAgentSpawnSummary({ agents: [], agentCount: 2 });
  assert.equal(none.live, false);
  assert.equal(none.status, "Status unavailable");
});

test("a coordinator decides liveness even while no member is working", () => {
  const between = deriveAgentSpawnSummary({
    agents: [member("completed")],
    agentCount: 1,
    coordinatorStatus: "running"
  });
  assert.equal(between.live, true);
  assert.equal(between.status, "working");

  const failedRun = deriveAgentSpawnSummary({
    agents: [member("completed")],
    agentCount: 1,
    coordinatorStatus: "failed"
  });
  assert.equal(failedRun.status, "Workflow failed");
  assert.equal(failedRun.tone, "failed");

  const stoppedRun = deriveAgentSpawnSummary({
    agents: [member("completed")],
    agentCount: 1,
    coordinatorStatus: "cancelled"
  });
  assert.equal(stoppedRun.status, "Workflow stopped");
});

test("batches are named as batches", () => {
  const batch = deriveAgentSpawnSummary({
    agents: [member("running", "subagent_batch")],
    agentCount: 1
  });
  assert.equal(batch.lead, "Launched 1 subagent batch");

  const mixed = deriveAgentSpawnSummary({
    agents: [member("running", "subagent_batch"), member("running")],
    agentCount: 2
  });
  assert.equal(mixed.lead, "Launched 1 subagent and 1 batch");
});
