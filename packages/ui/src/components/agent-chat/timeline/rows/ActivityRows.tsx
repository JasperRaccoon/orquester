import React from "react";
import { X } from "lucide-react";

import type { RuntimeSubagent } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import type { AgentChatTimelineRow, WorkLogEntry } from "../../../../lib/agent-chat/contracts";
import { DisclosureChevron, ShimmerText } from "../../primitives";
import { useTimelineRowContext, type TimelineRowContextValue } from "../context";
import {
  liveWorkEntryLabel,
  omitSupersededLifecycleMarkers,
  showDestructiveRowStyle,
  summarizeToolGroup,
  summaryKindIconName,
  workEntryDisplayIndicatesToolFailure,
  workEntryDisplayLabel,
  workEntryIconName,
  workEntryIsActiveTurnActivity,
  workEntryIsRerouteNotice,
  workEntryIsVisibleInGroup,
  workEntryIsWarning,
  type WorkEntryIconName
} from "../work-presentation";
import { deriveAgentSpawnSummary } from "../row-format";
import { TimelineRowTimestamp } from "../timestamp";
import { InlineDiff, looksLikeUnifiedDiff } from "./InlineDiff";
import { WorkEntryIcon } from "./icons";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

// ---------------------------------------------------------------------------
// The live activity line — the one row shape every activity surface reuses
// ---------------------------------------------------------------------------

/**
 * `w-fit` is deliberate: the hover/focus background hugs the text instead of
 * spanning the whole column, which is what keeps a long run of tool rows
 * reading as a list of *things* rather than a list of stripes.
 * *T3: `MessagesTimeline.tsx:3158-3226`.*
 */
