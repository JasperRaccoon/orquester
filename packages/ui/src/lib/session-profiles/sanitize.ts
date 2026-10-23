/**
 * Agent Profiles — wire validation. Every list, profile, item detail and
 * mutation answer is repaired FIELD BY FIELD before it reaches UI state
 * (AGENTS.md: validate payloads before they reach shared UI state): a daemon of
 * another version may send another shape, and one malformed item costs only
 * itself — it is dropped, never a crash.
 *
 * Secrets: an MCP server's env and header entries keep only their KEY and the
 * fact that a value is set. A `value` that should never have crossed the wire
 * is dropped here rather than carried into state.
 */

import {
  isSessionProfileAgentId,
  isSessionProfileItemKind,
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_DEFAULT_SETTINGS,
  SESSION_PROFILE_KNOWLEDGE_COLLECTION_ID_PATTERN,
  SESSION_PROFILE_ITEM_KINDS,
  type HookView,
  type McpServerView,
  type McpTransport,
  type SecretEntryView,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileDetail,
  type SessionProfileItem,
  type SessionProfileItemCount,
  type SessionProfileItemDetail,
  type SessionProfileItemError,
  type SessionProfileItemKind,
  type SessionProfileListError,
  type SessionProfileListResponse,
  type SessionProfileMutationResponse,
  type SessionProfileGlobalItem,
  type SessionProfileGlobalSourceResponse,
  type SessionProfilePluginSource,
  type SessionProfilePluginView,
  type SessionProfilePrepareState,
  type SessionProfilePrepareStatus,
  type SessionProfilePrepareStatusResponse,
  type SessionProfileSettings,
  type SessionProfileSummary
} from "@orquester/api";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const PREPARE_STATES: readonly SessionProfilePrepareState[] = ["preparing", "ready", "failed", "not-prepared"];
const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];

function sanitizePrepareStatus(value: unknown): SessionProfilePrepareStatus | null {
  if (!isRecord(value) || !isSessionProfileAgentId(value.agent)) return null;
  const state = PREPARE_STATES.includes(value.state as SessionProfilePrepareState)
    ? (value.state as SessionProfilePrepareState)
    : "not-prepared";
  const status: SessionProfilePrepareStatus = { agent: value.agent, state, updatedAt: str(value.updatedAt) ?? "" };
  const reason = nonEmpty(value.reason);
  if (reason !== undefined) status.reason = reason;
  return status;
}

/** One entry per agent, in `SESSION_PROFILE_AGENTS` order; an agent the wire left out is `not-prepared`. */
export function sanitizePreparation(value: unknown): SessionProfilePrepareStatus[] {
  const byAgent = new Map<SessionProfileAgentId, SessionProfilePrepareStatus>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      const status = sanitizePrepareStatus(raw);
      if (status !== null && !byAgent.has(status.agent)) byAgent.set(status.agent, status);
    }
  }
  return SESSION_PROFILE_AGENTS.map((agent) => byAgent.get(agent) ?? { agent, state: "not-prepared", updatedAt: "" });
}

function sanitizeCount(value: unknown): SessionProfileItemCount {
  if (!isRecord(value)) return { total: 0, enabled: 0 };
  const num = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0);
  const total = num(value.total);
  return { total, enabled: Math.min(num(value.enabled), total) };
}

function sanitizeCounts(value: unknown): Record<SessionProfileItemKind, SessionProfileItemCount> {
  const record = isRecord(value) ? value : {};
  const counts = {} as Record<SessionProfileItemKind, SessionProfileItemCount>;
  for (const kind of SESSION_PROFILE_ITEM_KINDS) counts[kind] = sanitizeCount(record[kind]);
  return counts;
}

function sanitizeSettings(value: unknown): SessionProfileSettings {
  const record = isRecord(value) ? value : {};
  const hide = isRecord(record.hideBuiltinSkills) ? record.hideBuiltinSkills : {};
  const hideBuiltinSkills = { ...SESSION_PROFILE_DEFAULT_SETTINGS.hideBuiltinSkills };
  for (const agent of SESSION_PROFILE_AGENTS) {
    if (typeof hide[agent] === "boolean") hideBuiltinSkills[agent] = hide[agent] as boolean;
  }
  // Knowledge Graph: the ticked collection ids; absent (an older daemon) = none ticked.
  const knowledge = Array.isArray(record.knowledgeCollections)
    ? [...new Set(record.knowledgeCollections.filter((id): id is string => typeof id === "string" && SESSION_PROFILE_KNOWLEDGE_COLLECTION_ID_PATTERN.test(id)))]
    : undefined;
  return {
    hideBuiltinSkills,
    claudeWorkflowTool:
      typeof record.claudeWorkflowTool === "boolean"
        ? record.claudeWorkflowTool
        : SESSION_PROFILE_DEFAULT_SETTINGS.claudeWorkflowTool,
    ...(knowledge !== undefined ? { knowledgeCollections: knowledge } : {})
  };
}

