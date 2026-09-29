/**
 * What every inspector form reads: the block, the workflow around it, how to
 * change either (one undo step per field burst), the completion scope of its
 * templates, and its validation problems by field — plus the inspector-aware
 * form pieces: a Section that counts its problems and opens itself when a
 * problem in it is picked (`InspectorSection`), and a Field that anchors and
 * shows its own messages (`ConfigField`).
 */

import React, { createContext, useContext, useState } from "react";

import type { Workflow, WorkflowNode, WorkflowProblem } from "@orquester/api";

import type { WorkflowEditor } from "../../../lib/workflows/editor-store";
import type { CompletionScope } from "../../../lib/workflows/inspector-autocomplete";
import { updateNode } from "../canvas/ops";
import { Field, Section, type ProblemCounts } from "../ui/controls";

/** A request to bring a field into view: sections whose anchors cover `field` open. `nonce` makes a repeat pick a new request. */
export interface InspectorReveal {
  field: string;
  nonce: number;
}

export interface InspectorContextValue {
  editor: WorkflowEditor;
  workflow: Workflow;
  node: WorkflowNode;
  readOnly: boolean;
  /** The project the workflow runs in ("" for a temporary one). */
  projectPath: string;
  secretNames: readonly string[];
  scope: CompletionScope;
  promptScope: CompletionScope;
  problems: readonly WorkflowProblem[];
  openSecrets: () => void;
  /** The field last asked to be revealed (a picked problem), until it has been focused. */
  reveal?: InspectorReveal | null;
  /** Open the sections that hold `field`, switch to Settings, then focus it on the next frame. */
  revealField?: (field: string) => void;
}

export const InspectorContext = createContext<InspectorContextValue | null>(null);

export function useInspector(): InspectorContextValue {
  const value = useContext(InspectorContext);
  if (value === null) throw new Error("useInspector outside an inspector");
  return value;
}

/** Whether `field` is one of `prefixes` or under one (`config.chain.0` covers `config.chain.0.model`). */
export function fieldCovered(field: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => field === prefix || field.startsWith(`${prefix}.`));
}

