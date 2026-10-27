import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { WorkflowRunSummary } from "@orquester/api";

import {
  dismissWorkflowAttention,
  dismissWorkflowToasts,
  finishedRunNotice,
  markWorkflowRunViewed,
  notifyPrefsOf,
  notifyWorkflowRunFinished,
  observeWorkflowRunEvent,
  resetWorkflowNotifications,
  setRunOnScreen,
  workflowNotificationsStore
} from "./notifications.ts";
import { resetWorkflows, workflowsStore } from "./store.ts";

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run-1",
    workflowId: "wf",
    workflowName: "Nightly review",
    status: "failed",
    trigger: { kind: "schedule", text: "Every night" },
    test: false,
    queuedAt: "2026-09-28T02:00:00.000Z",
    startedAt: "2026-09-28T02:00:00.000Z",
    endedAt: "2026-09-28T02:12:00.000Z",
    error: "Review failed: every account is out of usage",
    projectPath: "/w/acme/app",
    ...overrides
  };
}

const state = () => workflowNotificationsStore.getState();

describe("notification rules", () => {
  it("reads notify settings field-wise, defaulting to failures only", () => {
    assert.deepEqual(notifyPrefsOf(undefined), { onFailure: true, onSuccess: false });
    assert.deepEqual(notifyPrefsOf({ notify: { onFailure: false, onSuccess: true } }), {
      onFailure: false,
      onSuccess: true
    });
    assert.deepEqual(notifyPrefsOf({ notify: { onSuccess: "yes" } } as never), { onFailure: true, onSuccess: false });
  });

  it("counts a Stop block's end as a success and a cancel or a skip as nothing", () => {
    const context = { prefs: { onFailure: true, onSuccess: true } };
    for (const status of ["failed", "interrupted"] as const) {
      assert.equal(finishedRunNotice(run({ status }), { prefs: { onFailure: true, onSuccess: false } })?.runId, "run-1");
    }
    for (const status of ["succeeded", "stopped"] as const) {
      assert.equal(finishedRunNotice(run({ status }), { prefs: { onFailure: false, onSuccess: true } })?.runId, "run-1");
    }
    for (const status of ["cancelled", "skipped", "running"] as const) {
      assert.equal(finishedRunNotice(run({ status }), context), null);
    }
  });
});

