// Automated workflows — validation (spec §7.2). One function for the daemon (on every write), the
// editor (continuously) and the MCP (`validate_workflow`). Errors block ENABLING, not saving — except
// schema errors, which the daemon cannot store. Warnings (a secret in a prompt, untrusted trigger text
// in a prompt) never block. Codes are stable: clients key help text and UI on them.
//
// The definition is parsed piecewise — the record, then each node, then each edge — so one broken
// block reports its own problem while every other block is still checked.

import {
  workflowEdgeSchema,
  workflowNodeSchema,
  workflowRecordSchema,
  type WorkflowEdge,
  type WorkflowNode
} from "@orquester/config";

import { UNSET_SUBWORKFLOW_ID } from "./block-types.ts";
import { parseTemplate, templateReferences, hasTemplate, type TemplateReference } from "./expressions.ts";
import { nodeTemplateFields } from "./fields.ts";
import { acceptsInput, findCycles, outputHandles, reachableFromTriggers, upstreamOf } from "./graph.ts";
import { presetToCron, scheduleIntervalProblem, validateCron, isValidTimeZone } from "./schedule.ts";
import {
  isTriggerType,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_NAME_PATTERN,
  WORKFLOW_SUMMARY_MAX_ERRORS,
  type Workflow,
  type WorkflowProblem,
  type WorkflowSummary
} from "./types.ts";

/**
 * The host's agent catalogue, for the agent blocks' chains: every chat agent the registry knows and
 * the model slugs its provider lists. The daemon builds it from its registry and provider snapshots,
 * the editor from the same two as its client holds them — both through `toWorkflowAgentCatalog`
 * (agent-catalog.ts), so they judge a chain alike. Given only once the registry could be read.
 */
export interface WorkflowAgentCatalog {
  agents: ReadonlyArray<{
    /** Registry refId (claude, codex, grok, opencode). */
    id: string;
    /** False when the agent is known but not usable on this host (not installed). */
    enabled?: boolean;
    /**
     * The model slugs the provider lists — null (or empty) when that catalogue is not loaded yet (a
     * provider still being probed): a model is then only warned about.
     */
    models: readonly string[] | null;
  }>;
}

export interface ValidateWorkflowOptions {
  /**
   * The host's agent catalogue: a chain entry naming an agent it does not know is an error
   * (`unknown_agent`); a model its loaded catalogue does not list an error (`unknown_model`), a
   * warning while that catalogue is empty or unknown. Without it nothing is checked.
   */
  catalog?: WorkflowAgentCatalog;
  /** Secret names visible to this workflow (global + its own); unknown `secrets.X` warns only when given. */
  secretNames?: readonly string[];
  /** Saved prompt ids; an unknown one warns only when given. */
  savedPromptIds?: readonly string[];
  /** Workflow ids; an unknown sub-workflow warns only when given. */
  knownWorkflowIds?: readonly string[];
  /**
   * A save (or the editor's check of one): an "every N" schedule preset whose N does not divide the
   * hour (day) is an ERROR. Without it — a stored definition being run or summarised — only a
   * warning, so a workflow saved before the rule keeps running.
   */
  strictScheduleIntervals?: boolean;
}

export interface ValidateWorkflowResult {
  /** The parsed definition (defaults applied) when it passes the schema, else null. */
  workflow: Workflow | null;
  problems: WorkflowProblem[];
}

/** True when any problem is an error (enabling is refused). */
export function hasWorkflowErrors(problems: readonly WorkflowProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}

/**
 * A `WorkflowSummary`'s error fields from a validation: the count, the first errors (each copied
 * field-wise), and how many of them are left out. `errors` / `errorsOmitted` are absent when empty.
 * One derivation for the daemon's rows and a client's own row from a write answer.
 */
export function workflowSummaryErrors(
  problems: readonly WorkflowProblem[]
): Pick<WorkflowSummary, "errorCount" | "errors" | "errorsOmitted"> {
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length === 0) return { errorCount: 0 };
  const shown = errors.slice(0, WORKFLOW_SUMMARY_MAX_ERRORS).map((problem) => {
    const copy: WorkflowProblem = { severity: "error", code: problem.code, message: problem.message };
    if (problem.nodeId !== undefined) copy.nodeId = problem.nodeId;
    if (problem.edgeId !== undefined) copy.edgeId = problem.edgeId;
    if (problem.field !== undefined) copy.field = problem.field;
    return copy;
  });
  const omitted = errors.length - shown.length;
  return { errorCount: errors.length, errors: shown, ...(omitted > 0 ? { errorsOmitted: omitted } : {}) };
}

