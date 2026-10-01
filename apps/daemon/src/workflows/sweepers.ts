// Automated workflows — the hourly sweepers (spec §5.8, §5.10):
//
//   - run retention (`RunStore.sweep`: the newest 100 runs per workflow, nothing past 30 days, never
//     an active run);
//   - temporary projects a failed run kept, once past their `deleteAfter` → deleted, and the run's
//     `tempProject.deleted` set;
//   - workflow chat tabs (`owner.kind === "workflow"`) in EXISTING projects, `workflowTabRetentionDays`
//     after their run ended — never a tab the user wrote in after that end (the thread's last user
//     message is read), never a tab whose run is still going. A tab whose run record is gone (swept
//     by retention, or its workflow deleted) is judged by its own clock instead: closed once the
//     retention window has passed since the later of its creation and the user's last message in it.
//
// Temporary projects are swept BEFORE run retention: the record is what names a kept project, and
// retention itself skips a run whose project is still there (run-store.ts), so neither can leak it.
//
// Everything goes through the daemon's own routes (`DaemonApi`); a failure is logged and the next
// sweep tries again. Driven by the injected clock (no sleeps).

import { isRunActive, WORKFLOW_LIMITS, type SessionSummary } from "@orquester/api";

import { readThread } from "../chat-client/index.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { Clock, ProjectOps, RunStore, WorkflowLogger, WorkflowStore } from "./contracts.ts";

export interface WorkflowSweepersDeps {
  clock: Clock;
  runStore: RunStore;
  store: WorkflowStore;
  projects: ProjectOps;
  /** The daemon's own client, bound late. Without it the tab sweep is skipped. */
  api: () => DaemonApi | null;
  /** Runs the engine holds right now (never swept). */
  activeRunIds: () => string[];
  logger?: WorkflowLogger;
}

export interface SweepReport {
  tempProjectsDeleted: string[];
  tabsClosed: string[];
  errors: string[];
}

export interface WorkflowSweepers {
  start(): void;
  stop(): void;
  sweepNow(): Promise<SweepReport>;
}

const DAY_MS = 24 * 60 * 60_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkflowSweepers(deps: WorkflowSweepersDeps): WorkflowSweepers {
  const intervalMs = 60 * 60_000;
  const tabRetentionMs = WORKFLOW_LIMITS.workflowTabRetentionDays * DAY_MS;
  let timer: { cancel(): void } | null = null;
  let running: Promise<SweepReport> | null = null;
  let stopped = true;

  const sweepTempProjects = async (report: SweepReport): Promise<void> => {
    const now = deps.clock.now().getTime();
    const active = new Set(deps.activeRunIds());
    // A deleted workflow's runs whose temporary project its delete could not remove are kept on
    // record, due now: sweep those too.
    const workflowIds = new Set<string>([...deps.store.list().map((workflow) => workflow.id), ...(deps.runStore.workflowIds?.() ?? [])]);
    for (const workflowId of workflowIds) {
      let before: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const listing = await deps.runStore.listForWorkflow(workflowId, before !== undefined ? { before, limit: 100 } : { limit: 100 });
        for (const summary of listing.runs) {
          const temp = summary.tempProject;
          if (!temp || temp.deleted || temp.deleteAfter === undefined) continue;
          if (active.has(summary.id) || isRunActive(summary.status)) continue;
          if (Date.parse(temp.deleteAfter) > now) continue;
          try {
            await deps.projects.deleteProject(temp.path);
            const run = await deps.runStore.load(summary.id);
            if (run?.tempProject) {
              run.tempProject = { path: run.tempProject.path, deleted: true };
              await deps.runStore.save(run);
            }
            report.tempProjectsDeleted.push(temp.path);
          } catch (error) {
            report.errors.push(`temp project ${temp.path}: ${message(error)}`);
          }
        }
        if (listing.before === null) break;
        before = listing.before;
      }
    }
  };

  const sweepTabs = async (report: SweepReport): Promise<void> => {
    const api = deps.api();
    if (!api) return;
    const response = await api.request("GET", "/api/sessions");
    if (response.status >= 400 || !Array.isArray(response.body)) {
      report.errors.push(`sessions: the daemon answered ${response.status}`);
      return;
    }
    const now = deps.clock.now().getTime();
    const active = new Set(deps.activeRunIds());
    for (const session of response.body as SessionSummary[]) {
      const owner = session.owner;
      if (!owner || owner.kind !== "workflow" || active.has(owner.runId)) continue;
      try {
        const run = await deps.runStore.load(owner.runId);
        if (!run) {
          // The record is gone: the tab's own clock decides (its creation, the user's last word).
          let since = Date.parse(session.createdAt);
          if (!Number.isFinite(since)) continue;
          if (now - since < tabRetentionMs) continue;
          if (session.kind === "agent-chat") {
            const thread = await readThread(api, session.id);
            for (const item of thread.items) {
              if (item.kind !== "message" || item.role !== "user" || item.agentId) continue;
              const at = Date.parse(item.createdAt);
              if (Number.isFinite(at) && at > since) since = at;
            }
            if (now - since < tabRetentionMs) continue;
          }
        } else {
          if (isRunActive(run.status) || run.endedAt === undefined) continue;
          // A temp project's tabs go with the project.
          if (run.tempProject && run.tempProject.path === session.projectPath) continue;
          const endedAt = Date.parse(run.endedAt);
          if (!Number.isFinite(endedAt) || now - endedAt < tabRetentionMs) continue;
          if (session.kind === "agent-chat") {
            const thread = await readThread(api, session.id);
            const userWroteAfter = thread.items.some(
              (item) => item.kind === "message" && item.role === "user" && !item.agentId && Date.parse(item.createdAt) > endedAt
            );
            if (userWroteAfter) continue;
          }
        }
        const closed = await api.request("DELETE", `/api/sessions/${encodeURIComponent(session.id)}`);
        if (closed.status >= 400 && closed.status !== 404) {
          report.errors.push(`tab ${session.id}: the daemon answered ${closed.status}`);
          continue;
        }
        report.tabsClosed.push(session.id);
      } catch (error) {
        report.errors.push(`tab ${session.id}: ${message(error)}`);
      }
    }
  };

  const sweepNow = (): Promise<SweepReport> => {
    running ??= (async () => {
      const report: SweepReport = { tempProjectsDeleted: [], tabsClosed: [], errors: [] };
      try {
        await sweepTempProjects(report);
      } catch (error) {
        report.errors.push(`temp projects: ${message(error)}`);
      }
      try {
        await deps.runStore.sweep();
      } catch (error) {
        report.errors.push(`run retention: ${message(error)}`);
      }
      try {
        await sweepTabs(report);
      } catch (error) {
        report.errors.push(`tabs: ${message(error)}`);
      }
      if (report.errors.length > 0) deps.logger?.warn("workflow sweep had errors", { errors: report.errors });
      return report;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const arm = (): void => {
    if (stopped) return;
    timer = deps.clock.setTimeout(() => {
      timer = null;
      void sweepNow().finally(arm);
    }, intervalMs);
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      arm();
    },
    stop(): void {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
    sweepNow
  };
}
