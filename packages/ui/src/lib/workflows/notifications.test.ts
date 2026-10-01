import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { WorkflowRunSummary } from "@orquester/api";

import {
  attentionEntryFor,
  DEFAULT_NOTIFY_PREFS,
  dismissWorkflowAttention,
  dismissWorkflowToasts,
  finishedRunNotice,
  markWorkflowRunViewed,
  notifyPrefsOf,
  notifyWorkflowRunFinished,
  observeWorkflowRunEvent,
  resetWorkflowNotifications,
  runOutcomeKind,
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
    assert.equal(runOutcomeKind("failed"), "failure");
    assert.equal(runOutcomeKind("interrupted"), "failure");
    assert.equal(runOutcomeKind("succeeded"), "success");
    assert.equal(runOutcomeKind("stopped"), "success");
    assert.equal(runOutcomeKind("cancelled"), "quiet");
    assert.equal(runOutcomeKind("skipped"), "quiet");
    assert.equal(runOutcomeKind("running"), "quiet");
  });

  it("preserves the failure's error, project and test-run identity in its toast", () => {
    const failed = finishedRunNotice(run(), { prefs: DEFAULT_NOTIFY_PREFS });
    assert.equal(failed?.tone, "danger");
    assert.match(failed!.message, /every account is out of usage/);
    assert.equal(failed?.projectPath, "/w/acme/app");
    assert.equal(finishedRunNotice(run({ status: "succeeded" }), { prefs: DEFAULT_NOTIFY_PREFS }), null);
    assert.equal(
      finishedRunNotice(run({ test: true }), { prefs: DEFAULT_NOTIFY_PREFS })?.test,
      true
    );
  });

  it("says nothing about a sub-workflow's run", () => {
    assert.equal(finishedRunNotice(run({ parentRunId: "p" }), { prefs: DEFAULT_NOTIFY_PREFS }), null);
  });

  it("puts failed runs in the Attention Center, never test runs", () => {
    const entry = attentionEntryFor(run(), { prefs: DEFAULT_NOTIFY_PREFS });
    assert.deepEqual(entry, {
      runId: "run-1",
      workflowId: "wf",
      workflowName: "Nightly review",
      detail: "Review failed: every account is out of usage",
      at: "2026-09-28T02:12:00.000Z",
      projectPath: "/w/acme/app"
    });
    assert.equal(attentionEntryFor(run({ test: true }), { prefs: DEFAULT_NOTIFY_PREFS }), null);
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
    assert.equal(state().attention.length, 1);
    // Other events and malformed payloads are ignored.
    observeWorkflowRunEvent({ type: "workflowRun.updated", payload: { run: run({ id: "run-2" }) } });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: { id: 3 } } });
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: null });
    assert.equal(state().toasts.length, 1);
  });

  it("remembers the latest 500 distinct runs without refreshing repeated events", () => {
    for (let index = 0; index < 500; index += 1) {
      notifyWorkflowRunFinished(run({ id: `run-${index}` }), { viewing: true });
    }
    notifyWorkflowRunFinished(run({ id: "run-0" }), { viewing: true });
    notifyWorkflowRunFinished(run({ id: "run-500" }), { viewing: true });

    notifyWorkflowRunFinished(run({ id: "run-1" }));
    assert.equal(state().toasts.length, 0, "the next oldest run is still remembered");
    notifyWorkflowRunFinished(run({ id: "run-0" }));
    assert.deepEqual(state().toasts.map((toast) => toast.runId), ["run-0"]);
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
