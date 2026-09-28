/**
 * The editor tab's chrome on a phone (workflows spec §7.4): a compact top bar
 * (close, the name — renamed in place — the save state, the enabled switch,
 * an overflow menu), the Steps · Canvas · Runs switch, and a floating
 * thumb-reach toolbar: Add · Undo · Redo · Fit · Tidy · Run.
 *
 * The toolbar floats inside the tab's own box (the app shell already keeps
 * that box above the bottom safe-area inset and the section bar), so it pads
 * no inset of its own.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CloudOff,
  KeyRound,
  LayoutGrid,
  Loader2,
  Maximize,
  MoreVertical,
  Play,
  Plus,
  Redo2,
  Settings2,
  Undo2,
  X
} from "lucide-react";

import { WORKFLOW_LIMITS } from "@orquester/api";

import { cn } from "../../../lib/cn";
import type { EditorSaveState } from "../../../lib/workflows/editor-store";
import { ActionSheet } from "./WorkflowSheet";

export type PhoneEditorView = "steps" | "canvas" | "runs";

export interface PhoneTopBarProps {
  name: string;
  onRename: (name: string) => void;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  enableRefusal: string | null;
  saveState: EditorSaveState;
  onRetrySave: () => void;
  readOnly: boolean;
  /** Back (in a run, to the editor) or close the tab. */
  onBack: (() => void) | null;
  onClose: (() => void) | null;
  onSettings: () => void;
  onSecrets: () => void;
  onRuns: () => void;
  onTidy: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const SaveLine: React.FC<{ state: EditorSaveState; onRetry: () => void }> = ({ state, onRetry }) => {
  if (state === "error") {
    return (
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-danger">
        <CloudOff size={11} aria-hidden /> Not saved · Retry
      </button>
    );
  }
  if (state === "conflict") return <span className="text-warn">Changed elsewhere</span>;
  const saving = state === "saving" || state === "pending";
  return (
    <span className="inline-flex items-center gap-1" aria-live="polite">
      {saving ? <Loader2 size={10} aria-hidden className="motion-safe:animate-spin" /> : <Check size={11} aria-hidden />}
      {saving ? "Saving…" : "Saved"}
    </span>
  );
};

export const PhoneTopBar: React.FC<PhoneTopBarProps> = (props) => {
  const [text, setText] = useState(props.name);
  const focused = useRef(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!focused.current) setText(props.name);
  }, [props.name]);
  const commit = (): void => {
    const next = text.trim();
    if (next.length === 0) setText(props.name);
    else if (next !== props.name) props.onRename(next.slice(0, WORKFLOW_LIMITS.maxNameLength));
  };
  const blocked = !props.enabled && props.enableRefusal !== null;
  const back = props.onBack ?? props.onClose;
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 pl-1 pr-1">
      {back ? (
        <button
          type="button"
          aria-label={props.onBack ? "Back to the editor" : "Close the workflow"}
          onClick={back}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-300 active:bg-neutral-800"
        >
          {props.onBack ? <ArrowLeft size={20} /> : <X size={20} />}
        </button>
      ) : (
        <span className="w-2" />
      )}
      <div className="min-w-0 flex-1">
        <input
          value={text}
          readOnly={props.readOnly}
          aria-label="Workflow name"
          maxLength={WORKFLOW_LIMITS.maxNameLength}
          enterKeyHint="done"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
          }}
          className="block h-7 w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-1 text-[16px] font-semibold text-neutral-50 focus:border-neutral-700 focus:bg-neutral-900 focus:outline-none"
        />
        <div className="truncate px-1 text-[11px] leading-4 text-neutral-500">
          <SaveLine state={props.saveState} onRetry={props.onRetrySave} />
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.enabled}
        aria-label={props.enabled ? "Enabled — its triggers fire" : "Disabled — only Run now starts it"}
        title={blocked ? props.enableRefusal! : undefined}
        disabled={props.readOnly}
        onClick={() => {
          if (blocked) {
            props.onToggleEnabled(true); // the editor says why it refuses
            return;
          }
          props.onToggleEnabled(!props.enabled);
        }}
        className="flex h-11 shrink-0 items-center gap-2 rounded-full px-2 active:bg-neutral-900"
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-6 w-10 items-center rounded-full transition-colors",
            props.enabled ? "bg-ok" : "bg-neutral-700",
            blocked && "opacity-50"
          )}
        >
          <span
            className={cn(
              "inline-block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
              props.enabled ? "translate-x-[19px]" : "translate-x-[3px]"
            )}
          />
        </span>
      </button>
      <button
        type="button"
        aria-label="More"
        onClick={() => setMenu(true)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-300 active:bg-neutral-800"
      >
        <MoreVertical size={20} />
      </button>
      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        label="Workflow menu"
        title={props.name}
        subtitle={props.enabled ? "Enabled — its triggers fire" : "Disabled — only Run now starts it"}
        actions={[
          { id: "settings", label: "Settings", hint: "Project, overlap, time zone, notifications", icon: <Settings2 size={18} />, onSelect: props.onSettings },
          { id: "runs", label: "Runs", hint: "Its run history", icon: <Play size={18} />, onSelect: props.onRuns },
          { id: "secrets", label: "Secrets", icon: <KeyRound size={18} />, onSelect: props.onSecrets },
          "separator",
          { id: "tidy", label: "Tidy up the canvas", icon: <LayoutGrid size={18} />, disabled: props.readOnly, onSelect: props.onTidy },
          { id: "undo", label: "Undo", icon: <Undo2 size={18} />, disabled: props.readOnly || !props.canUndo, onSelect: props.onUndo },
          { id: "redo", label: "Redo", icon: <Redo2 size={18} />, disabled: props.readOnly || !props.canRedo, onSelect: props.onRedo }
        ]}
      />
    </div>
  );
};

