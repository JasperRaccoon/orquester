/**
 * What every inspector form reads: the block, the workflow around it, how to
 * change either (one undo step per field burst), the completion scope of its
 * templates, and its validation problems by field.
 */

import React, { createContext, useContext } from "react";

import type { Workflow, WorkflowNode, WorkflowProblem } from "@orquester/api";

import type { WorkflowEditor } from "../../../lib/workflows/editor-store";
import type { CompletionScope } from "../../../lib/workflows/inspector-autocomplete";
import { updateNode } from "../canvas/ops";

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
}

export const InspectorContext = createContext<InspectorContextValue | null>(null);

export function useInspector(): InspectorContextValue {
  const value = useContext(InspectorContext);
  if (value === null) throw new Error("useInspector outside an inspector");
  return value;
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

export function useFieldMessages(field: string): { error: string | null; warning: string | null } {
  return fieldMessages(useInspector().problems, field);
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
