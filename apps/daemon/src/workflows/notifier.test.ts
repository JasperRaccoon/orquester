// The gate push (spec 2026-11-10 §6.4): one per person phase, deep-linking to the run and gate;
// none for a test run's gate.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowGateState } from "@orquester/api";

import { createWorkflowNotifier, type WorkflowGatePushPayload } from "./notifier.ts";
import { flush, ManualClock, node, workflow } from "./testing/fakes.ts";

const gate = (over: Partial<WorkflowGateState> = {}): WorkflowGateState => ({
  gateId: "g-1", runId: "r-1", workflowId: "w1", nodeId: "G", nodeName: "Approve", source: "gate", question: "Ship 1.2?",
  choices: [{ id: "approve", label: "Approve", comment: "none" }], decider: { kind: "human", label: "you" }, phase: "person",
  openedAt: "2026-11-10T12:00:00.000Z", escalated: false, ...over
});

test("a gate waiting for the person pushes with its deep link; an escalation says who handed it over; a test gate pushes nothing", async () => {
  const pushed: WorkflowGatePushPayload[] = [];
  const notifier = createWorkflowNotifier({ push: { notifyWorkflowRun: async () => undefined, notifyWorkflowGate: async (payload) => void pushed.push(payload) }, clock: new ManualClock() });
  const wf = workflow("w1", [node("T", "trigger.manual")], [], { name: "Deploy" });
  notifier.gateWaiting!(gate(), wf);
  notifier.gateWaiting!(gate({ gateId: "g-2", escalated: true, decider: { kind: "agent", label: "Reviewer agent (claude)" } }), wf);
  notifier.gateWaiting!(gate({ gateId: "g-3", test: true }), wf);
  await flush();
  assert.deepEqual(pushed, [
    { title: "Needs you: Deploy", body: "Ship 1.2?", tag: "workflow-gate-r-1-g-1", workflowId: "w1", runId: "r-1", gateId: "g-1" },
    { title: "Needs you: Deploy", body: "Ship 1.2? — Reviewer agent (claude) handed it to you.", tag: "workflow-gate-r-1-g-2", workflowId: "w1", runId: "r-1", gateId: "g-2" }
  ]);
});
