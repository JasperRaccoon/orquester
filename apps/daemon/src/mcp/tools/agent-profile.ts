// Agent profiles through the MCP: each agent CLI's own global configuration — MCP servers, skills, plugins, plugin
// marketplaces, hooks, slash commands and the global instruction file (docs/superpowers/specs/2026-09-28-agent-profile-
// design.md; docs/orquester-mcp.md §13).
//
// Every tool is an in-process client of the daemon's `agentProfileRoutes`, through DaemonApi only (`profileClient`
// below: one method per route). Rules every tool keeps:
//
// - Secret values — an MCP server's env and headers — are WRITE-ONLY. A tool takes them as `{KEY: value}` maps, turns
//   them into `SecretEntryDraft`s, and never returns, quotes or logs one: every view of a server names its keys only
//   (`{key, set: true}`), rebuilt here from the key alone whatever the daemon sent.
// - `revision` is optional on every write: when omitted the tool reads the item's (or the instruction file's) current
//   revision just before writing. A write the daemon refuses with PROFILE_CONFLICT is answered with the item's fresh
//   summary in the error's detail.
// - Daemon error codes pass through unchanged (a hint naming the tool that helps may follow the message).
// - Every result is bounded below the 60 000-byte cap by the tool itself and says what it cut.

import { z } from "zod";
import {
  AGENT_PROFILE_AGENT_LABELS,
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_CREATABLE_KINDS,
  AGENT_PROFILE_KINDS,
  agentProfileRoutes,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  PROFILE_COPYABLE_KINDS,
  PROFILE_FRONTMATTER_FIELDS,
  PROFILE_HOOK_EVENTS,
  PROFILE_ITEM_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  type AgentProfileAgentId,
  type AgentProfileOverviewResponse,
  type AgentProfileSnapshot,
  type CreateProfileItemRequest,
  type HookDraft,
  type MarketplacePluginsResponse,
  type McpServerDraft,
  type McpServerView,
  type McpTransport,
  type ProfileConflictPolicy,
  type ProfileImportScanResponse,
  type ProfileInstructionsInfo,
  type ProfileInstructionsResponse,
  type ProfileItem,
  type ProfileItemDetail,
  type ProfileItemDraft,
  type ProfileItemKind,
  type ProfileMutationResponse,
  type SecretEntryDraft,
  type SecretEntryView
} from "@orquester/api";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import { defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolDef } from "../tool.ts";

/** What a profile tool plans its result to: the cap less room for ok()'s own framing and a few keys added last. */
const PROFILE_RESULT_BUDGET = MAX_RESULT_BYTES - 4_000;
/** The longest description, warning or note a row carries, in code points. */
const MAX_ROW_TEXT = 300;
const MAX_NOTE_TEXT = 500;
/** A skill's other files listed by get_agent_profile_item. */
const MAX_SKILL_FILES = 200;
/** A secret value, an argument, a URL: generous bounds that keep a runaway argument out of the daemon. */
const MAX_SECRET_VALUE_CHARS = 16_384;
const MAX_PATH_CHARS = 4_096;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;

type Agent = AgentProfileAgentId;
const label = (agent: Agent): string => AGENT_PROFILE_AGENT_LABELS[agent];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_HINTS: Record<string, string> = {
  ITEM_NOT_FOUND: " get_agent_profile lists the items and their ids (a hook's id changes when it is edited).",
  AGENT_NOT_INSTALLED: " list_agent_profiles shows which agents are installed.",
  UNKNOWN_AGENT: " list_agent_profiles shows the agents.",
  KIND_NOT_SUPPORTED: " get_agent_profile's authoring.creatableKinds lists what the agent can create.",
  IMPORT_NOT_FOUND: " Scan again: import_agent_profile_items {agent, url}.",
  ITEM_EXISTS: " Pass onConflict \"replace\" or \"keep-both\" to create it anyway.",
  CONFIG_UNREADABLE: " The file must be fixed by hand first; get_agent_profile lists it under fileErrors.",
  ITEM_LOCKED: " Orquester or the agent CLI owns it.",
  NOT_EDITABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI.",
  NOT_TOGGLEABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI.",
  NOT_DELETABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI."
};

/**
 * A failed profile route as a ToolError: the daemon's `{error: {code, message}}` passes its code through unchanged,
 * a hint appended; anything else takes the MCP's generic mapping (daemonError), which never echoes a 5xx body. No
 * profile route quotes a secret value or a git URL (routes.ts), so the message is safe to pass on.
 */
function profileError(res: DaemonResponse): ToolError {
  const error = daemonError(res);
  const hint = ERROR_HINTS[error.code];
  if (!hint) return error;
  const message = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  return new ToolError(error.code, `${message}${hint}`, error.detail);
}

function expectProfileOk<T>(res: DaemonResponse): T {
  if (res.status >= 400) throw profileError(res);
  return res.body as T;
}

// ---------------------------------------------------------------------------
// The daemon's agent-profile routes, one method each (through DaemonApi only)
// ---------------------------------------------------------------------------

