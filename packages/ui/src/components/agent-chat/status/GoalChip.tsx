/**
 * The goal chip and its popover (goals §8.2).
 *
 * The chip is a compact readout in the status line's stable slot before the
 * plan chip — `Goal round 3`, `Goal paused`, `Goal budget 48k/50k tok` — in
 * the in-motion tone while the goal is active and the warn tone once it has
 * stopped short. Its label shimmers only while a turn is actually running.
 * A goal a deploy HELD (goals §5.7) reads `Goal paused for update` in the
 * in-motion tone, and its popover says it resumes by itself: the tab reads
 * working, and nothing went wrong.
 *
 * **Click, not hover.** The context meter opens on hover because reading it is
 * a glance; this popover carries actions, and an action is a decision. The
 * objective is still one hover away, in the chip's tooltip.
 *
 * **A dialog, not a menu**: a text readout and plain buttons are not menu
 * items. Opening it moves focus in — to its first action, else the panel —
 * and closing it from the keyboard or an action gives focus back to the chip;
 * while it is open, Escape closes it and does nothing else (the panel is a
 * keyboard layer the chat's own Escape handling yields to).
 *
 * The popover is the one place the WHOLE objective is shown — it wraps, and
 * scrolls past about a dozen lines rather than growing off screen — with every
 * fact the provider reported and the actions the §8.2 matrix offers. The
 * actions are messages: the shell sends them through the composer's own send
 * path, so each lands as the user's message (goals §8.2).
 */

import React from "react";
import { Target } from "lucide-react";
import type { AgentGoal, GoalAction } from "@orquester/api/agent-chat";

import { cn } from "../../../lib/cn";
import { Button } from "../../ui/button";
import { Dropdown, DropdownContext } from "../../ui/dropdown";
import { DROPDOWN_DESTRUCTIVE_ATTRIBUTE } from "../../ui/dropdown-logic";
import { ShimmerText } from "../primitives";
import {
  deriveGoalChip,
  deriveGoalPanel,
  goalPopoverProps,
  type GoalActionModel,
  type GoalChipTone
} from "./goal-chip";

/** The chip's tone, on the theme's semantic scale (the tab marker's too). */
const CHIP_TONE: Record<GoalChipTone, string> = {
  info: "text-info-300",
  warn: "text-warn-300"
};

/**
 * The trigger `<button>`: it may shrink below its content in the status line
 * (at 360 px the row has ~312 px, and every sibling but the activity label is
 * `shrink-0`), so the chip's detail truncates instead of pushing the token
 * count and the context meter off screen — and it shows the repo's focus ring.
 */
const TRIGGER_CLASS =
  "min-w-0 shrink rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

export interface GoalChipProps {
  /**
   * The thread the chip belongs to: its popover closes when this thread's tab
   * is left — never when it is activated. Absent: on any tab change.
   */
  sessionId?: string | null;
  /** The thread's goal. A finished one — or none — renders nothing. */
  goal: AgentGoal;
  /** The status line's own "a turn is running": an active goal's label shimmers. */
  turnRunning: boolean;
  /**
   * The paused goal is held for an Orquester update (goals §5.7,
   * `isGoalHeldForUpdate`), for the chip and its popover alike. Ignored on
   * any other status.
   */
  heldForUpdate?: boolean;
  /** Already gated by the §8.2 matrix; empty ⇒ the popover is a readout. */
  actions: readonly GoalActionModel[];
  /** Why there are no actions right now, when that needs saying. */
  actionsNote?: string | null;
  onAction: (action: GoalAction) => void;
}

