/**
 * The app store's hooks into the workflows store, and the `workflow` tab
 * kind: `/events` messages of the `workflows` channel reach the module store,
 * editor tabs open once per workflow, follow renames and close with their
 * workflow.
 *
 * The routing and tab actions run on the actual app store.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { WORKFLOWS_CHANNEL, type WorkflowSummary } from "@orquester/api";

import { useAppStore } from "../../store/app.ts";
import { resetWorkflows, workflowsStore } from "./store.ts";

const P = "/w/acme/app";
const Q = "/w/acme/other";

function summary(overrides: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    name: `Workflow ${overrides.id}`,
    enabled: false,
    revision: 1,
    project: { kind: "existing", projectPath: P },
    triggers: [],
    nodeCount: 1,
    errorCount: 0,
    activeRuns: [],
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides
  };
}

const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:${type}`,
  channel,
  type,
  createdAt: "2026-09-28T10:00:00.000Z",
  payload
});

const app = () => useAppStore.getState();

beforeEach(() => {
  resetWorkflows();
  useAppStore.setState({ workflowTabsByProject: {}, activeTabByProject: {}, sessions: [], browsers: [] });
});

describe("the app store routes workflow events", () => {
  it("an upsert and a delete on the workflows channel reach the module store", () => {
    app().applyEvent(event(WORKFLOWS_CHANNEL, "workflow.upserted", { workflow: summary({ id: "a" }) }));
    assert.equal(workflowsStore.getState().summaries.get("a")?.name, "Workflow a");
    app().applyEvent(event(WORKFLOWS_CHANNEL, "workflow.deleted", { id: "a" }));
    assert.equal(workflowsStore.getState().summaries.has("a"), false);
  });

  it("the same message on another channel does not reach workflows", () => {
    app().applyEvent(event("elsewhere", "workflow.upserted", { workflow: summary({ id: "a" }) }));
    assert.equal(workflowsStore.getState().summaries.size, 0);
  });
});

describe("the workflow tab kind", () => {
  it("opens one tab per workflow per project, reusing it and updating its run", () => {
    app().applyEvent(event(WORKFLOWS_CHANNEL, "workflow.upserted", { workflow: summary({ id: "a", name: "Nightly" }) }));
    app().openWorkflowTab(P, "a");
    const [tab] = app().workflowTabsByProject[P] ?? [];
    assert.ok(tab);
    assert.equal(tab.title, "Nightly", "titled after the workflow the store knows");
    assert.equal(tab.runId, null);
    assert.equal(app().activeTabByProject[P], tab.id);

    useAppStore.setState({ activeTabByProject: { [P]: "something-else" } });
    app().openWorkflowTab(P, "a", { runId: "r1" });
    const tabs = app().workflowTabsByProject[P] ?? [];
    assert.equal(tabs.length, 1, "reused");
    assert.equal(tabs[0]?.runId, "r1");
    assert.equal(app().activeTabByProject[P], tab.id, "and focused");

    app().openWorkflowTab(P, "a");
    assert.equal(app().workflowTabsByProject[P]?.[0]?.runId, "r1", "an absent runId leaves the run");
    app().openWorkflowTab(P, "a", { runId: null });
    assert.equal(app().workflowTabsByProject[P]?.[0]?.runId, null, "null clears it");

    app().openWorkflowTab(Q, "a");
    assert.equal(app().workflowTabsByProject[Q]?.length, 1, "another project gets its own tab: a tab is a view");
  });

  it("an unknown workflow takes the caller's title", () => {
    app().openWorkflowTab(P, "zz", { title: "Fresh" });
    assert.equal(app().workflowTabsByProject[P]?.[0]?.title, "Fresh");
  });

  it("follows a rename and closes with its workflow, handing the focus on", () => {
    app().openWorkflowTab(P, "a", { title: "Old" });
    app().openWorkflowTab(P, "b", { title: "Other" });
    app().openWorkflowTab(Q, "a", { title: "Old" });

    app().applyEvent(event(WORKFLOWS_CHANNEL, "workflow.upserted", { workflow: summary({ id: "a", name: "Renamed" }) }));
    assert.equal(app().workflowTabsByProject[P]?.[0]?.title, "Renamed");
    assert.equal(app().workflowTabsByProject[Q]?.[0]?.title, "Renamed");

    const aTab = app().workflowTabsByProject[P]?.[0]?.id;
    const bTab = app().workflowTabsByProject[P]?.[1]?.id;
    useAppStore.setState({ activeTabByProject: { ...app().activeTabByProject, [P]: aTab ?? null } });
    app().applyEvent(event(WORKFLOWS_CHANNEL, "workflow.deleted", { id: "a" }));
    assert.deepEqual(app().workflowTabsByProject[P]?.map((t) => t.workflowId), ["b"]);
    assert.deepEqual(app().workflowTabsByProject[Q], []);
    assert.equal(app().activeTabByProject[P], bTab, "the focus moves to the next tab");
    assert.equal(app().activeTabByProject[Q], null);
  });

  it("closeTab closes a workflow tab like any local tab", async () => {
    app().openWorkflowTab(P, "a", { title: "A" });
    const id = app().workflowTabsByProject[P]?.[0]?.id ?? "";
    await app().closeTab(id);
    assert.deepEqual(app().workflowTabsByProject[P], []);
    assert.equal(app().activeTabByProject[P], null);
  });
});