export function sanitizeSessionProfileSummary(value: unknown): SessionProfileSummary | null {
  if (!isRecord(value)) return null;
  const id = nonEmpty(value.id);
  const revision = nonEmpty(value.revision);
  if (id === undefined || revision === undefined) return null;
  const summary: SessionProfileSummary = {
    id,
    name: nonEmpty(value.name) ?? id,
    description: str(value.description) ?? "",
    revision,
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? "",
    counts: sanitizeCounts(value.counts),
    hasInstructions: value.hasInstructions === true,
    preparation: sanitizePreparation(value.preparation)
  };
  const icon = nonEmpty(value.icon);
  if (icon !== undefined) summary.icon = icon;
  return summary;
}

/** `"all"`, or a non-empty list of known agents, each once; anything else is `null` (the item is dropped). */
function sanitizeScope(value: unknown): SessionProfileAgentScope | null {
  if (value === "all") return "all";
  if (!Array.isArray(value)) return null;
  const agents: SessionProfileAgentId[] = [];
  for (const agent of value) if (isSessionProfileAgentId(agent) && !agents.includes(agent)) agents.push(agent);
  return agents.length > 0 ? agents : null;
}

/** Keys and "is set" only — never a value. */
function sanitizeSecretEntries(value: unknown): SecretEntryView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: SecretEntryView[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const key = nonEmpty(raw.key);
    if (key !== undefined) entries.push({ key, set: true });
  }
  return entries;
}

export function sanitizeMcpView(value: unknown): McpServerView | null {
  if (!isRecord(value)) return null;
  const name = nonEmpty(value.name);
  if (name === undefined) return null;
  const transport = TRANSPORTS.includes(value.transport as McpTransport) ? (value.transport as McpTransport) : "stdio";
  const view: McpServerView = { name, transport };
  const command = str(value.command);
  if (command !== undefined) view.command = command;
  if (Array.isArray(value.args)) view.args = value.args.filter((arg): arg is string => typeof arg === "string");
  const cwd = str(value.cwd);
  if (cwd !== undefined) view.cwd = cwd;
  const url = str(value.url);
  if (url !== undefined) view.url = url;
  const env = sanitizeSecretEntries(value.env);
  if (env !== undefined) view.env = env;
  const headers = sanitizeSecretEntries(value.headers);
  if (headers !== undefined) view.headers = headers;
  if (isRecord(value.advanced)) view.advanced = { ...value.advanced };
  // boxes: only a real `true` switches it on; anything else reads as the default (off).
  if (value.runInBox === true) view.runInBox = true;
  return view;
}

export function sanitizeHookView(value: unknown): HookView | null {
  if (!isRecord(value)) return null;
  const event = nonEmpty(value.event);
  const command = str(value.command);
  if (event === undefined || command === undefined) return null;
  const hook: HookView = { event, command };
  const matcher = str(value.matcher);
  if (matcher !== undefined) hook.matcher = matcher;
  if (typeof value.timeoutSec === "number" && Number.isFinite(value.timeoutSec)) hook.timeoutSec = value.timeoutSec;
  return hook;
}

function sanitizePluginView(value: unknown): SessionProfilePluginView | null {
  if (!isRecord(value)) return null;
  const name = nonEmpty(value.name);
  if (name === undefined) return null;
  const plugin: SessionProfilePluginView = { name, cached: value.cached === true };
  const marketplace = nonEmpty(value.marketplace);
  if (marketplace !== undefined) plugin.marketplace = marketplace;
  const version = nonEmpty(value.version);
  if (version !== undefined) plugin.version = version;
  const source = sanitizePluginSource(value.source);
  if (source !== null) plugin.source = source;
  return plugin;
}

function sanitizePluginSource(value: unknown): SessionProfilePluginSource | null {
  if (!isRecord(value) || (value.type !== "marketplace" && value.type !== "global")) return null;
  const source: SessionProfilePluginSource = { type: value.type, copiedAt: str(value.copiedAt) ?? "" };
  for (const key of ["marketplace", "commit", "url", "ref"] as const) {
    const field = nonEmpty(value[key]);
    if (field !== undefined) source[key] = field;
  }
  return source;
}