export function LiveActivityLine({
  label,
  iconName,
  live = false,
  failed = false,
  trailing
}: {
  label: React.ReactNode;
  iconName: WorkEntryIconName;
  live?: boolean;
  failed?: boolean;
  trailing?: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="relative flex min-h-6 w-fit max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-0.5 py-0.5 text-sm leading-relaxed">
      {/* Muted in both states: a failed tool keeps its identity glyph and gets
          the trailing mark below — the destructive treatment is reserved for a
          severe failure, which the standalone tool row renders (§7.3). */}
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500"
        role={failed ? "img" : undefined}
        aria-label={failed ? "Tool call failed" : undefined}
      >
        <WorkEntryIcon name={iconName} />
      </span>
      <ShimmerText live={live} className="min-w-0 flex-1 truncate">
        {label}
      </ShimmerText>
      {/* A non-zero exit is a MUTED mark, never the destructive treatment (§7.3). */}
      {failed ? <X size={12} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500/40" /> : null}
      {trailing}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The expanded body of a single tool call
// ---------------------------------------------------------------------------

function ToolOutput({
  id,
  text,
  ctx
}: {
  id: string;
  text: string;
  ctx: TimelineRowContextValue;
}): React.ReactElement {
  const ref = React.useRef<HTMLPreElement>(null);
  const remembered = ctx.toolOutputOffset(id);

  // The scroll offset inside an expanded tool output is part of the remembered
  // page shape (§7.2), so returning to a tab restores where you were reading
  // inside the output, not just which rows were open.
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (node && remembered > 0) node.scrollTop = remembered;
    // Restore once per mount; later scrolls are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <pre
      ref={ref}
      onScroll={(event) => ctx.setToolOutputOffset(id, event.currentTarget.scrollTop)}
      className="ac-scroll-thin max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[length:var(--font-size-code,0.6875rem)] leading-relaxed text-neutral-400"
    >
      {text}
    </pre>
  );
}

const stopRowToggle = (event: { stopPropagation: () => void }): void => event.stopPropagation();

/**
 * A click that *ends a selection* is withheld from the row toggle; an ordinary
 * click on an expanded label still collapses the row it opened.
 * *T3: `MessagesTimeline.tsx:4586-4596`.*
 */
function stopRowToggleWhileSelectingText(event: React.MouseEvent<HTMLElement>): void {
  const selection = event.currentTarget.ownerDocument.getSelection();
  if (selection && !selection.isCollapsed) event.stopPropagation();
}

function QuestionAnswerHistory({
  answer
}: {
  answer: NonNullable<WorkLogEntry["questionAnswer"]>;
}): React.ReactElement {
  const questionIds = [
    ...new Set([...Object.keys(answer.questionTextById ?? {}), ...Object.keys(answer.answers)])
  ];
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {questionIds.map((questionId) => {
        const value = answer.answers[questionId];
        return (
          <div key={questionId} className="space-y-1">
            {answer.questionTextById?.[questionId] ? (
              <p className="whitespace-pre-wrap text-sm text-neutral-500">
                {answer.questionTextById[questionId]}
              </p>
            ) : null}
            <p className="ms-3 whitespace-pre-wrap text-sm text-neutral-300">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tool row
// ---------------------------------------------------------------------------

export const ToolEntryRow = React.memo(function ToolEntryRow({
  entry,
  insideExpandedGroup = false,
  displayLabel
}: {
  entry: WorkLogEntry;
  insideExpandedGroup?: boolean;
  displayLabel?: string | undefined;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  const expanded = ctx.isExpanded(entry.id);

  const warning = workEntryIsWarning(entry);
  const failed = workEntryDisplayIndicatesToolFailure(entry);
  const destructive = showDestructiveRowStyle(entry);
  const reroute = workEntryIsRerouteNotice(entry);

  const iconName: WorkEntryIconName = warning || destructive ? "circle-alert" : workEntryIconName(entry);
  const label = displayLabel ?? workEntryDisplayLabel(entry, ctx.workspaceRoot);
  const detail = entry.detail?.trim() ?? "";
  const command = entry.command?.trim() ?? "";
  const changedFiles = entry.changedFiles ?? [];
  const diff = looksLikeUnifiedDiff(detail) ? detail : null;

  const canExpand =
    entry.questionAnswer !== undefined ||
    command.length > 0 ||
    detail.length > 0 ||
    changedFiles.length > 0;

  const iconClass = warning
    ? "text-warn"
    : destructive
      ? "text-danger"
      : reroute
        ? "text-info"
        : "text-neutral-500";
  const headingClass = warning
    ? "font-medium text-warn"
    : destructive
      ? "font-medium text-danger"
      : reroute
        ? "text-info-300"
        : "text-neutral-400";

  const toggle = (): void => ctx.setExpanded(entry.id, !expanded);

  return (
    <div
      data-activity-id={entry.id}
      {...(canExpand
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": expanded,
            "aria-label": failed ? `${label}, tool call failed` : label,
            onClick: toggle,
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggle();
              }
            }
          }
        : {})}
      className={cn(
        "group/timeline-row relative flex flex-col rounded-md px-0.5 transition-colors",
        insideExpandedGroup ? "py-0" : "py-0.5",
        expanded && "mb-1",
        canExpand &&
          "cursor-pointer hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      )}
    >
      <div className="flex select-none items-center gap-1.5">
        <span
          className={cn("flex h-6 w-6 shrink-0 items-center justify-center", iconClass)}
          role={failed ? "img" : undefined}
          aria-label={failed ? "Tool call failed" : undefined}
        >
          <WorkEntryIcon name={iconName} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className="flex w-full min-w-0 items-baseline gap-1.5 text-sm leading-relaxed">
            <span
              className={cn(
                "min-w-0 flex-1",
                // Collapsed truncates; expanded wraps AND becomes selectable —
                // without `select-text` a drag to select output toggles the row.
                expanded ? "select-text whitespace-pre-wrap break-words" : "truncate",
                headingClass
              )}
              onClick={expanded ? stopRowToggleWhileSelectingText : undefined}
              onPointerDown={expanded ? stopRowToggle : undefined}
            >
              {label}
            </span>
          </p>
          {failed && !destructive ? (
            <X size={12} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500/40" />
          ) : null}
          <TimelineRowTimestamp createdAt={entry.createdAt} />
          {/* `invisible`, not absent, so labels stay aligned down the column. */}
          <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center", !canExpand && "invisible")}>
            <DisclosureChevron open={expanded} />
          </span>
        </div>
      </div>
      {expanded && entry.questionAnswer ? <QuestionAnswerHistory answer={entry.questionAnswer} /> : null}
      {expanded && canExpand && entry.questionAnswer === undefined ? (
        <div
          className="ms-7 mt-1 cursor-default rounded-md bg-neutral-900/60 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          {command.length > 0 ? (
            <pre className="ac-scroll-thin mb-2 max-h-24 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-300 last:mb-0">
              {command}
            </pre>
          ) : null}
          {diff !== null ? (
            <InlineDiff diff={diff} workspaceRoot={ctx.workspaceRoot} onOpenFile={ctx.onOpenFile} />
          ) : detail.length > 0 ? (
            <ToolOutput id={entry.id} text={detail} ctx={ctx} />
          ) : null}
          {diff === null && changedFiles.length > 0 ? (
            <div className={cn("flex flex-col gap-0.5", (command.length > 0 || detail.length > 0) && "mt-2")}>
              {changedFiles.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => ctx.onOpenFile(path)}
                  className="flex w-full min-w-0 items-center rounded px-1 py-0.5 text-left font-mono text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
                >
                  <span className="min-w-0 truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : null}
          {/* §5.6: offered ONLY where the slimmer stamped `truncated`, so the
              button is a promise that the full read really has more. */}
          {entry.truncated === true ? (
            <button
              type="button"
              onClick={() => ctx.onLoadFullOutput(entry.id)}
              className="mt-2 rounded text-[11px] text-neutral-500 transition-colors hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              Load full output
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

// ---------------------------------------------------------------------------
// work / work-live / work-toggle
// ---------------------------------------------------------------------------

export const WorkRow = React.memo(function WorkRow({ row }: { row: Row<"work"> }): React.ReactElement {
  const entries = React.useMemo(
    () => omitSupersededLifecycleMarkers(row.groupedEntries, (entry) => entry),
    [row.groupedEntries]
  );
  return (
    <div className={row.isExpandedToolGroup ? "ms-7 flex flex-col" : "flex flex-col"}>
      {entries.map((entry) => (
        <ToolEntryRow
          key={entry.id}
          entry={entry}
          insideExpandedGroup={row.isExpandedToolGroup}
          displayLabel={entries.length === 1 ? row.displayLabel : undefined}
        />
      ))}
    </div>
  );
});

/** The single live tool row of a running turn; a spawn entry takes the spawn row. */
export const WorkLiveRow = React.memo(function WorkLiveRow({
  row
}: {
  row: Row<"work-live">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  if (row.entry.agentSpawn) return <AgentSpawnRow entry={row.entry} active={row.active} />;
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      aria-label={failed ? `${label}, tool call failed` : undefined}
      onClick={() => ctx.setExpanded(row.groupId, !row.expanded)}
      className="flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
    >
      <LiveActivityLine
        label={label}
        iconName={workEntryIconName(row.entry)}
        live={row.active && !failed}
        failed={failed}
      />
    </button>
  );
});

/** The "+N more" toggle inside a long expanded group. */
export const WorkToggleRow = React.memo(function WorkToggleRow({
  row
}: {
  row: Row<"work-toggle">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();
  // Collapsed, the row names what is hidden ("+4 more"); with nothing hidden it
  // falls back to the group's own settled summary. Expanded it offers the way
  // back, because a "+N more" that stays after opening reads as a second batch.
  const label = row.expanded
    ? "Show less"
    : row.hiddenCount > 0
      ? `+${row.hiddenCount} more`
      : row.summary;
  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : row.summary}
      onClick={() => ctx.setExpanded(row.groupId, !row.expanded)}
      className="group/timeline-row relative flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500">
        <WorkEntryIcon name={summaryKindIconName(row.summaryKind)} />
      </span>
      <span className="min-w-0 flex-1 truncate text-neutral-400">{label}</span>
      <TimelineRowTimestamp createdAt={row.createdAt} />
      <DisclosureChevron open={row.expanded} />
    </button>
  );
});

// ---------------------------------------------------------------------------
// The activity group
// ---------------------------------------------------------------------------

/**
 * The compressed representation of everything the agent did between two
 * assistant messages, and the densest thing in the UI.
 *
 * **The whole header row is the toggle and it carries no chevron** —
 * `aria-expanded` only. That is a real departure from generic disclosure UI and
 * it is what keeps a collapsed timeline calm.
 * *T3: `MessagesTimeline.tsx:2661-2678`.*
 */
export const ActivityGroupRow = React.memo(function ActivityGroupRow({
  row
}: {
  row: Row<"activity-group">;
}): React.ReactElement {
  const ctx = useTimelineRowContext();

  const visible = React.useMemo(
    () =>
      omitSupersededLifecycleMarkers(
        row.entries.filter((entry) => workEntryIsVisibleInGroup(entry, row.active)),
        (entry) => entry
      ),
    [row.entries, row.active]
  );

  const reasoningCount = row.entries.filter((entry) => entry.tone === "thinking").length;
  const tools = visible.filter((entry) => entry.tone !== "thinking");
  const liveWork = [...tools].reverse().find(workEntryIsActiveTurnActivity) ?? tools.at(-1);
  const thinking = row.active && liveWork === undefined;
  const iconEntry = row.active ? liveWork : tools.at(-1);
  const failed = iconEntry !== undefined && workEntryDisplayIndicatesToolFailure(iconEntry);

  const label = row.active
    ? liveWork
      ? liveWorkEntryLabel(liveWork, ctx.workspaceRoot, true)
      : "Thinking"
    : tools.length > 0
      ? summarizeToolGroup(tools)
      : `Thought${reasoningCount > 1 ? ` (×${reasoningCount})` : ""}`;

  return (
    <div>
      <button
        type="button"
        aria-expanded={row.expanded}
        aria-label={failed ? `${label}, tool call failed` : undefined}
        onClick={() => ctx.setExpanded(row.groupId, !row.expanded)}
        className="flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <LiveActivityLine
          label={label}
          iconName={iconEntry ? workEntryIconName(iconEntry) : "brain"}
          live={row.active && !failed && (thinking || liveWork !== undefined)}
          failed={failed}
        />
      </button>
      {row.expanded ? (
        <div className="ms-7 mt-2 flex flex-col">
          {row.entries.map((entry) =>
            entry.tone === "thinking" ? (
              <ReasoningTraceBlock key={entry.id} entry={entry} />
            ) : (
              <ToolEntryRow key={entry.id} entry={entry} insideExpandedGroup />
            )
          )}
        </div>
      ) : null}
    </div>
  );
});

function ReasoningTraceBlock({ entry }: { entry: WorkLogEntry }): React.ReactElement {
  const text = entry.detail ?? entry.label;
  return (
    <div className="px-0.5 py-0.5 text-sm leading-relaxed">
      <p className="whitespace-pre-wrap select-text text-neutral-400">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The spawn row
// ---------------------------------------------------------------------------

const MEMBER_STATUS_LABEL: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped"
};

/**
 * One row per spawn batch.
 *
 * **The row stores only ids** — the batch's `workflowId` and its member task
 * ids — and resolves its label, live flag and member list from the roster **at
 * render time**. Persisting a count here would go stale the moment a member
 * finished (§7.6).
 */
export const AgentSpawnRow = React.memo(function AgentSpawnRow({
  entry,
  active
}: {
  entry: WorkLogEntry;
  active?: boolean | undefined;
}): React.ReactElement | null {
  const ctx = useTimelineRowContext();
  const spawn = entry.agentSpawn;
  const expanded = ctx.isAgentRowExpanded(entry.id);

  const { agents, coordinatorStatus, agentCount } = React.useMemo(() => {
    if (!spawn) return { agents: [] as RuntimeSubagent[], coordinatorStatus: undefined, agentCount: 0 };
    const memberIds = new Set(spawn.agentTaskIds);
    const coordinator =
      spawn.workflowId === null
        ? undefined
        : ctx.roster.find((agent) => agent.id === spawn.workflowId);
    const members = ctx.roster.filter(
      (agent) => memberIds.has(agent.id) || (coordinator !== undefined && agent.parentAgentId === coordinator.id)
    );
    return {
      agents: members,
      coordinatorStatus: coordinator?.status,
      agentCount: Math.max(members.length, Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0))
    };
  }, [ctx.roster, spawn]);

  if (!spawn) return null;

  const summary = deriveAgentSpawnSummary({ agents, agentCount, coordinatorStatus });
  const workflowName = agents.find((agent) => agent.workflowName !== null)?.workflowName ?? null;
  const lead = workflowName ? `${summary.lead} · ${workflowName}` : summary.lead;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => ctx.setAgentRowExpanded(entry.id, !expanded)}
        className="flex cursor-pointer select-none rounded-md text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      >
        <LiveActivityLine
          label={
            <span className="flex min-w-0 gap-1.5">
              <span className="shrink-0">{lead}</span>
              <span
                className={cn(
                  "truncate",
                  summary.tone === "failed" ? "text-danger-300" : "text-neutral-500"
                )}
              >
                {summary.status}
              </span>
            </span>
          }
          iconName="bot"
          live={summary.live && active !== false}
          failed={summary.tone === "failed"}
        />
      </button>
      {expanded ? (
        <div className="ms-7 mt-0.5 flex flex-col">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => ctx.onOpenAgent(agent.id)}
              className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
            >
              <span className="min-w-0 flex-1 truncate text-neutral-300">{agent.title}</span>
              <span className="shrink-0 text-neutral-500">{MEMBER_STATUS_LABEL[agent.status]}</span>
            </button>
          ))}
          {agents.length === 0 ? (
            <span className="px-1 py-0.5 text-xs italic text-neutral-600">No agent rows reported</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