/** UTF-8 byte length without allocating. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}

function issueText(issue: ZodIssueLike): string {
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** Untrusted parts of a git event (attacker-controlled text, §6.2). */
const UNTRUSTED_TRIGGER_PATHS: readonly (readonly string[])[] = [
  ["pr", "title"],
  ["pr", "body"],
  ["release", "body"]
];

function overlapsUntrusted(path: readonly (string | number)[]): boolean {
  return UNTRUSTED_TRIGGER_PATHS.some((untrusted) => {
    const shorter = Math.min(untrusted.length, path.length);
    for (let i = 0; i < shorter; i += 1) if (untrusted[i] !== path[i]) return false;
    return true;
  });
}

function sizeOf(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : utf8ByteLength(text);
  } catch {
    return null;
  }
}

/** Validate a definition. Never throws. */
export function validateWorkflow(input: unknown, opts: ValidateWorkflowOptions = {}): ValidateWorkflowResult {
  const problems: WorkflowProblem[] = [];
  const push = (problem: WorkflowProblem): void => {
    problems.push(problem);
  };
  if (!isRecord(input)) {
    push({ severity: "error", code: "schema", message: "A workflow must be an object" });
    return { workflow: null, problems };
  }

  // -- Size -----------------------------------------------------------------------------------
  const bytes = sizeOf(input);
  if (bytes === null) {
    push({ severity: "error", code: "not_json", message: "The workflow cannot be written as JSON" });
    return { workflow: null, problems };
  }
  if (bytes > WORKFLOW_LIMITS.maxDefinitionBytes) {
    push({
      severity: "error",
      code: "definition_too_large",
      message: `The definition is ${Math.ceil(bytes / 1024)} KiB; the limit is ${WORKFLOW_LIMITS.maxDefinitionBytes / 1024} KiB`
    });
  }
  // Past a hard limit nothing else is checked: the per-block and graph checks are superlinear, and
  // a request that is refused anyway must not hold the event loop (5 000 blocks took ~20 s).
  const nodeCount = Array.isArray(input.nodes) ? input.nodes.length : 0;
  const edgeCount = Array.isArray(input.edges) ? input.edges.length : 0;
  if (nodeCount > WORKFLOW_LIMITS.maxNodes) {
    push({ severity: "error", code: "too_many_nodes", message: `At most ${WORKFLOW_LIMITS.maxNodes} blocks per workflow` });
  }
  if (edgeCount > WORKFLOW_LIMITS.maxEdges) {
    push({ severity: "error", code: "too_many_edges", message: `At most ${WORKFLOW_LIMITS.maxEdges} connections per workflow` });
  }
  if (problems.length > 0) return { workflow: null, problems };

  // -- The record, without its nodes and edges ---------------------------------------------------
  const top = workflowRecordSchema.safeParse({ ...input, nodes: [], edges: [] });
  if (!top.success) {
    for (const issue of top.error.issues) {
      push({ severity: "error", code: "schema", message: issueText(issue), field: issue.path.join(".") });
    }
  }
  if (typeof input.name === "string" && input.name.length > WORKFLOW_LIMITS.maxNameLength) {
    push({
      severity: "error",
      code: "name_too_long",
      message: `The name is longer than ${WORKFLOW_LIMITS.maxNameLength} characters`,
      field: "name"
    });
  }
  const workflowId = typeof input.id === "string" ? input.id : undefined;
  const settings = isRecord(input.settings) ? input.settings : {};
  const timezone = typeof settings.timezone === "string" ? settings.timezone : "UTC";
  if (!isValidTimeZone(timezone)) {
    push({ severity: "error", code: "invalid_timezone", message: `Unknown time zone "${timezone}"`, field: "settings.timezone" });
  }

  // -- Nodes ---------------------------------------------------------------------------------------
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (input.nodes !== undefined && !Array.isArray(input.nodes)) {
    push({ severity: "error", code: "schema", message: "nodes must be a list", field: "nodes" });
  }
  const nodes: WorkflowNode[] = [];
  const allIds = new Set<string>();
  const seenIds = new Set<string>();
  const seenNames = new Map<string, string>();
  rawNodes.forEach((raw, index) => {
    const rawId = isRecord(raw) && typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    const rawName = isRecord(raw) && typeof raw.name === "string" ? raw.name : undefined;
    if (rawId !== undefined) {
      if (seenIds.has(rawId)) {
        push({ severity: "error", code: "duplicate_node_id", message: `Two blocks share the id "${rawId}"`, nodeId: rawId });
      }
      seenIds.add(rawId);
      allIds.add(rawId);
    }
    if (rawName !== undefined && rawName.length > 0) {
      if (seenNames.has(rawName)) {
        push({
          severity: "error",
          code: "duplicate_node_name",
          message: `Two blocks are named "${rawName}" — names must be unique`,
          nodeId: rawId,
          field: "name"
        });
      } else seenNames.set(rawName, rawId ?? "");
      if (!WORKFLOW_NODE_NAME_PATTERN.test(rawName)) {
        push({
          severity: "error",
          code: "invalid_node_name",
          message: `"${rawName.slice(0, 60)}" is not a valid block name: a letter, then letters, digits or _ (at most 40)`,
          nodeId: rawId,
          field: "name"
        });
      }
    }
    const parsed = workflowNodeSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        push({
          severity: "error",
          code: "schema",
          message: `Block ${rawName ?? rawId ?? `#${index + 1}`}: ${issueText(issue)}`,
          nodeId: rawId,
          field: issue.path.join(".")
        });
      }
      return;
    }
    nodes.push(parsed.data);
  });

  // -- Edges ---------------------------------------------------------------------------------------
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (input.edges !== undefined && !Array.isArray(input.edges)) {
    push({ severity: "error", code: "schema", message: "edges must be a list", field: "edges" });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const label = (id: string): string => byId.get(id)?.name ?? id;
  const edges: WorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  rawEdges.forEach((raw, index) => {
    const parsed = workflowEdgeSchema.safeParse(raw);
    const rawId = isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        push({
          severity: "error",
          code: "schema",
          message: `Connection ${rawId ?? `#${index + 1}`}: ${issueText(issue)}`,
          edgeId: rawId,
          field: issue.path.join(".")
        });
      }
      return;
    }
    const edge = parsed.data;
    if (edgeIds.has(edge.id)) {
      push({ severity: "error", code: "duplicate_edge_id", message: `Two connections share the id "${edge.id}"`, edgeId: edge.id });
      return;
    }
    edgeIds.add(edge.id);
    let valid = true;
    if (!allIds.has(edge.source)) {
      push({ severity: "error", code: "edge_unknown_source", message: `A connection starts at a missing block (${edge.source})`, edgeId: edge.id });
      valid = false;
    }
    if (!allIds.has(edge.target)) {
      push({ severity: "error", code: "edge_unknown_target", message: `A connection ends at a missing block (${edge.target})`, edgeId: edge.id });
      valid = false;
    }
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && !outputHandles(source).includes(edge.sourceHandle)) {
      const handles = outputHandles(source);
      push({
        severity: "error",
        code: "edge_invalid_handle",
        message:
          handles.length === 0
            ? `${source.name} has no outputs`
            : `${source.name} has no "${edge.sourceHandle}" output (it has ${handles.join(", ")})`,
        edgeId: edge.id,
        nodeId: source.id
      });
      valid = false;
    }
    if (target && !acceptsInput(target)) {
      push({
        severity: "error",
        code: "edge_target_no_input",
        message: `${target.name} takes no input (${isTriggerType(target.type) ? "a trigger starts the run" : "a note never runs"})`,
        edgeId: edge.id,
        nodeId: target.id
      });
      valid = false;
    }
    if (edge.source === edge.target) {
      push({ severity: "error", code: "edge_self_loop", message: `${label(edge.source)} is connected to itself`, edgeId: edge.id, nodeId: edge.source });
      valid = false;
    }
    const key = `${edge.source}\u0000${edge.sourceHandle}\u0000${edge.target}`;
    if (edgeKeys.has(key)) {
      push({
        severity: "error",
        code: "duplicate_edge",
        message: `${label(edge.source)} → ${label(edge.target)} (${edge.sourceHandle}) is connected twice`,
        edgeId: edge.id
      });
      valid = false;
    }
    edgeKeys.add(key);
    if (valid && source && target) edges.push(edge);
  });

  const graph = { nodes, edges };

  // -- Cycles --------------------------------------------------------------------------------------
  for (const cycle of findCycles(graph)) {
    push({
      severity: "error",
      code: "cycle",
      message: `These blocks form a loop: ${[...cycle, cycle[0]!].map(label).join(" → ")} — use a sub-workflow or an agent that loops itself`,
      nodeId: cycle[0]
    });
  }

  // -- Per block -----------------------------------------------------------------------------------
  const nameToNode = new Map(nodes.map((node) => [node.name, node]));
  const upstreamCache = new Map<string, Set<string>>();
  const upstream = (id: string): Set<string> => {
    let set = upstreamCache.get(id);
    if (set === undefined) {
      set = upstreamOf(graph, id);
      upstreamCache.set(id, set);
    }
    return set;
  };
  const secretNames = opts.secretNames ? new Set(opts.secretNames) : null;
  const hasUntrustedGitTrigger = (node: WorkflowNode): boolean =>
    node.type === "trigger.git" && (node.config.event.kind === "pull_request" || node.config.event.kind === "release");
  const triggers = nodes.filter((node) => isTriggerType(node.type));
  const reachable = reachableFromTriggers(graph);
  const timeoutMax = (minutes: number | undefined, max: number, node: WorkflowNode, field: string, what: string): void => {
    if (minutes !== undefined && minutes > max) {
      push({
        severity: "error",
        code: "timeout_too_long",
        message: `${node.name}: ${what} is at most ${max >= 60 && max % 60 === 0 ? `${max / 60} h` : `${max} min`}`,
        nodeId: node.id,
        field
      });
    }
  };

  /** A reference's path within a git event, when it reads one; null when it reads something else. */
  const triggerPathOf = (node: WorkflowNode, ref: TemplateReference): (string | number)[] | null => {
    if (ref.root === "trigger") return ref.path;
    if (ref.root === "input") {
      const direct = edges.filter((edge) => edge.target === node.id).map((edge) => byId.get(edge.source));
      return direct.some((source) => source !== undefined && hasUntrustedGitTrigger(source)) ? ref.path : null;
    }
    if (ref.root === "nodes") {
      const referenced = typeof ref.path[0] === "string" ? nameToNode.get(ref.path[0]) : undefined;
      if (referenced && hasUntrustedGitTrigger(referenced) && (ref.path.length < 2 || ref.path[1] === "output")) {
        return ref.path.slice(2);
      }
    }
    return null;
  };

  for (const node of nodes) {
    // Templates: syntax, references, secrets, untrusted text.
    for (const field of nodeTemplateFields(node)) {
      if (!field.value.includes("{{")) continue;
      for (const error of parseTemplate(field.value).errors) {
        push({ severity: "error", code: "template_syntax", message: `${node.name}: ${error.message}`, nodeId: node.id, field: field.field });
      }
      let secretWarned = false;
      const titleSecrets = new Set<string>();
      let untrustedWarned = false;
      for (const ref of templateReferences(field.value)) {
        if (ref.root === "nodes") {
          const name = ref.path[0];
          if (typeof name !== "string") {
            push({
              severity: "error",
              code: "unknown_reference",
              message: `${node.name}: {{ ${ref.source} }} must name a block, e.g. nodes.Fetch.output`,
              nodeId: node.id,
              field: field.field
            });
            continue;
          }
          const referenced = nameToNode.get(name);
          if (referenced === undefined) {
            push({
              severity: "error",
              code: "unknown_reference",
              message: `${node.name}: there is no block named "${name}" ({{ ${ref.source} }})`,
              nodeId: node.id,
              field: field.field
            });
          } else if (!upstream(node.id).has(referenced.id)) {
            push({
              severity: "warning",
              code: "reference_not_upstream",
              message: `${node.name}: "${name}" does not run before this block, so {{ ${ref.source} }} may be empty`,
              nodeId: node.id,
              field: field.field
            });
          }
        } else if (ref.root === "secrets") {
          const name = ref.path[0];
          if (ref.path.length !== 1 || typeof name !== "string") {
            push({
              severity: "error",
              code: "secret_reference",
              message: `${node.name}: {{ ${ref.source} }} must name exactly one secret, e.g. secrets.API_TOKEN`,
              nodeId: node.id,
              field: field.field
            });
            continue;
          }
          if (secretNames !== null && !secretNames.has(name)) {
            push({
              severity: "warning",
              code: "unknown_secret",
              message: `${node.name}: there is no secret named ${name}`,
              nodeId: node.id,
              field: field.field
            });
          }
          if (field.role === "prompt" && !secretWarned) {
            secretWarned = true;
            push({
              severity: "warning",
              code: "secret_in_prompt",
              message: `${node.name}: this secret will be written to the agent's transcript`,
              nodeId: node.id,
              field: field.field
            });
          } else if (field.role === "title" && !titleSecrets.has(name)) {
            // Nothing leaks — the daemon renders the placeholder — but the title will not show the value.
            titleSecrets.add(name);
            push({
              severity: "info",
              code: "secret_in_title",
              message: `${node.name}: the chat title shows this secret as «secret:${name}», never its value`,
              nodeId: node.id,
              field: field.field
            });
          }
        }
        if (field.role === "prompt" && !untrustedWarned) {
          const path = triggerPathOf(node, ref);
          // A bare `trigger` covers everything: it matters when a PR / release trigger can start this block.
          const covers =
            path !== null &&
            (path.length > 0
              ? overlapsUntrusted(path)
              : [...upstream(node.id)].some((id) => {
                  const source = byId.get(id);
                  return source !== undefined && hasUntrustedGitTrigger(source);
                }));
          if (covers) {
            untrustedWarned = true;
            push({
              severity: "warning",
              code: "untrusted_prompt_input",
              message: `${node.name}: pull-request and release text is written by others — a prompt that includes it can be steered by them (prompt injection)`,
              nodeId: node.id,
              field: field.field
            });
          }
        }
      }
    }

    timeoutMax(node.timeoutMinutes, maxTimeoutMinutesFor(node), node, "timeoutMinutes", "the timeout");

    switch (node.type) {
      case "trigger.schedule": {
        const reason = validateCron(node.config.cron, timezone);
        if (reason !== null) {
          push({ severity: "error", code: "invalid_cron", message: `${node.name}: ${reason}`, nodeId: node.id, field: "config.cron" });
        }
        const uneven = scheduleIntervalProblem(node.config.preset);
        if (uneven !== null) {
          push({
            severity: opts.strictScheduleIntervals === true ? "error" : "warning",
            code: "schedule_uneven_interval",
            message: `${node.name}: ${uneven}`,
            nodeId: node.id,
            field: "config.preset"
          });
        }
        const derived = presetToCron(node.config.preset);
        if (derived !== null && derived !== node.config.cron.trim().split(/\s+/).join(" ")) {
          push({
            severity: "warning",
            code: "schedule_preset_mismatch",
            message: `${node.name}: the cron (${node.config.cron}) no longer matches the chosen preset; the cron is used`,
            nodeId: node.id,
            field: "config.cron"
          });
        }
        break;
      }
      case "trigger.git": {
        if (node.config.event.kind === "release" && node.config.repo.kind === "url" && !/github\.com[/:]/i.test(node.config.repo.url)) {
          push({
            severity: "warning",
            code: "release_github_only",
            message: `${node.name}: releases are read from GitHub only — use a tag event for other hosts`,
            nodeId: node.id,
            field: "config.event"
          });
        }
        break;
      }
      case "agent": {
        const config = node.config;
        if (config.chain.length > WORKFLOW_LIMITS.maxAgentChain) {
          push({
            severity: "error",
            code: "chain_too_long",
            message: `${node.name}: at most ${WORKFLOW_LIMITS.maxAgentChain} agents in a fallback chain`,
            nodeId: node.id,
            field: "config.chain"
          });
        }
        if (opts.catalog) {
          const known = new Map(opts.catalog.agents.map((agent) => [agent.id, agent]));
          config.chain.forEach((entry, index) => {
            const where = `config.chain.${index}`;
            const agent = known.get(entry.agent);
            if (agent === undefined) {
              const valid = opts.catalog!.agents.map((a) => a.id);
              push({
                severity: "error",
                code: "unknown_agent",
                message: `${node.name}: "${entry.agent.slice(0, 60)}" is not a chat agent on this host${valid.length ? ` (known: ${valid.slice(0, 20).join(", ")})` : ""}`,
                nodeId: node.id,
                field: `${where}.agent`
              });
              return;
            }
            if (agent.enabled === false) {
              push({
                severity: "warning",
                code: "unknown_agent",
                message: `${node.name}: ${entry.agent} is not available on this host right now — the chain passes over it`,
                nodeId: node.id,
                field: `${where}.agent`
              });
            }
            const models = agent.models ?? [];
            if (models.includes(entry.model)) return;
            if (models.length === 0) {
              push({
                severity: "warning",
                code: "unknown_model",
                message: `${node.name}: ${entry.agent}'s models are not known yet — "${entry.model.slice(0, 80)}" could not be checked`,
                nodeId: node.id,
                field: `${where}.model`
              });
              return;
            }
            push({
              severity: "error",
              code: "unknown_model",
              message: `${node.name}: ${entry.agent} has no model "${entry.model.slice(0, 80)}" (it has ${models.slice(0, 20).join(", ")}${models.length > 20 ? ", …" : ""})`,
              nodeId: node.id,
              field: `${where}.model`
            });
          });
        }
        if (config.prompt.kind === "text" && config.prompt.text.trim().length === 0) {
          push({ severity: "error", code: "empty_prompt", message: `${node.name}: the prompt is empty`, nodeId: node.id, field: "config.prompt.text" });
        }
        if (config.prompt.kind === "saved" && opts.savedPromptIds && !opts.savedPromptIds.includes(config.prompt.promptId)) {
          push({
            severity: "warning",
            code: "unknown_saved_prompt",
            message: `${node.name}: the saved prompt it uses no longer exists`,
            nodeId: node.id,
            field: "config.prompt.promptId"
          });
        }
        if (config.session.kind === "continue") {
          const from = nameToNode.get(config.session.fromNode);
          const reason =
            from === undefined
              ? `there is no block named "${config.session.fromNode}"`
              : from.type !== "agent"
                ? `"${from.name}" is not an agent block`
                : !upstream(node.id).has(from.id)
                  ? `"${from.name}" does not run before this block`
                  : null;
          if (reason !== null) {
            push({
              severity: "error",
              code: "continue_invalid",
              message: `${node.name}: cannot continue a session — ${reason}`,
              nodeId: node.id,
              field: "config.session.fromNode"
            });
          }
        }
        timeoutMax(config.maxMinutes, WORKFLOW_LIMITS.agentMaxMinutes.max, node, "config.maxMinutes", "the working time");
        break;
      }
      case "code": {
        const config = node.config;
        if (utf8ByteLength(config.source) > WORKFLOW_LIMITS.maxCodeSourceBytes) {
          push({
            severity: "error",
            code: "code_too_large",
            message: `${node.name}: the code is larger than ${WORKFLOW_LIMITS.maxCodeSourceBytes / 1024} KiB`,
            nodeId: node.id,
            field: "config.source"
          });
        }
        if (!/\bexport\s+default\b/.test(config.source)) {
          push({
            severity: "warning",
            code: "code_no_default_export",
            message: `${node.name}: the code has no \`export default\` function to run`,
            nodeId: node.id,
            field: "config.source"
          });
        }
        const memory = WORKFLOW_LIMITS.codeMemoryMb;
        if (config.memoryMb !== undefined && (config.memoryMb < memory.min || config.memoryMb > memory.max)) {
          push({
            severity: "error",
            code: "memory_out_of_range",
            message: `${node.name}: memory is ${memory.min}–${memory.max} MB`,
            nodeId: node.id,
            field: "config.memoryMb"
          });
        }
        timeoutMax(config.timeoutMinutes, WORKFLOW_LIMITS.processTimeoutMinutes.max, node, "config.timeoutMinutes", "the timeout");
        break;
      }
      case "shell": {
        if (hasTemplate(node.config.script)) {
          push({
            severity: "error",
            code: "shell_template",
            message: `${node.name}: {{ … }} cannot be used inside a shell script. Add an env entry (e.g. VALUE = {{ input.x }}) and read "$VALUE" in the script`,
            nodeId: node.id,
            field: "config.script"
          });
        }
        timeoutMax(node.config.timeoutMinutes, WORKFLOW_LIMITS.processTimeoutMinutes.max, node, "config.timeoutMinutes", "the timeout");
        break;
      }
      case "http": {
        const url = node.config.url.trim();
        if (url.length === 0) {
          push({ severity: "error", code: "http_url_missing", message: `${node.name}: the URL is empty`, nodeId: node.id, field: "config.url" });
        } else if (!url.startsWith("{{") && !/^https?:\/\//i.test(url)) {
          push({
            severity: "error",
            code: "http_url_invalid",
            message: `${node.name}: the URL must start with http:// or https://`,
            nodeId: node.id,
            field: "config.url"
          });
        }
        const seconds = node.config.timeoutSeconds;
        if (seconds !== undefined && seconds > WORKFLOW_LIMITS.httpTimeoutSeconds.max) {
          push({
            severity: "error",
            code: "timeout_too_long",
            message: `${node.name}: the timeout is at most ${WORKFLOW_LIMITS.httpTimeoutSeconds.max / 60} min`,
            nodeId: node.id,
            field: "config.timeoutSeconds"
          });
        }
        break;
      }
      case "wait": {
        const config = node.config;
        if (config.kind === "duration" && config.minutes > WORKFLOW_LIMITS.waitMaxMinutes) {
          push({ severity: "error", code: "wait_too_long", message: `${node.name}: a wait is at most 7 days`, nodeId: node.id, field: "config.minutes" });
        }
        if (config.kind === "until" && config.timezone !== undefined && !isValidTimeZone(config.timezone)) {
          push({
            severity: "error",
            code: "invalid_timezone",
            message: `${node.name}: unknown time zone "${config.timezone}"`,
            nodeId: node.id,
            field: "config.timezone"
          });
        }
        break;
      }
      case "workflow": {
        const target = node.config.workflowId;
        if (target === UNSET_SUBWORKFLOW_ID) {
          push({ severity: "error", code: "subworkflow_unset", message: `${node.name}: pick the workflow to run`, nodeId: node.id, field: "config.workflowId" });
        } else if (workflowId !== undefined && target === workflowId) {
          push({ severity: "error", code: "subworkflow_self", message: `${node.name}: a workflow cannot run itself`, nodeId: node.id, field: "config.workflowId" });
        } else if (opts.knownWorkflowIds && !opts.knownWorkflowIds.includes(target)) {
          push({
            severity: "warning",
            code: "unknown_workflow",
            message: `${node.name}: the workflow it runs no longer exists`,
            nodeId: node.id,
            field: "config.workflowId"
          });
        }
        break;
      }
      default:
        break;
    }

    if (triggers.length > 0 && !isTriggerType(node.type) && node.type !== "note" && !reachable.has(node.id)) {
      push({
        severity: "warning",
        code: "unreachable",
        message: `${node.name} is not connected to a trigger, so it never runs`,
        nodeId: node.id
      });
    }
  }

  // -- Pinned data ---------------------------------------------------------------------------------
  if (isRecord(input.pinned)) {
    for (const [nodeId, value] of Object.entries(input.pinned)) {
      if (!allIds.has(nodeId)) {
        push({ severity: "warning", code: "pinned_unknown_node", message: `Pinned data for a missing block (${nodeId})`, field: `pinned.${nodeId}` });
        continue;
      }
      const size = sizeOf(value);
      if (size === null || size > WORKFLOW_LIMITS.maxPinnedBytes) {
        push({
          severity: "error",
          code: "pinned_too_large",
          message: `${label(nodeId)}: pinned data is limited to ${WORKFLOW_LIMITS.maxPinnedBytes / 1024} KiB of JSON`,
          nodeId,
          field: `pinned.${nodeId}`
        });
      }
    }
  }

  if (triggers.length === 0) {
    push({ severity: "info", code: "no_trigger", message: "No trigger: this workflow only runs with Run now" });
  }

  const full = workflowRecordSchema.safeParse(input);
  return { workflow: full.success ? full.data : null, problems };
}

/** A block's own `timeoutMinutes` cap (§5.9). */
function maxTimeoutMinutesFor(node: WorkflowNode): number {
  switch (node.type) {
    case "agent":
      return WORKFLOW_LIMITS.agentMaxMinutes.max;
    case "http":
      return WORKFLOW_LIMITS.httpTimeoutSeconds.max / 60;
    case "wait":
      return WORKFLOW_LIMITS.waitMaxMinutes;
    default:
      return WORKFLOW_LIMITS.processTimeoutMinutes.max;
  }
}
