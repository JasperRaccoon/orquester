/**
 * How the editor draws the block catalogue (workflows spec §7.2): each type's
 * icon, accent and palette group, the rule operators in words, and the one-line
 * summary a block card shows under its name ("Claude Opus · High → Codex
 * fallback", "Every 15 min", "POST api.atlassian.com/…", "2 rules · all").
 *
 * Accents are CSS classes (`wf-accent-<category>`, styles/workflows.css) that
 * set `--wf-accent` per colour mode, so every scheme × light/dark reads native
 * and a component only ever paints `rgb(var(--wf-accent) / …)`.
 */

import {
  Bot,
  Braces,
  CalendarClock,
  Globe,
  GitBranch,
  GitMerge,
  Hourglass,
  MousePointerClick,
  OctagonX,
  Route,
  Split,
  SquareTerminal,
  StickyNote,
  Workflow as WorkflowIcon,
  type LucideIcon
} from "lucide-react";

import {
  describeSchedule,
  triggerSummaryText,
  WORKFLOW_BLOCK_CATALOG,
  UNSET_SUBWORKFLOW_ID,
  type RuleOperator,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRule
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Categories, accents, icons
// ---------------------------------------------------------------------------

/** The editor's accent families — `code` covers code and shell, `http` the integrations. */
export type BlockAccent = "trigger" | "agent" | "code" | "http" | "flow" | "note";

const ACCENT: Record<WorkflowNodeType, BlockAccent> = {
  "trigger.manual": "trigger",
  "trigger.schedule": "trigger",
  "trigger.git": "trigger",
  agent: "agent",
  code: "code",
  shell: "code",
  http: "http",
  if: "flow",
  switch: "flow",
  merge: "flow",
  stop: "flow",
  wait: "flow",
  workflow: "flow",
  note: "note"
};

export function blockAccent(type: WorkflowNodeType): BlockAccent {
  return ACCENT[type] ?? "flow";
}

/** The class that sets `--wf-accent` for a type (styles/workflows.css). */
export function accentClass(type: WorkflowNodeType): string {
  return `wf-accent-${blockAccent(type)}`;
}

export const BLOCK_ICONS: Record<WorkflowNodeType, LucideIcon> = {
  "trigger.manual": MousePointerClick,
  "trigger.schedule": CalendarClock,
  "trigger.git": GitBranch,
  agent: Bot,
  code: Braces,
  shell: SquareTerminal,
  http: Globe,
  if: Split,
  switch: Route,
  merge: GitMerge,
  stop: OctagonX,
  wait: Hourglass,
  workflow: WorkflowIcon,
  note: StickyNote
};

/**
 * The agent an agent block runs first (its chain's head), whose logo stands in
 * for the generic icon wherever a configured block is drawn; undefined for
 * other types and for an agent block with nothing chosen yet.
 */
export function blockAgent(node: WorkflowNode): string | undefined {
  if (node.type !== "agent") return undefined;
  return node.config.chain?.[0]?.agent || undefined;
}

export function blockTitle(type: WorkflowNodeType): string {
  return WORKFLOW_BLOCK_CATALOG[type]?.title ?? type;
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

export type PaletteGroupId = "triggers" | "agents" | "code" | "flow" | "integrations";

export interface PaletteGroup {
  id: PaletteGroupId;
  label: string;
  types: WorkflowNodeType[];
}

export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  { id: "triggers", label: "Triggers", types: ["trigger.manual", "trigger.schedule", "trigger.git"] },
  { id: "agents", label: "Agents", types: ["agent"] },
  { id: "code", label: "Code", types: ["code", "shell"] },
  { id: "flow", label: "Flow", types: ["if", "switch", "merge", "wait", "stop", "workflow", "note"] },
  { id: "integrations", label: "Integrations", types: ["http"] }
];

/** Words a search also matches, beyond the title and description. */
const KEYWORDS: Partial<Record<WorkflowNodeType, string>> = {
  "trigger.manual": "run now button start input",
  "trigger.schedule": "cron timer every daily weekly nightly",
  "trigger.git": "push tag release pull request pr branch webhook",
  agent: "claude codex grok opencode llm ai prompt",
  code: "javascript js script function node",
  shell: "bash sh command terminal script",
  http: "api request fetch rest webhook url post get",
  if: "condition branch true false filter",
  switch: "case route router branch",
  merge: "join combine wait all",
  stop: "end finish fail exit",
  wait: "delay sleep pause until",
  workflow: "subworkflow sub child call",
  note: "sticky comment annotation"
};

export interface PaletteMatchGroup extends PaletteGroup {
  /** Only the types the query matched, best first. */
  types: WorkflowNodeType[];
}

/**
 * The palette narrowed to `query` (case-insensitive, every word must match the
 * title, description or keywords). `allowTriggers: false` drops triggers — the
 * add menu of an output handle, which can only add something that takes input.
 */
export function filterPalette(query: string, options: { allowTriggers?: boolean; allowNotes?: boolean } = {}): PaletteMatchGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const allowTriggers = options.allowTriggers ?? true;
  const allowNotes = options.allowNotes ?? true;
  const out: PaletteMatchGroup[] = [];
  for (const group of PALETTE_GROUPS) {
    const scored: { type: WorkflowNodeType; score: number }[] = [];
    for (const type of group.types) {
      if (!allowTriggers && group.id === "triggers") continue;
      if (!allowNotes && type === "note") continue;
      const entry = WORKFLOW_BLOCK_CATALOG[type];
      const title = entry.title.toLowerCase();
      const haystack = `${title} ${entry.description.toLowerCase()} ${KEYWORDS[type] ?? ""} ${type}`;
      if (!words.every((word) => haystack.includes(word))) continue;
      const score = words.length === 0 ? 0 : words.every((word) => title.includes(word)) ? 0 : 1;
      scored.push({ type, score });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => a.score - b.score);
    out.push({ ...group, types: scored.map((entry) => entry.type) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule operators
// ---------------------------------------------------------------------------

export const RULE_OPERATOR_LABELS: Record<RuleOperator, string> = {
  equals: "equals",
  notEquals: "does not equal",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  matches: "matches regex",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  exists: "exists",
  isTrue: "is true",
  isFalse: "is false"
};

const RULE_OPERATOR_SYMBOLS: Partial<Record<RuleOperator, string>> = {
  equals: "=",
  notEquals: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤"
};

/** Operators with no right-hand value. */
export const UNARY_RULE_OPERATORS: ReadonlySet<RuleOperator> = new Set([
  "isEmpty",
  "isNotEmpty",
  "exists",
  "isTrue",
  "isFalse"
]);

export function isUnaryOperator(op: RuleOperator): boolean {
  return UNARY_RULE_OPERATORS.has(op);
}

/** `{{ input.items | length }}` → `input.items | length`; other text as written. */
export function compactExpression(text: string): string {
  const trimmed = text.trim();
  const single = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(trimmed);
  return single && !single[1]!.includes("{{") ? single[1]! : trimmed;
}

/** One rule in words: `input.items | length > 0`, `input.title contains "bug"`. */
export function ruleText(rule: WorkflowRule): string {
  const left = compactExpression(rule.left) || "…";
  if (isUnaryOperator(rule.op)) return `${left} ${RULE_OPERATOR_LABELS[rule.op]}`;
  const op = RULE_OPERATOR_SYMBOLS[rule.op] ?? RULE_OPERATOR_LABELS[rule.op];
  const rawRight = rule.right ?? "";
  const right = rawRight.includes("{{") ? compactExpression(rawRight) : /^-?\d+(\.\d+)?$/.test(rawRight) ? rawRight : `"${rawRight}"`;
  return `${left} ${op} ${right}`;
}

// ---------------------------------------------------------------------------
// Block summaries
// ---------------------------------------------------------------------------

export interface NodeSummaryContext {
  /** A registry agent's display name ("Claude"); a capitalised id when absent. */
  agentLabel?: (refId: string) => string | undefined;
  /** A model's short name ("Opus"). */
  modelLabel?: (refId: string, slug: string) => string | undefined;
  /** An option value's label ("High"). */
  optionLabel?: (refId: string, slug: string, optionId: string, value: string) => string | undefined;
  /** Another workflow's name, for Run workflow. */
  workflowName?: (id: string) => string | undefined;
  /** A project-repo git trigger says "· <projectName>". */
  projectName?: string;
}

const REASONING_IDS = ["effort", "reasoningEffort", "variant"];

const KNOWN_AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode"
};

const capitalise = (text: string): string => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1));

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function defaultAgentLabel(refId: string): string {
  return KNOWN_AGENT_LABELS[refId] ?? capitalise(refId);
}

/** "opus" → "Opus"; a versioned slug ("gpt-5.5", "claude-opus-4") stays as written. */
export function defaultModelLabel(slug: string): string {
  return /^[a-z]+$/.test(slug) ? capitalise(slug) : slug;
}

function agentSummary(node: Extract<WorkflowNode, { type: "agent" }>, ctx: NodeSummaryContext): string {
  const chain = node.config.chain;
  const first = chain[0];
  if (!first) return "No agent chosen";
  const agent = ctx.agentLabel?.(first.agent) ?? defaultAgentLabel(first.agent);
  const model = ctx.modelLabel?.(first.agent, first.model) ?? defaultModelLabel(first.model);
  const effortOption = first.options?.find((option) => REASONING_IDS.includes(option.id) && typeof option.value === "string");
  const effort = effortOption
    ? (ctx.optionLabel?.(first.agent, first.model, effortOption.id, effortOption.value as string) ??
      capitalise(effortOption.value as string))
    : null;
  let text = `${agent} ${model}${effort ? ` · ${effort}` : ""}`;
  if (chain.length === 2) {
    const second = chain[1]!;
    const secondAgent = ctx.agentLabel?.(second.agent) ?? defaultAgentLabel(second.agent);
    const label = second.agent === first.agent ? (ctx.modelLabel?.(second.agent, second.model) ?? defaultModelLabel(second.model)) : secondAgent;
    text += ` → ${label} fallback`;
  } else if (chain.length > 2) {
    text += ` → ${chain.length - 1} fallbacks`;
  }
  if (node.config.session.kind === "continue") text = `Continues ${node.config.session.fromNode} · ${text}`;
  return text;
}

function shortUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";
  if (!/^https?:\/\//i.test(trimmed)) return truncate(trimmed, 36);
  try {
    // Templates in the host or path parse as text; keep them readable.
    const parsed = new URL(trimmed.replace(/\{\{[\s\S]*?\}\}/g, "x"));
    const host = /\{\{/.test(trimmed.split("/")[2] ?? "") ? (trimmed.split("/")[2] ?? parsed.host) : parsed.host;
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return host;
    const path = `/${segments.join("/")}`;
    if (path.length <= 18) return `${host}${path}`;
    return `${host}/…/${truncate(segments[segments.length - 1]!, 16)}`;
  } catch {
    return truncate(trimmed.replace(/^https?:\/\//i, ""), 36);
  }
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** The one line under a block's name. */
export function nodeSummary(node: WorkflowNode, ctx: NodeSummaryContext = {}): string {
  switch (node.type) {
    case "trigger.manual":
      return node.config.inputExample?.trim() ? "Run now · with input" : "Run now";
    case "trigger.schedule":
      return describeSchedule(node.config.preset, node.config.cron);
    case "trigger.git":
      return triggerSummaryText(node, ctx.projectName ? { projectName: ctx.projectName } : {});
    case "agent":
      return agentSummary(node, ctx);
    case "code": {
      const lines = node.config.source.split("\n");
      const comment = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
      if (comment.startsWith("//")) return truncate(comment.replace(/^\/\/\s*/, ""), 48);
      const count = lines.filter((line) => line.trim().length > 0).length;
      return `JavaScript · ${count} ${count === 1 ? "line" : "lines"}`;
    }
    case "shell": {
      const line = node.config.script
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0 && !entry.startsWith("#"));
      return line ? `$ ${truncate(line, 44)}` : "Empty script";
    }
    case "http": {
      const url = shortUrl(node.config.url);
      return url ? `${node.config.method} ${url}` : `${node.config.method} · no URL yet`;
    }
    case "if": {
      const rules = node.config.rules;
      if (rules.length === 1) return truncate(ruleText(rules[0]!), 48);
      return `${rules.length} rules · ${node.config.combine}`;
    }
    case "switch": {
      const count = node.config.cases.length;
      return `${count} ${count === 1 ? "case" : "cases"}${node.config.fallback ? " + default" : ""}`;
    }
    case "merge":
      return node.config.mode === "first" ? "First branch to arrive" : "Waits for every branch";
    case "stop": {
      const as = node.config.as === "failure" ? "Ends the run as failed" : "Ends the run";
      return node.config.message?.trim() ? `${as} · ${truncate(node.config.message, 32)}` : as;
    }
    case "wait":
      return node.config.kind === "duration"
        ? `Wait ${formatMinutes(node.config.minutes)}`
        : `Until ${node.config.time}${node.config.timezone ? ` ${node.config.timezone}` : ""}`;
    case "workflow": {
      if (!node.config.workflowId || node.config.workflowId === UNSET_SUBWORKFLOW_ID) return "Pick a workflow";
      const name = ctx.workflowName?.(node.config.workflowId);
      return name ? `Runs “${truncate(name, 36)}”` : "Runs another workflow";
    }
    case "note":
      return truncate(node.config.text.split("\n")[0] ?? "", 48);
    default:
      return "";
  }
}
