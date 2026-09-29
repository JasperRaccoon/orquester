/**
 * The inspector's template autocompletion (workflows spec §3.3, §7.2): what a
 * `{{ … }}` can read at the caret, and the saved-prompt `{variables}` an agent
 * prompt takes.
 *
 * Pure: `templateCompletions(text, pos, scope)` answers the span to replace
 * and the options, the way CodeMirror's completion source wants them
 * (`TemplateEditor` adapts it without importing `@codemirror/autocomplete`).
 * The scope — the blocks upstream of the one being edited, the triggers, the
 * secret names — comes from `completionScopeFor`.
 */

import {
  EXPRESSION_FILTERS,
  isTriggerType,
  PROMPT_VARIABLES,
  upstreamOf,
  WORKFLOW_EXPRESSION_FILTER_GUIDE,
  WORKFLOW_EXPRESSION_ROOT_GUIDE,
  type ExpressionRoot,
  type Workflow,
  type WorkflowNodeType
} from "@orquester/api";

export interface CompletionOption {
  label: string;
  /** What is inserted (defaults to the label). */
  apply?: string;
  /** Shown beside the label: a short hint. */
  detail?: string;
  /** The longer explanation shown beside the list for the selected option (the shared guide's text, `backticks` marking code). */
  info?: string;
  /** CodeMirror's icon kind. */
  type: "variable" | "property" | "function" | "keyword" | "constant";
}

export interface CompletionAnswer {
  from: number;
  to: number;
  options: CompletionOption[];
}

export interface CompletionNode {
  name: string;
  type: WorkflowNodeType;
}

export interface CompletionScope {
  /** Blocks that run before this one (their outputs are readable). */
  upstream: readonly CompletionNode[];
  /** The workflow's trigger types (`trigger.*` fields). */
  triggerTypes: readonly WorkflowNodeType[];
  /** The fields of `input`: the single direct input's output fields, or the input blocks' names. */
  inputFields: readonly string[];
  secretNames: readonly string[];
  /** An agent prompt: `{variables}` complete too. */
  promptVariables: boolean;
}

/** What a block's `output` is known to hold (spec §3.2). */
export const KNOWN_OUTPUT_FIELDS: Partial<Record<WorkflowNodeType, readonly string[]>> = {
  "trigger.manual": ["kind", "input"],
  "trigger.schedule": ["kind", "firedAt", "scheduledFor"],
  "trigger.git": ["kind", "event", "repo", "ref", "sha", "previousSha", "branch", "tag", "release", "pr"],
  agent: ["text", "sessionId", "agent", "model", "accountId", "durationMs", "hops"],
  shell: ["stdout", "stderr", "exitCode"],
  http: ["status", "headers", "body"]
};

const NESTED_FIELDS: Record<string, readonly string[]> = {
  pr: ["number", "title", "body", "url", "author", "head", "base", "action", "headSha"],
  release: ["id", "name", "tag", "body", "url", "prerelease"],
  repo: ["url", "name"],
  error: ["kind", "message"]
};

/** The shared guide's text for a `{{ … }}` path (`nodes.<Name>.status`…), by its path. */
function pathInfo(path: string): string | undefined {
  return WORKFLOW_EXPRESSION_ROOT_GUIDE.find((row) => row.path === path)?.text;
}

/** The shared guide's text for a root (its first row: `nodes` → `nodes.<Name>.output`). */
function rootInfo(root: ExpressionRoot): string | undefined {
  return WORKFLOW_EXPRESSION_ROOT_GUIDE.find((row) => row.root === root)?.text;
}

const ROOTS: { label: ExpressionRoot; detail: string }[] = [
  { label: "nodes", detail: "earlier blocks, by name" },
  { label: "input", detail: "the wired-in block's output" },
  { label: "trigger", detail: "what started the run" },
  { label: "run", detail: "id, startedAt, attempt…" },
  { label: "project", detail: "path, name, branch…" },
  { label: "secrets", detail: "workflow secrets" },
  { label: "workflow", detail: "id, name" }
];