describe("the notifications store", () => {
  beforeEach(() => {
    resetWorkflowNotifications();
    resetWorkflows();
  });

  it("raises a toast and an entry once per run, however often the event arrives", () => {
    const event = { type: "workflowRun.finished", payload: { run: run() } };
    observeWorkflowRunEvent(event);
    observeWorkflowRunEvent(event);
    assert.equal(state().toasts.length, 1);
    assert.equal(state().toasts[0]?.tone, "danger");
    assert.equal(state().toasts[0]?.message, "Review failed: every account is out of usage");
    assert.equal(state().toasts[0]?.projectPath, "/w/acme/app");
    assert.deepEqual(state().attention, [{
      runId: "run-1",
      workflowId: "wf",
      workflowName: "Nightly review",
      detail: "Review failed: every account is out of usage",
      at: "2026-09-28T02:12:00.000Z",
      projectPath: "/w/acme/app"
    }]);
    // Other events and malformed payloads are ignored.
    observeWorkflowRunEvent({ type: "workflowRun.updated", payload: { run: run({ id: "run-2" }) } });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: { id: 3 } } });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: null });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run({ id: "child", parentRunId: "p" }) } });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run({ id: "success", status: "succeeded" }) } });
    assert.equal(state().toasts.length, 1);
    assert.equal(state().attention.length, 1);
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run({ id: "test", test: true }) } });
    assert.equal(state().toasts[0]?.runId, "test");
    assert.equal(state().toasts[0]?.test, true);
    assert.equal(state().attention.length, 1, "test runs never enter the Attention Center");
  });

  it("stays quiet for the run the user is looking at", () => {
    const view = {};
    setRunOnScreen(view, "run-1");
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run() } });
    setRunOnScreen(view, null);
    assert.deepEqual(state(), { toasts: [], attention: [] });
  });

  it("a mounted run in a hidden document does not swallow the failure", () => {
    const view = {};
    setRunOnScreen(view, "run-2");
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "hidden" } });
    try {
      observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run({ id: "run-2" }) } });
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
      setRunOnScreen(view, null);
    }
    assert.equal(state().attention[0]?.runId, "run-2");
  });

  it("viewing a LIVE run never silences its later failure", () => {
    markWorkflowRunViewed("run-live");
    notifyWorkflowRunFinished(run({ id: "run-live" }));
    assert.equal(state().attention.some((entry) => entry.runId === "run-live"), true);
  });

  it("the workflow summary's notify settings decide (a success toast when asked, no failure when off)", () => {
    workflowsStore.setState({
      summaries: new Map([["wf", { id: "wf", notify: { onFailure: false, onSuccess: true } } as never]])
    });
    notifyWorkflowRunFinished(run({ id: "f" }));
    assert.equal(state().toasts.length, 0);
    assert.equal(state().attention.length, 0);
    notifyWorkflowRunFinished(run({ id: "s", status: "succeeded", error: undefined }));
    assert.equal(state().toasts[0]?.runId, "s");
  });

  it("clears a run's toast and entry once it is viewed, and stays quiet about it after", () => {
    notifyWorkflowRunFinished(run());
    notifyWorkflowRunFinished(run({ id: "run-2" }));
    markWorkflowRunViewed("run-1");
    assert.deepEqual(
      state().toasts.map((toast) => toast.runId),
      ["run-2"]
    );
    assert.deepEqual(
      state().attention.map((entry) => entry.runId),
      ["run-2"]
    );
    markWorkflowRunViewed("run-3", { finished: true });
    notifyWorkflowRunFinished(run({ id: "run-3" }));
    assert.equal(
      state().attention.some((entry) => entry.runId === "run-3"),
      false
    );
  });

  it("dismisses the toasts and one entry at a time", () => {
    notifyWorkflowRunFinished(run());
    notifyWorkflowRunFinished(run({ id: "run-2" }));
    assert.deepEqual(
      state().toasts.map((toast) => toast.runId),
      ["run-2", "run-1"]
    );
    dismissWorkflowToasts();
    assert.equal(state().toasts.length, 0);
    assert.equal(state().attention.length, 2);
    dismissWorkflowAttention("run-1");
    assert.deepEqual(
      state().attention.map((entry) => entry.runId),
      ["run-2"]
    );
  });

  it("reads the workflow's notify settings from a loaded run's definition", () => {
    workflowsStore.setState({
      runs: {
        "run-9": {
          summary: run({ id: "run-9", status: "succeeded" }),
          detail: {
            ...run({ id: "run-9", status: "succeeded" }),
            definition: { id: "wf", settings: { notify: { onFailure: true, onSuccess: true } } } as never,
            triggerPayload: null,
            blocks: {},
            takenEdges: [],
            deadEdges: []
          },
          blocks: {},
          takenEdges: [],
          deadEdges: [],
          error: null
        }
      }
    });
    notifyWorkflowRunFinished(run({ id: "run-9", status: "succeeded", error: undefined }));
    assert.equal(state().toasts[0]?.runId, "run-9");
    assert.equal(state().toasts[0]?.tone, "ok");
    // A success is never an Attention entry.
    assert.equal(state().attention.length, 0);
  });

  it("forgets everything on a connection switch", () => {
    notifyWorkflowRunFinished(run());
    resetWorkflowNotifications();
    assert.deepEqual(state(), { toasts: [], attention: [] });
    notifyWorkflowRunFinished(run());
    assert.equal(state().toasts.length, 1);
  });
});
