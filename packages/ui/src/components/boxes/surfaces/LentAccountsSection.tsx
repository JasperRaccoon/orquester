/**
 * "Lent logins" on a box (lending spec 2026-11-03 §9): one row per lend, each with End, and End all.
 * Ending has no confirm: it is the safe direction. Shared by the chat's box panel and Settings.
 */

import React from "react";
import { Loader2, X } from "lucide-react";
import type { BoxSummary } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { getRegistryIcon } from "../../../icons";
import { ApiError } from "../../../lib/api-client";
import { endAccountLend, endAccountLends } from "../../../lib/boxes/store";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { lentAccountsModel, type LentAccountRow, type LentAccountTone } from "./lent-accounts.logic";

const DOT_TONE: Record<LentAccountTone, string> = {
  neutral: "bg-neutral-500",
  ok: "bg-ok",
  info: "bg-info",
  warn: "bg-warn",
  danger: "bg-danger"
};

const TEXT_TONE: Record<LentAccountTone, string> = {
  neutral: "text-neutral-500",
  ok: "text-neutral-300",
  info: "text-info",
  warn: "text-warn",
  danger: "text-danger"
};

const END_BUTTON =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-neutral-300 hover:bg-neutral-800 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:pointer-events-none disabled:opacity-40";

const END_TITLE = "Take this login off the VM now. A token already copied off it works until it expires.";
const END_ALL_TITLE = "Take every login off this VM now. A token already copied off it works until it expires.";

/** Which end is running: one lend's id, or every lend on the box. */
const ALL = Symbol("all");

const LentAccountRowView: React.FC<{
  row: LentAccountRow;
  busy: boolean;
  disabled: boolean;
  onEnd: () => void;
}> = ({ row, busy, disabled, onEnd }) => {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <li data-lent-account={row.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="flex min-w-0 flex-1 basis-32 items-center gap-1.5">
        <span aria-hidden className="flex shrink-0 items-center">
          {getRegistryIcon("agent", row.agent, 13)}
        </span>
        <span className="truncate text-neutral-100" title={row.label}>
          {row.label}
        </span>
      </span>
      <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[11px]">
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONE[row.tone])} />
        {row.needsLogin ? (
          <button
            type="button"
            onClick={() => openSettings("accounts")}
            title="Open Settings → Agent accounts"
            className={cn(
              "min-w-0 truncate rounded underline underline-offset-2 hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              TEXT_TONE[row.tone]
            )}
          >
            {row.statusText}
          </button>
        ) : (
          <span className={cn("min-w-0", TEXT_TONE[row.tone])}>{row.statusText}</span>
        )}
      </span>
      {row.until ? <span className="shrink-0 text-[11px] tabular-nums text-neutral-500">{row.until}</span> : null}
      {row.canEnd ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onEnd}
          aria-label={`End the lend of ${row.label}`}
          title={END_TITLE}
          className={cn(END_BUTTON, "ml-auto")}
        >
          {busy ? <Loader2 size={11} aria-hidden className="animate-spin" /> : <X size={11} aria-hidden />}
          End
        </button>
      ) : null}
      {row.statusMessage ? <p className="basis-full break-words text-[11px] text-neutral-500">{row.statusMessage}</p> : null}
    </li>
  );
};

/** Renders nothing while nothing is lent to the box (an older daemon says nothing about lends). */
export const LentAccountsSection: React.FC<{
  box: Pick<BoxSummary, "id" | "state" | "lentAccounts">;
  now: number;
  className?: string;
}> = ({ box, now, className }) => {
  const api = useApi();
  const model = lentAccountsModel(box, now);
  const [ending, setEnding] = React.useState<string | typeof ALL | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (model.rows.length === 0) return null;

  const end = async (target: string | typeof ALL): Promise<void> => {
    setEnding(target);
    setError(null);
    try {
      await (target === ALL ? endAccountLends(api, box.id) : endAccountLend(api, box.id, target));
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? (failure.serverMessage ?? `Orquester answered ${failure.status}.`)
          : "Could not reach Orquester."
      );
    } finally {
      setEnding(null);
    }
  };

  return (
    <section aria-label="Lent logins" data-lent-accounts={box.id} className={cn("min-w-0 space-y-1 text-xs", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium text-neutral-400">Lent logins</span>
        {model.canEndAll ? (
          <button type="button" disabled={ending !== null} onClick={() => void end(ALL)} title={END_ALL_TITLE} className={END_BUTTON}>
            {ending === ALL ? <Loader2 size={11} aria-hidden className="animate-spin" /> : <X size={11} aria-hidden />}
            End all
          </button>
        ) : null}
      </div>
      <ul className="min-w-0 space-y-1">
        {model.rows.map((row) => (
          <LentAccountRowView
            key={row.id}
            row={row}
            busy={ending === row.id}
            disabled={ending !== null}
            onEnd={() => void end(row.id)}
          />
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
};
