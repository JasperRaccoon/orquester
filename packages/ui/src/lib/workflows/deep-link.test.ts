import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideDeepLink,
  parseWorkflowDeepLink,
  parseWorkflowRunMessage,
  pendingWorkflowDeepLink,
  requestWorkflowDeepLink,
  stripWorkflowDeepLink,
  subscribeWorkflowDeepLink,
  takeWorkflowDeepLink
} from "./deep-link.ts";

describe("workflow deep links", () => {
  it("parses ?workflow=&run=", () => {
    assert.deepEqual(parseWorkflowDeepLink("?workflow=wf-1&run=run-2"), { workflowId: "wf-1", runId: "run-2" });
    assert.deepEqual(parseWorkflowDeepLink("workflow=wf-1"), { workflowId: "wf-1", runId: null });
    assert.deepEqual(parseWorkflowDeepLink("?workflow=wf-1&run=%3Cscript%3E"), { workflowId: "wf-1", runId: null });
    assert.equal(parseWorkflowDeepLink("?run=run-2"), null);
    assert.equal(parseWorkflowDeepLink("?workflow=../etc"), null);
    assert.equal(parseWorkflowDeepLink(""), null);
  });

  it("strips its parameters and keeps the rest", () => {
    assert.equal(stripWorkflowDeepLink("https://o.example.com/?workflow=a&run=b"), "/");
    assert.equal(stripWorkflowDeepLink("https://o.example.com/app?x=1&workflow=a#h"), "/app?x=1#h");
  });

  it("parses the service worker's message; anything else is null", () => {
    assert.deepEqual(parseWorkflowRunMessage({ type: "orquester:open-workflow-run", workflowId: "w", runId: "r" }), { workflowId: "w", runId: "r" });
    assert.equal(parseWorkflowRunMessage({ type: "other", workflowId: "w" }), null);
    assert.equal(parseWorkflowRunMessage({ type: "orquester:open-workflow-run", workflowId: 3 }), null);
    assert.equal(parseWorkflowRunMessage("orquester:open-workflow-run"), null);
    assert.equal(parseWorkflowRunMessage(null), null);
  });

  it("one pending link, taken once, listeners told", () => {
    let told = 0;
    const off = subscribeWorkflowDeepLink(() => {
      told += 1;
    });
    requestWorkflowDeepLink({ workflowId: "a", runId: null });
    requestWorkflowDeepLink({ workflowId: "b", runId: "r" });
    assert.equal(told, 2);
    assert.deepEqual(pendingWorkflowDeepLink(), { workflowId: "b", runId: "r" });
    assert.deepEqual(takeWorkflowDeepLink(), { workflowId: "b", runId: "r" });
    assert.equal(takeWorkflowDeepLink(), null);
    off();
  });

  it("waits for the connection and the workflows, opens in the workflow's own project", () => {
    const base = { connected: true, workflowsLoaded: true, currentProjectPath: "/w/x/cur" };
    assert.deepEqual(decideDeepLink({ ...base, connected: false, workflow: null }), { kind: "wait" });
    assert.deepEqual(decideDeepLink({ ...base, workflowsLoaded: false, workflow: null }), { kind: "wait" });
    assert.deepEqual(decideDeepLink({ ...base, workflow: { projectPath: "/w/x/own" } }), { kind: "open", projectPath: "/w/x/own" });
    assert.deepEqual(decideDeepLink({ ...base, workflow: { projectPath: null } }), { kind: "open", projectPath: "/w/x/cur" });
    assert.equal(decideDeepLink({ ...base, workflow: null }).kind, "gone");
  });
});