const SECRET_INFO = pathInfo("secrets.<NAME>");

const RUN_FIELDS = ["id", "startedAt", "workflowId", "workflowName", "attempt"];
const PROJECT_FIELDS = ["path", "name", "workspace", "branch"];
const WORKFLOW_FIELDS = ["id", "name"];
const NODE_FIELDS = [
  { label: "output", detail: "its result", info: pathInfo("nodes.<Name>.output") },
  { label: "status", detail: "succeeded, failed…", info: pathInfo("nodes.<Name>.status") },
  { label: "error", detail: "{ kind, message }", info: pathInfo("nodes.<Name>.error") }
];

const FILTER_APPLY: Partial<Record<string, string>> = { default: 'default("")', lines: "lines(5)" };
const FILTER_DETAIL: Record<string, string> = {
  json: "pretty JSON",
  compact: "one-line JSON",
  default: "fallback value",
  trim: "strip whitespace",
  lines: "first n lines",
  first: "first item",
  last: "last item",
  length: "count",
  upper: "UPPER CASE",
  lower: "lower case"
};

function triggerFields(types: readonly WorkflowNodeType[]): string[] {
  const out = new Set<string>(["kind"]);
  for (const type of types) for (const field of KNOWN_OUTPUT_FIELDS[type] ?? []) out.add(field);
  return [...out];
}

function fieldsOf(type: WorkflowNodeType): readonly string[] {
  return KNOWN_OUTPUT_FIELDS[type] ?? [];
}

/** The `{{` that opens the expression the caret is in, or -1. */
function openExpressionAt(text: string, pos: number): number {
  const before = text.slice(0, pos);
  const open = before.lastIndexOf("{{");
  if (open < 0) return -1;
  if (open > 0 && before[open - 1] === "\\") return -1;
  if (before.indexOf("}}", open) >= 0) return -1;
  return open;
}

function prop(label: string, detail?: string, info?: string): CompletionOption {
  const option: CompletionOption = { label, type: "property" };
  if (detail) option.detail = detail;
  if (info) option.info = info;
  return option;
}

/** Options for the path segment after `parents` (dotted, bracket-free). */
function pathOptions(parents: string[], scope: CompletionScope): CompletionOption[] {
  if (parents.length === 0) {
    return ROOTS.map((root) => {
      const option: CompletionOption = { label: root.label, detail: root.detail, type: "variable" };
      const info = rootInfo(root.label);
      if (info) option.info = info;
      return option;
    });
  }
  const [root, ...rest] = parents;
  switch (root) {
    case "nodes": {
      if (rest.length === 0) {
        return scope.upstream.map((node) => ({ label: node.name, detail: node.type, type: "variable" }));
      }
      const node = scope.upstream.find((candidate) => candidate.name === rest[0]);
      if (rest.length === 1) return NODE_FIELDS.map((field) => prop(field.label, field.detail, field.info));
      if (rest[1] === "error" && rest.length === 2) return NESTED_FIELDS.error!.map((field) => prop(field));
      if (rest[1] !== "output" || !node) return [];
      if (rest.length === 2) return fieldsOf(node.type).map((field) => prop(field));
      if (rest.length === 3 && isTriggerType(node.type)) return (NESTED_FIELDS[rest[2]!] ?? []).map((field) => prop(field));
      return [];
    }
    case "trigger":
      if (rest.length === 0) return triggerFields(scope.triggerTypes).map((field) => prop(field));
      if (rest.length === 1) return (NESTED_FIELDS[rest[0]!] ?? []).map((field) => prop(field));
      return [];
    case "input":
      return rest.length === 0 ? scope.inputFields.map((field) => prop(field)) : [];
    case "run":
      return rest.length === 0 ? RUN_FIELDS.map((field) => prop(field)) : [];
    case "project":
      return rest.length === 0 ? PROJECT_FIELDS.map((field) => prop(field)) : [];
    case "workflow":
      return rest.length === 0 ? WORKFLOW_FIELDS.map((field) => prop(field)) : [];
    case "secrets":
      if (rest.length > 0) return [];
      return scope.secretNames.map((name) => {
        const option: CompletionOption = { label: name, detail: "secret", type: "constant" };
        if (SECRET_INFO) option.info = SECRET_INFO;
        return option;
      });
    default:
      return [];
  }
}

