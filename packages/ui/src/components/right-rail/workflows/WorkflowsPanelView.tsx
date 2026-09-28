/**
 * The Automated workflows panel as drawn: search, New workflow and the
 * All | This project | Running switch at the top, the cards scrolling
 * between, the panel's notice (a failure, or an overlap skip's "Run anyway")
 * above the foot, and Secrets pinned at the bottom.
 *
 * Presentational — `WorkflowsPanel` owns the store, the dialogs and the tabs —
 * so a static render check draws every state from plain props.
 */

import React from "react";
import { ArrowRight, Bot, Info, KeyRound, Loader2, Play, Plus, Tag, Ticket, Workflow, X } from "lucide-react";

import type { WorkflowSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import type { WorkflowListFilter } from "../../../lib/workflows/format";
import type { WorkflowRunsList, WorkflowsNotice } from "../../../lib/workflows/store";
import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from "../../../lib/workflows/templates";
import { Button } from "../../ui/button";
import { RailEmptyState, RailSearchInput, RailSegmented, type RailSegmentOption } from "../primitives";
import { WorkflowCard } from "./WorkflowCard";

export interface WorkflowCardActions {
  toggleExpanded: (workflow: WorkflowSummary) => void;
  setEnabled: (workflow: WorkflowSummary, enabled: boolean) => void;
  run: (workflow: WorkflowSummary) => void;
  edit: (workflow: WorkflowSummary) => void;
  openRun: (workflow: WorkflowSummary, runId: string) => void;
  duplicate: (workflow: WorkflowSummary) => void;
  remove: (workflow: WorkflowSummary) => void;
  retryRuns: (workflow: WorkflowSummary) => void;
}

export interface WorkflowsPanelViewProps {
  variant: "docked" | "sheet";
  query: string;
  onQueryChange: (query: string) => void;
  filter: WorkflowListFilter;
  onFilterChange: (filter: WorkflowListFilter) => void;
  /** A project is open: "This project" and the starters are offered. */
  projectAvailable: boolean;
  /** What the filter and the search leave, in order. */
  workflows: readonly WorkflowSummary[];
  /** How many workflows the daemon has at all (0 → the designed empty state). */
  total: number;
  /** How many of them run now (the Running switch's count). */
  runningCount: number;
  status: "loading" | "loaded" | "error";
  loadError: string | null;
  onRetry: () => void;
  now: number;
  expandedId: string | null;
  /** The expanded card's last runs. */
  expandedRuns: WorkflowRunsList | null;
  startingIds: ReadonlySet<string>;
  editDisabledReason: string | null;
  actions: WorkflowCardActions;
  notice: WorkflowsNotice | null;
  onNoticeAction: () => void;
  onDismissNotice: () => void;
  onNew: () => void;
  onSecrets: () => void;
  onTemplate: (id: WorkflowTemplateId) => void;
  /** The starter being created, if any. */
  creatingTemplate: WorkflowTemplateId | "blank" | null;
}

const TEMPLATE_ICONS: Record<WorkflowTemplateId, typeof Bot> = {
  "nightly-agent-task": Bot,
  "jira-ticket-fixer": Ticket,
  "release-tag-reviewer": Tag
};

export const WorkflowsPanelView: React.FC<WorkflowsPanelViewProps> = (props) => {
  const sheet = props.variant === "sheet";
  const filterOptions: RailSegmentOption<WorkflowListFilter>[] = [
    { id: "all", label: "All", title: "Every workflow on this server" },
    {
      id: "project",
      label: "This project",
      title: props.projectAvailable ? "Workflows that run in this project" : "Open a project to filter by it",
      disabled: !props.projectAvailable
    },
    {
      id: "running",
      label: props.runningCount > 0 ? `Running · ${props.runningCount}` : "Running",
      title: "Workflows with a run in progress"
    }
  ];
  const showEmpty = props.status === "loaded" && props.total === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <RailSearchInput
              value={props.query}
              onChange={props.onQueryChange}
              placeholder="Search workflows…"
              label="Search workflows"
            />
          </div>
          <Button
            type="button"
            onClick={props.onNew}
            title="New workflow"
            className={cn("shrink-0 rounded-lg px-2.5", sheet ? "h-10" : "h-9")}
          >
            <Plus size={14} aria-hidden />
            New
            <span className="sr-only"> workflow</span>
          </Button>
        </div>
        <RailSegmented
          label="Which workflows to list"
          options={filterOptions}
          value={props.filter}
          onChange={props.onFilterChange}
        />
      </div>

      <div
        aria-label="Automated workflows"
        aria-busy={props.status === "loading" ? true : undefined}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3"
      >
        {props.loadError !== null && props.status === "loaded" ? (
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-500">
            <span className="min-w-0 flex-1 break-words">{props.loadError}</span>
            <button
              type="button"
              onClick={props.onRetry}
              className="shrink-0 rounded px-1 text-neutral-300 underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </div>
        ) : null}

        {props.status === "loading" && props.total === 0 ? (
          <LoadingCards />
        ) : props.status === "error" && props.total === 0 ? (
          <RailEmptyState
            title="Couldn't load workflows"
            hint={props.loadError ?? undefined}
            action={
              <Button type="button" size="sm" variant="outline" onClick={props.onRetry}>
                Retry
              </Button>
            }
          />
        ) : showEmpty ? (
          <StarterEmptyState
            sheet={sheet}
            projectAvailable={props.projectAvailable}
            creating={props.creatingTemplate}
            onBlank={props.onNew}
            onTemplate={props.onTemplate}
          />
        ) : props.workflows.length === 0 ? (
          <RailEmptyState {...filteredEmpty(props.filter, props.query)} />
        ) : (
          props.workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              variant={props.variant}
              now={props.now}
              expanded={props.expandedId === workflow.id}
              runs={props.expandedId === workflow.id ? props.expandedRuns : null}
              starting={props.startingIds.has(workflow.id)}
              editDisabledReason={props.editDisabledReason}
              onToggleExpanded={() => props.actions.toggleExpanded(workflow)}
              onToggleEnabled={(enabled) => props.actions.setEnabled(workflow, enabled)}
              onRun={() => props.actions.run(workflow)}
              onEdit={() => props.actions.edit(workflow)}
              onOpenRun={(runId) => props.actions.openRun(workflow, runId)}
              onDuplicate={() => props.actions.duplicate(workflow)}
              onDelete={() => props.actions.remove(workflow)}
              onRetryRuns={() => props.actions.retryRuns(workflow)}
            />
          ))
        )}
      </div>

      {props.notice !== null ? (
        <NoticeCard notice={props.notice} sheet={sheet} onAction={props.onNoticeAction} onDismiss={props.onDismissNotice} />
      ) : null}

      <div className="shrink-0 border-t border-neutral-800 px-3 py-2.5">
        <Button
          type="button"
          variant="ghost"
          onClick={props.onSecrets}
          className={cn("w-full justify-start gap-2 text-neutral-400", sheet ? "h-10" : "h-8")}
        >
          <KeyRound size={14} aria-hidden />
          Secrets
          <span className="ml-auto min-w-0 truncate text-[11px] font-normal text-neutral-500">write-only values</span>
        </Button>
      </div>
    </div>
  );
};

