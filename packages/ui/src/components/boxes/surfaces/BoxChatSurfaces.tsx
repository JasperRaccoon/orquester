/**
 * Ephemeral AI VMs — what an agent chat shows about boxes (spec 2026-10-19
 * §8.3, §9.3, §13.3), at the top of the chat above the transcript:
 *
 *  - for a chat of a box project, a chip naming the box, and the state's
 *    banner or notice — destroyed (read-only; the composer is replaced by
 *    {@link BoxComposerLock}), provisioning (disabled until ready),
 *    unreachable ("Reconnecting", non-blocking);
 *  - a card per temporary box this chat created, with its cost so far, its
 *    countdown, Watch (a terminal in the box) and Destroy;
 *  - the box → host config change sets this chat's turns made, to approve or
 *    deny.
 *
 * The panel scrolls on its own past a third of the view, so the transcript
 * below always keeps most of the height.
 */

import React from "react";
import { Eye, Lock, Server, Trash2 } from "lucide-react";
import type { BoxConfigChangeSet, BoxSummary } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useUsageNow } from "../../../hooks/use-usage-display";
import { ApiError } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { launchWithNotice } from "../../../lib/launch-notice";
import { ConfirmDialog } from "../../ui";
import { TONE_BAND, TONE_BAND_TEXT, type ChatTone } from "../../agent-chat/primitives/tone";
import { destroyBox, useBoxConfigChanges, useBoxes, watchBox, type ProjectBoxView } from "./box-data";
import { BOX_PILL_TONE, BOX_TEXT_TONE } from "./BoxBadge";
import {
  boxChatChip,
  boxChatGate,
  chatTemporaryBoxes,
  temporaryBoxCard,
  type BoxTone
} from "./box-surfaces.logic";
import { ConfigChangeCard, useShownConfigChanges } from "./ConfigChangeCard";

const CHAT_TONE: Record<BoxTone, ChatTone> = {
  neutral: "neutral",
  info: "info",
  warn: "warn",
  danger: "danger"
};

const SMALL_BUTTON =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-40";

/** One temporary box the chat created. */
const TemporaryBoxCard: React.FC<{ box: BoxSummary; now: number }> = ({ box, now }) => {
  const api = useApi();
  const model = temporaryBoxCard(box, now);
  const [confirming, setConfirming] = React.useState(false);
  const [destroying, setDestroying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const destroy = async (): Promise<void> => {
    setConfirming(false);
    setDestroying(true);
    setError(null);
    try {
      await destroyBox(api, box.id);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? (failure.serverMessage ?? `Orquester answered ${failure.status}.`)
          : "Could not reach Orquester."
      );
    } finally {
      setDestroying(false);
    }
  };

  return (
    <div
      data-temporary-box={box.id}
      data-state={box.state}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-2.5 py-1.5 text-xs",
        box.state === "destroyed" ? "border-neutral-800/70 bg-neutral-900/30 opacity-70" : "border-neutral-800 bg-neutral-900/60"
      )}
    >
      <Server size={13} aria-hidden className="shrink-0 text-neutral-400" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-neutral-100" title={model.title}>
          {model.title}
        </span>
        <span className="truncate text-[11px] text-neutral-500" title={model.subtitle}>
          {model.subtitle}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end text-[11px] tabular-nums">
        <span className={BOX_TEXT_TONE[model.tone]} title={box.stateReason ?? undefined}>
          {model.stateText}
        </span>
        <span className="text-neutral-400">{model.cost}</span>
      </span>
      {model.countdown ? (
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium tabular-nums",
            BOX_PILL_TONE[model.countdown.urgency === "normal" ? "warn" : "danger"]
          )}
          title="Destroyed automatically when its time limit ends"
        >
          {model.countdown.text}
        </span>
      ) : null}
      {box.state !== "destroyed" ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={!model.canWatch}
            title={model.watchTitle}
            onClick={() => launchWithNotice(watchBox(box), "the VM's terminal")}
            className={cn(SMALL_BUTTON, "border border-neutral-700 text-neutral-200 hover:bg-neutral-800")}
          >
            <Eye size={11} aria-hidden />
            Watch
          </button>
          <button
            type="button"
            disabled={!model.canDestroy || destroying}
            onClick={() => setConfirming(true)}
            className={cn(SMALL_BUTTON, "text-danger-300 hover:bg-danger-900/40")}
            title="Destroy this VM now"
          >
            <Trash2 size={11} aria-hidden />
            Destroy
          </button>
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-[11px] text-danger">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Destroy VM"
        message={
          <>
            Destroy <span className="font-medium text-neutral-200">{model.title}</span> at {box.providerLabel}? Anything
            in it the agent did not copy out is lost, and the agent can no longer use it.
          </>
        }
        confirmLabel="Destroy"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void destroy()}
      />
    </div>
  );
};