/** Errors and warnings on any of `prefixes` or under them, each problem counted once. */
export function countProblems(problems: readonly WorkflowProblem[], prefixes: readonly string[]): ProblemCounts {
  let errors = 0;
  let warnings = 0;
  for (const problem of problems) {
    if (problem.field === undefined || !fieldCovered(problem.field, prefixes)) continue;
    if (problem.severity === "error") errors += 1;
    else if (problem.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}

/** The problems on `field` and everything under it (`config.chain.0` covers `config.chain.0.model`). */
export function problemsAt(problems: readonly WorkflowProblem[], field: string): WorkflowProblem[] {
  return problems.filter(
    (problem) => problem.field !== undefined && (problem.field === field || problem.field.startsWith(`${field}.`))
  );
}

/** The first error (else warning) message on `field`, split for a `Field`'s error / warning slots. */
export function fieldMessages(problems: readonly WorkflowProblem[], field: string): { error: string | null; warning: string | null } {
  const at = problemsAt(problems, field);
  const error = at.find((problem) => problem.severity === "error");
  const warning = at.find((problem) => problem.severity === "warning");
  const strip = (message: string): string => message.replace(/^[A-Za-z][A-Za-z0-9_]*: /, "");
  return { error: error ? strip(error.message) : null, warning: warning ? strip(warning.message) : null };
}

/** `fieldMessages` for the inspected block: the first error and the first warning on `field` or under it. */
export function useFieldMessages(field: string): { error: string | null; warning: string | null } {
  return fieldMessages(useInspector().problems, field);
}

/** Error / warning counts for the inspected block on field paths under any of `prefixes` ("config.chain.0", "retry", "timeoutMinutes"). */
export function useSectionProblems(prefixes: readonly string[]): ProblemCounts {
  return countProblems(useInspector().problems, prefixes);
}

/**
 * Open state for anything collapsible that holds fields under `anchors` (a
 * section, a chain card, a Disclosure): starts open when `defaultOpen`, when
 * it has errors or when a pending reveal covers it; opens again when a new
 * reveal covers it or when errors appear in it (none → some). Set during
 * render, so the field is in the DOM by the frame the reveal focuses it.
 */
export function useRevealOpen(anchors: readonly string[], defaultOpen = false): [boolean, (open: boolean) => void] {
  const { reveal, problems } = useInspector();
  const errors = countProblems(problems, anchors).errors;
  const covers = reveal != null && fieldCovered(reveal.field, anchors);
  const [open, setOpen] = useState(() => defaultOpen || errors > 0 || covers);
  const [seen, setSeen] = useState({ nonce: reveal?.nonce ?? 0, errors });
  const nonce = reveal?.nonce ?? seen.nonce;
  if (nonce !== seen.nonce || errors !== seen.errors) {
    setSeen({ nonce, errors });
    if (!open && ((nonce !== seen.nonce && covers) || (seen.errors === 0 && errors > 0))) setOpen(true);
  }
  return [open, setOpen];
}

/** Change the block's `config` (merged one level), coalescing bursts under `key`. */
export function useConfigSetter<C>(): (patch: Partial<C> | ((config: C) => C), key: string) => void {
  const { editor, node, readOnly } = useInspector();
  return (patch, key) => {
    if (readOnly) return;
    editor.change(
      (draft) =>
        updateNode(draft, node.id, (current) => {
          const config = current.config as unknown as C;
          const next = typeof patch === "function" ? patch(config) : { ...config, ...patch };
          return { ...current, config: next } as WorkflowNode;
        }),
      { coalesce: `config:${node.id}:${key}` }
    );
  };
}

/** Change top-level block fields (`notes`, `disabled`, `retry`…); `undefined` removes one. */
export function useNodeSetter(): (patch: Record<string, unknown>, key: string) => void {
  const { editor, node, readOnly } = useInspector();
  return (patch, key) => {
    if (readOnly) return;
    editor.change(
      (draft) =>
        updateNode(draft, node.id, (current) => {
          const next: Record<string, unknown> = { ...current };
          for (const [name, value] of Object.entries(patch)) {
            if (value === undefined) delete next[name];
            else next[name] = value;
          }
          return next as unknown as WorkflowNode;
        }),
      { coalesce: `node:${node.id}:${key}` }
    );
  };
}

/** Marks a region of a form as the home of a validation field, so a problem can focus it. */
export const FieldAnchor: React.FC<{ field: string; children: React.ReactNode; className?: string }> = ({
  field,
  children,
  className
}) => (
  <div data-wf-field={field} className={className}>
    {children}
  </div>
);

/**
 * A collapsible inspector Section (see `Section`) that knows which fields it
 * holds: `anchors` are field-path prefixes ("config.chain", "retry"); their
 * problems show as count pills, and it opens itself when errors appear in it or
 * a picked problem's field is under one of them. `collapsible={false}` makes a
 * plain titled section that still shows the counts.
 */
export const InspectorSection: React.FC<{
  title: React.ReactNode;
  anchors: readonly string[];
  summary?: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  sticky?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ title, anchors, summary, description, aside, defaultOpen = false, collapsible = true, sticky, className, children }) => {
  const problems = useSectionProblems(anchors);
  const [open, setOpen] = useRevealOpen(anchors, defaultOpen);
  return (
    <Section
      title={title}
      summary={summary}
      description={description}
      aside={aside}
      collapsible={collapsible}
      open={collapsible ? open : undefined}
      onOpenChange={setOpen}
      problems={problems}
      sticky={sticky}
      className={className}
    >
      {children}
    </Section>
  );
};

/**
 * A `Field` for one config path: a `FieldAnchor` on `path` (so a problem there
 * can focus it) with that path's first error and first warning shown under the
 * control. The other props are `Field`'s.
 */
export const ConfigField: React.FC<{
  path: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  hint?: React.ReactNode;
  optional?: boolean;
  defaultNote?: React.ReactNode;
  aside?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ path, label, help, hint, optional, defaultNote, aside, htmlFor, className, children }) => {
  const { error, warning } = useFieldMessages(path);
  return (
    <FieldAnchor field={path} className={className}>
      <Field
        label={label}
        help={help}
        hint={hint}
        optional={optional}
        defaultNote={defaultNote}
        aside={aside}
        htmlFor={htmlFor}
        error={error}
        warning={warning}
      >
        {children}
      </Field>
    </FieldAnchor>
  );
};
