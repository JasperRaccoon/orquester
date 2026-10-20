/**
 * Ephemeral AI VMs — a box → host config change set waiting for the owner
 * (spec 2026-10-19 §8.3): every file the box changed in the agent's
 * configuration, which of them are executable, an expandable diff per file,
 * and Approve / Deny (`POST boxRoutes.configChange`). Shown in the chat whose
 * turn made the changes, or — for changes no turn made — in a dialog opened
 * from the project row ({@link ConfigChangesDialog}).
 *
 * Nothing is approved by default or by keyboard alone: Approve is a plain
 * button press, and the card never takes focus by itself.
 */

import React from "react";
import { ChevronRight, FileCog, ShieldAlert } from "lucide-react";
import type { BoxConfigChangeSet } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { ApiError } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { diffLineTone, type DiffLineTone } from "../../agent-chat/banners/approval-detail";
import { Modal, ModalCloseButton } from "../../ui";
import { decideConfigChange } from "./box-data";
import {
  configChangeCard,
  configChangeDecisionFailure,
  configChangesIndicator,
  nextShownChangeIds
} from "./box-surfaces.logic";

const DIFF_TONE: Record<DiffLineTone, string> = {
  added: "text-ok-300",
  removed: "text-danger-300",
  meta: "text-neutral-500",
  context: "text-neutral-300"
};

const BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-50";

export const ConfigChangeCard: React.FC<{
  change: BoxConfigChangeSet;
  /** Offered once the set is decided: takes the card off the list. */
  onDismiss?: () => void;
  className?: string;
}> = ({ change, onDismiss, className }) => {
  const api = useApi();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  // A double click must not send twice: this guard is synchronous.
  const inFlight = React.useRef(false);
  const model = configChangeCard(change, submitting);

  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await decideConfigChange(api, change.id, decision);
    } catch (failure) {
      setError(configChangeDecisionFailure(failure instanceof ApiError ? failure.status : null));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div
      role="group"
      aria-label={model.title}
      data-box-config-change={change.id}
      data-state={change.state}
      className={cn("rounded-xl border border-warn-900/50 bg-warn-soft/30 px-3 py-2.5 text-xs", className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FileCog size={14} aria-hidden className="shrink-0 text-warn-300" />
        <span className="min-w-0 flex-1 truncate font-medium text-warn-300">{model.title}</span>
        <span className="shrink-0 text-[11px] text-neutral-500">{model.summary}</span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-neutral-400">
        Approve to write these files to this host and every other VM; deny to revert the VM's copy. They stay in
        effect in this VM until you decide.
      </p>

      <ul className="mt-2 space-y-1">
        {model.rows.map((row) => {
          const expanded = open.has(row.path);
          const expandable = row.diff !== null;
          return (
            <li key={row.path} className="min-w-0 rounded-lg bg-neutral-950/60">
              <button
                type="button"
                aria-expanded={expandable ? expanded : undefined}
                disabled={!expandable && row.note === null}
                onClick={() => toggle(row.path)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-neutral-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
              >
                <ChevronRight
                  size={12}
                  aria-hidden
                  className={cn("shrink-0 text-neutral-500 transition-transform", expanded && "rotate-90")}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200" title={row.path}>
                  {row.path}
                </span>
                {row.executable ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-soft/60 px-1.5 text-[10px] font-medium text-warn"
                    title="Runs code on this host once approved: a hook, an MCP server command, a plugin or skill script, or an executable file"
                  >
                    <ShieldAlert size={10} aria-hidden />
                    executable
                  </span>
                ) : null}
                <span className="shrink-0 rounded-full bg-neutral-800 px-1.5 text-[10px] text-neutral-400">
                  {row.changeLabel}
                </span>
              </button>
              {expanded ? (
                <div className="px-2 pb-1.5">
                  {row.diff !== null ? (
                    <pre
                      tabIndex={0}
                      role="region"
                      aria-label={`Changes to ${row.path}`}
                      className="max-h-72 overflow-auto rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] leading-snug"
                    >
                      {row.diff.split("\n").map((line, index) => (
                        <span key={index} className={cn("block whitespace-pre", DIFF_TONE[diffLineTone(line)])}>
                          {line === "" ? " " : line}
                        </span>
                      ))}
                    </pre>
                  ) : null}
                  {row.note ? <p className="pt-1 text-[11px] italic text-neutral-500">{row.note}</p> : null}
                </div>
              ) : row.diff === null && row.note ? (
                <p className="px-2 pb-1 pl-[1.625rem] text-[11px] italic text-neutral-500">{row.note}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {model.executableCount > 0 && change.state === "pending" ? (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-warn-300">
          <ShieldAlert size={12} aria-hidden className="mt-px shrink-0" />
          {model.executableCount === 1 ? "One file runs code" : `${model.executableCount} files run code`} on this host
          once approved. Read their diffs first.
        </p>
      ) : null}

      {model.outcome ? (
        <div className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px] text-neutral-400" role="status">
            {model.outcome}
          </p>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {error ? (
            <span role="alert" className="mr-auto min-w-0 truncate text-[11px] text-danger" title={error}>
              {error}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!model.canDecide}
            onClick={() => void decide("deny")}
            className={cn(BUTTON, "border border-neutral-700 text-neutral-200 hover:bg-neutral-800")}
          >
            Deny
          </button>
          <button
            type="button"
            disabled={!model.canDecide}
            onClick={() => void decide("approve")}
            className={cn(BUTTON, "bg-neutral-200 text-neutral-900 hover:bg-neutral-50")}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * The change sets a list shows ({@link nextShownChangeIds}): the pending ones
 * `isMine` picks, plus those decided while on screen until dismissed.
 */
export function useShownConfigChanges(
  all: readonly BoxConfigChangeSet[],
  isMine: (change: BoxConfigChangeSet) => boolean
): { shown: BoxConfigChangeSet[]; dismiss: (id: string) => void } {
  const [ids, setIds] = React.useState<readonly string[]>([]);
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
  const pendingKey = all
    .filter((change) => change.state === "pending" && isMine(change))
    .map((change) => change.id)
    .join("\n");
  const knownKey = all.map((change) => change.id).join("\n");
  React.useEffect(() => {
    const pendingIds = pendingKey ? pendingKey.split("\n") : [];
    const known = new Set(knownKey ? knownKey.split("\n") : []);
    setIds((current) => nextShownChangeIds(current, pendingIds, known, dismissed));
  }, [pendingKey, knownKey, dismissed]);
  const shown = React.useMemo(
    () => ids.flatMap((id) => all.find((change) => change.id === id) ?? []),
    [ids, all]
  );
  const dismiss = React.useCallback((id: string) => setDismissed((current) => new Set(current).add(id)), []);
  return { shown, dismiss };
}

/**
 * The project row's pending config changes no chat turn made, in a dialog —
 * the same cards a chat shows; a decided one keeps its outcome until closed.
 */
export const ConfigChangesDialog: React.FC<{
  open: boolean;
  projectName: string;
  changes: readonly BoxConfigChangeSet[];
  onClose: () => void;
}> = ({ open, projectName, changes, onClose }) => {
  const pending = changes.filter((change) => change.state === "pending").length;
  return (
    <Modal open={open} onClose={onClose} className="max-h-[85vh] max-w-2xl">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
          <span className="truncate text-sm text-neutral-200">
            {configChangesIndicator(pending) ?? "Config changes decided"} — {projectName}
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
          {changes.map((change) => (
            <ConfigChangeCard key={change.id} change={change} />
          ))}
        </div>
      </div>
    </Modal>
  );
};
