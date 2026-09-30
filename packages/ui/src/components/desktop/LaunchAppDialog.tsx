/**
 * "New desktop…" / "Open app in desktop" (spec §10.2): a command line with
 * suggestions (.desktop entries, project executables, recent launches), a
 * working directory, env rows and a target — a new desktop, or one of the
 * project's running desktops. Mounted once; opens from the store's
 * `launchDialog`. Below 640 px it is a full-screen sheet.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ChevronRight,
  Eye,
  EyeOff,
  FileTerminal,
  History,
  Loader2,
  Monitor,
  Plus,
  Trash2
} from "lucide-react";

import type { DesktopSuggestionsResponse, RecentLaunch } from "@orquester/api";

import { useIsDesktop } from "../../hooks/use-media-query";
import { cn } from "../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { useAppStore, type LaunchDialogTarget } from "../../store/app";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Modal } from "../ui/modal";
import { DialogHeader, Field, SelectField } from "../right-rail/workflows/dialog-parts";
import {
  DEFAULT_RENDER_THREADS,
  DESKTOP_SIZE_PRESETS,
  MAX_RENDER_THREADS,
  MIN_RENDER_THREADS,
  buildCreateRequest,
  buildLaunchRequest,
  describeLaunchError,
  rankSuggestions,
  rowsFromEnv,
  suggestionItems,
  type EnvRow,
  type LaunchSuggestion
} from "./launch-dialog-model";

const MAX_RECENT_CHIPS = 6;

let rowSeq = 0;
const newRowId = (): string => `env-${++rowSeq}`;
const blankRow = (): EnvRow => ({ id: newRowId(), key: "", value: "" });

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;

export const LaunchAppDialog: React.FC = () => {
  const target = useAppStore((s) => s.launchDialog);
  const close = useAppStore((s) => s.closeLaunchDialog);
  if (!target) return null;
  // Keyed so every opening starts from a clean form.
  return <LaunchAppForm key={`${target.projectPath}\u0000${target.targetDesktopId ?? ""}`} target={target} onClose={close} />;
};

const SUGGESTION_ICONS: Record<LaunchSuggestion["kind"], React.ReactNode> = {
  recent: <History size={13} aria-hidden />,
  entry: <AppWindow size={13} aria-hidden />,
  executable: <FileTerminal size={13} aria-hidden />
};

const LaunchAppForm: React.FC<{ target: LaunchDialogTarget; onClose: () => void }> = ({ target, onClose }) => {
  const ids = useId();
  const touch = !useIsDesktop();
  const api = useAppStore((s) => s.api);
  const allDesktops = useAppStore((s) => s.desktops);
  const createDesktopWithApp = useAppStore((s) => s.createDesktopWithApp);
  const launchIntoDesktop = useAppStore((s) => s.launchIntoDesktop);
  const { projectPath } = target;

  const running = useMemo(
    () =>
      allDesktops
        .filter((d) => d.projectPath === projectPath && d.status === "running")
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)),
    [allDesktops, projectPath]
  );

  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [desktopId, setDesktopId] = useState<string>(target.targetDesktopId ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sizeId, setSizeId] = useState("fit");
  const [renderThreads, setRenderThreads] = useState(DEFAULT_RENDER_THREADS);
  const [suggestions, setSuggestions] = useState<DesktopSuggestionsResponse | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandRef = useRef<HTMLInputElement | null>(null);

  // A target that stopped (or never was running) falls back to "New desktop".
  const targetId = running.some((d) => d.id === desktopId) ? desktopId : "";

  useEffect(() => {
    if (!api) return undefined;
    const controller = new AbortController();
    api
      .desktopSuggestions(projectPath, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setSuggestions(response);
      })
      .catch(() => {
        // No suggestions is not an error: the command can still be typed.
      });
    return () => controller.abort();
  }, [api, projectPath]);

  const items = useMemo(() => suggestionItems(suggestions), [suggestions]);
  const ranked = useMemo(() => rankSuggestions(items, command), [items, command]);
  const recent = suggestions?.recent.slice(0, MAX_RECENT_CHIPS) ?? [];
  const showList = listOpen && ranked.length > 0;

  const validation = buildLaunchRequest({ command, cwd, envRows });
  const commandError = touched && !validation.ok ? validation.commandError : null;
  const envErrors = touched && !validation.ok ? validation.envErrors : {};

  const applyRecent = (launch: RecentLaunch) => {
    setCommand(launch.command);
    setCwd(launch.cwd);
    const rows = rowsFromEnv(launch.env, newRowId);
    setEnvRows(rows);
    // Values brought back from history are shown masked.
    setRevealed(new Set());
    setError(null);
  };

  const pick = (item: LaunchSuggestion) => {
    if (item.recent) applyRecent(item.recent);
    else setCommand(item.insert);
    setListOpen(false);
    setHighlight(-1);
    commandRef.current?.focus();
  };

  const updateRow = (id: string, patch: Partial<EnvRow>) => {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setError(null);
  };

  const submit = async () => {
    setTouched(true);
    if (!validation.ok || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (targetId) {
        await launchIntoDesktop(targetId, validation.request);
      } else {
        await createDesktopWithApp(
          buildCreateRequest(projectPath, validation.request, { sizeId, renderThreads })
        );
      }
      onClose();
    } catch (caught) {
      setError(describeLaunchError(caught));
      setSubmitting(false);
    }
  };

  const onCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && ranked.length > 0) {
      event.preventDefault();
      setListOpen(true);
      setHighlight((i) => (showList ? (i + 1) % ranked.length : 0));
    } else if (event.key === "ArrowUp" && showList) {
      event.preventDefault();
      setHighlight((i) => (i <= 0 ? ranked.length - 1 : i - 1));
    } else if (event.key === "Enter" && showList && highlight >= 0 && ranked[highlight]) {
      // Enter on a highlighted suggestion picks it; otherwise it submits.
      event.preventDefault();
      pick(ranked[highlight]);
    } else if (event.key === "Escape" && showList) {
      // The first Escape closes the list, not the dialog.
      event.preventDefault();
      event.stopPropagation();
      setListOpen(false);
      setHighlight(-1);
    }
  };

  const inputSize = touch ? "h-10 text-[15px]" : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      className={cn(
        "max-w-lg sm:max-h-[90vh]",
        // Full-screen sheet on phones.
        "max-sm:fixed max-sm:inset-0 max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
      )}
    >
      <form
        {...KEYBOARD_SURFACE_PROPS}
        className="flex min-h-0 w-full flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader
          title={targetId ? "Open app in desktop" : "New desktop"}
          subtitle={baseName(projectPath)}
          onClose={onClose}
        />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {recent.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Recent commands">
              {recent.map((launch) => (
                <button
                  key={`${launch.command}\u0000${launch.cwd}`}
                  type="button"
                  onClick={() => applyRecent(launch)}
                  title={launch.cwd ? `${launch.command}\nin ${launch.cwd}` : launch.command}
                  className="flex max-w-full items-center gap-1 truncate rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300 ring-1 ring-transparent transition-colors hover:bg-neutral-700 hover:text-neutral-100"
                >
                  <History size={11} aria-hidden className="shrink-0 text-neutral-500" />
                  <span className="truncate font-mono">{launch.command}</span>
                </button>
              ))}
            </div>
          ) : null}

          <Field id={`${ids}-command`} label="Command" error={commandError}>
            <div className="relative">
              <Input
                id={`${ids}-command`}
                ref={commandRef}
                autoFocus
                value={command}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                placeholder="xterm, ./build/bin/editor --flag, …"
                role="combobox"
                aria-expanded={showList}
                aria-controls={`${ids}-suggestions`}
                aria-autocomplete="list"
                aria-activedescendant={showList && highlight >= 0 ? `${ids}-s${highlight}` : undefined}
                onChange={(event) => {
                  setCommand(event.target.value);
                  setListOpen(true);
                  setHighlight(-1);
                  setError(null);
                }}
                onFocus={() => setListOpen(true)}
                onBlur={() => setListOpen(false)}
                onKeyDown={onCommandKeyDown}
                className={cn("font-mono", inputSize)}
              />
              {showList ? (
                <ul
                  id={`${ids}-suggestions`}
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 p-1 shadow-xl shadow-black/40"
                >
                  {ranked.map((item, index) => (
                    <li
                      key={`${item.kind}\u0000${item.label}\u0000${item.insert}`}
                      id={`${ids}-s${index}`}
                      role="option"
                      aria-selected={index === highlight}
                      // mousedown, not click: the input's blur would close the list first.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pick(item);
                      }}
                      onMouseEnter={() => setHighlight(index)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-300",
                        index === highlight && "bg-neutral-800 text-neutral-100"
                      )}
                    >
                      <span className="shrink-0 text-neutral-500">{SUGGESTION_ICONS[item.kind]}</span>
                      <span className={cn("min-w-0 flex-1 truncate", item.kind !== "entry" && "font-mono text-[13px]")}>
                        {item.label}
                      </span>
                      {item.detail ? (
                        <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-neutral-500">
                          {item.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Field>

          <Field id={`${ids}-cwd`} label="Working directory" hint="Relative to the project; empty is the project root.">
            <Input
              id={`${ids}-cwd`}
              value={cwd}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              placeholder="Project root"
              onChange={(event) => {
                setCwd(event.target.value);
                setError(null);
              }}
              className={cn("font-mono", inputSize)}
            />
          </Field>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-400">Environment</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEnvRows((rows) => [...rows, blankRow()])}
              >
                <Plus size={12} aria-hidden />
                Add variable
              </Button>
            </div>
            {envRows.length === 0 ? (
              <p className="text-[11px] text-neutral-500">No extra variables.</p>
            ) : (
              envRows.map((row) => {
                const masked = !revealed.has(row.id) && editingValue !== row.id && row.value !== "";
                const rowError = envErrors[row.id];
                return (
                  <div key={row.id} className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Input
                        aria-label="Variable name"
                        value={row.key}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        placeholder="KEY"
                        onChange={(event) => updateRow(row.id, { key: event.target.value })}
                        className={cn("w-2/5 font-mono", rowError && "border-danger", inputSize)}
                      />
                      <span className="text-neutral-600">=</span>
                      <Input
                        aria-label={`Value of ${row.key || "variable"}`}
                        type={masked ? "password" : "text"}
                        value={row.value}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        placeholder="value"
                        onFocus={() => setEditingValue(row.id)}
                        onBlur={() => setEditingValue((id) => (id === row.id ? null : id))}
                        onChange={(event) => updateRow(row.id, { value: event.target.value })}
                        className={cn("min-w-0 flex-1 font-mono", inputSize)}
                      />
                      <button
                        type="button"
                        aria-label={revealed.has(row.id) ? "Hide value" : "Show value"}
                        title={revealed.has(row.id) ? "Hide value" : "Show value"}
                        onClick={() =>
                          setRevealed((current) => {
                            const next = new Set(current);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
                      >
                        {revealed.has(row.id) ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button
                        type="button"
                        aria-label="Remove variable"
                        title="Remove variable"
                        onClick={() => setEnvRows((rows) => rows.filter((r) => r.id !== row.id))}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {rowError ? <p className="text-xs text-danger">{rowError}</p> : null}
                  </div>
                );
              })
            )}
          </div>

          <Field id={`${ids}-target`} label="Run in">
            <SelectField
              id={`${ids}-target`}
              touch={touch}
              value={targetId}
              onChange={(event) => {
                setDesktopId(event.target.value);
                setError(null);
              }}
            >
              <option value="">New desktop</option>
              {running.map((desktop) => (
                <option key={desktop.id} value={desktop.id}>
                  {desktop.title || "Desktop"}
                </option>
              ))}
            </SelectField>
          </Field>

          {targetId === "" ? (
            <div className="space-y-3">
              <button
                type="button"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
              >
                <ChevronRight
                  size={12}
                  aria-hidden
                  className={cn("transition-transform", advancedOpen && "rotate-90")}
                />
                Advanced
              </button>
              {advancedOpen ? (
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 sm:grid-cols-2">
                  <Field id={`${ids}-size`} label="Size">
                    <SelectField
                      id={`${ids}-size`}
                      touch={touch}
                      value={sizeId}
                      onChange={(event) => setSizeId(event.target.value)}
                    >
                      {DESKTOP_SIZE_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </SelectField>
                  </Field>
                  <Field id={`${ids}-threads`} label="Render threads">
                    <Input
                      id={`${ids}-threads`}
                      type="number"
                      inputMode="numeric"
                      min={MIN_RENDER_THREADS}
                      max={MAX_RENDER_THREADS}
                      step={1}
                      value={renderThreads}
                      onChange={(event) => setRenderThreads(Number(event.target.value))}
                      className={inputSize}
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}

          {error !== null ? (
            <p role="alert" className="whitespace-pre-wrap break-words text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose} className={cn(touch && "h-10 flex-1")}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting} className={cn(touch && "h-10 flex-1")}>
            {submitting ? (
              <Loader2 size={14} aria-hidden className="animate-spin" />
            ) : (
              <Monitor size={14} aria-hidden />
            )}
            {targetId ? "Launch" : "Start desktop"}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