function narrow(options: CompletionOption[], partial: string): CompletionOption[] {
  if (partial.length === 0) return options;
  const lower = partial.toLowerCase();
  return options.filter((option) => option.label.toLowerCase().startsWith(lower));
}

/**
 * The completions at `pos` in `text`: inside an open `{{ … }}` the path or a
 * filter; in a prompt, a `{variable}` after a single `{`. Null when there is
 * nothing to offer.
 */
export function templateCompletions(text: string, pos: number, scope: CompletionScope): CompletionAnswer | null {
  const open = openExpressionAt(text, pos);
  if (open >= 0) {
    const expression = text.slice(open + 2, pos);
    const pipe = expression.lastIndexOf("|");
    if (pipe >= 0) {
      const partial = /([A-Za-z]*)$/.exec(expression.slice(pipe + 1))![1]!;
      if (!/^\s*[A-Za-z]*$/.test(expression.slice(pipe + 1))) return null;
      const options = narrow(
        EXPRESSION_FILTERS.map((name) => {
          const apply = FILTER_APPLY[name];
          const option: CompletionOption = { label: name, detail: FILTER_DETAIL[name] ?? "", type: "function" };
          if (apply) option.apply = apply;
          const guide = WORKFLOW_EXPRESSION_FILTER_GUIDE[name];
          option.info = `\`${guide.usage}\` — ${guide.text}`;
          return option;
        }),
        partial
      );
      return options.length > 0 ? { from: pos - partial.length, to: pos, options } : null;
    }
    const path = expression.trimStart();
    if (!/^[A-Za-z0-9_.]*$/.test(path)) return null;
    const segments = path.split(".");
    const partial = segments.pop() ?? "";
    if (segments.some((segment) => segment.length === 0)) return null;
    const options = narrow(pathOptions(segments, scope), partial);
    return options.length > 0 ? { from: pos - partial.length, to: pos, options } : null;
  }
  if (scope.promptVariables) {
    const match = /(^|[^{])\{([A-Za-z]*)$/.exec(text.slice(Math.max(0, pos - 64), pos));
    if (match) {
      const partial = match[2]!;
      const options = narrow(
        PROMPT_VARIABLES.map((spec) => ({ label: spec.name, apply: `${spec.name}}`, detail: spec.description, type: "keyword" as const })),
        partial
      );
      return options.length > 0 ? { from: pos - partial.length, to: pos, options } : null;
    }
  }
  return null;
}

/** The scope for editing `nodeId` of `workflow`. */
export function completionScopeFor(
  workflow: Pick<Workflow, "nodes" | "edges">,
  nodeId: string,
  options: { secretNames?: readonly string[]; promptVariables?: boolean } = {}
): CompletionScope {
  const upstreamIds = upstreamOf(workflow, nodeId);
  const upstream = workflow.nodes
    .filter((node) => upstreamIds.has(node.id))
    .map((node) => ({ name: node.name, type: node.type }));
  const parents = workflow.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => workflow.nodes.find((node) => node.id === edge.source))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);
  const distinct = [...new Map(parents.map((node) => [node.id, node])).values()];
  const inputFields = distinct.length === 1 ? [...fieldsOf(distinct[0]!.type)] : distinct.map((node) => node.name);
  return {
    upstream,
    triggerTypes: workflow.nodes.filter((node) => isTriggerType(node.type)).map((node) => node.type),
    inputFields,
    secretNames: options.secretNames ?? [],
    promptVariables: options.promptVariables ?? false
  };
}