function profileClient(api: DaemonApi) {
  const call = async <T>(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<T> =>
    expectProfileOk<T>(await api.request(method, path, opts));
  return {
    overview: () => call<AgentProfileOverviewResponse>("GET", agentProfileRoutes.overview),
    snapshot: (agent: Agent) => call<AgentProfileSnapshot>("GET", agentProfileRoutes.snapshot(agent)),
    item: (agent: Agent, id: string) => call<ProfileItemDetail>("GET", agentProfileRoutes.item(agent, id)),
    create: (agent: Agent, body: CreateProfileItemRequest) => call<ProfileMutationResponse>("POST", agentProfileRoutes.items(agent), { body }),
    update: (agent: Agent, id: string, revision: string, draft: ProfileItemDraft) =>
      call<ProfileMutationResponse>("PUT", agentProfileRoutes.item(agent, id), { body: { revision, draft } }),
    setEnabled: (agent: Agent, id: string, revision: string, enabled: boolean) =>
      call<ProfileMutationResponse>("POST", agentProfileRoutes.itemEnabled(agent, id), { body: { revision, enabled } }),
    remove: (agent: Agent, id: string, revision: string) =>
      call<ProfileMutationResponse>("DELETE", agentProfileRoutes.item(agent, id), { query: { revision } }),
    trust: (agent: Agent, id: string, revision: string) =>
      call<ProfileMutationResponse>("POST", agentProfileRoutes.itemTrust(agent, id), { body: { revision } }),
    copy: (agent: Agent, id: string, toAgent: Agent, onConflict: ProfileConflictPolicy) =>
      call<ProfileMutationResponse>("POST", agentProfileRoutes.itemCopy(agent, id), { body: { toAgent, onConflict } }),
    instructions: (agent: Agent) => call<ProfileInstructionsResponse>("GET", agentProfileRoutes.instructions(agent)),
    writeInstructions: (agent: Agent, text: string, revision: string) =>
      call<ProfileMutationResponse>("PUT", agentProfileRoutes.instructions(agent), { body: { text, revision } }),
    importGit: (agent: Agent, url: string) => call<ProfileImportScanResponse>("POST", agentProfileRoutes.importGit(agent), { body: { url } }),
    marketplacePlugins: (agent: Agent, marketplace: string) =>
      call<MarketplacePluginsResponse>("GET", agentProfileRoutes.marketplacePlugins(agent, marketplace))
  };
}
type ProfileClient = ReturnType<typeof profileClient>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** One item as every result shows it: what it is, where it comes from, what may be done to it, and its revision. */
function itemView(item: ProfileItem): Record<string, unknown> {
  const view: Record<string, unknown> = { id: item.id, kind: item.kind, name: item.name };
  if (item.description) view.description = clipText(redactUrlCredentials(item.description), MAX_ROW_TEXT);
  view.enabled = item.enabled;
  if (item.stashed) view.stashed = true;
  view.source = item.source?.label;
  view.sourceType = item.source?.type;
  if (item.source?.ownerAgent) view.ownerAgent = item.source.ownerAgent;
  if (item.source?.pluginId) view.pluginId = item.source.pluginId;
  view.locked = item.locked;
  view.toggleable = item.toggleable;
  view.editable = item.editable;
  view.deletable = item.deletable;
  if (Array.isArray(item.warnings) && item.warnings.length > 0) {
    view.warnings = item.warnings.map((w) => ({ code: w.code, message: clipText(String(w.message ?? ""), MAX_ROW_TEXT), ...(w.action ? { action: w.action } : {}) }));
  }
  if (isRecord(item.meta) && Object.keys(item.meta).length > 0) {
    view.meta = Object.fromEntries(Object.entries(item.meta).map(([k, v]) => [k, clipText(redactUrlCredentials(String(v)), 200)]));
  }
  view.revision = item.revision;
  return view;
}

function instructionsView(info: ProfileInstructionsInfo): Record<string, unknown> {
  const view: Record<string, unknown> = { path: info.path, exists: info.exists, bytes: info.bytes, lines: info.lines };
  if (info.mtime) view.mtime = info.mtime;
  view.revision = info.revision;
  if (Array.isArray(info.warnings) && info.warnings.length > 0) view.warnings = info.warnings.map((w) => clipText(`${w.code}: ${w.message}`, MAX_ROW_TEXT));
  if (info.legacyPath) view.legacyPath = info.legacyPath;
  return view;
}

/** A secret list as a result shows it: the keys, never a value — rebuilt from the key alone whatever arrived. */
function secretKeys(entries: readonly SecretEntryView[] | undefined): { key: string; set: true }[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  return entries.filter((e) => isRecord(e) && typeof e.key === "string").map((e) => ({ key: e.key, set: true as const }));
}

/** A URL as a result shows it: credentials written into it (`https://user:token@host`) replaced by `***`. */
export function redactUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/i, "$1***@");
}

function mcpView(mcp: McpServerView): Record<string, unknown> {
  const view: Record<string, unknown> = { name: mcp.name, transport: mcp.transport };
  if (mcp.command !== undefined) view.command = mcp.command;
  if (mcp.args !== undefined) view.args = mcp.args;
  if (mcp.cwd !== undefined) view.cwd = mcp.cwd;
  const env = secretKeys(mcp.env);
  if (env) view.env = env;
  if (mcp.url !== undefined) view.url = redactUrlCredentials(mcp.url);
  const headers = secretKeys(mcp.headers);
  if (headers) view.headers = headers;
  if (mcp.advanced && Object.keys(mcp.advanced).length > 0) view.advanced = mcp.advanced;
  return view;
}

/** Keep the longest prefix of `rows` under the budget; names what it left out. */
function fitRows(result: Record<string, unknown>, key: string, rows: unknown[], note: string): Record<string, unknown> {
  result[key] = rows;
  if (resultBytes(result) <= PROFILE_RESULT_BUDGET) return result;
  const place = (n: number) => {
    result[key] = rows.slice(0, n);
    result.truncated = true;
    result.omitted = rows.length - n;
    result.note = note;
  };
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    place(mid);
    if (resultBytes(result) <= PROFILE_RESULT_BUDGET) lo = mid;
    else hi = mid - 1;
  }
  place(lo);
  return result;
}

/**
 * What every write answers: the ids it created or changed, the daemon's notes, and a compact summary of each changed
 * item (read from the fresh snapshot the write returned — never the whole snapshot). An id the snapshot no longer
 * lists (a delete) is named in `absentIds`.
 */
function mutationResult(res: ProfileMutationResponse, head: Record<string, unknown>): Record<string, unknown> {
  const itemIds = Array.isArray(res.itemIds) ? res.itemIds : [];
  const byId = new Map((res.snapshot?.items ?? []).map((item) => [item.id, item]));
  const items = itemIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [itemView(item)] : [];
  });
  const absentIds = itemIds.filter((id) => !byId.has(id));
  const result: Record<string, unknown> = { ...head, agent: res.snapshot?.agent ?? head.agent, itemIds, notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
  if (absentIds.length > 0) result.absentIds = absentIds;
  return fitRows(result, "items", items, "Changed items past the size cap were left out of `items`: itemIds names them all; get_agent_profile shows them.");
}

