/**
 * The editor tab's toolbar (workflows spec §7.2): the workflow's name (renamed
 * in place), its enabled switch (refused while it has errors), the save state,
 * undo/redo, Tidy up, zoom, the Editor | Runs toggle, Run now and Settings.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CloudOff,
  LayoutGrid,
  Loader2,
  Maximize,
  Minus,
  Play,
  Plus,
  Redo2,
  Settings2,
  Undo2,
  Workflow as WorkflowIcon
} from "lucide-react";

import { WORKFLOW_LIMITS } from "@orquester/api";

import { cn } from "../../lib/cn";
import type { EditorSaveState } from "../../lib/workflows/editor-store";
import { FOCUS_RING, Segmented } from "./ui/controls";

export type EditorMode = "editor" | "runs";

export interface EditorToolbarProps {
  name: string;
  onRename: (name: string) => void;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  /** Why enabling is refused (errors), else null. */
  enableRefusal: string | null;
  saveState: EditorSaveState;
  saveError: string | null;
  onRetrySave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onTidy: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  /** Live runs of this workflow (a dot on Runs). */
  liveRuns: number;
  runButtonRef: React.Ref<HTMLButtonElement>;
  onRunNow: () => void;
  onSettings: () => void;
  readOnly: boolean;
}

const ToolButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string }> = ({
  label,
  shortcut,
  className,
  children,
  ...props
}) => (
  <button
    type="button"
    aria-label={label}
    title={shortcut ? `${label} (${shortcut})` : label}
    {...props}
    className={cn(
      "inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors",
      "hover:bg-neutral-800 hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-35",
      FOCUS_RING,
      className
    )}
  >
    {children}
  </button>
);

const Divider: React.FC = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-neutral-800" />;

const SaveState: React.FC<{ state: EditorSaveState; error: string | null; onRetry: () => void }> = ({ state, error, onRetry }) => {
  if (state === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        title={error ?? "Couldn't save"}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-danger hover:bg-danger-soft/30"
      >
        <CloudOff size={13} />
        Not saved · Retry
      </button>
    );
  }
  if (state === "conflict") {
    return (
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[11.5px] text-warn">
        <AlertCircle size={13} />
        Changed elsewhere
      </span>
    );
  }
  const saving = state === "saving" || state === "pending";
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[11.5px] text-neutral-500" aria-live="polite">
      {saving ? <Loader2 size={12} className="motion-safe:animate-spin" /> : <Check size={12} className="text-neutral-500" />}
      {saving ? "Saving…" : "Saved"}
    </span>
  );
};

const NameInput: React.FC<{ name: string; onRename: (name: string) => void; readOnly: boolean }> = ({ name, onRename, readOnly }) => {
  const [text, setText] = useState(name);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(name);
  }, [name]);
  const commit = (): void => {
    const next = text.trim();
    if (next.length === 0) setText(name);
    else if (next !== name) onRename(next.slice(0, WORKFLOW_LIMITS.maxNameLength));
  };
  return (
    <span className="relative inline-grid min-w-[80px] max-w-[min(360px,32vw)] items-center">
      {/* The invisible twin sizes the field to its text. */}
      <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre px-2 text-[14px] font-semibold">
        {text || " "}
      </span>
      <input
        value={text}
        readOnly={readOnly}
        aria-label="Workflow name"
        maxLength={WORKFLOW_LIMITS.maxNameLength}
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
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setText(name);
            requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
          }
        }}
        className={cn(
          "col-start-1 row-start-1 h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-[14px] font-semibold text-neutral-50",
          "hover:border-neutral-800 focus:border-neutral-600 focus:bg-neutral-900 focus:outline-none"
        )}
      />
    </span>
  );
};

