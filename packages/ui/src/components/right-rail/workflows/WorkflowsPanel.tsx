/**
 * The right rail's Automated workflows panel (workflows spec §7.1): every
 * workflow on this server as a card — enable it, run it now, open its editor,
 * see its last runs — plus New workflow, the starters, and the secrets.
 *
 * This is the container: the workflows store (`lib/workflows`), the editor
 * tabs (`openWorkflowTab`), the dialogs and the delete confirm. What it draws
 * is `WorkflowsPanelView`. What must survive a panel switch (the filter, the
 * open card) is remembered at module level; the data itself is the store's.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { Workflow, WorkflowSummary } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { filterWorkflows, normalizeWorkflowProjectPath, type WorkflowListFilter } from "../../../lib/workflows/format";
import { useWorkflowRuns, useWorkflows } from "../../../lib/workflows/hooks";
import {
  createWorkflow,
  deleteWorkflow,
  dismissWorkflowsNotice,
  duplicateWorkflow,
  loadWorkflowRuns,
  loadWorkflows,
  runWorkflowNow,
  setWorkflowEnabled
} from "../../../lib/workflows/store";
import { createFromTemplate, type WorkflowTemplateId } from "../../../lib/workflows/templates";
import { useAppStore } from "../../../store/app";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { openWorkflowRunInEditor } from "../../workflows/runs/open-run";
import type { RightRailPanelProps } from "../types";
import { NewWorkflowDialog } from "./NewWorkflowDialog";
import { WorkflowSecretsDialog } from "./WorkflowSecretsDialog";
import { WorkflowsPanelView, type WorkflowCardActions } from "./WorkflowsPanelView";

/** The filter and the open card outlive a remount (the rail closing, a phone's section). Memory only. */
const remembered: { filter: WorkflowListFilter; expandedId: string | null } = {
  filter: "all",
  expandedId: null
};

const NO_PROJECT_REASON = "Open a project to edit workflows in it";

