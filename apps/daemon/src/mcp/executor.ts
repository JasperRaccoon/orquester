/**
 * THE executor (unified MCP design 2026-10-15 §3.3): the only caller of a catalog tool's `run`,
 * for both transports — the external `/mcp` server (`server.ts`) and the in-chat session-tool route
 * (`../session-tools/route.ts`).
 *
 * ```
 * look up (audience)                     → TOOL_NOT_FOUND
 * parse (strict, audience schema)        → INVALID_ARGUMENT (stripped keys refused too)
 * toolset on in this chat (chat only)    → TOOL_NOT_ENABLED (names the toolset; suggests request_toolset)
 * scope = tool.scope(args)               → THREAD_NOT_FOUND | PROJECT_NOT_FOUND | PERMISSION_DENIED
 * gate (chat only; external = allow)     → deny: PERMISSION_DENIED | ADMIN_NOT_AVAILABLE
 *   card → grant? else preview (> 1 MiB → PREVIEW_TOO_LARGE), arguments frozen, port.request
 *          → APPROVAL_DENIED | APPROVAL_TIMEOUT | cancelled; the gate re-runs on the caller as it is now
 * turn policy + exchange (scope.causesTurnIn) → PERMISSION_DENIED | EXCHANGE_LIMIT
 * run(frozen args, ctx) → ok() / the tool's CallToolResult / toSafeToolError()
 * ```
 *
 * Every daemon request a tool makes carries the caller's principal (`DaemonApi.request(…,
 * {principal})`, a fresh single-use nonce each): `agent` for a chat caller, `external
 * {credentialId}` for an external client (`./principal.ts`).
 */

import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  approvalPreviewBytes,
  buildThreadMessage,
  grantOptionsFor,
  sanitizeApprovalLabel,
  TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES,
  TOOL_APPROVAL_DENY_REASON_MAX_CHARS,
  TOOL_APPROVAL_REASON_MAX_CHARS,
  TOOLSETS,
  toolsetById,
  TOOL_APPROVAL_REFERENCE_KEY,
  type AccountSummary,
  type AdminFamily,
  type ApprovalPreviewSection,
  type ToolApprovalReference,
  type ToolsetId,
  type WorkspaceSummary
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { canonicalProject, type CanonicalProject } from "./addressing.ts";
import type {
  AnyOrquesterTool,
  ApprovalCancelReason,
  ApprovalOutcome,
  ApprovalPort,
  ApprovalPreview,
  ApprovalRequest,
  Audience,
  GrantQuery,
  CallContext,
  ScopeClaim,
  ScopeContext,
  LegacyToolServices,
  ThreadCaller,
  Tier,
  ToolCaller,
  ToolsetCardInput
} from "./catalog/contract.ts";
import { withPrincipal, type DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { gate, type GateDecision, type GateInput } from "./gate/policy.ts";
import { gateFacts } from "./gate/scope.ts";
import { assertExchangeRoom, assertTargetModeNotBroader, causedByFor, NEW_SESSION } from "./gate/turn-policy.ts";
import { toolByName } from "./catalog/index.ts";
import { readThread } from "./reads.ts";
import { argumentProblems, clipText, MAX_ECHO_CHARS, ok, toSafeToolError } from "./result.ts";
import type { SessionSecretRequests } from "../session-tools/contract.ts";

/** Re-exported for daemon-side callers; tool modules import it from `./gate/turn-policy.ts`. */
export { NEW_SESSION };

/** The toolsets on in one chat, by id. */
export type EnabledToolsets = (caller: ThreadCaller) => Promise<ReadonlySet<string>>;

/**
 * Production wiring, set by the daemon's `index.ts` blocks (Task 3 sets `approvals` and
 * `enabledToolsets`): read at call time, so the order the blocks run in does not matter. Tests pass
 * their own through {@link ExecutorDeps}.
 */
export interface ExecutorPorts {
  /** Cards and grants; null → every card is refused (fail closed). */
  approvals: ApprovalPort | null;
  /** The chat's resolved toolsets; null → the catalogue defaults for its agent ({@link defaultEnabledToolsets}). */
  enabledToolsets: EnabledToolsets | null;
  /**
   * A toolset card a chat raised (`request_toolset`) was APPROVED by the user — a real card, not
   * "already on" — while the call still runs. AWAITED before the call resumes: the chat transport
   * waits (bounded) for the host to apply the toolset, so the tool answers "now" / "after-restart"
   * truthfully, and schedules the automatic continue turn (spec §9.3). Its errors are logged,
   * never thrown into the call; null → nothing waited for or scheduled.
   */
  onToolsetApproved?: ((caller: ThreadCaller, toolset: ToolsetId) => void | Promise<void>) | null;
}

export const executorPorts: ExecutorPorts = { approvals: null, enabledToolsets: null, onToolsetApproved: null };

export interface ExecutorDeps {
  /** The tools by name for an audience (default: the catalog). */
  lookup?: (name: string, audience: Audience) => AnyOrquesterTool | undefined;
  approvals?: ApprovalPort | null;
  enabledToolsets?: EnabledToolsets | null;
  /** The caller as it is NOW (mode, planning) — the gate re-runs on it after a card (§13). */
  refreshCaller?: (caller: ThreadCaller) => Promise<ThreadCaller>;
  /** See {@link ExecutorPorts.onToolsetApproved} (default: the daemon's wiring). */
  onToolsetApproved?: ((caller: ThreadCaller, toolset: ToolsetId) => void | Promise<void>) | null;
  legacy?: LegacyToolServices;
  secretRequests?: SessionSecretRequests;
  now?: () => number;
  newId?: () => string;
}

export interface CallEnv {
  caller: ToolCaller;
  /** The transport's in-process API (unbound): the executor binds the principal. */
  api: DaemonApi;
  signal: AbortSignal;
  /** External callers: the principal the transport minted (`{kind: "external", credentialId}`). */
  principal?: CallerPrincipal;
}

/** The catalogue defaults for a chat's agent: locked toolsets plus those on by default. */
export const defaultEnabledToolsets: EnabledToolsets = async (caller) =>
  new Set(TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[caller.agentId] === true).map((toolset) => toolset.id));