// ---------------------------------------------------------------------------
// Revisions and conflicts
// ---------------------------------------------------------------------------

/** The item as the agent lists it now; ITEM_NOT_FOUND (or AGENT_NOT_INSTALLED) when it does not. */
async function currentItem(client: ProfileClient, agent: Agent, id: string): Promise<ProfileItem> {
  const snapshot = await client.snapshot(agent);
  if (!snapshot.installed) throw new ToolError("AGENT_NOT_INSTALLED", `${label(agent)} is not installed on this host.${ERROR_HINTS.AGENT_NOT_INSTALLED}`);
  const item = snapshot.items.find((entry) => entry.id === id);
  if (!item) throw new ToolError("ITEM_NOT_FOUND", `${label(agent)} has no item "${clipText(id, MAX_ECHO_CHARS)}".${ERROR_HINTS.ITEM_NOT_FOUND}`);
  return item;
}

/**
 * Run a write that carries an item revision; a PROFILE_CONFLICT it answers is re-thrown with the item's fresh summary
 * (`detail.item`), or `detail.itemGone` when the item no longer exists.
 */
async function withItemConflict<T>(client: ProfileClient, agent: Agent, id: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== "PROFILE_CONFLICT") throw error;
    let current: ProfileItem | undefined;
    try {
      current = (await client.snapshot(agent)).items.find((item) => item.id === id);
    } catch {
      throw error;
    }
    if (!current) {
      throw new ToolError("PROFILE_CONFLICT", `${error.message} The item "${clipText(id, MAX_ECHO_CHARS)}" no longer exists under that id: get_agent_profile lists the current items.`, { itemGone: true });
    }
    throw new ToolError(
      "PROFILE_CONFLICT",
      `${error.message} The item changed since that revision was read; it is now at revision ${current.revision} (its current state is in detail.item). Check your change still applies, then retry with that revision, or omit revision to write over whatever is current.`,
      { item: itemView(current) }
    );
  }
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const agentArg = z.enum(AGENT_PROFILE_AGENTS).describe(`The agent CLI: ${AGENT_PROFILE_AGENTS.join(", ")}.`);
const idArg = z.string().min(1).max(1_024).describe("The item's id as get_agent_profile lists it, e.g. \"mcp:jira\", \"skill:handoff\", \"hook:Stop:0123456789abcdef\".");
const revisionArg = z.string().min(1).max(1_024).optional()
  .describe("The item's revision as last read (get_agent_profile). Omit it to use the current one, read just before writing. A stale one answers PROFILE_CONFLICT with the fresh item.");
const onConflictArg = z.enum(["fail", "replace", "keep-both"]).default("fail")
  .describe("When an item of that kind and name exists: fail (default, ITEM_EXISTS), replace it, or keep-both (the new one gets a suffixed name).");

const secretMap = z.record(z.string().min(1).max(256), z.string().max(MAX_SECRET_VALUE_CHARS));
const secretPatch = z.record(z.string().min(1).max(256), z.string().max(MAX_SECRET_VALUE_CHARS).nullable());
const stringList = z.array(z.string().max(MAX_PATH_CHARS)).max(500);
const transportArg = z.enum(["stdio", "http", "sse"]);

const mcpCreateSchema = z.object({
  name: z.string().min(1).max(64).describe("Server name: a letter or _, then letters, digits, _ or - (not ending in _)."),
  transport: transportArg.optional().describe("stdio (a local command), http or sse (a URL). Default: http when url is given, else stdio. get_agent_profile's authoring.mcpTransports lists the agent's."),
  command: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("stdio: the executable."),
  args: stringList.optional().describe("stdio: its arguments."),
  cwd: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("stdio: its working directory."),
  env: secretMap.optional().describe("stdio: environment variables as {NAME: value}. Values are secrets: write-only, never shown again."),
  url: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("http/sse: the server URL."),
  headers: secretMap.optional().describe("http/sse: request headers as {Name: value}. Values are secrets: write-only, never shown again."),
  advanced: z.record(z.unknown()).optional().describe("The agent's own non-secret extras (get_agent_profile's authoring.mcpAdvancedFields), e.g. {timeout: 60000}.")
}).strict();

const mcpUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional().describe("A new name renames the server."),
  transport: transportArg.optional().describe("Switching between stdio and http/sse drops the other side's fields: send command or url for the new one."),
  command: z.string().min(1).max(MAX_PATH_CHARS).optional(),
  args: stringList.optional().describe("Replaces the whole argument list."),
  cwd: z.string().min(1).max(MAX_PATH_CHARS).nullable().optional().describe("null removes it."),
  env: secretPatch.optional().describe("Only the keys you name change: \"value\" sets or replaces one, null removes it; every key you leave out keeps its current value."),
  url: z.string().min(1).max(MAX_PATH_CHARS).optional(),
  headers: secretPatch.optional().describe("As env: \"value\" sets, null removes, a key left out is kept."),
  advanced: z.record(z.unknown()).optional().describe("Only the keys you name change; null removes one.")
}).strict();

const documentCreateSchema = z.object({
  name: z.string().min(1).max(256).describe("Skill: lowercase words joined by - (≤ 64). Command: the same, optionally one folder level (\"git/pr\")."),
  frontmatter: z.record(z.unknown()).optional().describe("YAML frontmatter, e.g. {description: \"What it does and when to use it\"} — skills need a description. get_agent_profile's authoring.frontmatterFields lists the fields the agent knows."),
  body: z.string().max(MAX_TEXT_CHARS).optional().describe("The markdown body (default empty).")
}).strict();

