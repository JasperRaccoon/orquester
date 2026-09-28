/**
 * Automated workflows — finished-run notifications in the open clients
 * (workflows spec §5.11): a toast when a run fails (and, when the workflow
 * asks for it, when one succeeds), and a "Workflow failed" entry in the
 * Attention Center that opens the run, is dismissible, and clears once the
 * run is viewed. The Web Push is the daemon's; this is the in-app half.
 *
 * The rules are pure (`finishedRunNotice`, `attentionEntryFor`); the module
 * store below holds what is on screen, fed by `observeWorkflowRunEvent` from
 * the app store's event router. Memory only: a notice is about now, and the
 * run history keeps every run for whoever missed it.
 */

import { createStore } from "zustand/vanilla";

import type { WorkflowRunSummary, WorkflowSettings } from "@orquester/api";

import { sanitizeRunSummary, isRecord } from "./sanitize";
import { workflowsStore } from "./store";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface WorkflowNotifyPrefs {
  onFailure: boolean;
  onSuccess: boolean;
}

/** The schema's defaults: failures on, successes off. */
export const DEFAULT_NOTIFY_PREFS: WorkflowNotifyPrefs = { onFailure: true, onSuccess: false };

/** A workflow's `settings.notify`, field-wise, falling back to the defaults. */
export function notifyPrefsOf(
  settings: Partial<Pick<WorkflowSettings, "notify">> | null | undefined
): WorkflowNotifyPrefs {
  const notify = (settings as { notify?: unknown } | null | undefined)?.notify;
  if (!isRecord(notify)) return DEFAULT_NOTIFY_PREFS;
  return {
    onFailure: typeof notify.onFailure === "boolean" ? notify.onFailure : DEFAULT_NOTIFY_PREFS.onFailure,
    onSuccess: typeof notify.onSuccess === "boolean" ? notify.onSuccess : DEFAULT_NOTIFY_PREFS.onSuccess
  };
}

export type RunOutcomeKind = "failure" | "success" | "quiet";

/**
 * How a finished run counts for notifications: failed/interrupted are
 * failures; succeeded and a Stop block's end are successes (§3.4); a user's
 * cancel and a skipped fire say nothing (the user did it, or nothing ran).
 */
export function runOutcomeKind(status: WorkflowRunSummary["status"]): RunOutcomeKind {
  switch (status) {
    case "failed":
    case "interrupted":
      return "failure";
    case "succeeded":
    case "stopped":
      return "success";
    default:
      return "quiet";
  }
}

export interface WorkflowRunNotice {
  /** The run it is about (also its identity: one notice per run). */
  runId: string;
  workflowId: string;
  workflowName: string;
  tone: "danger" | "ok";
  title: string;
  message: string;
  /** The run's project, when it ran in an existing one. */
  projectPath?: string;
  test: boolean;
  at: string;
}

export interface NoticeContext {
  prefs: WorkflowNotifyPrefs;
  /** The user is looking at this run right now: nothing to tell them. */
  viewing?: boolean;
}

/** The toast a finished run raises, or `null`. A sub-workflow's run speaks through its parent. */
export function finishedRunNotice(run: WorkflowRunSummary, context: NoticeContext): WorkflowRunNotice | null {
  if (context.viewing || run.parentRunId) return null;
  const kind = runOutcomeKind(run.status);
  if (kind === "quiet") return null;
  if (kind === "failure" && !context.prefs.onFailure) return null;
  if (kind === "success" && !context.prefs.onSuccess) return null;
  const name = run.workflowName.trim() || "Workflow";
  const failed = kind === "failure";
  const detail = run.error?.trim();
  const message = failed
    ? detail || (run.status === "interrupted" ? "It was interrupted and could not be resumed." : "A block failed.")
    : run.status === "stopped"
      ? "Ended at a Stop block."
      : "Every step finished.";
  const notice: WorkflowRunNotice = {
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: name,
    tone: failed ? "danger" : "ok",
    title: `${run.test ? "Test run" : "Workflow"} ${failed ? "failed" : "finished"}: ${name}`,
    message,
    test: run.test,
    at: run.endedAt ?? new Date().toISOString()
  };
  if (run.projectPath) notice.projectPath = run.projectPath;
  return notice;
}

