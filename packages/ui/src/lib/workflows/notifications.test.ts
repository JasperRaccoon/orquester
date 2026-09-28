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
  MAX_TOASTS,
  notifyPrefsOf,
  notifyWorkflowRunFinished,
  observeWorkflowRunEvent,
  resetWorkflowNotifications,
  runOutcomeKind,
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
    assert.deepEqual(notifyPrefsOf(undefined), DEFAULT_NOTIFY_PREFS);
    assert.deepEqual(notifyPrefsOf({ notify: { onFailure: false, onSuccess: true } }), {
      onFailure: false,
      onSuccess: true
    });
    assert.deepEqual(notifyPrefsOf({ notify: { onSuccess: "yes" } } as never), DEFAULT_NOTIFY_PREFS);
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

  it("toasts a failure, and a success only when the workflow asks", () => {
    const failed = finishedRunNotice(run(), { prefs: DEFAULT_NOTIFY_PREFS });
    assert.equal(failed?.title, "Workflow failed: Nightly review");
    assert.equal(failed?.tone, "danger");
    assert.equal(failed?.message, "Review failed: every account is out of usage");
    assert.equal(failed?.projectPath, "/w/acme/app");
    assert.equal(finishedRunNotice(run({ status: "succeeded" }), { prefs: DEFAULT_NOTIFY_PREFS }), null);
    const ok = finishedRunNotice(run({ status: "succeeded", error: undefined }), {
      prefs: { onFailure: true, onSuccess: true }
    });
    assert.equal(ok?.title, "Workflow finished: Nightly review");
    assert.equal(ok?.tone, "ok");
    assert.equal(finishedRunNotice(run(), { prefs: { onFailure: false, onSuccess: true } }), null);
    assert.equal(finishedRunNotice(run({ status: "cancelled" }), { prefs: DEFAULT_NOTIFY_PREFS }), null);
    assert.equal(
      finishedRunNotice(run({ test: true }), { prefs: DEFAULT_NOTIFY_PREFS })?.title,
      "Test run failed: Nightly review"
    );
  });

  it("says nothing about a run on screen or a sub-workflow's run", () => {
    assert.equal(finishedRunNotice(run(), { prefs: DEFAULT_NOTIFY_PREFS, viewing: true }), null);
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
    assert.equal(
      attentionEntryFor(run({ status: "succeeded" }), { prefs: { onFailure: true, onSuccess: true } }),
      null
    );
    assert.equal(attentionEntryFor(run(), { prefs: { onFailure: false, onSuccess: false } }), null);
    assert.equal(
      attentionEntryFor(run({ status: "interrupted", error: undefined }), { prefs: DEFAULT_NOTIFY_PREFS })?.detail,
      "Interrupted"
    );
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

  it("stays quiet for the run the user is looking at", () => {
    observeWorkflowRunEvent({ type: "workflowRun.finished", payload: { run: run() } }, { viewingRunId: "run-1" });
    assert.deepEqual(state(), { toasts: [], attention: [] });
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
    markWorkflowRunViewed("run-3");
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

  it("keeps a bounded queue, newest first", () => {
    for (let index = 0; index < MAX_TOASTS + 3; index += 1) notifyWorkflowRunFinished(run({ id: `r${index}` }));
    assert.equal(state().toasts.length, MAX_TOASTS);
    assert.equal(state().toasts[0]?.runId, `r${MAX_TOASTS + 2}`);
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
    assert.equal(state().toasts[0]?.title, "Workflow finished: Nightly review");
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