export const PhoneViewSwitch: React.FC<{
  view: PhoneEditorView;
  onView: (view: PhoneEditorView) => void;
  liveRuns: number;
}> = ({ view, onView, liveRuns }) => (
  <div className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-3 py-2">
    <div role="radiogroup" aria-label="View" className="flex rounded-xl bg-neutral-900 p-1 ring-1 ring-neutral-800">
      {(
        [
          ["steps", "Steps"],
          ["canvas", "Canvas"],
          ["runs", "Runs"]
        ] as const
      ).map(([id, label]) => {
        const active = view === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onView(id)}
            className={cn(
              "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13.5px] font-medium transition-colors",
              active ? "bg-neutral-800 text-neutral-50 shadow-sm shadow-black/25" : "text-neutral-400 active:text-neutral-200"
            )}
          >
            {label}
            {id === "runs" && liveRuns > 0 ? (
              <span aria-label={`${liveRuns} running`} className="h-1.5 w-1.5 rounded-full bg-info motion-safe:animate-pulse" />
            ) : null}
          </button>
        );
      })}
    </div>
  </div>
);

const ToolButton: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  wide?: boolean;
  refEl?: React.Ref<HTMLButtonElement>;
  primary?: boolean;
}> = ({ label, onClick, disabled, children, wide, refEl, primary }) => (
  <button
    ref={refEl}
    type="button"
    aria-label={label}
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "flex h-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[10.5px] font-medium transition-colors disabled:opacity-35",
      wide ? "px-3.5" : "w-12",
      primary ? "bg-neutral-100 text-neutral-900 active:bg-neutral-300" : "text-neutral-300 active:bg-neutral-800"
    )}
  >
    {children}
  </button>
);

export const PhoneToolbar: React.FC<{
  canvas: boolean;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onAdd: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFit: () => void;
  onTidy: () => void;
  onRun: () => void;
  runRef: React.Ref<HTMLButtonElement>;
}> = (props) => (
  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
    <div
      role="toolbar"
      aria-label="Editor"
      className="pointer-events-auto flex items-center gap-0.5 rounded-2xl border border-neutral-800 bg-neutral-900/95 p-1 shadow-xl shadow-black/40 backdrop-blur"
    >
      <ToolButton label="Add a step" onClick={props.onAdd} disabled={props.readOnly} wide>
        <Plus size={18} />
        Add
      </ToolButton>
      <span aria-hidden className="mx-0.5 h-7 w-px bg-neutral-800" />
      <ToolButton label="Undo" onClick={props.onUndo} disabled={props.readOnly || !props.canUndo}>
        <Undo2 size={18} />
        Undo
      </ToolButton>
      <ToolButton label="Redo" onClick={props.onRedo} disabled={props.readOnly || !props.canRedo}>
        <Redo2 size={18} />
        Redo
      </ToolButton>
      {props.canvas ? (
        <>
          <ToolButton label="Fit to view" onClick={props.onFit}>
            <Maximize size={17} />
            Fit
          </ToolButton>
          <ToolButton label="Tidy up" onClick={props.onTidy} disabled={props.readOnly}>
            <LayoutGrid size={17} />
            Tidy
          </ToolButton>
        </>
      ) : null}
      <span aria-hidden className="mx-0.5 h-7 w-px bg-neutral-800" />
      <ToolButton label="Run now" onClick={props.onRun} refEl={props.runRef} wide primary>
        <Play size={16} className="fill-current" />
        Run
      </ToolButton>
    </div>
  </div>
);