const documentUpdateSchema = z.object({
  name: z.string().min(1).max(256).optional().describe("A new name renames it."),
  frontmatter: z.record(z.unknown()).optional().describe("Only the keys you name change; null removes a key; the rest stay as they are."),
  body: z.string().max(MAX_TEXT_CHARS).optional().describe("The whole new body; omit it to keep the current one.")
}).strict();

const hookCreateSchema = z.object({
  event: z.string().min(1).max(256).describe("The event (get_agent_profile's authoring.hookEvents), e.g. Stop, PreToolUse."),
  matcher: z.string().max(MAX_PATH_CHARS).optional().describe("Tool-name matcher for tool events, e.g. \"Bash\"."),
  command: z.string().min(1).max(MAX_TEXT_CHARS).describe("The shell command it runs."),
  timeoutSec: z.number().positive().optional().describe("Timeout in seconds.")
}).strict();

const hookUpdateSchema = z.object({
  event: z.string().min(1).max(256).optional(),
  matcher: z.string().max(MAX_PATH_CHARS).nullable().optional().describe("null removes it."),
  command: z.string().min(1).max(MAX_TEXT_CHARS).optional(),
  timeoutSec: z.number().positive().nullable().optional().describe("null removes it.")
}).strict();

const pluginCreateSchema = z.union([
  z.object({ plugin: z.string().min(1).max(256), marketplace: z.string().min(1).max(256) }).strict(),
  z.object({ spec: z.string().min(1).max(MAX_PATH_CHARS) }).strict()
]);

const marketplaceCreateSchema = z.object({
  name: z.string().min(1).max(256).optional().describe("Optional: the agent derives one from the source."),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("github"), repo: z.string().min(1).max(256).describe("owner/repo"), ref: z.string().min(1).max(256).optional() }).strict(),
    z.object({ type: z.literal("git"), url: z.string().min(1).max(MAX_PATH_CHARS), ref: z.string().min(1).max(256).optional() }).strict(),
    z.object({ type: z.literal("path"), path: z.string().min(1).max(MAX_PATH_CHARS) }).strict()
  ]).describe("{type:\"github\", repo:\"owner/repo\", ref?} | {type:\"git\", url, ref?} | {type:\"path\", path}.")
}).strict();

type McpCreate = z.infer<typeof mcpCreateSchema>;
type McpUpdate = z.infer<typeof mcpUpdateSchema>;

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** `{KEY: value}` as the wire's entries (key order kept). */
function secretEntries(map: Record<string, string> | undefined): SecretEntryDraft[] | undefined {
  return map === undefined ? undefined : Object.entries(map).map(([key, value]) => ({ key, value }));
}

/**
 * The update's entries: every current key kept (`{keep: true}`) unless the patch names it — a string replaces it,
 * null removes it — then the patch's new keys. Only keys are read from `current`; values never pass through here.
 */
export function mergeSecretEntries(current: readonly SecretEntryView[] | undefined, patch: Record<string, string | null> | undefined): SecretEntryDraft[] {
  const out: SecretEntryDraft[] = [];
  const seen = new Set<string>();
  for (const entry of current ?? []) {
    if (!isRecord(entry) || typeof entry.key !== "string" || seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (patch && Object.prototype.hasOwnProperty.call(patch, entry.key)) {
      const value = patch[entry.key];
      if (typeof value === "string") out.push({ key: entry.key, value });
    } else {
      out.push({ key: entry.key, keep: true });
    }
  }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!seen.has(key) && typeof value === "string") out.push({ key, value });
  }
  return out;
}

const REMOTE_ONLY = ["url", "headers"] as const;
const STDIO_ONLY = ["command", "args", "cwd", "env"] as const;

function refuseOtherTransport(fields: Record<string, unknown>, transport: McpTransport, where: string): void {
  const wrong = (transport === "stdio" ? REMOTE_ONLY : STDIO_ONLY).filter((key) => fields[key] !== undefined);
  if (wrong.length > 0) {
    throw new ToolError("INVALID_ARGUMENT", `${where}: ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not for a${transport === "stdio" ? " stdio" : `n ${transport}`} server (stdio takes command, args, cwd, env; http and sse take url, headers).`);
  }
}

function mcpCreateDraft(mcp: McpCreate): McpServerDraft {
  const transport: McpTransport = mcp.transport ?? (mcp.url !== undefined ? "http" : "stdio");
  refuseOtherTransport(mcp, transport, "mcp");
  const draft: McpServerDraft = { name: mcp.name, transport };
  if (transport === "stdio") {
    if (mcp.command === undefined) throw new ToolError("INVALID_ARGUMENT", "mcp.command is required for a stdio server (or pass url for an http one).");
    draft.command = mcp.command;
    if (mcp.args !== undefined) draft.args = mcp.args;
    if (mcp.cwd !== undefined) draft.cwd = mcp.cwd;
    const env = secretEntries(mcp.env);
    if (env) draft.env = env;
  } else {
    if (mcp.url === undefined) throw new ToolError("INVALID_ARGUMENT", `mcp.url is required for an ${transport} server.`);
    draft.url = mcp.url;
    const headers = secretEntries(mcp.headers);
    if (headers) draft.headers = headers;
  }
  if (mcp.advanced !== undefined) draft.advanced = mcp.advanced;
  return draft;
}

