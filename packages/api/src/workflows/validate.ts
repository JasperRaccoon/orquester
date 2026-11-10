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
import {
  acceptsInput,
  agentOutcomeIds,
  findCycles,
  gateChoiceIds,
  isLoopEdge,
  loopResetSet,
  outputHandles,
  reachableFromTriggers,
  upstreamOf,
  withoutLoopEdges
} from "./graph.ts";
import { createUndeclaredInputCheck, inputDeclarationProblems } from "./inputs.ts";
import { passThroughHandle, pinnedOutcomeProblem } from "./outcomes.ts";
import { presetToCron, scheduleIntervalProblem, validateCron, isValidTimeZone } from "./schedule.ts";
import {
  isTriggerType,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_NAME_PATTERN,
  type Workflow,
  type WorkflowProblem
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
  /**
   * Agent Profile ids (spec 2026-10-18 §5.5); an agent block naming one not among them warns
   * (`unknown_profile`: its runs would fail) — only when given.
   */
  sessionProfileIds?: readonly string[];
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

/**
 * The edges a depth-first walk (from the triggers, then every other block, in definition order) finds
 * pointing back to a block still on its path: in a cycle, the connection that goes "back".
 */
function forwardBackEdges(graph: { nodes: readonly WorkflowNode[]; edges: readonly WorkflowEdge[] }): WorkflowEdge[] {
  const outs = new Map<string, WorkflowEdge[]>(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges) if (outs.has(edge.source) && outs.has(edge.target)) outs.get(edge.source)!.push(edge);
  const state = new Map<string, "open" | "done">();
  const back: WorkflowEdge[] = [];
  const roots = [...graph.nodes.filter((node) => isTriggerType(node.type)), ...graph.nodes.filter((node) => !isTriggerType(node.type))];
  for (const root of roots) {
    if (state.has(root.id)) continue;
    // Iterative: no recursion depth limit on hostile input.
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const list = outs.get(frame.id)!;
      if (frame.next >= list.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const edge = list[frame.next]!;
      frame.next += 1;
      const seen = state.get(edge.target);
      if (seen === "open") back.push(edge);
      else if (seen === undefined) {
        state.set(edge.target, "open");
        stack.push({ id: edge.target, next: 0 });
      }
    }
  }
  return back;
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
    const rawLoop = isRecord(raw) ? raw.loop : undefined;
    if (isRecord(rawLoop)) {
      const { min, max } = WORKFLOW_LIMITS.loops;
      const limit = rawLoop.maxLoops;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < min || limit > max) {
        push({
          severity: "error",
          code: "loop_limit_range",
          message: `Connection ${rawId ?? `#${index + 1}`}: a loop edge's maxLoops is a whole number from ${min} to ${max}`,
          edgeId: rawId,
          field: "loop.maxLoops"
        });
        return;
      }
    }
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
            : edge.sourceHandle === "success" && agentOutcomeIds(source).length > 0
              ? `${source.name} declares outcomes, so it has no "success" output: connect from one of ${handles.join(", ")}`
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
        message:
          isLoopEdge(edge) && isTriggerType(target.type)
            ? `A loop edge cannot go back to a trigger (${target.name}): point it at the first block after it`
            : `${target.name} takes no input (${isTriggerType(target.type) ? "a trigger starts the run" : "a note never runs"})`,
        edgeId: edge.id,
        nodeId: target.id
      });
      valid = false;
    }
    if (isLoopEdge(edge) && edge.sourceHandle === "error") {
      push({
        severity: "error",
        code: "loop_from_error",
        message: `${label(edge.source)} → ${label(edge.target)}: a loop edge cannot leave the error output — loop from an outcome, a choice or an If/Switch branch, and let retry handle failures`,
        edgeId: edge.id,
        nodeId: edge.source
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
  // The forward graph: what every order, readiness and reachability helper reads (§7.1).
  const forward = withoutLoopEdges(graph);

  // -- Cycles (of the forward graph) and loop edges ------------------------------------------------
  const backEdges = forwardBackEdges(forward);
  for (const cycle of findCycles(forward)) {
    const members = new Set(cycle);
    const back = backEdges.find((edge) => members.has(edge.source) && members.has(edge.target));
    const path = [...cycle, cycle[0]!].map(label).join(" → ");
    push(
      back
        ? {
            severity: "error",
            code: "cycle",
            message: `${label(back.source)} → ${label(back.target)} goes back to an earlier block (${path}): make it a loop edge with a limit (\`loop: { maxLoops: 1–${WORKFLOW_LIMITS.loops.max} }\`), or remove it`,
            nodeId: back.target,
            edgeId: back.id
          }
        : {
            severity: "error",
            code: "cycle",
            message: `These blocks form a loop: ${path} — connections run one way; to repeat steps, make the connection back to the earlier block a loop edge with a limit`,
            nodeId: cycle[0]
          }
    );
  }
  const handleEdgeCount = new Map<string, number>();
  for (const edge of edges) {
    const key = `${edge.source}\u0000${edge.sourceHandle}`;
    handleEdgeCount.set(key, (handleEdgeCount.get(key) ?? 0) + 1);
  }
  const loops = edges.filter(isLoopEdge);
  for (const loop of loops) {
    if (!upstreamOf(forward, loop.source).has(loop.target)) {
      push({
        severity: "error",
        code: "loop_not_ancestor",
        message: `${label(loop.source)} → ${label(loop.target)}: a loop edge goes back to a block that runs before its source, and ${label(loop.target)} does not`,
        edgeId: loop.id,
        nodeId: loop.source
      });
    }
    if ((handleEdgeCount.get(`${loop.source}\u0000${loop.sourceHandle}`) ?? 0) > 1) {
      push({
        severity: "error",
        code: "loop_handle_shared",
        message: `${label(loop.source)}: its "${loop.sourceHandle}" output has a loop edge, so it can carry no other connection (a block there would be reset at once)`,
        edgeId: loop.id,
        nodeId: loop.source
      });
    }
    // A disabled block passes through on its first outcome / choice (§7.5): were that a loop's
    // handle, the loop would only repeat itself — the engine never takes it.
    const source = byId.get(loop.source);
    if (source?.disabled === true && passThroughHandle(source) === loop.sourceHandle) {
      push({
        severity: "warning",
        code: "loop_from_disabled",
        message: `${source.name} is disabled and passes through on "${loop.sourceHandle}", which has a loop edge: the loop is not taken, so this path ends there`,
        edgeId: loop.id,
        nodeId: loop.source
      });
    }
  }
  /** Whether `reader` and `read` run again together in some loop: `read`'s previous pass is then readable. */
  const resetSets = loops.map((loop) => loopResetSet(forward, loop));
  const loopsBack = (reader: string, read: string): boolean => resetSets.some((set) => set.has(reader) && set.has(read));

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
  const undeclaredInput = createUndeclaredInputCheck(graph);
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

  /** An agent chain (an agent block's, a gate's reviewer agent's): its length and the host's catalogue. */
  const checkChain = (node: WorkflowNode, chain: readonly { agent: string; model: string }[], base: string): void => {
    if (chain.length > WORKFLOW_LIMITS.maxAgentChain) {
      push({
        severity: "error",
        code: "chain_too_long",
        message: `${node.name}: at most ${WORKFLOW_LIMITS.maxAgentChain} agents in a fallback chain`,
        nodeId: node.id,
        field: base
      });
    }
    if (!opts.catalog) return;
    const known = new Map(opts.catalog.agents.map((agent) => [agent.id, agent]));
    chain.forEach((entry, index) => {
      const where = `${base}.${index}`;
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
  };
  /** An agent prompt: not empty; a saved prompt that still exists. */
  const checkPrompt = (node: WorkflowNode, prompt: { kind: "text"; text: string } | { kind: "saved"; promptId: string }, base: string): void => {
    if (prompt.kind === "text" && prompt.text.trim().length === 0) {
      push({ severity: "error", code: "empty_prompt", message: `${node.name}: the prompt is empty`, nodeId: node.id, field: `${base}.text` });
    }
    if (prompt.kind === "saved" && opts.savedPromptIds && !opts.savedPromptIds.includes(prompt.promptId)) {
      push({
        severity: "warning",
        code: "unknown_saved_prompt",
        message: `${node.name}: the saved prompt it uses no longer exists`,
        nodeId: node.id,
        field: `${base}.promptId`
      });
    }
  };
  /** An Agent Profile id that still exists. */
  const checkProfile = (node: WorkflowNode, profileId: string | undefined, field: string): void => {
    if (profileId !== undefined && opts.sessionProfileIds && !opts.sessionProfileIds.includes(profileId)) {
      push({
        severity: "warning",
        code: "unknown_profile",
        message: `${node.name}: the Agent Profile it launches with no longer exists — its runs fail until another is picked`,
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
        const undeclared = undeclaredInput(node, ref);
        if (undeclared !== null) {
          push({
            severity: "warning",
            code: "undeclared_input",
            message: `${node.name}: {{ ${ref.source} }} reads the input "${undeclared.name.slice(0, 60)}", which the manual trigger does not declare (it declares ${undeclared.declared.join(", ")}) — declare it, or the value is always empty`,
            nodeId: node.id,
            field: field.field
          });
        }
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
              message: loopsBack(node.id, referenced.id)
                ? `${node.name}: "${name}" runs after this block, so {{ ${ref.source} }} reads its previous loop pass and is empty on the first pass`
                : `${node.name}: "${name}" does not run before this block, so {{ ${ref.source} }} may be empty`,
              nodeId: node.id,
              field: field.field
            });
          }
        } else if (ref.root === "loop") {
          const key = ref.path[0];
          if (key !== undefined && key !== "pass" && key !== "feedback") {
            push({
              severity: "error",
              code: "unknown_reference",
              message: `${node.name}: {{ ${ref.source} }} reads nothing — loop has \`pass\` and \`feedback\``,
              nodeId: node.id,
              field: field.field
            });
          } else if (!resetSets.some((set) => set.has(node.id))) {
            push({
              severity: "warning",
              code: "loop_outside_loop",
              message: `${node.name}: no loop edge runs this block again, so {{ ${ref.source} }} is always ${key === "pass" ? "1" : "empty"}`,
              nodeId: node.id,
              field: field.field
            });
          } else if (key === "feedback" && !loops.some((loop) => loop.target === node.id)) {
            push({
              severity: "warning",
              code: "loop_feedback_not_target",
              message: `${node.name}: only the block a loop edge points back to receives feedback, so {{ ${ref.source} }} is always empty here`,
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
      case "trigger.manual": {
        for (const problem of inputDeclarationProblems(node)) push(problem);
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
        checkChain(node, config.chain, "config.chain");
        checkPrompt(node, config.prompt, "config.prompt");
        checkProfile(node, config.profileId, "config.profileId");
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
        checkAgentReport(node, config, push);
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
      case "gate": {
        // Spec 2026-11-10 §6.1: 2–8 unique choices, a question, a bounded person phase, a valid
        // reviewer agent. Edges leave `choice:<id>` / `error` only (`outputHandles`, checked above).
        const config = node.config;
        const { min, max } = WORKFLOW_LIMITS.gateChoices;
        if (config.choices.length < min || config.choices.length > max) {
          push({ severity: "error", code: "gate_choices", message: `${node.name}: a gate has ${min}–${max} choices`, nodeId: node.id, field: "config.choices" });
        }
        const choiceIds = new Set<string>();
        config.choices.forEach((choice, index) => {
          if (choiceIds.has(choice.id)) {
            push({ severity: "error", code: "gate_choice_duplicate", message: `${node.name}: two choices share the id "${choice.id}"`, nodeId: node.id, field: `config.choices.${index}.id` });
          }
          choiceIds.add(choice.id);
          if (choice.label.trim().length === 0) {
            push({ severity: "error", code: "gate_choice_label", message: `${node.name}: the choice "${choice.id}" has no label`, nodeId: node.id, field: `config.choices.${index}.label` });
          } else if ([...choice.label].length > WORKFLOW_LIMITS.labelChars) {
            push({
              severity: "error",
              code: "label_too_long",
              message: `${node.name}: the choice "${choice.id}"'s label is at most ${WORKFLOW_LIMITS.labelChars} characters`,
              nodeId: node.id,
              field: `config.choices.${index}.label`
            });
          }
        });
        if (config.question.trim().length === 0) {
          push({ severity: "error", code: "gate_question_empty", message: `${node.name}: the question is empty`, nodeId: node.id, field: "config.question" });
        } else if (config.question.length > WORKFLOW_LIMITS.gateQuestionChars) {
          push({
            severity: "error",
            code: "gate_question_too_long",
            message: `${node.name}: the question is at most ${WORKFLOW_LIMITS.gateQuestionChars} characters (put the rest in details)`,
            nodeId: node.id,
            field: "config.question"
          });
        }
        if (config.details !== undefined && utf8ByteLength(config.details) > WORKFLOW_LIMITS.gateDetailsBytes) {
          push({
            severity: "error",
            code: "gate_details_too_large",
            message: `${node.name}: the details are at most ${WORKFLOW_LIMITS.gateDetailsBytes / 1024} KB`,
            nodeId: node.id,
            field: "config.details"
          });
        }
        if (config.timeout !== undefined) {
          if (config.timeout.minutes > WORKFLOW_LIMITS.gatePersonPhaseMaxMinutes) {
            push({ severity: "error", code: "timeout_too_long", message: `${node.name}: a gate's timeout is at most 7 days`, nodeId: node.id, field: "config.timeout.minutes" });
          }
          const then = config.timeout.then;
          if (then.kind === "choice" && !choiceIds.has(then.choice)) {
            push({
              severity: "error",
              code: "gate_timeout_choice",
              message: `${node.name}: the timeout takes "${then.choice.slice(0, 60)}", which is not one of its choices (${[...choiceIds].join(", ") || "none"})`,
              nodeId: node.id,
              field: "config.timeout.then.choice"
            });
          }
        }
        const decider = config.decider;
        if (decider.kind === "agent") {
          checkChain(node, decider.chain, "config.decider.chain");
          checkPrompt(node, decider.prompt, "config.decider.prompt");
          checkProfile(node, decider.profileId, "config.decider.profileId");
        }
        if (decider.kind === "agent" || decider.kind === "launcher") {
          timeoutMax(decider.maxMinutes, WORKFLOW_LIMITS.agentMaxMinutes.max, node, "config.decider.maxMinutes", "the agent's time to decide");
        }
        if (node.disabled === true && config.choices.length > 0) {
          push({
            severity: "warning",
            code: "gate_disabled",
            message: `${node.name} is disabled: it asks nobody and takes its first choice (${config.choices[0]!.label.slice(0, 60)})`,
            nodeId: node.id
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
      const pinnedNode = byId.get(nodeId);
      const outcomeProblem = pinnedNode ? pinnedOutcomeProblem(pinnedNode, value) : null;
      if (outcomeProblem !== null) {
        push({ severity: "error", code: "pinned_outcome_missing", message: `${label(nodeId)}: ${outcomeProblem}`, nodeId, field: `pinned.${nodeId}` });
      }
      if (pinnedNode?.type === "gate") {
        // A pinned gate takes the choice its pin names (§7.5): one of its own.
        const choice = isRecord(value) ? value.choice : undefined;
        const ids = gateChoiceIds(pinnedNode);
        if (typeof choice !== "string" || !ids.includes(choice)) {
          push({
            severity: "error",
            code: "pinned_gate_choice",
            message: `${pinnedNode.name}: pinned data for a gate needs a "choice" — one of ${ids.join(", ") || "its choices"}`,
            nodeId,
            field: `pinned.${nodeId}`
          });
        }
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

type Push = (problem: WorkflowProblem) => void;

/**
 * An agent block's declared outcomes and outputs (spec 2026-11-10 §5.1): 2–12 outcomes with unique
 * ids, at most `maxOutputs` outputs with unique names, enum outputs with 1–50 unique values; a
 * disabled block with outcomes passes through on its first one (§7.5), which is worth a warning.
 */
function checkAgentReport(node: Extract<WorkflowNode, { type: "agent" }>, config: Extract<WorkflowNode, { type: "agent" }>["config"], push: Push): void {
  const where = (field: string) => ({ nodeId: node.id, field });
  const describeLimit = WORKFLOW_LIMITS.inputDescriptionChars;
  if (config.outcomes !== undefined) {
    const { min, max } = WORKFLOW_LIMITS.outcomes;
    if (config.outcomes.length < min || config.outcomes.length > max) {
      push({
        severity: "error",
        code: "outcomes_count",
        message: `${node.name}: declare ${min}–${max} outcomes (it has ${config.outcomes.length})${config.outcomes.length < min ? " — remove the list for a block without outcomes" : ""}`,
        ...where("config.outcomes")
      });
    }
    const seen = new Set<string>();
    config.outcomes.forEach((outcome, index) => {
      if (seen.has(outcome.id)) {
        push({ severity: "error", code: "duplicate_outcome", message: `${node.name}: two outcomes share the id "${outcome.id}"`, ...where(`config.outcomes.${index}.id`) });
      }
      seen.add(outcome.id);
      if ([...(outcome.label ?? "")].length > WORKFLOW_LIMITS.labelChars) {
        push({ severity: "error", code: "label_too_long", message: `${node.name}: the outcome "${outcome.id}"'s label is at most ${WORKFLOW_LIMITS.labelChars} characters`, ...where(`config.outcomes.${index}.label`) });
      }
      if ((outcome.description?.length ?? 0) > describeLimit) {
        push({ severity: "error", code: "description_too_long", message: `${node.name}: the outcome "${outcome.id}"'s description is longer than ${describeLimit} characters`, ...where(`config.outcomes.${index}.description`) });
      }
    });
    if (node.disabled === true && config.outcomes.length > 0) {
      push({
        severity: "warning",
        code: "disabled_takes_first_outcome",
        message: `${node.name} is disabled: it passes its input on through its first outcome, "${config.outcomes[0]!.id}"`,
        ...where("disabled")
      });
    }
  }
  if (config.outputs !== undefined) {
    if (config.outputs.length > WORKFLOW_LIMITS.maxOutputs) {
      push({ severity: "error", code: "outputs_count", message: `${node.name}: at most ${WORKFLOW_LIMITS.maxOutputs} outputs (it has ${config.outputs.length})`, ...where("config.outputs") });
    }
    const seen = new Set<string>();
    config.outputs.forEach((output, index) => {
      const field = `config.outputs.${index}`;
      if (seen.has(output.name)) {
        push({ severity: "error", code: "duplicate_output", message: `${node.name}: two outputs are named "${output.name}"`, ...where(`${field}.name`) });
      }
      seen.add(output.name);
      if ((output.description?.length ?? 0) > describeLimit) {
        push({ severity: "error", code: "description_too_long", message: `${node.name}: the output "${output.name}"'s description is longer than ${describeLimit} characters`, ...where(`${field}.description`) });
      }
      if (output.type === "enum") {
        const values = output.values ?? [];
        const { min, max } = WORKFLOW_LIMITS.enumValues;
        if (values.length < min || values.length > max) {
          push({ severity: "error", code: "enum_values", message: `${node.name}: the enum output "${output.name}" needs ${min}–${max} values (it has ${values.length})`, ...where(`${field}.values`) });
        } else if (new Set(values).size !== values.length) {
          push({ severity: "error", code: "enum_values", message: `${node.name}: the enum output "${output.name}" lists a value twice`, ...where(`${field}.values`) });
        } else if (values.some((value) => value.length === 0)) {
          push({ severity: "error", code: "enum_values", message: `${node.name}: the enum output "${output.name}" has an empty value`, ...where(`${field}.values`) });
        }
      } else if (output.values !== undefined) {
        push({ severity: "warning", code: "enum_values", message: `${node.name}: "${output.name}" is a ${output.type} output, so its values are ignored`, ...where(`${field}.values`) });
      }
    });
  }
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
