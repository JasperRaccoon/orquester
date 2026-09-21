/**
 * The status line that sits between the timeline and the banner dock (§7.6):
 * elapsed time, tokens so far, the current activity label, and the
 * context-window meter.
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
import { formatPlanProgress, planIsRunning, resolveStatusLine } from "./status-line";

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
  activePlan,
  onCompact,
  latestCheckpoint
}: ChatStatusLineProps): React.ReactElement {
  const status = resolveStatusLine({ connection, turnStartedAt, activityLabel });
  const meter = React.useMemo(
    () =>
      deriveContextMeter({
        usedTokens: tokensUsed,
        maxTokens: contextMaxTokens,
        autoCompactAtTokens,
        totalProcessedTokens,
        reportsContextWindow
      }),
    [tokensUsed, contextMaxTokens, autoCompactAtTokens, totalProcessedTokens, reportsContextWindow]
  );
  const planProgress = formatPlanProgress(activePlan);
  const checkpointFiles = latestCheckpoint?.files.length ?? 0;

  return (
    <div
      data-session-id={sessionId}
      className="w-full shrink-0 px-3 sm:px-5"
      role="status"
      aria-live="polite"
    >
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
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-neutral-500"
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
            <ContextMeter model={meter} onCompact={onCompact} />
          </>
        ) : null}
      </div>
    </div>
  );
}

export default ChatStatusLine;