export function sanitizeSessionProfileItem(value: unknown): SessionProfileItem | null {
  if (!isRecord(value) || !isSessionProfileItemKind(value.kind)) return null;
  const id = nonEmpty(value.id);
  const name = nonEmpty(value.name);
  const agents = sanitizeScope(value.agents);
  if (id === undefined || name === undefined || agents === null) return null;
  const base = { id, name, enabled: value.enabled === true, agents } as const;
  const extra: Partial<SessionProfileItem> = {};
  const description = nonEmpty(value.description);
  if (description !== undefined) extra.description = description;
  if (Array.isArray(value.unsupported)) {
    const unsupported: { agent: SessionProfileAgentId; reason: string }[] = [];
    for (const raw of value.unsupported) {
      if (isRecord(raw) && isSessionProfileAgentId(raw.agent) && nonEmpty(raw.reason) !== undefined) {
        unsupported.push({ agent: raw.agent, reason: raw.reason as string });
      }
    }
    if (unsupported.length > 0) extra.unsupported = unsupported;
  }
  const createdAt = str(value.createdAt);
  if (createdAt !== undefined) extra.createdAt = createdAt;
  const updatedAt = str(value.updatedAt);
  if (updatedAt !== undefined) extra.updatedAt = updatedAt;
  switch (value.kind) {
    case "skill":
    case "command":
      return { ...base, ...extra, kind: value.kind };
    case "mcp": {
      const mcp = sanitizeMcpView(value.mcp) ?? { name, transport: "stdio" };
      return { ...base, ...extra, kind: "mcp", mcp };
    }
    case "hook": {
      const hook = sanitizeHookView(value.hook);
      return hook === null ? null : { ...base, ...extra, kind: "hook", hook };
    }
    case "plugin": {
      const plugin = sanitizePluginView(value.plugin) ?? { name, cached: false };
      return { ...base, ...extra, kind: "plugin", plugin };
    }
  }
}

function sanitizeItemErrors(value: unknown): SessionProfileItemError[] {
  if (!Array.isArray(value)) return [];
  const errors: SessionProfileItemError[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const message = nonEmpty(raw.message);
    if (message === undefined) continue;
    const itemId = nonEmpty(raw.itemId);
    errors.push(itemId === undefined ? { message } : { itemId, message });
  }
  return errors;
}

export function sanitizeSessionProfileDetail(value: unknown): SessionProfileDetail | null {
  const summary = sanitizeSessionProfileSummary(value);
  if (summary === null || !isRecord(value)) return null;
  const items: SessionProfileItem[] = [];
  if (Array.isArray(value.items)) {
    for (const raw of value.items) {
      const item = sanitizeSessionProfileItem(raw);
      if (item !== null) items.push(item);
    }
  }
  return { ...summary, settings: sanitizeSettings(value.settings), items, itemErrors: sanitizeItemErrors(value.itemErrors) };
}

export function sanitizeSessionProfileList(value: unknown): SessionProfileListResponse {
  const record = isRecord(value) ? value : {};
  const profiles: SessionProfileSummary[] = [];
  if (Array.isArray(record.profiles)) {
    for (const raw of record.profiles) {
      const summary = sanitizeSessionProfileSummary(raw);
      if (summary !== null && !profiles.some((profile) => profile.id === summary.id)) profiles.push(summary);
    }
  }
  const errors: SessionProfileListError[] = [];
  if (Array.isArray(record.errors)) {
    for (const raw of record.errors) {
      if (!isRecord(raw)) continue;
      const profileId = nonEmpty(raw.profileId);
      const message = nonEmpty(raw.message);
      if (profileId !== undefined && message !== undefined) errors.push({ profileId, message });
    }
  }
  return { profiles, errors };
}

/** A mutation's answer: the fresh profile (or `null` when it does not read) and the item it touched. */
export function sanitizeSessionProfileMutation(value: unknown): { profile: SessionProfileDetail | null; itemId: string | null } {
  if (!isRecord(value)) return { profile: null, itemId: null };
  return { profile: sanitizeSessionProfileDetail(value.profile), itemId: nonEmpty(value.itemId) ?? null };
}

export function sanitizePrepareStatusResponse(value: unknown): SessionProfilePrepareStatusResponse | null {
  if (!isRecord(value)) return null;
  const profileId = nonEmpty(value.profileId);
  const revision = nonEmpty(value.revision);
  if (profileId === undefined || revision === undefined) return null;
  return { profileId, revision, agents: sanitizePreparation(value.agents) };
}