export interface WorkflowAttentionEntry {
  runId: string;
  workflowId: string;
  workflowName: string;
  /** One line: the run's error, else what happened. */
  detail: string;
  projectPath?: string;
  at: string;
}

/** An Attention Center entry for a failed run (never a test run, never a sub-workflow's), or `null`. */
export function attentionEntryFor(run: WorkflowRunSummary, context: NoticeContext): WorkflowAttentionEntry | null {
  if (context.viewing || run.parentRunId || run.test) return null;
  if (runOutcomeKind(run.status) !== "failure" || !context.prefs.onFailure) return null;
  const entry: WorkflowAttentionEntry = {
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName.trim() || "Workflow",
    detail: run.error?.trim() || (run.status === "interrupted" ? "Interrupted" : "A block failed"),
    at: run.endedAt ?? new Date().toISOString()
  };
  if (run.projectPath) entry.projectPath = run.projectPath;
  return entry;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Toasts waiting to be read; the newest shows, with a count of the rest. */
export const MAX_TOASTS = 5;
/** Attention entries kept (newest first). */
export const MAX_ATTENTION = 20;
/** Runs already notified — an event delivered twice (a reconnect's reload) notifies once. */
const MAX_REMEMBERED = 500;

export interface WorkflowNotificationsState {
  /** Newest first. */
  toasts: readonly WorkflowRunNotice[];
  /** Newest first. */
  attention: readonly WorkflowAttentionEntry[];
}

const INITIAL: WorkflowNotificationsState = { toasts: [], attention: [] };

export const workflowNotificationsStore = createStore<WorkflowNotificationsState>(() => INITIAL);

let notified: string[] = [];
const notifiedSet = new Set<string>();
const viewed = new Set<string>();

function remember(runId: string): boolean {
  if (notifiedSet.has(runId)) return false;
  notifiedSet.add(runId);
  notified.push(runId);
  if (notified.length > MAX_REMEMBERED) {
    const drop = notified.slice(0, notified.length - MAX_REMEMBERED);
    notified = notified.slice(-MAX_REMEMBERED);
    for (const id of drop) notifiedSet.delete(id);
  }
  return true;
}

/**
 * The notify settings of a run's workflow: the rail row's `notify` (the
 * workflow as it is now), else a loaded run's frozen definition, else the
 * defaults.
 */
export function notifyPrefsForRun(run: Pick<WorkflowRunSummary, "id" | "workflowId">): WorkflowNotifyPrefs {
  const state = workflowsStore.getState();
  const notify = state.summaries.get(run.workflowId)?.notify;
  if (notify) return notifyPrefsOf({ notify });
  const own = state.runs[run.id]?.detail?.definition;
  if (own) return notifyPrefsOf(own.settings);
  for (const entry of Object.values(state.runs)) {
    const definition = entry.detail?.definition;
    if (definition && definition.id === run.workflowId) return notifyPrefsOf(definition.settings);
  }
  return DEFAULT_NOTIFY_PREFS;
}

/** Record a finished run: raise its toast and attention entry per the rules. */
export function notifyWorkflowRunFinished(
  run: WorkflowRunSummary,
  context: { prefs?: WorkflowNotifyPrefs; viewing?: boolean } = {}
): void {
  if (runOutcomeKind(run.status) === "quiet") return;
  if (!remember(run.id)) return;
  const viewing = context.viewing === true || viewed.has(run.id) || isRunOnScreen(run.id);
  const prefs = context.prefs ?? notifyPrefsForRun(run);
  const toast = finishedRunNotice(run, { prefs, viewing });
  const entry = attentionEntryFor(run, { prefs, viewing });
  if (!toast && !entry) return;
  const state = workflowNotificationsStore.getState();
  workflowNotificationsStore.setState({
    toasts: toast ? [toast, ...state.toasts.filter((t) => t.runId !== run.id)].slice(0, MAX_TOASTS) : state.toasts,
    attention: entry
      ? [entry, ...state.attention.filter((e) => e.runId !== run.id)].slice(0, MAX_ATTENTION)
      : state.attention
  });
}

/**
 * The app store's hook into the `workflows` event channel: a
 * `workflowRun.finished` notifies; anything else is ignored. What is on
 * screen is read from the run views' own reports (`setRunOnScreen`): a tab
 * in Editor mode, hidden, or a hidden document shows nothing.
 */
export function observeWorkflowRunEvent(
  event: { type: string; payload: unknown },
  context: { viewingRunId?: string | null } = {}
): void {
  if (event.type !== "workflowRun.finished" || !isRecord(event.payload)) return;
  const run = sanitizeRunSummary(event.payload.run);
  if (run === null) return;
  notifyWorkflowRunFinished(run, { viewing: context.viewingRunId === run.id });
}

/** Close the toasts (the newest and the ones behind it). */
export function dismissWorkflowToasts(): void {
  if (workflowNotificationsStore.getState().toasts.length === 0) return;
  workflowNotificationsStore.setState({ toasts: [] });
}

/** Remove one attention entry (its ×). */
export function dismissWorkflowAttention(runId: string): void {
  const state = workflowNotificationsStore.getState();
  if (!state.attention.some((entry) => entry.runId === runId)) return;
  workflowNotificationsStore.setState({ attention: state.attention.filter((entry) => entry.runId !== runId) });
}

/**
 * The run was seen: its toast and its attention entry are read. Only a
 * FINISHED run is remembered as seen (`finished: true`) — a live run is
 * judged when it finishes, by whether it is on screen then
 * (`setRunOnScreen`), so glancing at it while it ran never silences its
 * failure.
 */
export function markWorkflowRunViewed(runId: string, options: { finished?: boolean } = {}): void {
  if (options.finished === true) {
    viewed.add(runId);
    if (viewed.size > MAX_REMEMBERED) {
      const first = viewed.values().next().value;
      if (first !== undefined) viewed.delete(first);
    }
  }
  const state = workflowNotificationsStore.getState();
  const toasts = state.toasts.filter((toast) => toast.runId !== runId);
  const attention = state.attention.filter((entry) => entry.runId !== runId);
  if (toasts.length === state.toasts.length && attention.length === state.attention.length) return;
  workflowNotificationsStore.setState({ toasts, attention });
}

// ---------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------

/** What each mounted run view shows right now (null: nothing, or hidden). */
const onScreen = new Map<object, string>();

let documentVisible: () => boolean = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * A run view reports the run it shows — only while its tab is in Runs mode
 * AND shown; `null` when not. Several views may report (grid cells).
 */
export function setRunOnScreen(owner: object, runId: string | null): void {
  if (runId === null) onScreen.delete(owner);
  else onScreen.set(owner, runId);
}

/** The user can see `runId` right now: a view shows it and the document is visible. */
export function isRunOnScreen(runId: string): boolean {
  if (!documentVisible()) return false;
  for (const shown of onScreen.values()) if (shown === runId) return true;
  return false;
}

/** Test seam: the document's visibility. */
export function setDocumentVisibilityProbe(probe: (() => boolean) | null): void {
  documentVisible = probe ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
}

/** A connection switch or a sign-out: nothing from the previous daemon stays. */
export function resetWorkflowNotifications(): void {
  notified = [];
  notifiedSet.clear();
  viewed.clear();
  workflowNotificationsStore.setState(INITIAL);
}
