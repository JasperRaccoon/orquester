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
import { isFinishedRow, rosterRowTicks, rosterStatusVisual } from "./roster-rows";

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
        fading ? "pointer-events-none opacity-0" : isFinishedRow(agent) && "opacity-70 hover:opacity-100"
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot tone={visuals.tone} size="xs" pulse={visuals.pulse} />
      </span>

      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <Bot size={13} strokeWidth={1.8} aria-hidden className="shrink-0 text-neutral-500" />
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

/**
 * A background shell's row (§7.6) — **two lines, not three, and its own shape.**
 *
 * A shell is a command, not a persona: it has no model, spends no tokens and
 * calls no tools, so the agent row's third line had nothing true to say about
 * it and a chip reading "shell" was the only thing telling the two apart. The
 * shell row is therefore shorter and denser — identity, then the one fact a
 * process has (running, or how it exited) — with the terminal glyph framed as
 * a process box and the exit code as a badge whose tone says success or
 * failure at a glance. Fixed height like every roster row (2.875rem).
 */
const SHELL_ROW_GRID = cn(
  "grid h-[2.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto]",
  "grid-rows-[1.25rem_1.125rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left"
);

export function BackgroundShellRow({
  agent,
  fading = false,
  active = false,
  onOpen
}: AgentRosterRowProps): React.ReactElement {
  const visuals = rosterStatusVisual(agent.status);
  const activity = agentActivityText(agent) ?? visuals.label;
  const live = rosterRowTicks(agent.status);
  const exit = typeof agent.exitCode === "number" && !live ? agent.exitCode : null;

  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      aria-label={`${agent.title} — background shell, ${activity}`}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-agent-kind={agent.agentKind}
      className={cn(
        "group ac-press ac-enter",
        SHELL_ROW_GRID,
        "transition-opacity duration-300 motion-reduce:transition-none",
        "hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1",
        "focus-visible:ring-inset focus-visible:ring-neutral-500",
        active && "bg-neutral-800",
        fading ? "pointer-events-none opacity-0" : isFinishedRow(agent) && "opacity-70 hover:opacity-100"
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot tone={visuals.tone} size="xs" pulse={visuals.pulse} />
      </span>

      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-neutral-800 text-neutral-400"
        >
          <Terminal size={11} strokeWidth={2} />
        </span>
        <span className="min-w-0 truncate text-sm text-neutral-300">{agent.title}</span>
      </span>

      <span className="col-start-3 row-start-1 flex items-center gap-1 font-mono text-[11px] text-neutral-500">
        <span className="inline-flex min-w-14 items-center justify-end gap-1.5">
          {exit !== null ? (
            <span
              data-shell-exit={exit}
              className={cn(
                "rounded-sm px-1 text-[10px] leading-4",
                exit === 0 ? "bg-ok-soft/40 text-ok" : "bg-danger-soft/40 text-danger-300"
              )}
            >
              exit {exit}
            </span>
          ) : null}
          <ElapsedTicker startedAt={agent.startedAt} endedAt={agent.completedAt} live={live} />
        </span>
        <span className="flex w-3 shrink-0 items-center justify-center">
          <ChevronRight size={12} aria-hidden className="ac-reveal text-neutral-500" />
        </span>
      </span>

      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate font-mono text-[11px]",
          agent.status === "failed" ? "text-danger-300" : "text-neutral-500"
        )}
      >
        {activity}
      </span>
      <span className="sr-only">{visuals.label}</span>
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
  /** Present while a drill-in is open: the row becomes the way back. */
  onOpen?: (() => void) | undefined;
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
  metrics,
  onOpen
}: RosterMainRowProps): React.ReactElement {
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className={cn(
        ROW_GRID,
        onOpen
          ? "cursor-pointer rounded-md text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
          : "cursor-default"
      )}
      data-roster-main="true"
    >
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
    </Tag>
  );
}