// ---------------------------------------------------------------------------
// Schemas per audience
// ---------------------------------------------------------------------------

const schemas = new WeakMap<AnyOrquesterTool, Map<Audience, z.ZodTypeAny>>();

/** The keys an audience never sees: the other audience's only-inputs. */
export function strippedKeys(tool: AnyOrquesterTool, audience: Audience): readonly string[] {
  return ((audience === "external" ? tool.chatOnlyInput : tool.externalOnlyInput) ?? []) as readonly string[];
}

/** The tool's input shape as `audience` is served it. */
export function audienceShape(tool: AnyOrquesterTool, audience: Audience): z.ZodRawShape {
  const stripped = new Set(strippedKeys(tool, audience));
  return Object.fromEntries(Object.entries(tool.input as z.ZodRawShape).filter(([key]) => !stripped.has(key)));
}

/** The strict schema one audience's arguments are parsed with (unknown and stripped keys refused). */
export function audienceSchema(tool: AnyOrquesterTool, audience: Audience): z.ZodTypeAny {
  let byAudience = schemas.get(tool);
  if (!byAudience) {
    byAudience = new Map();
    schemas.set(tool, byAudience);
  }
  let schema = byAudience.get(audience);
  if (!schema) {
    schema = z.object(audienceShape(tool, audience)).strict();
    byAudience.set(audience, schema);
  }
  return schema;
}