/** An item's editable detail; `null` when it does not read. Secrets stay masked (`sanitizeMcpView`). */
export function sanitizeSessionProfileItemDetail(value: unknown): SessionProfileItemDetail | null {
  if (!isRecord(value)) return null;
  const item = sanitizeSessionProfileItem(value.item);
  if (item === null) return null;
  switch (item.kind) {
    case "skill":
    case "command": {
      const document = isRecord(value.document) ? value.document : {};
      const detail: SessionProfileItemDetail = {
        kind: item.kind,
        item,
        document: {
          frontmatter: isRecord(document.frontmatter) ? { ...document.frontmatter } : {},
          body: str(document.body) ?? ""
        }
      };
      if (Array.isArray(value.files)) detail.files = value.files.filter((file): file is string => typeof file === "string");
      return detail;
    }
    case "mcp":
      return { kind: "mcp", item, mcp: sanitizeMcpView(value.mcp) ?? item.mcp };
    case "hook":
      return { kind: "hook", item, hook: sanitizeHookView(value.hook) ?? item.hook };
    case "plugin":
      return { kind: "plugin", item, plugin: sanitizePluginView(value.plugin) ?? item.plugin };
  }
}

/** An import, copy or plugin add's answer: the fresh profile (or `null`), the items it made, its notes. */
export function sanitizeSessionProfileImport(value: unknown): { profile: SessionProfileDetail | null; itemIds: string[]; notes: string[] } {
  if (!isRecord(value)) return { profile: null, itemIds: [], notes: [] };
  const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  return { profile: sanitizeSessionProfileDetail(value.profile), itemIds: strings(value.itemIds), notes: strings(value.notes) };
}

/** What Import from Global offers; `null` when it does not read. */
export function sanitizeGlobalSource(value: unknown): SessionProfileGlobalSourceResponse | null {
  if (!isRecord(value) || !isSessionProfileAgentId(value.agent)) return null;
  const items: SessionProfileGlobalItem[] = [];
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    if (!isRecord(raw) || !isSessionProfileItemKind(raw.kind)) continue;
    const id = nonEmpty(raw.id);
    const name = nonEmpty(raw.name);
    if (id === undefined || name === undefined) continue;
    const item: SessionProfileGlobalItem = { id, kind: raw.kind, name, exists: raw.exists === true };
    const description = nonEmpty(raw.description);
    if (description !== undefined) item.description = description;
    const unavailable = nonEmpty(raw.unavailable);
    if (unavailable !== undefined) item.unavailable = unavailable;
    items.push(item);
  }
  const instructions = isRecord(value.instructions) ? value.instructions : {};
  return {
    agent: value.agent,
    installed: value.installed === true,
    instructions: { exists: instructions.exists === true, bytes: typeof instructions.bytes === "number" ? instructions.bytes : 0 },
    items
  };
}

/** One workflow the delete confirmation lists (`ProfileReferencesResponse.workflows`, read field-wise). */
export interface ProfileWorkflowUse {
  workflowId: string;
  name: string;
  enabled: boolean;
  workspace?: string;
}

/**
 * The workflows whose agent blocks launch with a profile (`workflowRoutes.profileReferences`):
 * `unknown` when the daemon cannot tell (it may be more), or when the answer does not read — the
 * confirmation then says so, and the delete sends no `expectWorkflowUses`. Never "none" by default.
 */
export function sanitizeProfileWorkflowUses(value: unknown): { workflows: ProfileWorkflowUse[]; unknown: boolean } {
  if (!isRecord(value) || !Array.isArray(value.workflows)) return { workflows: [], unknown: true };
  const workflows: ProfileWorkflowUse[] = [];
  let unreadable = false;
  for (const raw of value.workflows) {
    const workflowId = isRecord(raw) ? nonEmpty(raw.workflowId) : undefined;
    if (!isRecord(raw) || workflowId === undefined) {
      unreadable = true;
      continue;
    }
    if (workflows.some((use) => use.workflowId === workflowId)) continue;
    const workspace = nonEmpty(raw.workspace);
    workflows.push({ workflowId, name: nonEmpty(raw.name) ?? workflowId, enabled: raw.enabled === true, ...(workspace !== undefined ? { workspace } : {}) });
  }
  return { workflows, unknown: unreadable || nonEmpty(value.unknownReason) !== undefined };
}
