import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, Undo2, X } from "lucide-react";
import type { UsagePricesResponse } from "@orquester/api";

import { getRegistryIcon } from "../../icons";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { formatTokens } from "../../lib/usage-history-format";
import { emitUsagePricesChanged } from "../../lib/usage-prices-events";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, IconButton, Modal, ModalCloseButton } from "../ui";
import type { UsagePricesDialogProps } from "./types";
import {
  RATE_FIELDS,
  builtinRatesFor,
  draftFromPrices,
  isRateEdit,
  newPriceRow,
  priceDraftResult,
  ratePlaceholder,
  unpricedSuggestions,
  type PriceRow,
  type RateField
} from "./usage-prices.logic";

const RATE_LABELS: Record<RateField, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite5m: "Cache write 5m",
  cacheWrite1h: "Cache write 1h"
};

/** Which cell takes focus once the rows render: a row's model id or one of its rates. */
type FocusTarget = { key: string; field: "model" | "mapTo" | RateField };

const CELL_INPUT =
  "h-7 w-full min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-100 " +
  "placeholder:text-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-50";

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.serverMessage ?? fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** "Model prices": the user's per-model price overrides and "map to" aliases on the connected daemon. */
export const UsagePricesDialog: React.FC<UsagePricesDialogProps> = ({ open, onClose, initialModel }) => {
  const api = useAppStore((s) => s.api);
  const [prices, setPrices] = useState<UsagePricesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [rows, setRows] = useState<PriceRow[]>([]);
  /** The rows as drafted from the daemon (or as last discarded to): edits are what differs. */
  const [pristine, setPristine] = useState("[]");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const focusNext = useRef<FocusTarget | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const seenListId = `${listId}-seen`;
  const knownListId = `${listId}-known`;

  // Each opening reads the daemon's prices afresh and drafts from them; a close drops the draft.
  useEffect(() => {
    if (!open) {
      setPrices(null);
      setLoadError(null);
      setRows([]);
      setPristine("[]");
      setConfirmDiscard(false);
      setAttempted(false);
      setSaveError(null);
      return undefined;
    }
    if (!api) {
      setLoadError("Not connected to a daemon.");
      return undefined;
    }
    const abort = new AbortController();
    setLoadError(null);
    api
      .getUsagePrices(abort.signal)
      .then((answer) => {
        if (abort.signal.aborted) return;
        let draft = draftFromPrices(answer);
        const wanted = initialModel?.trim();
        if (wanted) {
          const existing = draft.find((row) => row.model === wanted);
          if (existing) {
            focusNext.current = { key: existing.key, field: existing.mapTo ? "mapTo" : "input" };
          } else {
            const added = newPriceRow(wanted);
            draft = [added, ...draft];
            focusNext.current = { key: added.key, field: "input" };
          }
        }
        setPrices(answer);
        setRows(draft);
        setPristine(JSON.stringify(draft));
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setLoadError(
          error instanceof ApiError && error.status === 404
            ? "This daemon is too old to edit model prices. Update it to set prices."
            : errorText(error, "Couldn't load prices.")
        );
      });
    return () => abort.abort();
  }, [open, api, initialModel, reload]);

  // On opening, focus moves into the editor (its Close button) while the prices load, so it never
  // stays behind the backdrop on whatever opened it; the loaded rows may then take it.
  useEffect(() => {
    if (!open) return;
    const header = headerRef.current;
    if (header && !header.closest('[role="dialog"]')?.contains(document.activeElement)) {
      header.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.focus();
    }
  }, [open]);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const input = inputs.current.get(`${target.key}:${target.field}`);
    if (!input) return;
    focusNext.current = null;
    input.focus();
  });

  const result = useMemo(() => (prices ? priceDraftResult(rows, prices) : null), [rows, prices]);
  const dirty = Boolean(result?.changed) || rows.some((row) => row.isNew);
  /** The user changed the draft since it loaded: closing must not drop that silently. */
  const unsaved = prices !== null && JSON.stringify(rows) !== pristine;

  const builtin = prices?.builtin ?? [];
  const seenModels = prices?.seenModels ?? [];
  const rowModels = useMemo(() => new Set(rows.map((row) => row.model.trim())), [rows]);
  const knownModels = useMemo(
    () => [...new Set([...seenModels.map((info) => info.model), ...builtin.map((entry) => entry.model)])].sort(),
    [seenModels, builtin]
  );
  const suggestions = useMemo(() => unpricedSuggestions(seenModels, rows), [seenModels, rows]);

  const update = (key: string, change: (row: PriceRow) => PriceRow) => {
    setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));
    setSaveError(null);
  };

  const addRow = (model = "") => {
    const row = newPriceRow(model);
    focusNext.current = { key: row.key, field: model ? "input" : "model" };
    setRows((current) => [row, ...current]);
  };

  const discard = () => {
    if (!prices) return;
    const draft = draftFromPrices(prices);
    setRows(draft);
    setPristine(JSON.stringify(draft));
    setAttempted(false);
    setSaveError(null);
  };

  // Escape, Back and the X ask before dropping edits; a stray backdrop click never does.
  const close = useCallback(() => {
    if (saving) return;
    if (unsaved) setConfirmDiscard(true);
    else onClose();
  }, [saving, unsaved, onClose]);
  const backdropClose = useCallback(() => {
    if (!unsaved) close();
  }, [unsaved, close]);

  const save = async () => {
    if (!api || !result || saving) return;
    setAttempted(true);
    if (Object.keys(result.errors).length > 0) return;
    if (!result.changed) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateUsagePrices(result.patch);
      emitUsagePricesChanged();
      onClose();
    } catch (error) {
      setSaveError(errorText(error, "Couldn't save prices."));
    } finally {
      setSaving(false);
    }
  };

  const register = (key: string, field: FocusTarget["field"]) => (node: HTMLInputElement | null) => {
    const id = `${key}:${field}`;
    if (node) inputs.current.set(id, node);
    else inputs.current.delete(id);
  };

  return (
    <Modal open={open} onClose={close} onBackdropClick={backdropClose} className="max-w-4xl flex-col">
      <ConfirmDialog
        open={open && confirmDiscard}
        title="Discard unsaved price changes?"
        message="Your edits to model prices haven't been saved."
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
      <div className="flex min-h-0 w-full flex-col">
        <header ref={headerRef} className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-neutral-100">Model prices</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Prices apply to all past and future usage on this daemon, including the top-bar estimate and agents'
              get_usage.
            </p>
          </div>
          <ModalCloseButton onClose={close} />
        </header>

        <div className="ac-scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {loadError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <p role="alert" className="text-sm text-neutral-300">
                {loadError}
              </p>
              {api && (
                <Button size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>
                  Retry
                </Button>
              )}
            </div>
          ) : !prices ? (
            <p className="flex items-center justify-center gap-2 py-8 text-xs text-neutral-500">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              Loading prices…
            </p>
          ) : (
            <>
              {suggestions.length > 0 && (
                <ul className="flex flex-col gap-1" aria-label="Models with no price">
                  {suggestions.map((info) => (
                    <li
                      key={`${info.agent}:${info.model}`}
                      className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-2.5 py-1.5 text-xs"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {getRegistryIcon("agent", info.agent, 13)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-neutral-400">
                        No price: <span className="font-mono text-neutral-200">{info.model}</span> ·{" "}
                        <span className="tabular-nums">{formatTokens(info.tokens)}</span> tokens
                      </span>
                      <Button size="sm" variant="ghost" disabled={saving} onClick={() => addRow(info.model)}>
                        Set
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex justify-end">
                <span className="text-[11px] text-neutral-500">USD / million tokens</span>
              </div>

              <div className="overflow-x-auto rounded-lg border border-neutral-800">
                <table className="w-full min-w-[52rem] table-fixed border-collapse text-xs">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[17%]" />
                    {RATE_FIELDS.map((field) => (
                      <col key={field} />
                    ))}
                    <col className="w-10" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-neutral-800 bg-neutral-900/60 text-left text-[10px] uppercase tracking-wider text-neutral-500">
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        Model ID
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        Map to
                      </th>
                      {RATE_FIELDS.map((field) => (
                        <th key={field} scope="col" className="px-2 py-1.5 font-medium">
                          {RATE_LABELS[field]}
                        </th>
                      ))}
                      <th scope="col" className="px-1 py-1 text-right">
                        <IconButton label="Add a model" disabled={saving} onClick={() => addRow()}>
                          <Plus size={14} />
                        </IconButton>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-2 py-6 text-center text-neutral-500">
                          No custom prices or mappings. Add a row to set one.
                        </td>
                      </tr>
                    )}
                    {rows.map((row) => {
                      const error = result?.errors[row.key];
                      const shownError = error && (!error.missing || attempted) ? error.message : null;
                      const rates = builtinRatesFor(row.model, builtin);
                      const mapTo = row.mapTo.trim();
                      return (
                        <React.Fragment key={row.key}>
                          <tr className={cn("align-middle", !shownError && "border-b border-neutral-800/60")}>
                            <td className="px-2 py-1.5">
                              {row.isNew ? (
                                <input
                                  ref={register(row.key, "model")}
                                  className={cn(CELL_INPUT, "font-mono")}
                                  list={seenListId}
                                  aria-label="Model ID"
                                  placeholder="model-id"
                                  value={row.model}
                                  disabled={saving}
                                  spellCheck={false}
                                  autoComplete="off"
                                  onChange={(e) => update(row.key, (r) => ({ ...r, model: e.target.value }))}
                                />
                              ) : (
                                <span
                                  className={cn(
                                    "block truncate font-mono text-neutral-200",
                                    row.reset && "text-neutral-500 line-through"
                                  )}
                                  title={row.model}
                                >
                                  {row.model}
                                </span>
                              )}
                            </td>
                            {row.reset ? (
                              <td colSpan={6} className="px-2 py-1.5 text-neutral-500">
                                Automatic pricing after saving
                              </td>
                            ) : (
                              <>
                                <td className="px-2 py-1.5">
                                  <input
                                    ref={register(row.key, "mapTo")}
                                    className={cn(CELL_INPUT, "font-mono")}
                                    list={knownListId}
                                    aria-label={`Map ${row.model || "this model"} to`}
                                    placeholder="—"
                                    value={row.mapTo}
                                    disabled={saving}
                                    spellCheck={false}
                                    autoComplete="off"
                                    onChange={(e) => update(row.key, (r) => ({ ...r, mapTo: e.target.value }))}
                                  />
                                </td>
                                {mapTo ? (
                                  <td colSpan={5} className="truncate px-2 py-1.5 text-neutral-400" title={mapTo}>
                                    Counted as <span className="font-mono text-neutral-200">{mapTo}</span>
                                  </td>
                                ) : (
                                  RATE_FIELDS.map((field) => (
                                    <td key={field} className="px-1.5 py-1.5">
                                      <input
                                        ref={register(row.key, field)}
                                        className={cn(CELL_INPUT, "font-mono tabular-nums")}
                                        inputMode="decimal"
                                        aria-label={`${RATE_LABELS[field]} price for ${row.model || "this model"}`}
                                        placeholder={ratePlaceholder(field, rates)}
                                        value={row.rates[field]}
                                        disabled={saving}
                                        autoComplete="off"
                                        onChange={(e) => {
                                          const text = e.target.value;
                                          if (!isRateEdit(text)) return;
                                          update(row.key, (r) => ({ ...r, rates: { ...r.rates, [field]: text } }));
                                        }}
                                      />
                                    </td>
                                  ))
                                )}
                              </>
                            )}
                            <td className="px-1 py-1.5 text-right">
                              {row.isNew ? (
                                <IconButton
                                  label="Remove row"
                                  disabled={saving}
                                  onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                                >
                                  <X size={14} />
                                </IconButton>
                              ) : row.reset ? (
                                <IconButton
                                  label="Undo reset"
                                  disabled={saving}
                                  onClick={() => update(row.key, (r) => ({ ...r, reset: false }))}
                                >
                                  <Undo2 size={14} />
                                </IconButton>
                              ) : (
                                <IconButton
                                  label="Reset to automatic"
                                  disabled={saving}
                                  onClick={() => update(row.key, (r) => ({ ...r, reset: true }))}
                                >
                                  <RotateCcw size={14} />
                                </IconButton>
                              )}
                            </td>
                          </tr>
                          {shownError && (
                            <tr className="border-b border-neutral-800/60">
                              <td colSpan={8} className="px-2 pb-1.5">
                                <p role="alert" className="text-[11px] text-danger">
                                  {shownError}
                                </p>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] leading-relaxed text-neutral-500">
                Blank cache rates use the model's built-in rate, else its input price. Enter 0 for free tokens. A
                mapped model's usage counts as the model it maps to.
              </p>

              <datalist id={seenListId}>
                {seenModels
                  .filter((info) => !rowModels.has(info.model))
                  .map((info) => (
                    <option key={`${info.agent}:${info.model}`} value={info.model} />
                  ))}
              </datalist>
              <datalist id={knownListId}>
                {knownModels.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          {saveError && (
            <p role="alert" className="mr-auto min-w-0 text-xs text-danger">
              {saveError}
            </p>
          )}
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={discard}>
            Discard changes
          </Button>
          <Button size="sm" disabled={!prices || !dirty || saving} onClick={() => void save()}>
            {saving && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
};