export const EditorToolbar: React.FC<EditorToolbarProps> = (props) => {
  const { readOnly, mode } = props;
  const editing = mode === "editor";
  const enableBlocked = !props.enabled && props.enableRefusal !== null;
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2">
      <span className="wf-accent-agent ml-1 mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-neutral-300 ring-1 ring-neutral-800">
        <WorkflowIcon size={14} />
      </span>
      <NameInput name={props.name} onRename={props.onRename} readOnly={readOnly} />
      <button
        type="button"
        role="switch"
        aria-checked={props.enabled}
        aria-label={props.enabled ? "Enabled — its triggers fire" : "Disabled — only Run now starts it"}
        title={
          enableBlocked
            ? props.enableRefusal!
            : props.enabled
              ? "Enabled — its triggers fire. Click to disable."
              : "Disabled — only Run now starts it. Click to enable."
        }
        disabled={readOnly || enableBlocked}
        onClick={() => props.onToggleEnabled(!props.enabled)}
        className={cn(
          "group ml-1 inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-[12px] font-medium transition-colors",
          "hover:bg-neutral-900 disabled:cursor-not-allowed",
          FOCUS_RING
        )}
      >
        <span
          aria-hidden
          className={cn(
            "relative inline-flex h-[18px] w-8 items-center rounded-full transition-colors",
            props.enabled ? "bg-ok/90" : "bg-neutral-700",
            enableBlocked && "opacity-40"
          )}
        >
          <span
            className={cn(
              "inline-block h-3 w-3 rounded-full bg-neutral-950 transition-transform motion-reduce:transition-none",
              props.enabled ? "translate-x-[17px]" : "translate-x-[3px]"
            )}
          />
        </span>
        <span className={cn(props.enabled ? "text-neutral-100" : "text-neutral-500")}>{props.enabled ? "On" : "Off"}</span>
      </button>
      <SaveState state={props.saveState} error={props.saveError} onRetry={props.onRetrySave} />

      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        {editing ? (
          <>
            <ToolButton label="Undo" shortcut="⌘/Ctrl Z" disabled={readOnly || !props.canUndo} onClick={props.onUndo}>
              <Undo2 size={15} />
            </ToolButton>
            <ToolButton label="Redo" shortcut="⌘/Ctrl ⇧ Z" disabled={readOnly || !props.canRedo} onClick={props.onRedo}>
              <Redo2 size={15} />
            </ToolButton>
            <Divider />
            <button
              type="button"
              onClick={props.onTidy}
              disabled={readOnly}
              title="Lay the blocks out left to right"
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-neutral-300 transition-colors",
                "hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-35",
                FOCUS_RING
              )}
            >
              <LayoutGrid size={14} />
              <span className="hidden lg:inline">Tidy up</span>
            </button>
            <ToolButton label="Zoom out" onClick={props.onZoomOut}>
              <Minus size={15} />
            </ToolButton>
            <ToolButton label="Zoom in" onClick={props.onZoomIn}>
              <Plus size={15} />
            </ToolButton>
            <ToolButton label="Fit to view" shortcut="Shift 1" onClick={props.onFit}>
              <Maximize size={14} />
            </ToolButton>
            <Divider />
          </>
        ) : null}
        <div className="relative">
          <Segmented<EditorMode>
            label="Editor or runs"
            size="sm"
            value={mode}
            onChange={props.onMode}
            className="w-[136px]"
            options={[
              { id: "editor", label: "Editor" },
              {
                id: "runs",
                label: (
                  <>
                    Runs
                    {props.liveRuns > 0 ? <span aria-label={`${props.liveRuns} running`} className="h-1.5 w-1.5 rounded-full bg-info motion-safe:animate-pulse" /> : null}
                  </>
                )
              }
            ]}
          />
        </div>
        <button
          ref={props.runButtonRef}
          type="button"
          onClick={props.onRunNow}
          className={cn(
            "ml-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-neutral-100 px-3 text-[12.5px] font-semibold text-neutral-900 transition-colors hover:bg-neutral-50",
            FOCUS_RING
          )}
        >
          <Play size={13} className="fill-current" />
          Run now
        </button>
        <ToolButton label="Workflow settings" onClick={props.onSettings}>
          <Settings2 size={15} />
        </ToolButton>
      </div>
    </div>
  );
};