export function GoalChip({
  sessionId,
  goal,
  turnRunning,
  heldForUpdate = false,
  actions,
  actionsNote = null,
  onAction
}: GoalChipProps): React.ReactElement | null {
  // One identity per thread: the Dropdown's dismiss effect is keyed on it.
  const popoverProps = React.useMemo(() => goalPopoverProps(sessionId ?? null), [sessionId]);
  const chip = deriveGoalChip(goal, turnRunning, { heldForUpdate });
  if (chip === null) return null;
  return (
    <Dropdown
      align="right"
      width="w-72"
      className="p-0"
      triggerClassName={TRIGGER_CLASS}
      {...popoverProps}
      trigger={
        <span
          title={chip.title}
          className={cn(
            "ac-press inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1 font-mono",
            "hover:bg-neutral-800",
            CHIP_TONE[chip.tone]
          )}
        >
          <Target size={12} aria-hidden className="shrink-0" />
          {/* The visible fragments are for the eye; the button's spoken name
              is the one sentence in the `sr-only` span below. */}
          <span aria-hidden className="inline-flex min-w-0 items-center gap-1">
            {/* `.ac-shimmer` owns its colour while live; settled, the tone does. */}
            <ShimmerText live={chip.live} className={cn(!chip.live && CHIP_TONE[chip.tone])}>
              Goal
            </ShimmerText>
            {chip.detail !== null ? (
              <>
                {/* Below `sm` the short form, capped hard: the popover has the rest. */}
                <span className="ac-tabular max-w-[4.5rem] truncate sm:hidden">{chip.detailShort}</span>
                <span className="ac-tabular hidden max-w-[10rem] truncate sm:inline">{chip.detail}</span>
              </>
            ) : null}
            {chip.tokens !== null ? (
              <span className="ac-tabular hidden text-neutral-500 sm:inline">{chip.tokens}</span>
            ) : null}
          </span>
          <span className="sr-only">{chip.ariaLabel}</span>
        </span>
      }
    >
      <GoalPanel
        goal={goal}
        heldForUpdate={heldForUpdate}
        actions={actions}
        actionsNote={actionsNote}
        onAction={onAction}
      />
    </Dropdown>
  );
}

export interface GoalPanelProps {
  goal: AgentGoal;
  /** The paused goal is held for an Orquester update (goals §5.7): its status says so. */
  heldForUpdate?: boolean;
  actions: readonly GoalActionModel[];
  actionsNote?: string | null;
  onAction: (action: GoalAction) => void;
}

/** One fact of the readout: a muted label, then its value. */
function Fact({
  label,
  children,
  title
}: {
  label: string;
  children: React.ReactNode;
  title?: string | undefined;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px] leading-4">
      <span className="shrink-0 text-neutral-500">{label}</span>
      <span className="ac-tabular min-w-0 text-right text-neutral-300" title={title}>
        {children}
      </span>
    </div>
  );
}

/**
 * The popover's contents, exported so the readout can be rendered — and
 * asserted — without driving the popover open (the `ContextMeterPanel`
 * pattern). An action closes the popover as it fires.
 */
export function GoalPanel({
  goal,
  heldForUpdate = false,
  actions,
  actionsNote = null,
  onAction
}: GoalPanelProps): React.ReactElement {
  const { close } = React.useContext(DropdownContext);
  const panel = deriveGoalPanel(goal, new Date(), { heldForUpdate });
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
          <Target size={12} aria-hidden />
          Goal
        </div>
        <div className="min-w-0 text-right text-[11px] leading-4 text-neutral-400">
          {panel.statusLabel}
          {panel.phase !== null ? (
            <>
              <span className="mx-1 text-neutral-600">·</span>
              {panel.phase}
            </>
          ) : null}
        </div>
      </div>

      {/* ~12 lines of 16px before it scrolls: a long objective is read, not a wall. */}
      <p className="ac-scroll-thin max-h-48 select-text overflow-y-auto whitespace-pre-wrap break-words text-xs leading-4 text-neutral-200">
        {panel.objective}
      </p>

      {panel.rounds !== null ? <Fact label="Rounds">{panel.rounds}</Fact> : null}
      {panel.lastCheck !== null ? (
        <div className="flex flex-col gap-0.5 text-[11px] leading-4">
          <span className="text-neutral-500">Last check</span>
          <span className="select-text whitespace-pre-wrap break-words text-neutral-300">
            {panel.lastCheck}
          </span>
        </div>
      ) : null}
      {panel.tokens !== null ? <Fact label="Tokens">{panel.tokens}</Fact> : null}
      {panel.elapsed !== null ? <Fact label="Elapsed">{panel.elapsed}</Fact> : null}
      {panel.setAt !== null ? (
        <Fact label="Set" title={panel.setAtTitle ?? undefined}>
          {panel.setAt}
        </Fact>
      ) : null}

      {actions.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {actions.map((model) => (
            <Button
              key={model.action}
              variant="outline"
              size="sm"
              // What the button will say on the user's behalf, before it does.
              title={`Sends “${model.text}”`}
              // Never the control focus lands on when the popover opens.
              {...(model.destructive ? { [DROPDOWN_DESTRUCTIVE_ATTRIBUTE]: "true" } : {})}
              onClick={() => {
                onAction(model.action);
                close();
              }}
            >
              {model.label}
            </Button>
          ))}
        </div>
      ) : actionsNote !== null ? (
        <p className="text-[11px] leading-4 text-neutral-500">{actionsNote}</p>
      ) : null}
    </div>
  );
}
