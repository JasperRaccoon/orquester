/**
 * The status line that sits between the timeline and the banner dock (§7.6):
 * elapsed time, tokens so far, the current activity label, the thread's goal
 * (goals §8.2), and the context-window meter.
 *
 * **Anything that changes every second is a self-ticking leaf.** The elapsed
 * readout is an {@link ElapsedTicker} — a DOM write, zero React commits — and
 * the label is a {@link ShimmerText} whose text is swapped in place rather
 * than remounted, so a `Starting… → Working → Read 3 files` progression never
 * restarts the shimmer or re-measures the line.
 * *T3: `MessagesTimeline.tsx:267-272` ("nowIso is intentionally excluded —
 * self-ticking components handle it") and `:2890` (`WorkingTimer`).*
 *
 * The row's height is fixed and every optional chip keeps a stable order, so
 * the line never reflows as facts arrive mid-turn.
 */

import React from "react";
import { GitCommitHorizontal, ListChecks } from "lucide-react";
import { cn } from "../../../lib/cn";
import type { ChatStatusLineProps } from "../contracts";
import { ElapsedTicker, ShimmerText, StatusDot } from "../primitives";
import { TONE_TEXT } from "../primitives/tone";
import { ContextMeter } from "./ContextMeter";
import { deriveContextMeter, formatContextTokens } from "./context-meter";
import { GoalChip } from "./GoalChip";
import type { GoalActionModel } from "./goal-chip";
import { formatPlanProgress, planIsRunning, resolveStatusLine } from "./status-line";

/** Stable empties, so a thread without goal actions never churns the chip's props. */
const NO_GOAL_ACTIONS: readonly GoalActionModel[] = [];
const noGoalAction = (): void => {};

export function ChatStatusLine({
  sessionId,
  connection,
  turnStartedAt,
  activityLabel,
  tokensUsed,
  contextMaxTokens,
  autoCompactAtTokens,
  totalProcessedTokens,
  reportsContextWindow,
  compactsAutomatically = null,
  activePlan,
  onCompact,
  latestCheckpoint,
  modelLabel = null,
  goal = null,
  goalHeldForUpdate = false,
  goalActions = NO_GOAL_ACTIONS,
  goalActionsNote = null,
  onGoalAction = noGoalAction
}: ChatStatusLineProps): React.ReactElement {
  const status = resolveStatusLine({ connection, turnStartedAt, activityLabel });
  const meter = React.useMemo(
    () =>
      deriveContextMeter({
        usedTokens: tokensUsed,
        maxTokens: contextMaxTokens,
        autoCompactAtTokens,
        totalProcessedTokens,
        reportsContextWindow,
        compactsAutomatically
      }),
    [
      tokensUsed,
      contextMaxTokens,
      autoCompactAtTokens,
      totalProcessedTokens,
      reportsContextWindow,
      compactsAutomatically
    ]
  );
  const planProgress = formatPlanProgress(activePlan);
  const checkpointFiles = latestCheckpoint?.files.length ?? 0;

  return (
    // Deliberately not a live region: the activity label changes every few
    // seconds while a turn runs, and an `aria-live` here would read the whole
    // line out on every tool call. The banner dock and the roster carry the
    // announcements that actually need one.
    <div data-session-id={sessionId} aria-label="Thread status" className="w-full shrink-0 px-3 sm:px-5">
      <div className="mx-auto flex h-7 w-full max-w-3xl min-w-0 items-center gap-2 text-[11px] leading-4">
        <StatusDot tone={status.tone} size="xs" pulse={status.pulse} />
        <ShimmerText
          live={status.live}
          className={cn("min-w-0 flex-1 truncate", !status.live && TONE_TEXT[status.tone])}
          title={status.label}
        >
          {status.label}
        </ShimmerText>

        {status.ticking && turnStartedAt !== null ? (
          <span className="shrink-0 font-mono text-neutral-500">
            <ElapsedTicker startedAt={turnStartedAt} live />
          </span>
        ) : null}

        {/* Goals §8.2: the goal's slot, before the plan chip. The chip renders
            nothing for a finished goal, so the line never keeps a gap. A
            goal a deploy holds (§5.7) keeps the in-motion tone. */}
        {goal !== null ? (
          <GoalChip
            sessionId={sessionId}
            goal={goal}
            turnRunning={status.ticking}
            heldForUpdate={goalHeldForUpdate}
            actions={goalActions}
            actionsNote={goalActionsNote}
            onAction={onGoalAction}
          />
        ) : null}

        {planProgress ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 font-mono text-neutral-500",
              planIsRunning(activePlan) && "text-info-300"
            )}
            title="Plan steps completed"
          >
            <ListChecks size={12} aria-hidden />
            <span className="ac-tabular">{planProgress}</span>
          </span>
        ) : null}

        {checkpointFiles > 0 && latestCheckpoint ? (
          // Below `sm` the row has no width to spare: the checkpoint gives its
          // share back (the changed-files card in the timeline still says it).
          <span
            className="hidden shrink-0 items-center gap-1 font-mono text-neutral-500 sm:flex"
            title={`Checkpoint at turn ${latestCheckpoint.checkpointTurnCount}`}
          >
            <GitCommitHorizontal size={12} aria-hidden />
            <span className="ac-tabular">
              {checkpointFiles} {checkpointFiles === 1 ? "file" : "files"}
            </span>
          </span>
        ) : null}

        {meter ? (
          <>
            <span className="ac-tabular shrink-0 font-mono text-neutral-500">
              {formatContextTokens(meter.usedTokens)} tok
            </span>
            <ContextMeter sessionId={sessionId} model={meter} modelLabel={modelLabel} onCompact={onCompact} />
          </>
        ) : null}
      </div>

      {/*
        The indeterminate turn hairline, D's `ac-working-bar`: a 40%-wide fill
        sliding inside a 1px track, directly under the status line, which is
        where the design reference puts it. It reads as "the turn is alive"
        from the corner of the eye without another spinner, and it is the one
        element here that says so while the label is truncated or the tab is
        half-scrolled away. The track only exists while a turn runs, so a
        settled thread has no extra hairline under its status row.
      */}
      <div className="mx-auto h-px w-full max-w-3xl overflow-hidden" aria-hidden>
        {status.ticking ? (
          <div className="ac-working-bar h-px rounded-full bg-info/70" />
        ) : null}
      </div>
    </div>
  );
}

export default ChatStatusLine;
