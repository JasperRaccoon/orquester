// Automated workflows — which fields of a block are `{{ … }}` templates. One list, read by the
// validator (syntax, references, secrets) and by renames (rewriting `nodes.<Name>`), so the two can
// never disagree about where a reference may hide.
//
// A shell script is deliberately NOT a template field: values reach it only through `env` (§4).
// A code block's source is JavaScript, not a template: it reads `nodes` as an argument.

import type { WorkflowNode } from "./types.ts";

export type TemplateFieldRole =
  /** An agent's prompt: secrets and untrusted trigger text land in the transcript. */
  | "prompt"
  /**
   * A new chat's title: shown on the tab, never sent to the agent as input, and rendered with
   * every secret as its `«secret:NAME»` placeholder.
   */
  | "title"
  /** A value rendered to text or to a raw value. */
  | "value";

export interface TemplateField {
  /** Dotted path inside the node, e.g. "config.headers.0.value". */
  field: string;
  value: string;
  role: TemplateFieldRole;
}

type Path = (string | number)[];

function candidatePaths(node: WorkflowNode): { path: Path; role: TemplateFieldRole }[] {
  const out: { path: Path; role: TemplateFieldRole }[] = [];
  const add = (role: TemplateFieldRole, ...path: Path): void => {
    out.push({ path: ["config", ...path], role });
  };
  switch (node.type) {
    case "agent": {
      const config = node.config;
      if (config.prompt.kind === "text") add("prompt", "prompt", "text");
      else add("prompt", "prompt", "append");
      if (config.session.kind === "new") add("title", "session", "title");
      break;
    }
    case "shell":
      node.config.env.forEach((_, index) => add("value", "env", index, "value"));
      break;
    case "http": {
      const config = node.config;
      add("value", "url");
      config.headers.forEach((_, index) => add("value", "headers", index, "value"));
      config.query.forEach((_, index) => add("value", "query", index, "value"));
      if (config.body?.kind === "json" || config.body?.kind === "text") add("value", "body", "value");
      else if (config.body?.kind === "form") config.body.fields.forEach((_, index) => add("value", "body", "fields", index, "value"));
      break;
    }
    case "if":
      node.config.rules.forEach((_, index) => {
        add("value", "rules", index, "left");
        add("value", "rules", index, "right");
      });
      break;
    case "switch":
      node.config.cases.forEach((current, caseIndex) =>
        current.rules.forEach((_, index) => {
          add("value", "cases", caseIndex, "rules", index, "left");
          add("value", "cases", caseIndex, "rules", index, "right");
        })
      );
      break;
    case "stop":
      add("value", "value");
      add("value", "message");
      break;
    case "workflow":
      add("value", "input");
      break;
    case "trigger.manual":
    case "trigger.schedule":
    case "trigger.git":
    case "code":
    case "merge":
    case "wait":
    case "note":
      break;
    default: {
      const unhandled: never = node;
      void unhandled;
    }
  }
  return out;
}

function read(target: unknown, path: Path): unknown {
  let current = target;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Every template-bearing string field of a block that is set, with its dotted path. */
export function nodeTemplateFields(node: WorkflowNode): TemplateField[] {
  const out: TemplateField[] = [];
  for (const { path, role } of candidatePaths(node)) {
    const value = read(node, path);
    if (typeof value === "string") out.push({ field: path.join("."), value, role });
  }
  return out;
}

/** A copy of the block with every template field passed through `rewrite` (unchanged fields keep identity). */
export function mapNodeTemplateFields(
  node: WorkflowNode,
  rewrite: (value: string, field: TemplateField) => string
): WorkflowNode {
  let copy: WorkflowNode | null = null;
  for (const { path, role } of candidatePaths(node)) {
    const value = read(node, path);
    if (typeof value !== "string") continue;
    const next = rewrite(value, { field: path.join("."), value, role });
    if (next === value) continue;
    copy ??= structuredClone(node);
    const parent = read(copy, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path[path.length - 1]!] = next;
  }
  return copy ?? node;
}
