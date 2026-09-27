// Ported from T3 Code (MIT): apps/web/src/components/chat/ContextWindowMeter.tsx

/**
 * The context-window meter and its popover (§7.6).
 *
 * A ring, because it lives inline in a dense control row where a bar would
 * either be too short to read or steal the width the controls need. Over 90 %
 * it turns destructive — the one place in the chat UI where a colour change is
 * a *threshold* rather than a state, so it is abrupt by design.
 *
 * The popover carries the four things the spec names: used/total, the total
 * processed across the thread, the auto-compaction sentence, and a **Compact**
 * button — always present, because §4.6.3 synthesises `/compact` on all four
 * adapters.
 *
 * **Without a context window there is no ring and no percentage**, only a bare
 * token count: an adapter with `reportsContextWindow: false`, or a model whose
 * provider catalogue names no window, gets the degraded readout rather than a
 * fabricated 0 %.
 */

import React from "react";
import { Minimize2 } from "lucide-react";
import { cn } from "../../../lib/cn";
import { dismissWhenChatTabLeaves } from "../../../lib/agent-chat-active-tab";
import { Button } from "../../ui/button";
import { Dropdown } from "../../ui/dropdown";
import { MeterRing } from "../primitives";
import { formatMeterPercent, isMeterOverloaded } from "../primitives/meter";
import {
  formatAutoCompactionSentence,
  formatContextTokens,
  type ContextMeterModel
} from "./context-meter";

export interface ContextMeterProps {
  /**
   * The thread the meter belongs to: its popover (whose Compact button acts
   * on this thread) closes when this thread's tab is left — never when it is
   * activated. Absent: on any tab change.
   */
  sessionId?: string | null;
  model: ContextMeterModel;
  /** Names the model in the auto-compaction sentence when no threshold is reported. */
  modelLabel?: string | null;
  onCompact: () => void;
  compactDisabled?: boolean;
  compactDisabledReason?: string | null;
}

export function ContextMeter({
  sessionId,
  model,
  modelLabel = null,
  onCompact,
  compactDisabled = false,
  compactDisabledReason = null
}: ContextMeterProps): React.ReactElement {
  const percent = formatMeterPercent(model.usedPercentage);
  const overloaded = isMeterOverloaded(model.usedPercentage);
  // One identity per thread: the Dropdown's dismiss effect is keyed on it.
  const dismissOn = React.useMemo(() => dismissWhenChatTabLeaves(sessionId ?? null), [sessionId]);
  const label =
    percent === null
      ? `Context window: ${formatContextTokens(model.usedTokens)} tokens used`
      : `Context window ${percent} used`;

  return (
    <Dropdown
      align="right"
      width="w-64"
      className="p-0"
      // Reading the remaining context is a glance, not a decision — T3 opens
      // this one on hover and holds it open long enough to reach the Compact
      // button inside it. Click still works, and touch is click-only.
      // *T3: `ContextWindowMeter.tsx:39-42`.*
      openOnHover
      hoverOpenDelay={150}
      hoverCloseDelay={150}
      // The repo's focus ring on the trigger `<button>` itself.
      triggerClassName="rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      // Its Compact button is bound to this thread: close when the tab is left.
      dismissOn={dismissOn}
      trigger={
        <span
          className={cn(
            "ac-press inline-flex h-7 w-7 items-center justify-center rounded-full",
            "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          )}
        >
          <MeterRing value={model.usedPercentage} size={20} label={label} />
        </span>
      }
    >
      <ContextMeterPanel
        model={model}
        modelLabel={modelLabel}
        onCompact={onCompact}
        compactDisabled={compactDisabled}
        compactDisabledReason={compactDisabledReason}
      />
    </Dropdown>
  );
}


/**
 * The popover's contents, exported so the readout can be rendered — and
 * asserted — without driving the popover open. Everything here is a function
 * of the model; the trigger owns the interaction.
 */
export function ContextMeterPanel({
  model,
  modelLabel = null,
  onCompact,
  compactDisabled = false,
  compactDisabledReason = null
}: ContextMeterProps): React.ReactElement {
  const percent = formatMeterPercent(model.usedPercentage);
  const overloaded = isMeterOverloaded(model.usedPercentage);
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-neutral-400">Context window</div>
        <div className="ac-tabular text-[11px] leading-4 text-neutral-400">
          {model.maxTokens !== null && percent !== null ? (
            <>
              <span className={cn(overloaded && "text-danger-300")}>{percent}</span>
              <span className="mx-1 text-neutral-600">·</span>
              <span>
                {formatContextTokens(model.usedTokens)}/{formatContextTokens(model.maxTokens)}
              </span>
            </>
          ) : (
            <span>{formatContextTokens(model.usedTokens)}</span>
          )}
        </div>
      </div>

      {model.maxTokens !== null && model.usedPercentage !== null ? (
        <div
          role="progressbar"
          aria-label="Context window usage"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(model.usedPercentage)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width,background-color] duration-500 ease-out",
              "motion-reduce:transition-none",
              overloaded ? "bg-danger" : "bg-neutral-400"
            )}
            style={{ width: `${Math.max(0, Math.min(100, model.usedPercentage))}%` }}
          />
        </div>
      ) : (
        // Say why there is no ring. A silent absence reads as a bug.
        <p className="text-[11px] leading-4 text-neutral-500">
          This agent does not report a context window, so only the token count is known.
        </p>
      )}

      {model.totalProcessedTokens !== null ? (
        <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
          <span className="text-neutral-500">Total processed</span>
          <span className="ac-tabular font-medium text-neutral-400">
            {formatContextTokens(model.totalProcessedTokens)}
          </span>
        </div>
      ) : null}

      {model.autoCompactAtTokens !== null ||
      model.maxTokens !== null ||
      model.compactsAutomatically === false ? (
        <p className="text-[11px] leading-4 text-neutral-500">
          {formatAutoCompactionSentence(
            modelLabel,
            model.autoCompactAtTokens,
            model.compactsAutomatically
          )}
        </p>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="mt-1 w-full justify-center"
        disabled={compactDisabled}
        onClick={onCompact}
      >
        <Minimize2 size={13} aria-hidden />
        Compact context
      </Button>
      {compactDisabled && compactDisabledReason ? (
        <p className="text-[11px] leading-4 text-neutral-500">{compactDisabledReason}</p>
      ) : null}
    </div>
  );
}
