// Ported from T3 Code (MIT): apps/web/src/components/AgentsPanel.tsx:139-192

/**
 * One roster row — the agent rows and the thread's own `main` row (§7.6).
 *
 * **Three fixed lines, one fixed height (62px).** Identity, activity, metrics.
 * A row must never change height when its data changes: a roster that reflows
 * while the pointer is over it moves the click target out from under the user,
 * and with a live agent updating twice a second it would never be still.
 * Every slot is therefore always rendered — the token count shows `— tok`
 * rather than disappearing, and the drill-in chevron keeps its 12px whether or
 * not the row is hovered.
 *
 * *T3: `AgentsPanel.tsx:1-12` (the visualization rules) and `:158` (the grid).*
 */

import React from "react";
import { Bot, Check, ChevronRight, Terminal } from "lucide-react";
import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import { cn } from "../../../lib/cn";
import { ElapsedTicker, StatusDot } from "../primitives";
import type { ChatTone } from "../primitives/tone";
import { agentActivityText, rosterRoleChip, rosterRowMetrics } from "./format";
import { rosterRowTicks, rosterStatusVisual } from "./roster-rows";

/** The grid every roster row shares. Changing this changes all of them. */
const ROW_GRID = cn(
  "grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto]",
  "grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left"
);

const ACTIVITY_LINE = "col-start-2 col-end-4 row-start-2 block truncate text-xs";
const METRICS_LINE =
  "ac-tabular col-start-2 col-end-4 row-start-3 truncate font-mono text-[11px] text-neutral-500";

export interface AgentRosterRowProps {
  agent: RuntimeSubagent;
  /** Rendered, but on its way out after the turn settled (§7.6). */
  fading?: boolean;
  /** This agent's timeline is the one open in the main area. */
  active?: boolean;
  onOpen: (agentId: string) => void;
}

export function AgentRosterRow({
  agent,
  fading = false,
  active = false,
  onOpen
}: AgentRosterRowProps): React.ReactElement {
  const visuals = rosterStatusVisual(agent.status);
  // A spawn batch that goes idle is just idle — it has no run of its own to
  // resume. *T3: `AgentsPanel.tsx:142-143`.*
  const statusLabel =
    agent.kind === "subagent_batch" && agent.status === "idle" ? "Idle" : visuals.label;
  const activity = agentActivityText(agent);
  const role = rosterRoleChip(agent);
  const metrics = rosterRowMetrics(agent);
  const background = agent.agentKind === "background";
  const Icon = background ? Terminal : Bot;

  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      aria-label={`${agent.title} — ${statusLabel}`}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-agent-kind={agent.agentKind}
      className={cn(
        // `ac-enter` is a one-shot on insertion: a row that updates in place
        // keeps the same element, so a spawn animates and a status change does
        // not. *T3: `AgentsPanel.tsx:4-5` — "Activity and completion update
        // rows in place".*
        "group ac-press ac-enter",
        ROW_GRID,
        "transition-opacity duration-300 motion-reduce:transition-none",
        "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1",
        "focus-visible:ring-inset focus-visible:ring-neutral-500",
        active && "bg-neutral-800",
        fading && "pointer-events-none opacity-0"
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot tone={visuals.tone} size="xs" pulse={visuals.pulse} />
      </span>

      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <Icon
          size={13}
          strokeWidth={1.8}
          aria-hidden
          className={cn("shrink-0", background ? "text-neutral-600" : "text-neutral-500")}
        />
        <span className="min-w-0 truncate text-sm font-medium text-neutral-200">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-neutral-800 px-1 font-mono text-[10px] text-neutral-500">
            {role}
          </span>
        ) : null}
      </span>

      <span className="col-start-3 row-start-1 flex items-center gap-1 text-right font-mono text-[11px] text-neutral-500">
        <span className="inline-flex min-w-14 items-center justify-end gap-1">
          <ElapsedTicker
            startedAt={agent.startedAt}
            endedAt={agent.completedAt}
            live={rosterRowTicks(agent.status)}
          />
          {agent.status === "completed" ? (
            <Check size={12} aria-hidden className="shrink-0 text-ok" />
          ) : null}
        </span>
        {/* The slot is always 12px wide, so revealing the chevron on hover
            cannot shift the elapsed readout beside it. */}
        <span className="flex w-3 shrink-0 items-center justify-center">
          <ChevronRight size={12} aria-hidden className="ac-reveal text-neutral-500" />
        </span>
      </span>

      <span
        className={cn(
          ACTIVITY_LINE,
          agent.status === "failed" ? "text-danger-300" : "text-neutral-500"
        )}
      >
        {activity ?? statusLabel}
      </span>
      <span className={METRICS_LINE}>{metrics.join(" · ")}</span>
      <span className="sr-only">{statusLabel}</span>
    </button>
  );
}

export interface RosterMainRowProps {
  title: string;
  tone: ChatTone;
  pulse: boolean;
  /**
   * The act-now halo, D's one "at most one dot on screen should ever ping"
   * affordance. The thread's own row is where it belongs in this surface: the
   * roster's other rows are agents doing their job, and only the parent can be
   * *waiting on the user*.
   */
  ping?: boolean;
  statusLabel: string;
  activityLabel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
  metrics: string[];
}

/**
 * The thread's own row, first in the list and never interactive: you are
 * already looking at it. It carries the same three lines so the roster reads
 * as one list rather than a header plus a list.
 */
export function RosterMainRow({
  title,
  tone,
  pulse,
  ping = false,
  statusLabel,
  activityLabel,
  startedAt,
  endedAt,
  live,
  metrics
}: RosterMainRowProps): React.ReactElement {
  return (
    <div className={cn(ROW_GRID, "cursor-default")} data-roster-main="true">
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot tone={tone} size="xs" pulse={pulse} ping={ping} label={statusLabel} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium text-neutral-200">{title}</span>
      </span>
      <span className="col-start-3 row-start-1 flex items-center gap-1 font-mono text-[11px] text-neutral-500">
        <span className="inline-flex min-w-14 items-center justify-end">
          <ElapsedTicker startedAt={startedAt} endedAt={endedAt} live={live} />
        </span>
        <span className="w-3 shrink-0" aria-hidden />
      </span>
      <span className={cn(ACTIVITY_LINE, "text-neutral-500")}>{activityLabel ?? statusLabel}</span>
      <span className={METRICS_LINE}>{metrics.join(" · ")}</span>
      <span className="sr-only">{statusLabel}</span>
    </div>
  );
}
