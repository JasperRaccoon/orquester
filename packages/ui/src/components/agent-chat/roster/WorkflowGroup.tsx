// Ported from T3 Code (MIT): apps/web/src/components/AgentsPanel.tsx:194-520

/**
 * Workflow groups and their phases (§7.6, "workflow groups with phases as T3
 * renders them").
 *
 * The rule that shapes all of it: **a run keeps its shape as it settles.** A
 * phase opens when it becomes active and stays open afterwards, and a live
 * workflow stays expanded once it finishes, so completion never yanks rows out
 * from under the user mid-read. Manual toggles stick until a later activation.
 * *T3: `AgentsPanel.tsx:311-317, 499-503`.*
 *
 * The phase rail shows the whole arc — done → live → pending — without
 * scrolling the member list: one segment per phase, chevron-separated, each
 * carrying one dot per member.
 *
 * Not ported as such: T3's read-only workflow-script viewer
 * (`AgentsPanel.tsx:263-306`), which fetches the script through an
 * orchestration RPC. Here the script is the coordinator's launch prompt, so
 * the workflow's name opens the coordinator's drill-in, which heads with it.
 *
 * Phase indices are compared, never counted from: Claude numbers them from 1,
 * older and synthetic payloads from 0.
 *
 * A live run carries its own Stop where the provider can stop one task
 * (`/task/stop`, `taskStopControl`): it stops the RUN — the provider runs a
 * workflow as one task — and leaves the turn and every other task running.
 * Its agents have none: they cannot be stopped one by one.
 */

import React from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentPanelWorkflowGroup, RuntimeSubagent } from "@orquester/api/agent-chat";
import { cn } from "../../../lib/cn";
import { isTerminalSubagentStatus, type TaskStopControl } from "../../../lib/agent-chat/roster.logic";
import { ChatIconButton, ElapsedTicker, StatusDot } from "../primitives";
import { formatSubagentTokenCount } from "./format";
import { rosterRowTicks, rosterStatusVisual } from "./roster-rows";
import { workflowGroupSummary } from "./roster-summary";
import { AgentRosterRow } from "./AgentRosterRow";

type Phase = AgentPanelWorkflowGroup["phases"][number];

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  return !isTerminalSubagentStatus(group.workflow.status);
}

function workflowLabel(workflow: RuntimeSubagent): string {
  return workflow.workflowName ?? workflow.title;
}

/** The run's own Stop: offered while the provider can stop it, pending until it settles. */
interface WorkflowStop {
  control: Exclude<TaskStopControl, "hidden">;
  onStop: () => void;
}

function WorkflowStopButton({
  label,
  stop,
  className
}: {
  label: string;
  stop: WorkflowStop;
  className?: string;
}): React.ReactElement {
  const stopping = stop.control === "stopping";
  return (
    <button
      type="button"
      disabled={stopping}
      onClick={stop.onStop}
      title={stopping ? `Stopping ${label}` : `Stop ${label} and all of its agents`}
      className={cn(
        "ac-press inline-flex h-5 shrink-0 items-center rounded px-1.5 font-mono text-[10px] font-medium normal-case tracking-normal",
        "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
}

function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }): React.ReactElement | null {
  if (group.phases.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight size={12} aria-hidden className="text-neutral-600" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info-900/50"
                : phase.state === "done"
                  ? "border-ok-900/50"
                  : "border-neutral-800"
            )}
          >
            <span
              className={cn(
                "font-mono text-[10px]",
                phase.state === "running"
                  ? "text-info-300"
                  : phase.state === "done"
                    ? "text-ok-300"
                    : "text-neutral-500"
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[10px] text-neutral-600">–</span>
              ) : (
                phase.members.map((member) => (
                  <StatusDot
                    key={member.id}
                    tone={rosterStatusVisual(member.status).tone}
                    size="xs"
                  />
                ))
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PhaseSection({
  phase,
  defaultOpen,
  activeAgentId,
  onOpenAgent
}: {
  phase: Phase;
  defaultOpen: boolean;
  activeAgentId: string | null;
  onOpenAgent: (agentId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(defaultOpen || phase.state === "running");
  const previousState = React.useRef(phase.state);

  React.useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") setOpen(true);
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "ac-press mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left",
          "text-[10px] font-medium uppercase tracking-wider hover:bg-neutral-800/40",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500",
          phase.state === "done"
            ? "text-ok-300"
            : phase.state === "running"
              ? "text-info-300"
              : "text-neutral-500"
        )}
      >
        {open ? (
          <ChevronDown size={12} aria-hidden className="shrink-0" />
        ) : (
          <ChevronRight size={12} aria-hidden className="shrink-0" />
        )}
        {phase.state === "done" ? <Check size={12} aria-hidden className="shrink-0" /> : null}
        <span className="truncate">{phase.title}</span>
        <span className="font-normal normal-case text-neutral-500">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} tone={rosterStatusVisual(member.status).tone} size="xs" />
            ))}
          </span>
        ) : null}
      </button>
      {open
        ? phase.members.map((member) => (
            <AgentRosterRow
              key={member.id}
              agent={member}
              active={member.id === activeAgentId}
              onOpen={onOpenAgent}
            />
          ))
        : null}
    </div>
  );
}

