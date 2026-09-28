import test from "node:test";
import assert from "node:assert/strict";

import { openWorkflowRun, subscribeOpenWorkflowRun, workflowRunTargetOf } from "./open-bridge.ts";

const target = { workflowId: "wf-1", runId: "run-1", nodeId: "node-1" };

test("with no listener, opening a run is a no-op that reports false", () => {
  assert.equal(openWorkflowRun(target), false);
});

test("every listener takes the run, and unsubscribing takes it out", () => {
  const a: unknown[] = [];
  const b: unknown[] = [];
  const stopA = subscribeOpenWorkflowRun((next) => a.push(next));
  const stopB = subscribeOpenWorkflowRun((next) => b.push(next));
  assert.equal(openWorkflowRun(target), true);
  assert.deepEqual(a, [target]);
  assert.deepEqual(b, [target]);
  stopA();
  assert.equal(openWorkflowRun(target), true);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  stopB();
  assert.equal(openWorkflowRun(target), false, "no listener left");
});

test("a listener that unsubscribes while being called does not skip the others", () => {
  const seen: string[] = [];
  const stopFirst = subscribeOpenWorkflowRun(() => {
    seen.push("first");
    stopFirst();
  });
  const stopSecond = subscribeOpenWorkflowRun(() => seen.push("second"));
  openWorkflowRun(target);
  assert.deepEqual(seen, ["first", "second"]);
  stopSecond();
});

test("only a chat tab with a whole workflow owner links to a run", () => {
  const owner = { kind: "workflow" as const, ...target };
  assert.deepEqual(workflowRunTargetOf({ kind: "agent-chat", owner }), target);
  assert.equal(workflowRunTargetOf({ kind: "agent-chat" }), null);
  assert.equal(workflowRunTargetOf({ kind: "shell", owner }), null);
  assert.equal(workflowRunTargetOf(null), null);
  assert.equal(workflowRunTargetOf(undefined), null);
  for (const bad of [{ ...owner, kind: "cron" }, { ...owner, runId: "" }, { ...owner, nodeId: 3 }, "wf"]) {
    assert.equal(
      workflowRunTargetOf({ kind: "agent-chat", owner: bad as unknown as typeof owner }),
      null,
      JSON.stringify(bad)
    );
  }
});