/** A clock for relative times: every second while something runs, else every 30 s. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

export const WorkflowsPanel: React.FC<RightRailPanelProps> = ({ projectPath, variant, onDelivered }) => {
  const api = useApi();
  const view = useWorkflows();
  const openWorkflowTab = useAppStore((state) => state.openWorkflowTab);
  const project = normalizeWorkflowProjectPath(projectPath);
  const projectAvailable = project.length > 0;

  const [query, setQuery] = useState("");
  const [filter, setFilterState] = useState<WorkflowListFilter>(() =>
    remembered.filter === "project" && !projectAvailable ? "all" : remembered.filter
  );
  const [expandedId, setExpandedState] = useState<string | null>(() => remembered.expandedId);
  const [startingIds, setStartingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [creatingTemplate, setCreatingTemplate] = useState<WorkflowTemplateId | "blank" | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [secretsFor, setSecretsFor] = useState<{ workflowId: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkflowSummary | null>(null);

  const setFilter = useCallback((next: WorkflowListFilter) => {
    remembered.filter = next;
    setFilterState(next);
  }, []);
  const setExpanded = useCallback((next: string | null) => {
    remembered.expandedId = next;
    setExpandedState(next);
  }, []);

  const expandedRuns = useWorkflowRuns(expandedId);
  const running = useMemo(() => view.workflows.filter((w) => w.activeRuns.length > 0), [view.workflows]);
  const now = useNow(running.length > 0);
  const workflows = useMemo(
    () => filterWorkflows(view.workflows, filter, project, query),
    [view.workflows, filter, project, query]
  );

  // A workflow deleted elsewhere takes its open card with it.
  useEffect(() => {
    if (expandedId !== null && view.status === "loaded" && !view.workflows.some((w) => w.id === expandedId)) {
      setExpanded(null);
    }
  }, [expandedId, view.status, view.workflows, setExpanded]);

  /** Open a workflow's editor tab in this project; a phone then goes back to the tab content. */
  const openEditor = useCallback(
    (workflowId: string, options: { runId?: string | null; title?: string } = {}) => {
      if (!projectAvailable) return;
      openWorkflowTab(projectPath, workflowId, options);
      onDelivered?.();
    },
    [openWorkflowTab, projectAvailable, projectPath, onDelivered]
  );

  const run = useCallback(
    async (workflow: WorkflowSummary, force = false) => {
      setStartingIds((current) => new Set(current).add(workflow.id));
      try {
        await runWorkflowNow(api, workflow.id, force ? { force: true } : {});
      } finally {
        setStartingIds((current) => {
          const next = new Set(current);
          next.delete(workflow.id);
          return next;
        });
      }
    },
    [api]
  );

  const actions: WorkflowCardActions = useMemo(
    () => ({
      toggleExpanded: (workflow) => setExpanded(remembered.expandedId === workflow.id ? null : workflow.id),
      setEnabled: (workflow, enabled) => void setWorkflowEnabled(api, workflow.id, enabled),
      run: (workflow) => void run(workflow),
      edit: (workflow) => openEditor(workflow.id, { title: workflow.name }),
      // The one "open a run" path (a toast's, the Attention Center's): it also
      // switches an editor tab that is already open to this run.
      openRun: (workflow, runId) => {
        if (!projectAvailable) return;
        if (openWorkflowRunInEditor({ runId, workflowId: workflow.id, workflowName: workflow.name, ...(projectPath ? { projectPath } : {}) })) onDelivered?.();
      },
      duplicate: (workflow) => {
        void duplicateWorkflow(api, workflow.id).then((result) => {
          if (result.ok) setExpanded(result.value.id);
        });
      },
      remove: (workflow) => setPendingDelete(workflow),
      retryRuns: (workflow) => void loadWorkflowRuns(api, workflow.id, { force: true })
    }),
    [api, openEditor, run, setExpanded, projectAvailable, projectPath, onDelivered]
  );

  const created = useCallback(
    (workflow: Workflow) => {
      setNewOpen(false);
      setQuery("");
      setExpanded(workflow.id);
      openEditor(workflow.id, { title: workflow.name });
    },
    [openEditor, setExpanded]
  );

  const fromTemplate = useCallback(
    async (id: WorkflowTemplateId) => {
      if (!projectAvailable || creatingTemplate !== null) return;
      setCreatingTemplate(id);
      const result = await createWorkflow(api, createFromTemplate(id, { kind: "existing", projectPath }));
      setCreatingTemplate(null);
      if (result.ok) created(result.value);
    },
    [api, created, creatingTemplate, projectAvailable, projectPath]
  );

  const notice = view.notice;
  const noticeAction = useCallback(() => {
    const target = notice?.workflowId ? view.workflows.find((w) => w.id === notice.workflowId) : undefined;
    dismissWorkflowsNotice();
    if (target && notice?.action === "run-anyway") void run(target, true);
  }, [notice, run, view.workflows]);

  return (
    <>
      <WorkflowsPanelView
        variant={variant}
        query={query}
        onQueryChange={setQuery}
        filter={filter}
        onFilterChange={setFilter}
        projectAvailable={projectAvailable}
        workflows={workflows}
        total={view.workflows.length}
        runningCount={running.length}
        status={view.status}
        loadError={view.error}
        onRetry={() => void loadWorkflows(api, { force: true })}
        now={now}
        expandedId={expandedId}
        expandedRuns={expandedId ? expandedRuns : null}
        startingIds={startingIds}
        editDisabledReason={projectAvailable ? null : NO_PROJECT_REASON}
        actions={actions}
        notice={notice}
        onNoticeAction={noticeAction}
        onDismissNotice={dismissWorkflowsNotice}
        onNew={() => setNewOpen(true)}
        onSecrets={() => setSecretsFor({ workflowId: null })}
        onTemplate={(id) => void fromTemplate(id)}
        creatingTemplate={creatingTemplate}
      />
      {newOpen ? (
        <NewWorkflowDialog projectPath={projectPath} onClose={() => setNewOpen(false)} onCreated={created} />
      ) : null}
      {secretsFor !== null ? (
        <WorkflowSecretsDialog
          workflows={view.workflows}
          initialWorkflowId={secretsFor.workflowId}
          onClose={() => setSecretsFor(null)}
        />
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete workflow?"
        message={
          <>
            <span className="text-neutral-200">{pendingDelete?.name}</span> is deleted for every device connected to
            this server — its running runs are cancelled, and its run history and secrets go with it.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void deleteWorkflow(api, target.id);
        }}
      />
    </>
  );
};