function ExpandedWorkflow({
  group,
  activeAgentId,
  onOpenAgent,
  onCollapse,
  stop
}: {
  group: AgentPanelWorkflowGroup;
  activeAgentId: string | null;
  onOpenAgent: (agentId: string) => void;
  onCollapse: () => void;
  stop: WorkflowStop | null;
}): React.ReactElement {
  const summary = workflowGroupSummary(group);
  const workflowActive = group.workflow.id === activeAgentId;
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        <StatusDot tone={rosterStatusVisual(group.workflow.status).tone} size="xs" />
        {/* The coordinator's drill-in: the script it runs, as its prompt. */}
        <button
          type="button"
          onClick={() => onOpenAgent(group.workflow.id)}
          title="Open the workflow and its script"
          className={cn(
            "ac-press min-w-0 truncate rounded-sm text-left uppercase tracking-wider",
            "hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            workflowActive && "text-neutral-200"
          )}
        >
          {workflowLabel(group.workflow)}
        </button>
        {/* Nothing to settle until the first member is reported: "0/0
            settled" said the run had none. */}
        {summary.agents > 0 ? (
          <span className="ml-auto font-mono normal-case text-neutral-500">
            {summary.settled}/{summary.agents} settled
          </span>
        ) : null}
        {stop ? (
          <WorkflowStopButton
            label={workflowLabel(group.workflow)}
            stop={stop}
            className={cn(summary.agents === 0 && "ml-auto")}
          />
        ) : null}
        <ChatIconButton
          size="micro"
          label="Collapse workflow"
          onClick={onCollapse}
          className={cn("-mr-0.5", summary.agents === 0 && !stop && "ml-auto")}
        >
          <ChevronDown size={12} aria-hidden />
        </ChatIconButton>
      </div>
      <PhaseRail group={group} />
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          defaultOpen={!workflowIsLive(group)}
          activeAgentId={activeAgentId}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRosterRow
          key={member.id}
          agent={member}
          active={member.id === activeAgentId}
          onOpen={onOpenAgent}
        />
      ))}
      {/* No member reported yet — before the run's first progress snapshot,
          or a CLI that sends none: the coordinator stands for the run. */}
      {summary.agents === 0 ? (
        <AgentRosterRow
          agent={group.workflow}
          active={group.workflow.id === activeAgentId}
          onOpen={onOpenAgent}
        />
      ) : null}
    </section>
  );
}

function CollapsedWorkflow({
  group,
  onExpand,
  stop
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
  stop: WorkflowStop | null;
}): React.ReactElement {
  const { agents, failed, totalTokens } = workflowGroupSummary(group);
  const { workflow } = group;
  return (
    <section className="flex items-center gap-1">
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        className={cn(
          "ac-press flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left",
          "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1",
          "focus-visible:ring-inset focus-visible:ring-neutral-500"
        )}
      >
        <StatusDot
          tone={rosterStatusVisual(failed > 0 ? "failed" : workflow.status).tone}
          size="xs"
        />
        <span className="min-w-0 truncate text-sm text-neutral-200">{workflowLabel(workflow)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-neutral-500">
          {failed > 0 ? <span className="text-danger-300">{failed} failed ·</span> : null}
          {agents > 0 ? <span>{agents} {agents === 1 ? "agent" : "agents"} ·</span> : null}
          <span className="ac-tabular">{formatSubagentTokenCount(totalTokens)} tok</span>
          {workflow.startedAt ? (
            <span className="ac-tabular">
              ·{" "}
              <ElapsedTicker
                startedAt={workflow.startedAt}
                endedAt={workflow.completedAt}
                live={rosterRowTicks(workflow.status)}
              />
            </span>
          ) : null}
          <ChevronRight size={12} aria-hidden />
        </span>
      </button>
      {/* Beside the expand button, never inside it: a button in a button. */}
      {stop ? <WorkflowStopButton label={workflowLabel(workflow)} stop={stop} /> : null}
    </section>
  );
}

interface WorkflowGroupProps {
  group: AgentPanelWorkflowGroup;
  activeAgentId?: string | null;
  onOpenAgent: (agentId: string) => void;
  /**
   * The run's Stop (`taskStopControl` of the coordinator): `"hidden"` — or
   * absent — shows none. `onStopTask` gets the coordinator's id.
   */
  stopControl?: TaskStopControl;
  onStopTask?: (taskId: string) => void;
}

/** A workflow's open state is presentation state, not a status derivative. */
export function WorkflowGroup({
  group,
  activeAgentId = null,
  onOpenAgent,
  stopControl = "hidden",
  onStopTask
}: WorkflowGroupProps): React.ReactElement {
  const [open, setOpen] = React.useState(() => workflowIsLive(group));
  const workflowId = group.workflow.id;
  const stop: WorkflowStop | null =
    stopControl === "hidden" || onStopTask === undefined
      ? null
      : { control: stopControl, onStop: () => onStopTask(workflowId) };
  return open ? (
    <ExpandedWorkflow
      group={group}
      activeAgentId={activeAgentId}
      onOpenAgent={onOpenAgent}
      onCollapse={() => setOpen(false)}
      stop={stop}
    />
  ) : (
    <CollapsedWorkflow group={group} onExpand={() => setOpen(true)} stop={stop} />
  );
}