function filteredEmpty(filter: WorkflowListFilter, query: string): { title: string; hint?: string } {
  if (query.trim().length > 0) return { title: `No workflows match “${query.trim()}”` };
  if (filter === "project") {
    return { title: "No workflows in this project", hint: "Workflows that run in other projects are under All." };
  }
  if (filter === "running") return { title: "Nothing is running", hint: "Live runs show here with their current step." };
  return { title: "No workflows" };
}

const LoadingCards: React.FC = () => (
  <div role="status" aria-label="Loading workflows" className="space-y-2">
    {[0, 1, 2].map((index) => (
      <div key={index} className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
        <div className="flex items-center gap-2.5">
          <span className="h-7 w-7 rounded-lg bg-neutral-800/80 motion-safe:animate-pulse" />
          <span className="h-3 w-2/5 rounded bg-neutral-800/80 motion-safe:animate-pulse" />
          <span className="ml-auto h-5 w-9 rounded-full bg-neutral-800/80" />
        </div>
        <div className="mt-3 h-2.5 w-3/5 rounded bg-neutral-800/60 motion-safe:animate-pulse" />
        <div className="mt-2 h-2.5 w-1/3 rounded bg-neutral-800/60 motion-safe:animate-pulse" />
      </div>
    ))}
  </div>
);

