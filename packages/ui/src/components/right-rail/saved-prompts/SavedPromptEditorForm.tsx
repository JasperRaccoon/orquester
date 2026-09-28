/**
 * The saved-prompt editor's form: title, description, scope, tags, pinned,
 * the body, and the variables helper under it (a chip per variable, which
 * inserts `{name}` at the caret, and the variables the body uses).
 *
 * Presentational — `SavedPromptEditor` owns the draft and the save and wraps
 * this in the modal — so a static render check draws it from plain props.
 */

import React, { useId, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";

import {
  PROMPT_VARIABLES,
  promptVariablesUsed,
  SAVED_PROMPT_BODY_MAX,
  SAVED_PROMPT_DESCRIPTION_MAX,
  SAVED_PROMPT_TITLE_MAX,
  type PromptVariableName
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../../lib/keyboard-surfaces";
import { Kbd } from "../../agent-chat/primitives/Kbd";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ModalCloseButton } from "../../ui/modal";
import { Switch } from "../../ui/switch";
import { RailSegmented, type RailSegmentOption } from "../primitives";
import {
  insertAtSelection,
  normalizeDescription,
  validateSavedPromptDraft,
  type SavedPromptDraft,
  type SavedPromptEditorScope
} from "./editor.logic";
import { useIsomorphicLayoutEffect } from "./layout-effect";

interface SavedPromptEditorFormProps {
  mode: "create" | "edit";
  draft: SavedPromptDraft;
  onChange: (patch: Partial<SavedPromptDraft>) => void;
  /** "This project" can be chosen. */
  projectScopeAvailable: boolean;
  saving: boolean;
  /** The daemon refused the save. */
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}

const BODY_PLACEHOLDER = "Review the uncommitted changes on {branch} for bugs and missing tests.\n\n{diff}";
const VARIABLES_HINT =
  "Variables fill in when you insert or send. Any other {name} stays as written; write {{name}} for a literal {name}.";

const count = (value: number): string => value.toLocaleString("en-US");

export const SavedPromptEditorForm: React.FC<SavedPromptEditorFormProps> = (props) => {
  const { draft, onChange } = props;
  const ids = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the body a chip changed has rendered.
  const pendingCaret = useRef<number | null>(null);
  // A body never focused has no caret the user chose: a chip appends there.
  const bodyFocused = useRef(false);
  const validation = validateSavedPromptDraft(draft);
  const used = useMemo(() => promptVariablesUsed(draft.body), [draft.body]);

  // Before paint: the caret never shows at the end of the new text first.
  useIsomorphicLayoutEffect(() => {
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    const textarea = bodyRef.current;
    if (caret === null || textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }, [draft.body]);

  const insertVariable = (name: PromptVariableName) => {
    const textarea = bodyFocused.current ? bodyRef.current : null;
    const start = textarea?.selectionStart ?? draft.body.length;
    const end = textarea?.selectionEnd ?? draft.body.length;
    const next = insertAtSelection(draft.body, start, end, `{${name}}`);
    pendingCaret.current = next.caret;
    onChange({ body: next.text });
  };

  const canSave = validation.valid && !props.saving;
  const scopeOptions: RailSegmentOption<SavedPromptEditorScope>[] = [
    { id: "global", label: "Global", title: "Available in every project" },
    {
      id: "project",
      label: "This project",
      title: props.projectScopeAvailable
        ? "Only in this project"
        : "Open a project to save a prompt to it",
      disabled: !props.projectScopeAvailable
    }
  ];
  const missingHint =
    validation.missing.length === 0
      ? undefined
      : validation.missing.length === 2
        ? "Give the prompt a title and a body"
        : validation.missing[0] === "title"
          ? "Give the prompt a title"
          : "Give the prompt a body";

  return (
    <div
      // The chat's chords stand down for keys typed in here (`lib/keyboard-surfaces.ts`):
      // a Ctrl+/ in the body must not open the chat's model menu behind the modal.
      {...KEYBOARD_SURFACE_PROPS}
      className="flex min-h-0 w-full flex-col"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (canSave) props.onSave();
        }
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
        <span className="text-sm font-medium text-neutral-100">
          {props.mode === "create" ? "New prompt" : "Edit prompt"}
        </span>
        <ModalCloseButton onClose={props.onCancel} />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <Field
          id={`${ids}-title`}
          label="Title"
          count={draft.title.trim().length}
          max={SAVED_PROMPT_TITLE_MAX}
          error={validation.errors.title}
        >
          <Input
            id={`${ids}-title`}
            autoFocus
            value={draft.title}
            placeholder="Review current changes"
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>

        <Field
          id={`${ids}-description`}
          label="Description"
          optional
          count={normalizeDescription(draft.description).length}
          max={SAVED_PROMPT_DESCRIPTION_MAX}
          error={validation.errors.description}
        >
          <Input
            id={`${ids}-description`}
            value={draft.description}
            placeholder="One line under the title"
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="text-xs text-neutral-400">Scope</div>
            <RailSegmented
              label="Scope"
              options={scopeOptions}
              value={draft.scope}
              onChange={(scope) => onChange({ scope })}
            />
          </div>
          <Field id={`${ids}-tags`} label="Tags" optional error={validation.errors.tags}>
            <Input
              id={`${ids}-tags`}
              value={draft.tagsText}
              placeholder="review, testing"
              onChange={(event) => onChange({ tagsText: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-neutral-300">Pinned</div>
            <div className="text-[11px] text-neutral-500">Pinned prompts are listed first.</div>
          </div>
          <Switch checked={draft.pinned} label="Pinned" onChange={(pinned) => onChange({ pinned })} />
        </div>

        <Field
          id={`${ids}-body`}
          label="Prompt"
          count={draft.body.length}
          max={SAVED_PROMPT_BODY_MAX}
          error={validation.errors.body}
        >
          <textarea
            ref={bodyRef}
            id={`${ids}-body`}
            rows={12}
            spellCheck
            value={draft.body}
            placeholder={BODY_PLACEHOLDER}
            onFocus={() => {
              bodyFocused.current = true;
            }}
            onChange={(event) => onChange({ body: event.target.value })}
            className={cn(
              "block w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-2",
              "font-mono text-[13px] leading-5 text-neutral-100 placeholder:text-neutral-500",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            )}
          />
        </Field>

        <div className="space-y-1.5">
          <div className="text-xs text-neutral-400">Variables</div>
          <div className="flex flex-wrap gap-1">
            {PROMPT_VARIABLES.map((spec) => (
              <button
                key={spec.name}
                type="button"
                title={spec.description}
                // Keep the caret where it is: the chip inserts there.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertVariable(spec.name)}
                className={cn(
                  "rounded-md border border-neutral-700/80 px-1.5 py-px font-mono text-[11px] leading-4 text-neutral-300",
                  "transition-colors hover:border-neutral-500 hover:text-neutral-100",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                )}
              >
                {`{${spec.name}}`}
              </button>
            ))}
          </div>
          {used.length > 0 ? (
            <p className="text-xs text-neutral-500">
              Uses: {used.map((name) => `{${name}}`).join(", ")}
            </p>
          ) : null}
          <p className="text-[11px] leading-4 text-neutral-500">{VARIABLES_HINT}</p>
        </div>

        {props.error !== null ? (
          <p role="alert" className="break-words text-xs text-danger">
            {props.error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
        <span className="mr-auto hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:inline-flex">
          <Kbd combo="mod+enter" /> to save
        </span>
        {/* Never disabled: closing mid-save is allowed — the save still lands. */}
        <Button type="button" size="sm" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canSave} title={missingHint} onClick={props.onSave}>
          {props.saving ? (
            <>
              <Loader2 size={13} aria-hidden className="animate-spin" /> Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
};

const Field: React.FC<{
  id: string;
  label: string;
  optional?: boolean;
  count?: number;
  max?: number;
  error?: string;
  children: React.ReactNode;
}> = ({ id, label, optional, count: length, max, error, children }) => (
  <div className="space-y-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={id} className="text-xs text-neutral-400">
        {label}
        {optional ? <span className="text-neutral-600"> (optional)</span> : null}
      </label>
      {max !== undefined && length !== undefined ? (
        <span
          className={cn(
            "text-[11px] tabular-nums",
            length > max ? "text-danger" : "text-neutral-500"
          )}
        >
          {count(length)}/{count(max)}
        </span>
      ) : null}
    </div>
    {children}
    {error ? <p className="text-xs text-danger">{error}</p> : null}
  </div>
);