/** Keys merged over `current`: a key the patch names takes its value, null removes it. */
function mergeRecord(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The whole draft an MCP update sends: the current definition with the patch applied (secrets by key only). */
function mcpUpdateDraft(current: McpServerView, patch: McpUpdate): McpServerDraft {
  const transport = patch.transport ?? current.transport;
  refuseOtherTransport(patch, transport, "mcp");
  const family = (t: McpTransport) => (t === "stdio" ? "stdio" : "remote");
  const carry = family(transport) === family(current.transport);
  const draft: McpServerDraft = { name: patch.name ?? current.name, transport };
  if (transport === "stdio") {
    const command = patch.command ?? (carry ? current.command : undefined);
    if (command === undefined) throw new ToolError("INVALID_ARGUMENT", "mcp.command is required when switching the server to stdio.");
    draft.command = command;
    const args = patch.args ?? (carry ? current.args : undefined);
    if (args !== undefined) draft.args = args;
    const cwd = patch.cwd === null ? undefined : patch.cwd ?? (carry ? current.cwd : undefined);
    if (cwd !== undefined) draft.cwd = cwd;
    draft.env = mergeSecretEntries(carry ? current.env : [], patch.env);
  } else {
    const url = patch.url ?? (carry ? current.url : undefined);
    if (url === undefined) throw new ToolError("INVALID_ARGUMENT", `mcp.url is required when switching the server to ${transport}.`);
    draft.url = url;
    draft.headers = mergeSecretEntries(carry ? current.headers : [], patch.headers);
  }
  const advanced = mergeRecord(current.advanced, patch.advanced);
  if (Object.keys(advanced).length > 0) draft.advanced = advanced;
  return draft;
}

const DRAFT_KEYS = ["mcp", "skill", "command", "hook", "plugin", "marketplace"] as const satisfies readonly ProfileItemKind[];

/** The one kind-named object the call carries. */
function pickKind(args: Record<string, unknown>, allowed: readonly ProfileItemKind[], tool: string): ProfileItemKind {
  const given = DRAFT_KEYS.filter((key) => args[key] !== undefined);
  if (given.length !== 1 || !allowed.includes(given[0]!)) {
    const names = allowed.join(", ");
    throw new ToolError("INVALID_ARGUMENT", given.length === 0 ? `${tool}: pass one of ${names}.` : `${tool}: pass exactly one of ${names} (got ${given.join(", ")}).`);
  }
  return given[0]!;
}

function assertCreatable(agent: Agent, kind: ProfileItemKind): void {
  if (!AGENT_PROFILE_CREATABLE_KINDS[agent].includes(kind)) {
    throw new ToolError("KIND_NOT_SUPPORTED", `${label(agent)} cannot create ${PROFILE_ITEM_KIND_LABELS[kind].many.toLowerCase()} here; it can create: ${AGENT_PROFILE_CREATABLE_KINDS[agent].join(", ")}.`);
  }
}

/** What an author needs to know about one agent: kinds, MCP transports and extras, hook events, frontmatter fields. */
function authoringView(agent: Agent): Record<string, unknown> {
  const fields = PROFILE_FRONTMATTER_FIELDS[agent];
  const fieldList = (kind: "skill" | "command") => (fields[kind] ?? []).map((f) => ({ key: f.key, type: f.type, ...(f.required ? { required: true } : {}) }));
  return {
    kinds: AGENT_PROFILE_KINDS[agent],
    creatableKinds: AGENT_PROFILE_CREATABLE_KINDS[agent],
    copyableKinds: PROFILE_COPYABLE_KINDS,
    mcpTransports: MCP_TRANSPORTS[agent],
    mcpAdvancedFields: MCP_ADVANCED_FIELDS[agent].map((f) => ({ key: f.key, type: f.type })),
    ...(PROFILE_HOOK_EVENTS[agent] ? { hookEvents: PROFILE_HOOK_EVENTS[agent] } : {}),
    frontmatterFields: { skill: fieldList("skill"), command: fieldList("command") }
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const listAgentProfiles = defineTool({
  name: "list_agent_profiles",
  title: "List agent profiles",
  description: "Every agent CLI whose global config Orquester manages (claude, codex, grok, opencode): installed, version, and how many MCP servers, skills, plugins, marketplaces, hooks and commands it has. get_agent_profile lists one agent's items.",
  input: { installedOnly: z.boolean().default(false).describe("Only the agents installed on this host.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const body = await profileClient(api).overview();
    const agents = (body.agents ?? []).filter((a) => !args.installedOnly || a.installed).map((a) => ({
      agent: a.agent,
      label: AGENT_PROFILE_AGENT_LABELS[a.agent] ?? a.agent,
      installed: a.installed,
      ...(a.version ? { version: a.version } : {}),
      counts: a.counts ?? {}
    }));
    return { agents };
  }
});

const getAgentProfile = defineTool({
  name: "get_agent_profile",
  title: "Get an agent's profile",
  description: "One agent's global items (MCP servers, skills, plugins, marketplaces, hooks, commands): id, kind, name, description, enabled, source, locked/toggleable/editable/deletable, warnings, revision — plus its instruction file (CLAUDE.md / AGENTS.md) info, unreadable files, and `authoring` (what can be created and how). Filter with kind and query; long lists are cut (truncated).",
  input: {
    agent: agentArg,
    kind: z.enum(PROFILE_ITEM_KINDS).optional().describe("Only items of this kind."),
    query: z.string().min(1).max(256).optional().describe("Only items whose id, name, description or source contains this text (case-insensitive).")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const snapshot = await profileClient(api).snapshot(args.agent);
    const counts: Partial<Record<ProfileItemKind, number>> = {};
    for (const item of snapshot.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    const needle = args.query?.toLowerCase();
    const matching = snapshot.items.filter((item) =>
      (args.kind === undefined || item.kind === args.kind) &&
      (needle === undefined || [item.id, item.name, item.description ?? "", item.source?.label ?? ""].some((text) => text.toLowerCase().includes(needle)))
    );
    const result: Record<string, unknown> = { agent: snapshot.agent, label: label(args.agent), installed: snapshot.installed };
    if (snapshot.version) result.version = snapshot.version;
    if (!snapshot.installed) result.note = `${label(args.agent)} is not installed on this host: it has no items to manage.`;
    result.counts = counts;
    result.instructions = instructionsView(snapshot.instructions);
    if (snapshot.fileErrors.length > 0) {
      result.fileErrors = snapshot.fileErrors.slice(0, 20).map((f) => ({ path: f.path, message: clipText(f.message, MAX_ROW_TEXT) }));
      result.fileErrorsNote = "These files could not be parsed: the list is partial and changes to them are refused (CONFIG_UNREADABLE) until they are fixed by hand.";
    }
    result.authoring = authoringView(args.agent);
    result.matched = matching.length;
    result.truncated = false;
    return fitRows(result, "items", matching.map(itemView), "Items past the result size cap were left out: narrow the list with kind or query.");
  }
});

const getAgentProfileItem = defineTool({
  name: "get_agent_profile_item",
  title: "Get an agent profile item",
  description: "One item's editable detail: a skill's or command's frontmatter and markdown body (and a skill's other files); an MCP server's definition — env and headers as keys only ({key, set: true}), values are write-only and never shown; a hook, plugin or marketplace. A body too big for one result is cut (bodyTruncated).",
  input: { agent: agentArg, id: idArg },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const detail = await profileClient(api).item(args.agent, args.id);
    const item = { ...itemView(detail.item), ...(detail.item.path ? { path: detail.item.path } : {}) };
    const result: Record<string, unknown> = { agent: args.agent, item };
    switch (detail.kind) {
      case "mcp":
        result.mcp = mcpView(detail.mcp);
        result.secretsNote = "env and header values are write-only: update_agent_profile_item keeps every key you do not name.";
        return result;
      case "hook":
        result.hook = detail.hook;
        return result;
      case "plugin":
        result.plugin = detail.plugin;
        return result;
      case "marketplace":
        result.marketplace = detail.marketplace?.source?.type === "git"
          ? { ...detail.marketplace, source: { ...detail.marketplace.source, url: redactUrlCredentials(detail.marketplace.source.url) } }
          : detail.marketplace;
        return result;
      case "skill":
      case "command": {
        const body = typeof detail.document?.body === "string" ? detail.document.body : "";
        const document: Record<string, unknown> = { frontmatter: detail.document?.frontmatter ?? {}, body: "" };
        result.document = document;
        if (Array.isArray(detail.files)) {
          result.files = detail.files.slice(0, MAX_SKILL_FILES);
          if (detail.files.length > MAX_SKILL_FILES) result.filesOmitted = detail.files.length - MAX_SKILL_FILES;
        }
        const room = PROFILE_RESULT_BUDGET - resultBytes(result) - 400;
        const fitted = fitJsonBytes(body, Math.max(0, room));
        document.body = fitted.text;
        if (fitted.truncated) {
          result.bodyTruncated = true;
          result.bodyChars = body.length;
          result.bodyNote = "The body was cut to fit the result. Never send a cut body back: update_agent_profile_item without body keeps the whole current body.";
        }
        return result;
      }
    }
    return result;
  }
});

const createAgentProfileItem = defineTool({
  name: "create_agent_profile_item",
  title: "Create an agent profile item",
  description: "Add one item to an agent's global config — pass exactly one of mcp, skill, command, hook, plugin (install from a marketplace, or an OpenCode npm spec) or marketplace. MCP env/headers are {KEY: value} maps: values are write-only secrets, never returned — and stay in YOUR transcript, so prefer asking the user to enter secrets in Orquester's UI. Returns the new ids, notes and a summary.",
  input: {
    agent: agentArg,
    mcp: mcpCreateSchema.optional().describe("An MCP server: {name, transport?, command?, args?, cwd?, env?, url?, headers?, advanced?}."),
    skill: documentCreateSchema.optional().describe("A skill: {name, frontmatter: {description, …}, body}."),
    command: documentCreateSchema.optional().describe("A slash command: {name, frontmatter?, body}."),
    hook: hookCreateSchema.optional().describe("A hook: {event, matcher?, command, timeoutSec?}."),
    plugin: pluginCreateSchema.optional().describe("{plugin, marketplace} (list_marketplace_plugins shows a marketplace's plugins) — or, for OpenCode, {spec}: an npm package spec or a file path."),
    marketplace: marketplaceCreateSchema.optional().describe("A plugin marketplace: {name?, source}."),
    onConflict: onConflictArg
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const kind = pickKind(args, DRAFT_KEYS, "create_agent_profile_item");
    assertCreatable(args.agent, kind);
    let draft: ProfileItemDraft;
    switch (kind) {
      case "mcp":
        draft = { kind, mcp: mcpCreateDraft(args.mcp!) };
        break;
      case "skill":
      case "command": {
        const doc = (kind === "skill" ? args.skill : args.command)!;
        draft = { kind, document: { name: doc.name, frontmatter: doc.frontmatter ?? {}, body: doc.body ?? "" } };
        break;
      }
      case "hook": {
        const hook: HookDraft = { event: args.hook!.event, command: args.hook!.command };
        if (args.hook!.matcher !== undefined) hook.matcher = args.hook!.matcher;
        if (args.hook!.timeoutSec !== undefined) hook.timeoutSec = args.hook!.timeoutSec;
        draft = { kind, hook };
        break;
      }
      case "plugin":
        draft = { kind, plugin: args.plugin! };
        break;
      case "marketplace":
        draft = { kind, marketplace: args.marketplace! };
        break;
    }
    const res = await profileClient(api).create(args.agent, { draft, onConflict: args.onConflict });
    return mutationResult(res, { created: true, agent: args.agent, kind });
  }
});

const updateAgentProfileItem = defineTool({
  name: "update_agent_profile_item",
  title: "Edit or rename an agent profile item",
  description: "Edit an MCP server, skill, command or hook — pass the object named after its kind with only what changes; everything left out keeps its current value (a new name renames). MCP env/headers: a key set to a string sets it, null removes it, a key not mentioned is kept. Frontmatter: null removes a key. Plugins and marketplaces cannot be edited. A hook's id changes: see itemIds.",
  input: {
    agent: agentArg,
    id: idArg,
    revision: revisionArg,
    mcp: mcpUpdateSchema.optional().describe("For an MCP server: {name?, transport?, command?, args?, cwd?, env?, url?, headers?, advanced?}."),
    skill: documentUpdateSchema.optional().describe("For a skill: {name?, frontmatter?, body?}."),
    command: documentUpdateSchema.optional().describe("For a command: {name?, frontmatter?, body?}."),
    hook: hookUpdateSchema.optional().describe("For a hook: {event?, matcher?, command?, timeoutSec?}.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const kind = pickKind(args, ["mcp", "skill", "command", "hook"], "update_agent_profile_item");
    const client = profileClient(api);
    const detail = await client.item(args.agent, args.id);
    if (detail.kind === "plugin" || detail.kind === "marketplace") {
      throw new ToolError("KIND_NOT_SUPPORTED", `${PROFILE_ITEM_KIND_LABELS[detail.kind].many} cannot be edited; remove it and install it again.`);
    }
    if (detail.kind !== kind) {
      throw new ToolError("INVALID_ARGUMENT", `"${clipText(args.id, MAX_ECHO_CHARS)}" is a ${PROFILE_ITEM_KIND_LABELS[detail.kind].one.toLowerCase()}: pass its changes as ${detail.kind}.`);
    }
    let draft: ProfileItemDraft;
    if (detail.kind === "mcp") {
      draft = { kind: "mcp", mcp: mcpUpdateDraft(detail.mcp, args.mcp!) };
    } else if (detail.kind === "skill" || detail.kind === "command") {
      const patch = (detail.kind === "skill" ? args.skill : args.command)!;
      draft = {
        kind: detail.kind,
        document: { name: patch.name ?? detail.item.name, frontmatter: patch.frontmatter ?? {}, body: patch.body ?? detail.document.body }
      };
    } else if (detail.kind === "hook") {
      const patch = args.hook!;
      const hook: HookDraft = { event: patch.event ?? detail.hook.event, command: patch.command ?? detail.hook.command };
      const matcher = patch.matcher === null ? undefined : patch.matcher ?? detail.hook.matcher;
      if (matcher !== undefined) hook.matcher = matcher;
      const timeoutSec = patch.timeoutSec === null ? undefined : patch.timeoutSec ?? detail.hook.timeoutSec;
      if (timeoutSec !== undefined) hook.timeoutSec = timeoutSec;
      draft = { kind: "hook", hook };
    } else {
      throw new ToolError("INVALID_ARGUMENT", "update_agent_profile_item: nothing to change.");
    }
    const revision = args.revision ?? detail.item.revision;
    const res = await withItemConflict(client, args.agent, args.id, () => client.update(args.agent, args.id, revision, draft));
    return mutationResult(res, { updated: true, agent: args.agent, previousId: args.id });
  }
});

const setAgentProfileItemEnabled = defineTool({
  name: "set_agent_profile_item_enabled",
  title: "Turn an agent profile item on or off",
  description: "Turn an item on or off (natively where the agent has an off switch, else Orquester stashes it and restores it later). Only items with toggleable: true (get_agent_profile).",
  input: {
    agent: agentArg,
    id: idArg,
    enabled: z.boolean().describe("true turns it on, false off."),
    revision: revisionArg
  },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const client = profileClient(api);
    const revision = args.revision ?? (await currentItem(client, args.agent, args.id)).revision;
    const res = await withItemConflict(client, args.agent, args.id, () => client.setEnabled(args.agent, args.id, revision, args.enabled));
    return mutationResult(res, { enabled: args.enabled, agent: args.agent });
  }
});

const deleteAgentProfileItem = defineTool({
  name: "delete_agent_profile_item",
  title: "Delete an agent profile item",
  description: "Delete an item from the agent's config (a plugin is uninstalled, a marketplace removed). Orquester keeps a backup of every file it rewrites, but there is no undo here. Requires confirm: true. To pause one instead, set_agent_profile_item_enabled {enabled: false}.",
  input: {
    agent: agentArg,
    id: idArg,
    revision: revisionArg,
    confirm: z.literal(true).describe("Must be true: the item is removed from the agent's config.")
  },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    const client = profileClient(api);
    const revision = args.revision ?? (await currentItem(client, args.agent, args.id)).revision;
    const res = await withItemConflict(client, args.agent, args.id, () => client.remove(args.agent, args.id, revision));
    return { deleted: true, agent: args.agent, id: args.id, notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
  }
});

const copyAgentProfileItem = defineTool({
  name: "copy_agent_profile_item",
  title: "Copy an agent profile item to another agent",
  description: "Copy an MCP server, skill or command to another agent, converted to its format (secret values move daemon-side, never through you). Fields the target cannot hold are dropped and named in notes. Returns the target's new ids and a summary.",
  input: {
    agent: agentArg.describe("The agent the item is on."),
    id: idArg,
    toAgent: z.enum(AGENT_PROFILE_AGENTS).describe("The agent to copy it to."),
    onConflict: onConflictArg
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const res = await profileClient(api).copy(args.agent, args.id, args.toAgent, args.onConflict);
    return mutationResult(res, { copied: true, fromAgent: args.agent, fromId: args.id, agent: args.toAgent });
  }
});

const trustAgentProfileHook = defineTool({
  name: "trust_agent_profile_hook",
  title: "Trust a Codex hook",
  description: "Codex only: mark a hook as trusted so Codex runs it (a hook with the \"trust\" warning action). The hook's command runs on every matching event: read it first (get_agent_profile_item).",
  input: { agent: agentArg, id: idArg, revision: revisionArg },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const client = profileClient(api);
    const revision = args.revision ?? (await currentItem(client, args.agent, args.id)).revision;
    const res = await withItemConflict(client, args.agent, args.id, () => client.trust(args.agent, args.id, revision));
    return mutationResult(res, { trusted: true, agent: args.agent });
  }
});

const getAgentInstructions = defineTool({
  name: "get_agent_instructions",
  title: "Read an agent's global instructions",
  description: "The agent's global instruction file (Claude: ~/.claude/CLAUDE.md; Codex, Grok, OpenCode: their AGENTS.md): its text, path and revision. A text too big for one result is paged: call again with offset = nextOffset.",
  input: {
    agent: agentArg,
    offset: z.number().int().min(0).default(0).describe("Character offset to read from (the previous nextOffset).")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const { text, info } = await profileClient(api).instructions(args.agent);
    const result: Record<string, unknown> = { agent: args.agent, instructions: instructionsView(info), totalChars: text.length };
    if (args.offset > text.length) throw new ToolError("INVALID_ARGUMENT", `offset ${args.offset} is past the end of the text (${text.length} characters).`);
    const rest = text.slice(args.offset);
    const fitted = fitJsonBytes(rest, Math.max(1_000, PROFILE_RESULT_BUDGET - resultBytes(result) - 300));
    result.text = fitted.text;
    if (args.offset > 0) result.offset = args.offset;
    if (fitted.truncated) {
      result.truncated = true;
      result.nextOffset = args.offset + fitted.text.length;
      result.note = "The text continues: call again with offset = nextOffset. write_agent_instructions replaces the WHOLE file — never write back a partial text.";
    }
    return result;
  }
});

const writeAgentInstructions = defineTool({
  name: "write_agent_instructions",
  title: "Write an agent's global instructions",
  description: "Replace the agent's whole global instruction file (CLAUDE.md / AGENTS.md) with text; it is created when missing. Every agent session of that CLI reads it. Read it first (get_agent_instructions) and send the complete new text.",
  input: {
    agent: agentArg,
    text: z.string().max(MAX_TEXT_CHARS).describe("The complete new file content (markdown)."),
    revision: z.string().max(1_024).optional().describe("The revision get_agent_instructions returned (\"\" means the file must not exist yet). Omit it to write over whatever is current.")
  },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    const client = profileClient(api);
    const revision = args.revision ?? (await client.instructions(args.agent)).info.revision;
    let res: ProfileMutationResponse;
    try {
      res = await client.writeInstructions(args.agent, args.text, revision);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "PROFILE_CONFLICT") throw error;
      let info: ProfileInstructionsInfo | undefined;
      try { info = (await client.instructions(args.agent)).info; } catch { /* the conflict is the answer either way */ }
      throw new ToolError(
        "PROFILE_CONFLICT",
        `${error.message} The file changed since that revision was read${info ? `; it is now at revision ${JSON.stringify(info.revision)} (detail.instructions)` : ""}. Re-read it with get_agent_instructions, merge your change, then write again.`,
        info ? { instructions: instructionsView(info) } : undefined
      );
    }
    return { written: true, agent: args.agent, instructions: instructionsView(res.snapshot.instructions), notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
  }
});

const importAgentProfileItems = defineTool({
  name: "import_agent_profile_items",
  title: "Import skills or commands from Git",
  description: "Two steps. 1) {agent, url}: clone and scan a Git repository (https or ssh; a …/tree/<ref>/<path> URL picks a folder) → {importId, candidates: [{ref, kind, name, exists}]}. 2) {agent, importId, picks: [ref…], onConflict?}: import the picked candidates (the scan expires after 15 minutes). The URL is never echoed back.",
  input: {
    agent: agentArg,
    url: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("Step 1: the Git URL to scan."),
    importId: z.string().min(1).max(1_024).optional().describe("Step 2: the scan's importId."),
    picks: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1).max(500).optional().describe("Step 2: the candidates' refs to import."),
    onConflict: onConflictArg
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const client = profileClient(api);
    const scan = args.url !== undefined;
    const take = args.importId !== undefined || args.picks !== undefined;
    if (scan === take || (take && (args.importId === undefined || args.picks === undefined))) {
      throw new ToolError("INVALID_ARGUMENT", "Pass url to scan a repository, or importId and picks to import what a scan found — not both.");
    }
    if (scan) {
      const body = await client.importGit(args.agent, args.url!);
      const candidates = (body.candidates ?? []).map((c) => ({ ref: c.ref, kind: c.kind, name: c.name, ...(c.description ? { description: clipText(c.description, MAX_ROW_TEXT) } : {}), exists: c.exists }));
      const result: Record<string, unknown> = {
        scanned: true,
        agent: args.agent,
        importId: body.importId,
        notes: (body.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)),
        next: candidates.length > 0
          ? "Import with import_agent_profile_items {agent, importId, picks: [the refs you want]}; a candidate with exists: true needs onConflict replace or keep-both."
          : "Nothing importable was found (skills are folders with a SKILL.md; commands are .md files)."
      };
      return fitRows(result, "candidates", candidates, "Candidates past the result size cap were left out.");
    }
    const res = await client.create(args.agent, { import: { importId: args.importId!, picks: args.picks! }, onConflict: args.onConflict });
    return mutationResult(res, { imported: true, agent: args.agent });
  }
});