/** No workflow yet: what workflows are, "Start from scratch", and the three starters. */
const StarterEmptyState: React.FC<{
  sheet: boolean;
  projectAvailable: boolean;
  creating: WorkflowTemplateId | "blank" | null;
  onBlank: () => void;
  onTemplate: (id: WorkflowTemplateId) => void;
}> = ({ sheet, projectAvailable, creating, onBlank, onTemplate }) => (
  <div className="flex flex-col items-center px-1 pb-2 pt-6 text-center">
    <div className="relative mb-4">
      <span className="absolute -inset-3 rounded-3xl bg-neutral-800/30 blur-md" aria-hidden />
      <span
        aria-hidden
        className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-neutral-700/80 bg-neutral-900 text-neutral-200 shadow-sm"
      >
        <Workflow size={22} />
      </span>
    </div>
    <h3 className="text-[15px] font-medium text-neutral-100">Automate this project</h3>
    <p className="mt-1.5 max-w-[17rem] text-xs leading-5 text-neutral-500">
      Chain agents, scripts and checks — on a schedule, on a git event, or whenever you press Run.
    </p>
    <Button type="button" onClick={onBlank} className={cn("mt-4 w-full max-w-[17rem]", sheet ? "h-10" : "h-9")}>
      <Plus size={14} aria-hidden />
      Start from scratch
    </Button>

    <div className="mt-6 w-full space-y-1.5 text-left">
      <div className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">Starters</div>
      {WORKFLOW_TEMPLATES.map((template) => {
        const Icon = TEMPLATE_ICONS[template.id];
        const busy = creating === template.id;
        return (
          <button
            key={template.id}
            type="button"
            disabled={!projectAvailable || creating !== null}
            title={projectAvailable ? `Create “${template.title}” in this project` : "Open a project to use a starter"}
            onClick={() => onTemplate(template.id)}
            className={cn(
              "group flex w-full items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 text-left transition-colors",
              "hover:border-neutral-700 hover:bg-neutral-900/80 disabled:cursor-not-allowed disabled:opacity-50",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              sheet ? "min-h-14 py-2.5" : "min-h-12 py-2"
            )}
          >
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800/80 text-neutral-300 ring-1 ring-neutral-700/60"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-neutral-100">{template.title}</span>
              <span className="line-clamp-2 block text-xs leading-4 text-neutral-500">{template.description}</span>
            </span>
            <ArrowRight
              size={14}
              aria-hidden
              className="shrink-0 text-neutral-600 transition-colors group-hover:text-neutral-300"
            />
          </button>
        );
      })}
    </div>
  </div>
);

/** The panel's notice, above the footer. An overlap skip offers "Run anyway". */
const NoticeCard: React.FC<{
  notice: WorkflowsNotice;
  sheet: boolean;
  onAction: () => void;
  onDismiss: () => void;
}> = ({ notice, sheet, onAction, onDismiss }) => (
  <div className="shrink-0 px-3 pb-2.5">
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-xl border bg-neutral-900 py-2 pl-3 pr-1.5 text-xs shadow-lg shadow-black/20",
        notice.tone === "error" ? "border-danger-900/60" : "border-neutral-700"
      )}
    >
      <Info
        size={14}
        aria-hidden
        className={cn("mt-0.5 shrink-0", notice.tone === "error" ? "text-danger" : "text-info")}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <p className={cn("break-words leading-5", notice.tone === "error" ? "text-danger" : "text-neutral-200")}>
          {notice.text}
        </p>
        {notice.action === "run-anyway" ? (
          <Button type="button" size="sm" onClick={onAction} className={cn(sheet && "h-10")}>
            <Play size={11} aria-hidden className="fill-current" />
            Run anyway
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200",
          sheet ? "h-10 w-10" : "h-6 w-6"
        )}
      >
        <X size={13} aria-hidden />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  </div>
);
