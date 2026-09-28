// Automated workflows — the Web Push for a finished run (spec §5.11), per `settings.notify`: on
// failure by default, on success when asked. Debounced per workflow and kind, so a schedule failing
// every minute pushes once a window. The toast and the Attention Center entry are client-side,
// driven by `workflowRun.finished`.

import type { Workflow, WorkflowRunSummary } from "@orquester/api";

import type { Clock, WorkflowLogger, WorkflowNotifier } from "./contracts.ts";

export interface WorkflowPushPayload {
  title: string;
  body: string;
  /** Replaces an earlier notification of the same workflow. */
  tag: string;
  workflowId: string;
  runId: string;
}

export interface WorkflowPushSender {
  /** `PushService.notifyWorkflowRun`. */
  notifyWorkflowRun(payload: WorkflowPushPayload): Promise<void>;
}

export interface WorkflowNotifierDeps {
  push: WorkflowPushSender | null;
  clock: Pick<Clock, "now">;
  logger?: WorkflowLogger;
}

const MAX_BODY = 240;

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function createWorkflowNotifier(deps: WorkflowNotifierDeps): WorkflowNotifier {
  const debounceMs = 60_000;
  const last = new Map<string, number>();
  return {
    runFinished(run: WorkflowRunSummary, workflow: Workflow): void {
      // A test run's user is watching; a child run's failure is its parent's to report.
      if (run.test || run.parentRunId !== undefined) return;
      const failure = run.status === "failed" || run.status === "interrupted";
      const success = run.status === "succeeded" || run.status === "stopped";
      if (!failure && !success) return;
      const notify = workflow.settings?.notify ?? { onFailure: true, onSuccess: false };
      if (failure ? !notify.onFailure : !notify.onSuccess) return;
      const key = `${workflow.id}:${failure ? "failed" : "finished"}`;
      const now = deps.clock.now().getTime();
      for (const [entry, at] of last) if (now - at >= debounceMs) last.delete(entry);
      if (last.has(key)) return;
      last.set(key, now);
      const duration = formatDuration(run.durationMs);
      const body = failure ? (run.error ?? "The run failed.") : duration ? `Finished in ${duration}.` : "Finished.";
      const payload: WorkflowPushPayload = {
        title: `${failure ? "Workflow failed" : "Workflow finished"}: ${workflow.name}`,
        body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
        tag: `workflow-${workflow.id}`,
        workflowId: workflow.id,
        runId: run.id
      };
      if (!deps.push) return;
      deps.push.notifyWorkflowRun(payload).catch((error: unknown) => {
        deps.logger?.warn("workflow push failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  };
}