/** The description one audience reads: the shared text plus that audience's note. */
export function audienceDescription(tool: AnyOrquesterTool, audience: Audience): string {
  const note = audience === "external" ? tool.externalNote : tool.chatNote;
  return note ? `${tool.description} ${note}` : tool.description;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A result is a record with a `content` array (a tool built it itself: an image, a text). */
function isCallToolResult(value: unknown): value is CallToolResult {
  return value !== null && typeof value === "object" && Array.isArray((value as { content?: unknown }).content);
}

/** What a cancelled call answers; a card withdrawn by a restart says so (the agent may call again later). */
const cancelled = (reason?: ApprovalCancelReason): CallToolResult =>
  toSafeToolError(
    new ToolError(
      "CANCELLED",
      reason === "restarting"
        ? "The call was cancelled: Orquester is restarting, and its approval card was withdrawn. Call it again once Orquester is back."
        : reason === "closed"
          ? "The call was cancelled: this chat was closed."
          : "The call was cancelled."
    )
  );

/** Deep-freeze a value (the frozen arguments `run` receives after a card). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** SHA-256 of a value's canonical JSON (sorted keys). */
export function argumentsHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((key) => [key, canonical((v as Record<string, unknown>)[key])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** The agent's own reason (`reason` on every Admin tool), when the arguments carry one. */
function agentReason(args: unknown): string | undefined {
  const reason = (args as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason.trim() !== "" ? clipText(reason, TOOL_APPROVAL_REASON_MAX_CHARS) : undefined;
}

/** The project's `workspace/project` label, for headers and cards. */
async function projectLabel(api: DaemonApi, projectPath: string): Promise<string> {
  const project = projectPath ? await canonicalProject(api, projectPath) : null;
  return project ? `${project.workspace}/${project.name}` : "";
}

/** Each workspace's git account label (best effort: a card still opens without them). */
async function gitAccountLabels(api: DaemonApi): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    const [workspaces, accounts] = await Promise.all([api.request("GET", "/api/workspaces"), api.request("GET", "/api/accounts")]);
    if (workspaces.status >= 400 || !Array.isArray(workspaces.body)) return labels;
    const byId = new Map<string, string>(
      accounts.status < 400 && Array.isArray(accounts.body) ? (accounts.body as AccountSummary[]).map((account) => [account.id, account.label]) : []
    );
    for (const workspace of workspaces.body as WorkspaceSummary[]) {
      const label = workspace.gitAccount?.label ?? (workspace.gitAccountId ? byId.get(workspace.gitAccountId) : undefined);
      if (label) labels.set(workspace.name, label);
    }
  } catch {
    // A card names what it can.
  }
  return labels;
}

/** The card a boundary decision opens when the tool has no `approval()` of its own. */
function boundaryPreview(tool: AnyOrquesterTool, caller: ThreadCaller, args: unknown, decision: Extract<GateDecision, { kind: "card" }>, where: string): ApprovalPreview {
  const agent = AGENT_LABELS[caller.agentId] ?? caller.agentId;
  const sections: ApprovalPreviewSection[] = [
    { kind: "text", text: `${agent} asks for ${decision.reason} with ${tool.name}.` },
    { kind: "code", title: "Arguments", language: "json", text: JSON.stringify(args, null, 2) }
  ];
  return { title: `${agent} wants to use ${tool.title}${where ? ` in ${where}` : ""}`, scopeLabel: where || "Another project", sections };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/** What one call learned about its Orquester card or grant: the tool row's `toolApproval` reference (§7.3). */
interface CallRecord {
  reference?: ToolApprovalReference;
}

/**
 * The result with the call's `toolApproval` reference (§7.1 "After", §7.3): in
 * `structuredContent` (Codex keeps it) and as one more JSON text block (Claude, Grok and OpenCode
 * keep only the text), where the host's slimming finds it (`sessionToolReferences`). No arguments,
 * no secrets: ids, kind, family, the card's title, the outcome and the user's deny reason.
 */
export function withApprovalReference(result: CallToolResult, reference: ToolApprovalReference): CallToolResult {
  const structured =
    result.structuredContent !== null && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  return {
    ...result,
    content: [...(Array.isArray(result.content) ? result.content : []), { type: "text", text: JSON.stringify({ [TOOL_APPROVAL_REFERENCE_KEY]: reference }) }],
    structuredContent: { ...structured, [TOOL_APPROVAL_REFERENCE_KEY]: reference }
  };
}

export async function executeToolCall(deps: ExecutorDeps, call: { name: string; arguments: unknown }, env: CallEnv): Promise<CallToolResult> {
  const record: CallRecord = {};
  let result: CallToolResult;
  try {
    result = await execute(deps, call, env, record);
  } catch (error) {
    // A wait that ended because the caller went away is a cancellation, not a failure.
    result = env.signal.aborted && !(error instanceof ToolError) ? cancelled() : toSafeToolError(error);
  }
  return record.reference ? withApprovalReference(result, record.reference) : result;
}

async function execute(deps: ExecutorDeps, call: { name: string; arguments: unknown }, env: CallEnv, record: CallRecord): Promise<CallToolResult> {
  const { signal } = env;
  let caller = env.caller;
  const audience: Audience = caller.kind === "external" ? "external" : "chat";
  const lookup = deps.lookup ?? toolByName;
  const tool = lookup(call.name, audience);
  if (!tool) throw new ToolError("TOOL_NOT_FOUND", `No tool named ${clipText(call.name, MAX_ECHO_CHARS)}.`);

  const parsed = await audienceSchema(tool, audience).safeParseAsync(call.arguments ?? {});
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", argumentProblems(tool.name, parsed.error));
  let args: Record<string, unknown> = parsed.data as Record<string, unknown>;
  if (signal.aborted) return cancelled();

  // The agent principal names the caller's canonical project root, or "" when it has none.
  // An unreadable one counts as none (no grants, every target "other"): fail closed.
  const ownProject =
    caller.kind === "thread" && caller.projectPath ? await canonicalProject(env.api, caller.projectPath).catch(() => null) : null;
  const principal: CallerPrincipal =
    caller.kind === "thread"
      ? {
          kind: "agent",
          threadId: caller.threadId,
          projectPath: ownProject?.canonical ?? "",
          agent: caller.agentId,
          title: caller.title,
          ...(caller.exchange ? { exchange: { ...caller.exchange } } : {})
        }
      : (env.principal ?? { kind: "external" });
  const api = withPrincipal(env.api, principal);
  const now = deps.now ?? Date.now;
  const scopeCtx: ScopeContext = { api, signal, now, caller };

  if (caller.kind === "thread") {
    const enabled = await (deps.enabledToolsets ?? executorPorts.enabledToolsets ?? defaultEnabledToolsets)(caller);
    if (!enabled.has(tool.toolset)) {
      const label = toolsetById(tool.toolset)?.label ?? tool.toolset;
      throw new ToolError(
        "TOOL_NOT_ENABLED",
        `${tool.name} is in the "${label}" toolset, which is off in this chat. To ask the user to turn it on, call request_toolset with toolset "${tool.toolset}" and your reason.`
      );
    }
  }

  const scope: ScopeClaim = await tool.scope(args, scopeCtx);
  let approval: CallContext["approval"];
  let card: { preview: ApprovalPreview | null; family: string } | null = null;

  if (caller.kind === "thread") {
    const tier: Tier = typeof tool.tier === "function" ? tool.tier(args) : tool.tier;
    const adminFamily: AdminFamily | undefined = typeof tool.adminFamily === "function" ? tool.adminFamily(args) : tool.adminFamily;
    const facts = await gateFacts(api, caller, scope);
    const gateInput = (who: ThreadCaller): GateInput => ({ tool: tool.name, tier, ...(adminFamily ? { adminFamily } : {}), planSafe: tool.planSafe === true, caller: who, scope, ...facts });
    const decision = gate(gateInput(caller));
    if (decision.kind === "deny") throw new ToolError(decision.code, decision.message);
    if (decision.kind === "card") {
      const outcome = await passCard(deps, tool, args, caller, scope, decision, facts, scopeCtx, ownProject);
      record.reference = outcome.reference;
      if (outcome.kind === "refused") throw outcome.error;
      if (outcome.kind === "cancelled") return cancelled(outcome.reason);
      approval = outcome.approval;
      card = { preview: outcome.preview, family: outcome.family };
      args = outcome.frozenArgs;
      if (outcome.grantChosen === true) await recordChildrenInGrant(deps, caller, card, approval);
      // §13: the caller may have changed while the card waited (now planning, a narrower mode): the
      // gate re-runs on it, and the call proceeds as the caller is now. A card it would raise again
      // is the one the user just answered.
      const current: ThreadCaller = deps.refreshCaller ? await deps.refreshCaller(caller) : caller;
      const again = gate(gateInput(current));
      if (again.kind === "deny") throw new ToolError(again.code, again.message);
      // A grant is honoured only while the caller is full-access and not workflow-owned (§7.6):
      // re-checked on the caller as it is now, closing the race with a mode change.
      if (approval.outcome === "granted" && (current.runtimeMode !== "full-access" || current.workflowOwned)) {
        throw new ToolError("PERMISSION_DENIED", `${tool.name}: the grant covering it applies only while this chat is in Full access. Call it again to ask the user.`);
      }
      caller = current;
    }
  }

  const who: ToolCaller = caller;
  const turn = await turnFor(deps, tool, who, scope, api);
  const ctx: CallContext = {
    api,
    signal,
    now,
    caller: who,
    turn,
    ...(deps.secretRequests ? { secretRequests: deps.secretRequests } : {}),
    ...(deps.legacy ? { legacy: deps.legacy } : {}),
    ...(who.kind === "thread" ? { requestToolsetCard: (input: ToolsetCardInput) => requestToolsetCard(deps, who, input, signal, record) } : {}),
    ...(approval ? { approval } : {})
  };
  if (signal.aborted) return cancelled();
  const result = await tool.run(args, ctx);
  if (card !== null && approval && who.kind === "thread") await afterApprovedRun(deps, who, card, approval, result);
  return isCallToolResult(result) ? result : ok(result);
}

// ---------------------------------------------------------------------------
// Cards and grants
// ---------------------------------------------------------------------------

type CardOutcome =
  | {
      kind: "passed";
      approval: NonNullable<CallContext["approval"]>;
      preview: ApprovalPreview | null;
      family: string;
      frozenArgs: Record<string, unknown>;
      reference: ToolApprovalReference;
      /** The user chose a grant on this card (T10: sub-workflows join that grant). */
      grantChosen?: boolean;
    }
  | { kind: "refused"; error: ToolError; reference: ToolApprovalReference }
  | { kind: "cancelled"; reason?: ApprovalCancelReason; reference: ToolApprovalReference };

async function passCard(
  deps: ExecutorDeps,
  tool: AnyOrquesterTool,
  args: Record<string, unknown>,
  caller: ThreadCaller,
  scope: ScopeClaim,
  decision: Extract<GateDecision, { kind: "card" }>,
  facts: Pick<GateInput, "targets" | "pendingTargets">,
  ctx: ScopeContext,
  ownProject: CanonicalProject | null
): Promise<CardOutcome> {
  const port = deps.approvals === undefined ? executorPorts.approvals : deps.approvals;
  // What runs is what was shown: a deep, frozen copy, hashed (§7.2).
  const frozenArgs = deepFreeze(structuredClone(args));
  const hash = argumentsHash(frozenArgs);
  const where = facts.targets.find((target) => target.class !== "own");
  const whereLabel = where ? await projectLabel(ctx.api, where.project) : (facts.pendingTargets[0] ? `workspace ${facts.pendingTargets[0].workspace}` : "");

  let preview: ApprovalPreview | null = null;
  if (tool.approval) preview = await tool.approval(frozenArgs, ctx);
  else if (decision.approvalKind === "admin") throw new ToolError("PERMISSION_DENIED", `${tool.name} is not available: it has no approval preview.`);
  const family = decision.approvalKind === "admin" ? (preview?.family ?? decision.family) : decision.family;

  // A grant covers the call without a card (full-access, non workflow-owned callers only; §7.6).
  // Grants are recorded for the caller's canonical project: without one, none can match (skip the read).
  if (port && ownProject !== null && preview?.ungrantable !== true) {
    const query: GrantQuery = {
      family,
      callerRuntimeMode: caller.runtimeMode,
      workflowOwned: caller.workflowOwned,
      threadId: caller.threadId,
      projectPath: ownProject?.canonical ?? "",
      // Canonical, as the caller's own `projectPath` is (§7.6: Admin only inside the caller's project).
      projects: decision.approvalKind === "admin" ? facts.targets.map((target) => target.project) : [],
      pendingProjects: scope.pendingProjects?.length ?? 0,
      ...(decision.targetProjectPath ? { targetProjectPath: decision.targetProjectPath } : {}),
      ...(preview?.workflowId ? { workflowId: preview.workflowId } : {}),
      ...(preview?.workflowReferencedPrompt ? { workflowReferencedPrompt: true } : {})
    };
    let grant = await port.findGrant(query);
    // Every other workflow the call runs (sub-workflows) must be covered by that same grant.
    for (const child of grant ? (preview?.childWorkflowIds ?? []) : []) {
      if ((await port.findGrant({ ...query, workflowId: child }))?.id !== grant!.id) {
        grant = null;
        break;
      }
    }
    if (grant) {
      const reference: ToolApprovalReference = {
        kind: decision.approvalKind,
        family: family as ToolApprovalReference["family"],
        title: sanitizeApprovalLabel(preview?.title ?? tool.title),
        outcome: "granted",
        grantId: grant.id,
        ...(grant.scope === "chat" || grant.scope === "project" ? { grantScope: grant.scope } : {})
      };
      return { kind: "passed", approval: { outcome: "granted", grantId: grant.id, ...(preview?.pins ? { pins: { ...preview.pins } } : {}) }, preview, family, frozenArgs, reference };
    }
  }

  const shown = preview ?? boundaryPreview(tool, caller, frozenArgs, decision, whereLabel);
  if (approvalPreviewBytes(shown.sections) > TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) {
    throw new ToolError("PREVIEW_TOO_LARGE", `The change is too large to show the user in one approval card. Split the change into smaller calls.`);
  }
  if (!port) throw new ToolError("PERMISSION_DENIED", `${tool.name} needs the user's approval, and approval cards are not available right now.`);

  const labels = await gitAccountLabels(ctx.api);
  const projects: { path: string; workspace: string; gitAccountLabel?: string }[] = [];
  const named = (path: string, workspace: string) => {
    if (projects.some((project) => project.path === path)) return;
    const label = labels.get(workspace);
    projects.push({ path, workspace, ...(label ? { gitAccountLabel: label } : {}) });
  };
  // A boundary card names the caller's own project and identity beside the targets (§5.2: a
  // cross-workspace action runs with the other workspace's identity, which the user compares).
  if (decision.approvalKind === "boundary" && ownProject) named(ownProject.canonical, ownProject.workspace);
  for (const target of facts.targets.filter((t) => decision.approvalKind === "admin" || t.class !== "own")) named(target.project, target.workspace);
  const crossProject = decision.crossProject;
  const grantOptions =
    // A grant is recorded for the caller's canonical project: none without one (findGrant never
    // honours projectPath ""); a cross-project grant needs its single target.
    ownProject === null || preview?.ungrantable === true || (decision.approvalKind === "boundary" && decision.family === "cross-project" && !decision.targetProjectPath)
      ? []
      : grantOptionsFor({
          family,
          callerRuntimeMode: caller.runtimeMode,
          workflowOwned: caller.workflowOwned,
          crossProject,
          ...(preview?.workflowReferencedPrompt ? { workflowReferencedPrompt: true } : {})
        });
  const reason = agentReason(frozenArgs);
  const request: ApprovalRequest = {
    threadId: caller.threadId,
    callerProjectPath: ownProject?.canonical ?? "",
    tool: tool.name,
    kind: decision.approvalKind,
    family: family as ApprovalRequest["family"],
    title: sanitizeApprovalLabel(shown.title),
    scope: { label: sanitizeApprovalLabel(shown.scopeLabel), ...(projects.length > 0 ? { projects } : {}) },
    ...(reason ? { reason } : {}),
    sections: shown.sections,
    secretFields: shown.secretFields ?? [],
    grantOptions,
    ...(preview?.workflowId ? { workflowId: preview.workflowId } : {}),
    ...(decision.targetProjectPath ? { targetProjectPath: decision.targetProjectPath } : {}),
    ...(preview?.workflowReferencedPrompt ? { workflowReferencedPrompt: true } : {}),
    ...(scope.pendingProjects?.length ? { pendingProjects: scope.pendingProjects.map((pending) => ({ workspace: pending.workspace })) } : {}),
    ...(caller.delivered ? { delivered: caller.delivered } : {})
  };
  const outcome = await port.request(request, ctx.signal);
  const reference: ToolApprovalReference = {
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
    kind: request.kind,
    family: request.family,
    title: request.title,
    outcome: outcome.outcome,
    ...(outcome.outcome === "approved" && outcome.grantId ? { grantId: outcome.grantId } : {}),
    ...(outcome.outcome === "approved" && outcome.grantId && outcome.grantScope ? { grantScope: outcome.grantScope } : {}),
    ...(outcome.outcome === "denied" && outcome.reason ? { reason: clipText(outcome.reason, TOOL_APPROVAL_DENY_REASON_MAX_CHARS) } : {})
  };
  // The user answered: the row keeps that answer even when the call is refused for staleness.
  if (argumentsHash(frozenArgs) !== hash) {
    return { kind: "refused", reference, error: new ToolError("PREVIEW_STALE", "The arguments changed after the card opened; nothing was done.") };
  }
  switch (outcome.outcome) {
    case "approved":
      return {
        reference,
        kind: "passed",
        approval: {
          outcome: "approved",
          approvalId: outcome.approvalId,
          ...(outcome.grantId ? { grantId: outcome.grantId } : {}),
          ...(outcome.secrets ? { secrets: outcome.secrets } : {}),
          ...(preview?.pins ? { pins: { ...preview.pins } } : {})
        },
        preview,
        family,
        frozenArgs,
        ...(outcome.grantChosen !== undefined ? { grantChosen: true } : {})
      };
    case "denied":
      return {
        kind: "refused",
        reference,
        error: new ToolError(
          "APPROVAL_DENIED",
          outcome.reason
          ? `The user denied ${tool.name}: "${clipText(outcome.reason, TOOL_APPROVAL_DENY_REASON_MAX_CHARS)}". Don't retry; ask the user.`
          : `The user denied ${tool.name}. Don't retry; ask the user.`
        )
      };
    case "timed_out":
      return { kind: "refused", reference, error: new ToolError("APPROVAL_TIMEOUT", `Nobody answered the approval card for ${tool.name} in time. Don't retry; ask the user.`) };
    case "cancelled":
      return { kind: "cancelled", reference, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }
}

/**
 * After an APPROVED Admin call of the `workflows` family that created a workflow (no
 * `preview.workflowId`; the result names `workflowId`) whose outcome named a grant (`grantId`: the
 * one the user chose on the card, or the one the card said the create joins): add the new id to
 * that grant (§7.6), so its later updates, runs and deletes are covered. Without the outcome's
 * `grantId` nothing joins (ruling: approving once never widens a standing grant).
 */
async function afterApprovedRun(
  deps: ExecutorDeps,
  caller: ThreadCaller,
  card: { preview: ApprovalPreview | null; family: string },
  approval: NonNullable<CallContext["approval"]>,
  result: Record<string, unknown> | CallToolResult
): Promise<void> {
  if (card.family !== "workflows" || card.preview?.workflowId || approval.outcome !== "approved" || !approval.grantId) return;
  const grantId = approval.grantId;
  const record = isCallToolResult(result) ? (result.structuredContent ?? {}) : result;
  if (isCallToolResult(result) && result.isError) return;
  const workflowId = (record as { workflowId?: unknown }).workflowId;
  const port = deps.approvals === undefined ? executorPorts.approvals : deps.approvals;
  if (typeof workflowId !== "string" || !port) return;
  await port
    .recordWorkflowInGrant({ threadId: caller.threadId, callerProjectPath: caller.projectPath, workflowId, grantId })
    .catch((error) => console.error("[mcp] could not record a workflow in its grant", error instanceof Error ? error.message : "unknown error"));
}

/**
 * A `workflows` card the user approved WITH an explicit grant choice (`grantChosen`; never
 * approve-once, never a create joining the chat's grant), for a workflow that runs sub-workflows
 * (`preview.childWorkflowIds`, each named on the card): the grant the user made covers those
 * children too, so it can ever take effect (§7.6: the grant rule above needs them all).
 */
async function recordChildrenInGrant(
  deps: ExecutorDeps,
  caller: ThreadCaller,
  card: { preview: ApprovalPreview | null; family: string },
  approval: NonNullable<CallContext["approval"]>
): Promise<void> {
  const children = card.preview?.childWorkflowIds ?? [];
  if (card.family !== "workflows" || approval.outcome !== "approved" || !approval.grantId || children.length === 0) return;
  const port = deps.approvals === undefined ? executorPorts.approvals : deps.approvals;
  if (!port) return;
  for (const workflowId of children) {
    await port
      .recordWorkflowInGrant({ threadId: caller.threadId, callerProjectPath: caller.projectPath, workflowId, grantId: approval.grantId })
      .catch((error) => console.error("[mcp] could not record a sub-workflow in its grant", error instanceof Error ? error.message : "unknown error"));
  }
}

/**
 * `request_toolset`'s card (spec §9.3): kind/family `toolset`, never a grant; refused for
 * workflow-owned callers. The outcome is the call's `toolApproval` reference; an approved real card
 * (not "already on", which opens none) is reported to the chat transport, which schedules the
 * automatic continue turn where the provider cannot take the tools in-session.
 */
async function requestToolsetCard(deps: ExecutorDeps, caller: ThreadCaller, input: ToolsetCardInput, signal: AbortSignal, record: CallRecord): Promise<ApprovalOutcome> {
  if (caller.workflowOwned) {
    throw new ToolError("PERMISSION_DENIED", "This chat runs inside an automated workflow, where nobody can approve a toolset.");
  }
  const port = deps.approvals === undefined ? executorPorts.approvals : deps.approvals;
  if (!port) throw new ToolError("PERMISSION_DENIED", "Approval cards are not available right now.");
  if (approvalPreviewBytes(input.sections) > TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) {
    throw new ToolError("PREVIEW_TOO_LARGE", "The toolset card is too large to show.");
  }
  const label = toolsetById(input.toolset)?.label ?? input.toolset;
  const title = sanitizeApprovalLabel(input.title);
  const outcome = await port.request(
    {
      threadId: caller.threadId,
      callerProjectPath: caller.projectPath,
      tool: "request_toolset",
      kind: "toolset",
      family: "toolset",
      toolset: input.toolset,
      title,
      scope: { label: sanitizeApprovalLabel(`This chat · ${label}`) },
      ...(input.reason ? { reason: clipText(input.reason, TOOL_APPROVAL_REASON_MAX_CHARS) } : {}),
      sections: input.sections,
      secretFields: [],
      grantOptions: [],
      ...(caller.delivered ? { delivered: caller.delivered } : {})
    },
    signal
  );
  // "Already on" opens no card (`approvalId: ""`): nothing to record, nothing changed.
  if (outcome.approvalId) {
    record.reference = {
      approvalId: outcome.approvalId,
      kind: "toolset",
      family: "toolset",
      title,
      outcome: outcome.outcome,
      ...(outcome.outcome === "denied" && outcome.reason ? { reason: clipText(outcome.reason, TOOL_APPROVAL_DENY_REASON_MAX_CHARS) } : {})
    };
    if (outcome.outcome === "approved") {
      const hook = deps.onToolsetApproved === undefined ? executorPorts.onToolsetApproved : deps.onToolsetApproved;
      try {
        await hook?.(caller, input.toolset);
      } catch (error) {
        console.error("[mcp] toolset approval hook failed", error instanceof Error ? error.message : "unknown error");
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Turn policy and the exchange (§5.3, §8.4)
// ---------------------------------------------------------------------------

async function turnFor(deps: ExecutorDeps, tool: AnyOrquesterTool, caller: ToolCaller, scope: ScopeClaim, api: DaemonApi): Promise<CallContext["turn"]> {
  if (caller.kind === "external") {
    // External turns carry no `causedBy` (a fresh exchange) and no provenance header.
    return { interactionMode: "default", provenance: (_origin, text) => text };
  }
  const fromProject = caller.workspace && caller.projectPath ? `${caller.workspace}/${basename(caller.projectPath)}` : "";
  const turn: CallContext["turn"] = {
    interactionMode: caller.planning ? "plan" : "default",
    provenance: (origin, text, replyMode) =>
      buildThreadMessage({ origin, fromTitle: caller.title, text, fromSessionId: caller.threadId, ...(fromProject ? { fromProject } : {}), replyMode })
  };
  if (scope.causesTurnIn.length === 0) return turn;
  const causedBy = causedByFor(caller, (deps.newId ?? randomUUID)());
  assertExchangeRoom(causedBy);
  for (const target of new Set(scope.causesTurnIn)) {
    if (target === NEW_SESSION) continue;
    if (target === caller.threadId) throw new ToolError("PERMISSION_DENIED", `${tool.name} cannot cause a turn in this chat itself.`);
    const snap = await readThread(api, target);
    assertTargetModeNotBroader(caller, { threadId: target, runtimeMode: snap.head.runtimeMode });
  }
  return { ...turn, causedBy };
}