const listMarketplacePlugins = defineTool({
  name: "list_marketplace_plugins",
  title: "List a marketplace's plugins",
  description: "The plugins a marketplace the agent has added offers: name, description, version, installed. Install one with create_agent_profile_item {agent, plugin: {plugin, marketplace}}.",
  input: {
    agent: agentArg,
    marketplace: z.string().min(1).max(256).describe("The marketplace's name (a marketplace item's name in get_agent_profile).")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const body = await profileClient(api).marketplacePlugins(args.agent, args.marketplace);
    const plugins = (body.plugins ?? []).map((p) => ({ name: p.name, ...(p.description ? { description: clipText(p.description, MAX_ROW_TEXT) } : {}), ...(p.version ? { version: p.version } : {}), installed: p.installed }));
    return fitRows({ agent: args.agent, marketplace: args.marketplace }, "plugins", plugins, "Plugins past the result size cap were left out.");
  }
});

export const agentProfileTools: ToolDef[] = [
  listAgentProfiles, getAgentProfile, getAgentProfileItem, createAgentProfileItem, updateAgentProfileItem,
  setAgentProfileItemEnabled, deleteAgentProfileItem, copyAgentProfileItem, trustAgentProfileHook,
  getAgentInstructions, writeAgentInstructions, importAgentProfileItems, listMarketplacePlugins
];
