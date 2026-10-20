import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  ScrollText,
  Server,
  Timer,
  Trash2,
  XCircle
} from "lucide-react";
import type { BoxSetupStepState, BoxSummary } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { boxesErrorText } from "../../../lib/boxes/errors";
import { useNow } from "../../../lib/boxes/hooks";
import { destroyBox, useBoxes, useBoxesLoaded } from "../../../lib/boxes/store";
import { Button, ConfirmDialog, Modal, ModalCloseButton } from "../../ui";
import { Badge, EmptyState, SettingsSection } from "../../settings/primitives";
import {
  boxCostLine,
  boxCountdown,
  boxOwner,
  boxStateView,
  boxTitle,
  canDestroyBox,
  listedBoxes,
  setupProgress
} from "./boxes-list.logic";

const STEP_ICON: Record<BoxSetupStepState, React.ReactNode> = {
  pending: <Circle size={12} className="text-neutral-600" />,
  running: <Loader2 size={12} className="animate-spin text-info" />,
  done: <CheckCircle2 size={12} className="text-ok" />,
  failed: <XCircle size={12} className="text-danger" />,
  skipped: <MinusCircle size={12} className="text-neutral-500" />
};

/** Countdowns and costs move once a minute (a display tick). */
const TICK_MS = 60_000;

/** Every live box and the recently destroyed ones; `runningOnly` (the plugin is off) leaves the destroyed ones out. */
export const BoxesList: React.FC<{ runningOnly?: boolean }> = ({ runningOnly = false }) => {
  const boxes = useBoxes();
  const loaded = useBoxesLoaded();
  const now = useNow(TICK_MS);
  const listed = listedBoxes(boxes, now, runningOnly);
  const [logFor, setLogFor] = useState<BoxSummary | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<BoxSummary | null>(null);
  const [destroying, setDestroying] = useState<string | null>(null);
  const [error, setError] = useState<{ boxId: string; message: string } | null>(null);
  const api = useAppStore((s) => s.api);

  const destroy = async (box: BoxSummary) => {
    if (!api) return;
    setDestroying(box.id);
    setError(null);
    try {
      await destroyBox(api, box.id);
    } catch (err) {
      setError({ boxId: box.id, message: boxesErrorText(err, "Could not destroy the box.") });
    } finally {
      setDestroying(null);
    }
  };

  return (
    <SettingsSection title="Boxes" description="Costs are estimates: uptime × the hourly price at creation.">
      {!loaded ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
          <Loader2 size={14} className="animate-spin" /> Loading boxes…
        </div>
      ) : listed.length === 0 ? (
        <EmptyState
          icon={<Server size={18} />}
          title="No boxes"
          description="Choose a box under Runs on when you create a project, or let an agent rent one for a task."
        />
      ) : (
        <ul aria-label="Boxes" className="divide-y divide-neutral-800/80">
          {listed.map((box) => (
            <BoxRow
              key={box.id}
              box={box}
              now={now}
              destroying={destroying === box.id}
              error={error?.boxId === box.id ? error.message : null}
              onViewLog={() => setLogFor(box)}
              onDestroy={() => setConfirmDestroy(box)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDestroy !== null}
        title="Destroy this box?"
        message="The box is deleted at the provider with everything on it. The agent that made it can't use it any more."
        confirmLabel="Destroy"
        onCancel={() => setConfirmDestroy(null)}
        onConfirm={() => {
          const box = confirmDestroy;
          setConfirmDestroy(null);
          if (box) void destroy(box);
        }}
      />
      {logFor && <SetupLogDialog box={logFor} onClose={() => setLogFor(null)} />}
    </SettingsSection>
  );
};

const BoxRow: React.FC<{
  box: BoxSummary;
  now: number;
  destroying: boolean;
  error: string | null;
  onViewLog: () => void;
  onDestroy: () => void;
}> = ({ box, now, destroying, error, onViewLog, onDestroy }) => {
  const [expanded, setExpanded] = useState(false);
  const state = boxStateView(box);
  const countdown = boxCountdown(box, now);
  const progress = setupProgress(box);
  const showProgress = progress.total > 0;

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm text-neutral-100" title={boxTitle(box)}>
            {boxTitle(box)}
          </p>
          <p className="truncate text-xs text-neutral-500" title={boxOwner(box)}>
            {boxOwner(box)} · {boxCostLine(box)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {countdown && (
            <Badge tone="warn" icon={<Timer size={10} />}>
              {countdown}
            </Badge>
          )}
          <Badge tone={state.tone} title={state.title ?? undefined}>
            {state.label}
          </Badge>
          {canDestroyBox(box) && (
            <Button size="sm" variant="outline" disabled={destroying} aria-label={`Destroy ${boxTitle(box)}`} onClick={onDestroy}>
              {destroying ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Destroy
            </Button>
          )}
        </div>
      </div>
      {box.stateReason && <p className="text-xs text-neutral-500">{box.stateReason}</p>}
      {box.state === "destroy-failed" && box.purpose === "project" && (
        <p className="text-xs text-danger">It may still be billing. Delete its project again to retry.</p>
      )}

      {showProgress && (
        <div className="space-y-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Setup {progress.done}/{progress.total}
            {progress.current && (
              <span className={cn(progress.failed ? "text-danger" : "text-neutral-500")}>
                · {progress.failed ? `failed at ${progress.current.label}` : progress.current.label}
              </span>
            )}
          </button>
          {!progress.complete && (
            <div aria-hidden className="h-1 overflow-hidden rounded-full bg-neutral-800">
              <div
                className={cn("h-full rounded-full", progress.failed ? "bg-danger" : "bg-info")}
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
          {expanded && (
            <div className="space-y-1.5 pl-4">
              <ol aria-label="Setup steps" className="space-y-1">
                {box.setup.map((step) => (
                  <li key={step.id} className="flex gap-2 text-xs">
                    <span className="mt-0.5 shrink-0" aria-label={step.state}>
                      {STEP_ICON[step.state]}
                    </span>
                    <span className="min-w-0">
                      <span className={cn(step.state === "pending" ? "text-neutral-500" : "text-neutral-300")}>{step.label}</span>
                      {step.message && (
                        <span className={cn("block", step.state === "failed" ? "text-danger" : "text-neutral-500")}>
                          {step.message}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              <Button size="sm" variant="ghost" onClick={onViewLog}>
                <ScrollText size={12} /> View log
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </li>
  );
};

/** A box's setup log (text the daemon keeps; no secrets). */
const SetupLogDialog: React.FC<{ box: BoxSummary; onClose: () => void }> = ({ box, onClose }) => {
  const api = useAppStore((s) => s.api);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    api
      .boxSetupLog(box.id, controller.signal)
      .then(setLog)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(boxesErrorText(err, "Could not read the setup log."));
      });
    return () => controller.abort();
  }, [api, box.id]);

  return (
    <Modal open onClose={onClose} className="h-[70vh] max-w-3xl">
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
          <span className="min-w-0 truncate text-sm font-medium text-neutral-100">Setup log · {boxTitle(box)}</span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error ? (
            <p className="text-xs text-danger">{error}</p>
          ) : log === null ? (
            <p className="flex items-center gap-2 text-xs text-neutral-500">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-300">
              {log || "The log is empty."}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  );
};