/** The top-of-chat box panel; renders nothing for a host chat with no boxes or changes. */
export const BoxChatPanel: React.FC<{ sessionId: string; view: ProjectBoxView | null }> = ({ sessionId, view }) => {
  const now = useUsageNow();
  const boxes = useBoxes();
  const temporary = React.useMemo(() => chatTemporaryBoxes(boxes, sessionId), [boxes, sessionId]);
  const changes = useBoxConfigChanges();
  const isMine = React.useCallback((change: BoxConfigChangeSet) => change.threadId === sessionId, [sessionId]);
  const { shown, dismiss } = useShownConfigChanges(changes, isMine);
  const gate = boxChatGate(view?.info, view?.setupStep ?? null);

  if (!view && temporary.length === 0 && shown.length === 0) return null;
  const chip = view ? boxChatChip(view.info, now) : null;

  return (
    <div className="shrink-0 border-b border-neutral-800/70 bg-neutral-950" data-box-chat-panel="">
      <div className="mx-auto max-h-[33vh] w-full min-w-0 max-w-3xl space-y-1.5 overflow-y-auto px-3 py-1.5 sm:px-5">
        {chip ? (
          <div className="flex min-w-0 items-center gap-1.5 text-xs">
            <Server size={12} aria-hidden className="shrink-0 text-neutral-500" />
            <span
              title={chip.title}
              data-box-chip={chip.tone}
              className={cn(
                "inline-flex h-5 min-w-0 items-center truncate rounded-full px-2 text-[11px] font-medium tabular-nums",
                BOX_PILL_TONE[chip.tone]
              )}
            >
              <span className="truncate">{chip.text}</span>
            </span>
          </div>
        ) : null}
        {gate.notice ? (
          <div
            role={gate.notice.tone === "danger" ? "alert" : "status"}
            data-box-notice={view?.info.state}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-xs leading-snug",
              TONE_BAND[CHAT_TONE[gate.notice.tone]]
            )}
          >
            <p className={cn("font-medium", TONE_BAND_TEXT[CHAT_TONE[gate.notice.tone]])}>{gate.notice.title}</p>
            <p className="text-neutral-300">{gate.notice.text}</p>
          </div>
        ) : null}
        {temporary.map((box) => (
          <TemporaryBoxCard key={box.id} box={box} now={now} />
        ))}
        {shown.map((change) => (
          <ConfigChangeCard key={change.id} change={change} onDismiss={() => dismiss(change.id)} />
        ))}
      </div>
    </div>
  );
};

/**
 * Stands where the composer is while the box cannot take messages (destroyed,
 * provisioning, being destroyed): the same rounded shape, inert, saying why.
 * The thread's draft stays in its store and comes back with the composer.
 */
export const BoxComposerLock: React.FC<{ reason: string }> = ({ reason }) => (
  <div className="pointer-events-auto w-full min-w-0 px-2 pb-2 sm:px-4 sm:pb-3" data-box-composer-lock="">
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <div
        aria-disabled="true"
        className="flex min-h-[3.25rem] items-center gap-2 rounded-[1.375rem] border border-neutral-800 bg-neutral-900/70 px-4 py-3 text-sm text-neutral-500"
      >
        <Lock size={14} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1">{reason}</span>
      </div>
    </div>
  </div>
);
