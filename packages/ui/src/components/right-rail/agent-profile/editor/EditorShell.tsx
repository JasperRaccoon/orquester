/**
 * The inside of every agent-profile editor: a header (title, the agent, and
 * Cancel), an optional toolbar that never scrolls away (the skill source
 * switcher), a body that scrolls, and the Save bar with whatever the last save
 * said above it. On a phone the header and the bar are the sheet's sticky
 * ends and the body scrolls between them; on desktop the same inside the
 * dialog. Measures its own width for the forms below (`EditorWideContext`).
 *
 * Presentational: it takes the primary action as data, so a static render
 * check draws every state from plain props.
 */

import React, { useRef } from "react";
import { Loader2, X } from "lucide-react";

import { cn } from "../../../../lib/cn";
import { Kbd } from "../../../agent-chat/primitives/Kbd";
import {
  EditorWideContext,
  isWide,
  useEditorEnv,
  useElementWidth,
  useInitialWidth
} from "./env";
import { agentLabel } from "./layout.logic";

export interface EditorPrimaryAction {
  label: string;
  /** While the request is in flight: a spinner and this label ("Saving…"). */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  /** Why it is disabled (the tooltip). */
  title?: string;
  onClick: () => void;
  tone?: "default" | "danger";
}

/** Ctrl/Cmd+Enter, the editors' Save — not an IME's Enter, not a held repeat. */
export function isSaveChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "repeat" | "isComposing">): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.repeat && !event.isComposing;
}

export interface EditorShellProps {
  title: string;
  /** Under the title; defaults to the agent's name. */
  subtitle?: string;
  toolbar?: React.ReactNode;
  /** Between the body and the buttons: the error banner, a conflict prompt, the upload's progress. */
  status?: React.ReactNode;
  /** `null` for a view with nothing to save (a plugin's details). */
  primary: EditorPrimaryAction | null;
  /** Extra buttons left of the primary one ("Back"). */
  secondary?: React.ReactNode;
  /** The body lays its children out in a column that fills a tall editor (CodeMirror takes what is left). */
  fill?: boolean;
  /** Cancel's label: "Close" for a view with nothing to lose. */
  cancelLabel?: string;
  children: React.ReactNode;
}

export const EditorShell: React.FC<EditorShellProps> = ({
  title,
  subtitle,
  toolbar,
  status,
  primary,
  secondary,
  fill = false,
  cancelLabel = "Cancel",
  children
}) => {
  const env = useEditorEnv();
  const phone = env.variant === "phone";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(rootRef, useInitialWidth());
  const sub = subtitle ?? agentLabel(env.agent);
  const canSubmit = primary !== null && !primary.disabled && !primary.busy && env.connected;

  return (
    <div
      ref={rootRef}
      data-editor-variant={env.variant}
      className={cn(
        "flex min-h-0 w-full min-w-0 flex-col",
        // A phone's sheet is a column: take all of it. A desktop dialog grows
        // to its content, or to this height for an editor that fills.
        phone ? "flex-1" : fill && "h-[min(88vh,860px)]"
      )}
      // Capture, so the chord saves from inside CodeMirror too: its own keymap
      // binds Mod-Enter (insert a blank line) and would take the key first.
      onKeyDownCapture={(event) => {
        if (!isSaveChord(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        if (canSubmit) primary.onClick();
      }}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b border-neutral-800",
          phone ? "min-h-14 bg-neutral-950 px-4 py-1.5" : "h-14 px-4"
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className={cn("truncate font-semibold text-neutral-50", phone ? "text-[15px] leading-5" : "text-sm")}>{title}</h2>
          {sub ? <p className="truncate text-xs text-neutral-500">{sub}</p> : null}
        </div>
        {phone ? (
          <button
            type="button"
            onClick={env.requestClose}
            className="-mr-2 inline-flex h-10 shrink-0 items-center rounded-md px-3 text-[15px] text-neutral-300 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            {cancelLabel}
          </button>
        ) : (
          <button
            type="button"
            aria-label={cancelLabel}
            title={cancelLabel}
            onClick={env.requestClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </header>

      {toolbar ? <div className="shrink-0 border-b border-neutral-800 px-4 py-2.5">{toolbar}</div> : null}

      <EditorWideContext.Provider value={isWide(width)}>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overscroll-contain px-4 py-4",
            fill ? "flex flex-col gap-3 overflow-y-auto" : "space-y-4 overflow-y-auto"
          )}
        >
          {children}
        </div>
      </EditorWideContext.Provider>

      <footer className={cn("shrink-0 border-t border-neutral-800", phone ? "bg-neutral-950 px-4 py-2.5" : "px-4 py-3")}>
        {status ? <div className="mb-2.5 min-w-0">{status}</div> : null}
        <div className="flex items-center justify-end gap-2">
          {!phone && primary !== null ? (
            <span className="mr-auto hidden items-center gap-1.5 text-[11px] text-neutral-500 md:inline-flex">
              <Kbd combo="mod+enter" /> to save
            </span>
          ) : null}
          {secondary}
          {!phone ? (
            <button
              type="button"
              onClick={env.requestClose}
              className="inline-flex h-8 items-center justify-center rounded-md border border-neutral-700 px-3 text-xs font-medium text-neutral-200 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              {cancelLabel}
            </button>
          ) : null}
          {primary !== null ? (
            <button
              type="button"
              disabled={!canSubmit}
              title={!env.connected ? "Not connected to the daemon" : primary.title}
              onClick={primary.onClick}
              className={cn(
                "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-900",
                "disabled:cursor-not-allowed disabled:opacity-50",
                phone ? "h-11 min-w-0 flex-1 px-4 text-[15px]" : "h-8 px-3 text-xs",
                primary.tone === "danger"
                  ? "bg-danger-600 text-white hover:bg-danger-500"
                  : "bg-neutral-200 text-neutral-900 hover:bg-neutral-50"
              )}
            >
              {primary.busy ? (
                <>
                  <Loader2 size={14} aria-hidden className="animate-spin" />
                  {primary.busyLabel ?? "Saving…"}
                </>
              ) : (
                <span className="min-w-0 truncate">{primary.label}</span>
              )}
            </button>
          ) : phone ? (
            <button
              type="button"
              onClick={env.requestClose}
              className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-neutral-700 text-[15px] font-medium text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              {cancelLabel}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
};
