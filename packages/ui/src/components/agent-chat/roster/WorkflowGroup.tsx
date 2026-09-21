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
 * Deliberately **not** ported: T3's read-only workflow-script viewer
 * (`AgentsPanel.tsx:263-306`), which fetches the script through an
 * orchestration RPC. We have no such route, and the spec does not name one.
 */

import React from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { AgentPanelWorkflowGroup, RuntimeSubagent } from "@orquester/api/agent-chat";
import { cn } from "../../../lib/cn";
import { ChatIconButton, StatusDot } from "../primitives";
import { elapsedBetween } from "../primitives/elapsed";
import { formatSubagentTokenCount } from "./format";
import { isFinishedRow, rosterStatusVisual } from "./roster-rows";
import { AgentRosterRow } from "./AgentRosterRow";

type Phase = AgentPanelWorkflowGroup["phases"][number];

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  return !isFinishedRow(group.workflow);
}

function workflowMembers(group: AgentPanelWorkflowGroup): RuntimeSubagent[] {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
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
  onCollapse
}: {
  group: AgentPanelWorkflowGroup;
  activeAgentId: string | null;
  onOpenAgent: (agentId: string) => void;
  onCollapse: () => void;
}): React.ReactElement {
  const members = workflowMembers(group);
  const settled = members.filter((member) => isFinishedRow(member)).length;
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
        <StatusDot tone={rosterStatusVisual(group.workflow.status).tone} size="xs" />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto font-mono normal-case text-neutral-500">
          {settled}/{members.length} settled
        </span>
        <ChatIconButton
          size="micro"
          label="Collapse workflow"
          onClick={onCollapse}
          className="-mr-0.5"
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
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
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
  onExpand
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}): React.ReactElement {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // The coordinator's usage may already aggregate its members', so count it
  // only when there are no member rows to sum. *T3: `AgentsPanel.tsx:466-471`.*
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={false}
        className={cn(
          "ac-press flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left",
          "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1",
          "focus-visible:ring-inset focus-visible:ring-neutral-500"
        )}
      >
        <StatusDot
          tone={rosterStatusVisual(failed > 0 ? "failed" : group.workflow.status).tone}
          size="xs"
        />
        <span className="min-w-0 truncate text-sm text-neutral-200">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-neutral-500">
          {failed > 0 ? <span className="text-danger-300">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="ac-tabular">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="ac-tabular">· {elapsed}</span> : null}
          <ChevronRight size={12} aria-hidden />
        </span>
      </button>
    </section>
  );
}

export interface WorkflowGroupProps {
  group: AgentPanelWorkflowGroup;
  activeAgentId?: string | null;
  onOpenAgent: (agentId: string) => void;
}

/** A workflow's open state is presentation state, not a status derivative. */
export function WorkflowGroup({
  group,
  activeAgentId = null,
  onOpenAgent
}: WorkflowGroupProps): React.ReactElement {
  const [open, setOpen] = React.useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflow
      group={group}
      activeAgentId={activeAgentId}
      onOpenAgent={onOpenAgent}
      onCollapse={() => setOpen(false)}
    />
  ) : (
    <CollapsedWorkflow group={group} onExpand={() => setOpen(true)} />
  );
}
