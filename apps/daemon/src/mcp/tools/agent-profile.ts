// Catalog family module `agent-profile` (Agent profiles) — plan Task 11 (unified MCP design
// 2026-10-15 §4 rows 38–39, §4.1, §7, §12.1): each agent CLI's own global configuration — MCP
// servers, skills, plugins, plugin marketplaces, hooks, slash commands and the global instruction
// file (docs/superpowers/specs/2026-09-28-agent-profile-design.md).
//
// - `get_agent_profile` (Read, `reads`): every CLI's summary; one CLI's items; one item; the
//   instruction file (paged); a marketplace's plugins. Replaces `list_agent_profiles`,
//   `get_agent_profile_item`, `get_agent_instructions`, `list_marketplace_plugins`.
// - `edit_agent_profile` (Admin `agent-profile`, `agent-profile-editing`): a batch of ≤ 10 changes
//   under ONE approval card for chat callers — every action, `import_scan` included (network egress
//   to an arbitrary URL); never grantable; never for workflow-owned chats (the gate). Replaces the
//   eight write tools. The card, its validation and its pins: `./agent-profile-preview.ts`.
//
// Every tool reaches the daemon's `agentProfileRoutes` through `DaemonApi` only. Secret values — an
// MCP server's env and headers — are WRITE-ONLY: never returned, quoted or logged; a view names
// keys only (`{key, set: true}`), rebuilt here from the key alone whatever the daemon sent. Chat
// callers may leave a value to the user (`{ask: true}`): it is typed in the card and goes from the
// card's answer to the write, never through the agent. Every result is bounded below the
// 60 000-byte cap and says what it cut.

import { z } from "zod";
import {
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_CREATABLE_KINDS,
  AGENT_PROFILE_KINDS,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  PROFILE_COPYABLE_KINDS,
  PROFILE_FRONTMATTER_FIELDS,
  PROFILE_HOOK_EVENTS,
  PROFILE_ITEM_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  type HookDraft,
  type McpServerDraft,
  type McpServerView,
  type McpTransport,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemDraft,
  type ProfileItemKind,
  type ProfileMutationResponse,
  type SecretEntryDraft,
  type SecretEntryView
} from "@orquester/api";

import { defineTool, DESTRUCTIVE, READ_ONLY, type AnyOrquesterTool, type CallContext, type ScopeClaim } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import {
  CLI_LABELS,
  changeKind,
  editPreview,
  isAsk,
  PROFILE_ACTIONS,
  profileClient,
  redactUrlCredentials,
  validateChanges,
  verifyPins,
  type Agent,
  type McpChange,
  type ProfileChange,
  type ProfileClient,
  type SecretInput
} from "./agent-profile-preview.ts";

/** What a profile tool plans its result to: the cap less room for ok()'s own framing and a few keys added last. */
const PROFILE_RESULT_BUDGET = MAX_RESULT_BYTES - 4_000;
/** The longest description, warning or note a row carries, in code points. */
const MAX_ROW_TEXT = 300;
const MAX_NOTE_TEXT = 500;
/** A skill's other files listed by get_agent_profile {itemId}. */
const MAX_SKILL_FILES = 200;
const MAX_SECRET_VALUE_CHARS = 16_384;
const MAX_PATH_CHARS = 4_096;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
/** Changes one edit_agent_profile call may carry (one card). */
export const MAX_PROFILE_CHANGES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Agent profiles are global: no project, no session (§5.2 "Global" row). */
const GLOBAL_SCOPE = (writes: boolean): ScopeClaim => ({ projects: [], sessions: [], reads: writes ? "none" : "metadata", writes, causesTurnIn: [] });

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
function fitRows(result: Record<string, unknown>, key: string, rows: unknown[], note: string, budget = PROFILE_RESULT_BUDGET): Record<string, unknown> {
  result[key] = rows;
  if (resultBytes(result) <= budget) return result;
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
    if (resultBytes(result) <= budget) lo = mid;
    else hi = mid - 1;
  }
  place(lo);
  return result;
}

/**
 * What a write answers: the ids it created or changed, the daemon's notes, and a compact summary
 * of each changed item (from the fresh snapshot the write returned). An id the snapshot no longer
 * lists (a delete) is named in `absentIds`.
 */
function mutationResult(res: ProfileMutationResponse, head: Record<string, unknown>, budget: number): Record<string, unknown> {
  const itemIds = Array.isArray(res.itemIds) ? res.itemIds : [];
  const byId = new Map((res.snapshot?.items ?? []).map((item) => [item.id, item]));
  const items = itemIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [itemView(item)] : [];
  });
  const absentIds = itemIds.filter((id) => !byId.has(id));
  const result: Record<string, unknown> = { ...head, itemIds, notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
  if (absentIds.length > 0) result.absentIds = absentIds;
  return fitRows(result, "items", items, "Changed items past the size cap were left out of `items`: itemIds names them all; get_agent_profile shows them.", budget);
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
// get_agent_profile
// ---------------------------------------------------------------------------

const agentArg = z.enum(AGENT_PROFILE_AGENTS);

async function profileSummary(client: ProfileClient): Promise<Record<string, unknown>> {
  const body = await client.overview();
  const agents = (body.agents ?? []).map((a) => ({
    agent: a.agent,
    label: CLI_LABELS[a.agent] ?? a.agent,
    installed: a.installed,
    ...(a.version ? { version: a.version } : {}),
    counts: a.counts ?? {}
  }));
  return { agents };
}

async function profileItems(client: ProfileClient, agent: Agent, kind: ProfileItemKind | undefined, query: string | undefined): Promise<Record<string, unknown>> {
  const snapshot = await client.snapshot(agent);
  const counts: Partial<Record<ProfileItemKind, number>> = {};
  for (const item of snapshot.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  const needle = query?.toLowerCase();
  const matching = snapshot.items.filter((item) =>
    (kind === undefined || item.kind === kind) &&
    (needle === undefined || [item.id, item.name, item.description ?? "", item.source?.label ?? ""].some((text) => text.toLowerCase().includes(needle)))
  );
  const result: Record<string, unknown> = { agent: snapshot.agent, label: CLI_LABELS[agent], installed: snapshot.installed };
  if (snapshot.version) result.version = snapshot.version;
  if (!snapshot.installed) result.note = `${CLI_LABELS[agent]} is not installed on this host: it has no items to manage.`;
  result.counts = counts;
  result.instructions = instructionsView(snapshot.instructions);
  if (snapshot.fileErrors.length > 0) {
    result.fileErrors = snapshot.fileErrors.slice(0, 20).map((f) => ({ path: f.path, message: clipText(f.message, MAX_ROW_TEXT) }));
    result.fileErrorsNote = "These files could not be parsed: the list is partial and changes to them are refused (CONFIG_UNREADABLE) until they are fixed by hand.";
  }
  result.authoring = authoringView(agent);
  result.matched = matching.length;
  result.truncated = false;
  return fitRows(result, "items", matching.map(itemView), "Items past the result size cap were left out: narrow the list with kind or query.");
}

async function profileItem(client: ProfileClient, agent: Agent, id: string): Promise<Record<string, unknown>> {
  const detail = await client.item(agent, id);
  const item = { ...itemView(detail.item), ...(detail.item.path ? { path: detail.item.path } : {}) };
  const result: Record<string, unknown> = { agent, item };
  switch (detail.kind) {
    case "mcp":
      result.mcp = mcpView(detail.mcp);
      result.secretsNote = "env and header values are write-only: an update keeps every key you do not name.";
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
        result.bodyNote = "The body was cut to fit the result. Never send a cut body back: an update without body keeps the whole current body.";
      }
      return result;
    }
  }
  return result;
}

async function profileInstructions(client: ProfileClient, agent: Agent, offset: number): Promise<Record<string, unknown>> {
  const { text, info } = await client.instructions(agent);
  const result: Record<string, unknown> = { agent, instructions: instructionsView(info), totalChars: text.length };
  if (offset > text.length) throw new ToolError("INVALID_ARGUMENT", `offset ${offset} is past the end of the text (${text.length} characters).`);
  const fitted = fitJsonBytes(text.slice(offset), Math.max(1_000, PROFILE_RESULT_BUDGET - resultBytes(result) - 300));
  result.text = fitted.text;
  if (offset > 0) result.offset = offset;
  if (fitted.truncated) {
    result.truncated = true;
    result.nextOffset = offset + fitted.text.length;
    result.note = "The text continues: call again with offset = nextOffset. write_instructions replaces the WHOLE file — never write back a partial text.";
  }
  return result;
}

async function marketplacePlugins(client: ProfileClient, agent: Agent, marketplace: string): Promise<Record<string, unknown>> {
  const body = await client.marketplacePlugins(agent, marketplace);
  const plugins = (body.plugins ?? []).map((p) => ({ name: p.name, ...(p.description ? { description: clipText(p.description, MAX_ROW_TEXT) } : {}), ...(p.version ? { version: p.version } : {}), installed: p.installed }));
  return fitRows({ agent, marketplace }, "plugins", plugins, "Plugins past the result size cap were left out.");
}

const getAgentProfile = defineTool({
  name: "get_agent_profile",
  title: "Get agent config",
  description:
    "Agent CLIs' global config (Claude Code, Codex, Grok, OpenCode). {} → each CLI: installed, version, counts. {agent} → its items (id, source, revision), instruction file, `authoring`. {agent, itemId} → one item (MCP env/header values never shown). {agent, instructions: true} → the instruction file, paged by offset. {agent, marketplace} → its plugins.",
  input: {
    agent: agentArg.optional().describe("Omit for every CLI's summary."),
    kind: z.enum(PROFILE_ITEM_KINDS).optional(),
    query: z.string().min(1).max(256).optional().describe("Filter: id, name, description or source contains it."),
    itemId: z.string().min(1).max(1_024).optional().describe("e.g. \"mcp:jira\", \"skill:handoff\"."),
    instructions: z.boolean().optional(),
    offset: z.number().int().min(0).optional().describe("The previous nextOffset."),
    marketplace: z.string().min(1).max(256).optional().describe("A marketplace's name.")
  },
  audiences: ["external", "chat"],
  toolset: "reads",
  tier: "read",
  scope: async () => GLOBAL_SCOPE(false),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api }) {
    const client = profileClient(api);
    const modes = (["itemId", "instructions", "marketplace"] as const).filter((key) => args[key] !== undefined && args[key] !== false);
    if (args.agent === undefined) {
      const given = (["kind", "query", "itemId", "instructions", "offset", "marketplace"] as const).filter((key) => args[key] !== undefined);
      if (given.length > 0) throw new ToolError("INVALID_ARGUMENT", `${given.join(", ")} ${given.length === 1 ? "needs" : "need"} agent.`);
      return profileSummary(client);
    }
    if (modes.length > 1) throw new ToolError("INVALID_ARGUMENT", `Pass one of itemId, instructions, marketplace (got ${modes.join(", ")}).`);
    if (modes.length === 1 && (args.kind !== undefined || args.query !== undefined)) throw new ToolError("INVALID_ARGUMENT", "kind and query filter the item list only.");
    if (args.offset !== undefined && modes[0] !== "instructions") throw new ToolError("INVALID_ARGUMENT", "offset pages the instruction file only.");
    switch (modes[0]) {
      case "itemId":
        return profileItem(client, args.agent, args.itemId!);
      case "instructions":
        return profileInstructions(client, args.agent, args.offset ?? 0);
      case "marketplace":
        return marketplacePlugins(client, args.agent, args.marketplace!);
      default:
        return profileItems(client, args.agent, args.kind, args.query);
    }
  }
});

// ---------------------------------------------------------------------------
// edit_agent_profile
// ---------------------------------------------------------------------------

const secretValue = z.union([z.string().max(MAX_SECRET_VALUE_CHARS), z.null(), z.object({ ask: z.literal(true) }).strict()]);
const secretMap = z.record(z.string().min(1).max(256), secretValue);
const docSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  frontmatter: z.record(z.unknown()).optional().describe("e.g. {description}; update changes only the keys named, null removes one."),
  body: z.string().max(MAX_TEXT_CHARS).optional().describe("The whole markdown body; update: omit to keep.")
}).strict();

const changeSchema = z.object({
  action: z.enum(PROFILE_ACTIONS),
  id: z.string().min(1).max(1_024).optional().describe("From get_agent_profile, e.g. \"skill:handoff\"."),
  revision: z.string().max(1_024).optional().describe("As read; a stale one is refused."),
  mcp: z.object({
    name: z.string().min(1).max(64).optional(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().min(1).max(MAX_PATH_CHARS).optional(),
    args: z.array(z.string().max(MAX_PATH_CHARS)).max(500).optional(),
    cwd: z.string().min(1).max(MAX_PATH_CHARS).nullable().optional(),
    env: secretMap.optional().describe("{KEY: value | {ask: true} | null (remove)}; keys not named are kept."),
    url: z.string().min(1).max(MAX_PATH_CHARS).optional(),
    headers: secretMap.optional().describe("As env."),
    advanced: z.record(z.unknown()).optional().describe("Non-secret extras (get_agent_profile authoring.mcpAdvancedFields).")
  }).strict().optional(),
  skill: docSchema.optional(),
  command: docSchema.optional(),
  hook: z.object({
    event: z.string().min(1).max(256).optional(),
    matcher: z.string().max(MAX_PATH_CHARS).nullable().optional(),
    command: z.string().min(1).max(MAX_TEXT_CHARS).optional(),
    timeoutSec: z.number().positive().nullable().optional()
  }).strict().optional(),
  plugin: z.object({
    plugin: z.string().min(1).max(256).optional(),
    marketplace: z.string().min(1).max(256).optional(),
    spec: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("OpenCode: an npm spec or file path.")
  }).strict().optional(),
  marketplace: z.object({
    name: z.string().min(1).max(256).optional(),
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("github"), repo: z.string().min(1).max(256), ref: z.string().min(1).max(256).optional() }).strict(),
      z.object({ type: z.literal("git"), url: z.string().min(1).max(MAX_PATH_CHARS), ref: z.string().min(1).max(256).optional() }).strict(),
      z.object({ type: z.literal("path"), path: z.string().min(1).max(MAX_PATH_CHARS) }).strict()
    ])
  }).strict().optional(),
  toAgent: agentArg.optional(),
  onConflict: z.enum(["fail", "replace", "keep-both"]).optional().describe("If an item of that name exists. Default fail."),
  text: z.string().max(MAX_TEXT_CHARS).optional().describe("write_instructions: the whole new file."),
  url: z.string().min(1).max(MAX_PATH_CHARS).optional().describe("import_scan: a Git URL (https or ssh; …/tree/<ref>/<path> picks a folder)."),
  importId: z.string().min(1).max(1_024).optional(),
  picks: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1).max(500).optional().describe("import_pick: candidate refs from import_scan.")
}).strict();

/** The card values for change `index` (`c<i>.env.<KEY>`): an asked value the card did not return is refused. */
function resolveSecrets(map: Record<string, SecretInput> | undefined, index: number, field: "env" | "headers", ctx: CallContext): Record<string, string | null> | undefined {
  if (map === undefined) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(map)) {
    if (isAsk(value)) {
      const typed = ctx.approval?.secrets?.[`c${index}.${field}.${key}`];
      if (typeof typed !== "string") throw new ToolError("INVALID_ARGUMENT", `changes[${index}]: no value was typed for ${field} ${clipText(key, MAX_ECHO_CHARS)}.`);
      out[key] = typed;
    } else out[key] = value;
  }
  return out;
}

/**
 * The update's entries: every current key kept (`{keep: true}`) unless the patch names it — a
 * string replaces it, null removes it — then the patch's new keys. Only keys are read from
 * `current`; values never pass through here.
 */
function mergeSecretEntries(current: readonly SecretEntryView[] | undefined, patch: Record<string, string | null> | undefined): SecretEntryDraft[] {
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

function mcpCreateDraft(mcp: McpChange, env: Record<string, string | null> | undefined, headers: Record<string, string | null> | undefined): McpServerDraft {
  const transport: McpTransport = mcp.transport ?? (mcp.url !== undefined ? "http" : "stdio");
  const draft: McpServerDraft = { name: mcp.name!, transport };
  const entries = (map: Record<string, string | null> | undefined): SecretEntryDraft[] | undefined =>
    map === undefined ? undefined : Object.entries(map).flatMap(([key, value]) => (typeof value === "string" ? [{ key, value }] : []));
  if (transport === "stdio") {
    draft.command = mcp.command!;
    if (mcp.args !== undefined) draft.args = mcp.args;
    if (typeof mcp.cwd === "string") draft.cwd = mcp.cwd;
    const list = entries(env);
    if (list) draft.env = list;
  } else {
    draft.url = mcp.url!;
    const list = entries(headers);
    if (list) draft.headers = list;
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
function mcpUpdateDraft(current: McpServerView, patch: McpChange, env: Record<string, string | null> | undefined, headers: Record<string, string | null> | undefined): McpServerDraft {
  const transport = patch.transport ?? current.transport;
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
    draft.env = mergeSecretEntries(carry ? current.env : [], env);
  } else {
    const url = patch.url ?? (carry ? current.url : undefined);
    if (url === undefined) throw new ToolError("INVALID_ARGUMENT", `mcp.url is required when switching the server to ${transport}.`);
    draft.url = url;
    draft.headers = mergeSecretEntries(carry ? current.headers : [], headers);
  }
  const advanced = mergeRecord(current.advanced, patch.advanced);
  if (Object.keys(advanced).length > 0) draft.advanced = advanced;
  return draft;
}

/**
 * Run a write that carries an item revision; a PROFILE_CONFLICT it answers is re-thrown with the
 * item's fresh summary (`detail.item`), or `detail.itemGone` when the item no longer exists.
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
    if (!current) throw new ToolError("PROFILE_CONFLICT", `${error.message} The item "${clipText(id, MAX_ECHO_CHARS)}" no longer exists under that id: get_agent_profile lists the current items.`, { itemGone: true });
    throw new ToolError(
      "PROFILE_CONFLICT",
      `${error.message} The item changed since that revision was read; it is now at revision ${current.revision} (detail.item). Check your change still applies, then retry.`,
      { item: itemView(current) }
    );
  }
}

/** The revision a write carries: the one the card pinned, else the caller's, else the current one. */
async function writeRevision(client: ProfileClient, agent: Agent, change: ProfileChange, index: number, ctx: CallContext): Promise<string> {
  const pinned = ctx.approval?.pins?.[`c${index}.revision`];
  if (pinned !== undefined) return pinned;
  if (change.revision !== undefined) return change.revision;
  const snapshot = await client.snapshot(agent);
  if (!snapshot.installed) throw new ToolError("AGENT_NOT_INSTALLED", `${CLI_LABELS[agent]} is not installed on this host.`);
  const item = snapshot.items.find((entry) => entry.id === change.id);
  if (!item) throw new ToolError("ITEM_NOT_FOUND", `${CLI_LABELS[agent]} has no item "${clipText(change.id!, MAX_ECHO_CHARS)}". get_agent_profile {agent} lists the items.`);
  return item.revision;
}

async function applyChange(agent: Agent, change: ProfileChange, index: number, ctx: CallContext, budget: number): Promise<Record<string, unknown>> {
  const client = profileClient(ctx.api);
  const head = { index, action: change.action };
  const onConflict = change.onConflict ?? "fail";
  switch (change.action) {
    case "create": {
      const kind = changeKind(change)!;
      let draft: ProfileItemDraft;
      switch (kind) {
        case "mcp":
          draft = { kind, mcp: mcpCreateDraft(change.mcp!, resolveSecrets(change.mcp!.env, index, "env", ctx), resolveSecrets(change.mcp!.headers, index, "headers", ctx)) };
          break;
        case "skill":
        case "command": {
          const doc = change[kind]!;
          draft = { kind, document: { name: doc.name!, frontmatter: doc.frontmatter ?? {}, body: doc.body ?? "" } };
          break;
        }
        case "hook": {
          const hook: HookDraft = { event: change.hook!.event!, command: change.hook!.command! };
          if (typeof change.hook!.matcher === "string") hook.matcher = change.hook!.matcher;
          if (typeof change.hook!.timeoutSec === "number") hook.timeoutSec = change.hook!.timeoutSec;
          draft = { kind, hook };
          break;
        }
        case "plugin": {
          const plugin = change.plugin!;
          draft = { kind, plugin: plugin.spec !== undefined ? { spec: plugin.spec } : { plugin: plugin.plugin!, marketplace: plugin.marketplace! } };
          break;
        }
        case "marketplace":
          draft = { kind, marketplace: { ...(change.marketplace!.name ? { name: change.marketplace!.name } : {}), source: change.marketplace!.source } };
          break;
      }
      return mutationResult(await client.create(agent, { draft, onConflict }), { ...head, kind }, budget);
    }
    case "update": {
      const kind = changeKind(change)!;
      const detail = await client.item(agent, change.id!);
      if (detail.kind === "plugin" || detail.kind === "marketplace") {
        throw new ToolError("KIND_NOT_SUPPORTED", `${PROFILE_ITEM_KIND_LABELS[detail.kind].many} cannot be edited; delete it and create it again.`);
      }
      if (detail.kind !== kind) throw new ToolError("INVALID_ARGUMENT", `"${clipText(change.id!, MAX_ECHO_CHARS)}" is a ${PROFILE_ITEM_KIND_LABELS[detail.kind].one.toLowerCase()}: pass its changes as ${detail.kind}.`);
      let draft: ProfileItemDraft;
      if (detail.kind === "mcp") {
        draft = { kind: "mcp", mcp: mcpUpdateDraft(detail.mcp, change.mcp!, resolveSecrets(change.mcp!.env, index, "env", ctx), resolveSecrets(change.mcp!.headers, index, "headers", ctx)) };
      } else if (detail.kind === "skill" || detail.kind === "command") {
        const patch = change[detail.kind]!;
        draft = { kind: detail.kind, document: { name: patch.name ?? detail.item.name, frontmatter: patch.frontmatter ?? {}, body: patch.body ?? detail.document.body } };
      } else if (detail.kind === "hook") {
        const patch = change.hook!;
        const hook: HookDraft = { event: patch.event ?? detail.hook.event, command: patch.command ?? detail.hook.command };
        const matcher = patch.matcher === null ? undefined : patch.matcher ?? detail.hook.matcher;
        if (matcher !== undefined) hook.matcher = matcher;
        const timeoutSec = patch.timeoutSec === null ? undefined : patch.timeoutSec ?? detail.hook.timeoutSec;
        if (timeoutSec !== undefined) hook.timeoutSec = timeoutSec;
        draft = { kind: "hook", hook };
      } else {
        throw new ToolError("INVALID_ARGUMENT", "Nothing to change.");
      }
      const revision = ctx.approval?.pins?.[`c${index}.revision`] ?? change.revision ?? detail.item.revision;
      const res = await withItemConflict(client, agent, change.id!, () => client.update(agent, change.id!, revision, draft));
      return mutationResult(res, { ...head, previousId: change.id }, budget);
    }
    case "enable":
    case "disable": {
      const revision = await writeRevision(client, agent, change, index, ctx);
      const res = await withItemConflict(client, agent, change.id!, () => client.setEnabled(agent, change.id!, revision, change.action === "enable"));
      return mutationResult(res, { ...head, enabled: change.action === "enable" }, budget);
    }
    case "delete": {
      const revision = await writeRevision(client, agent, change, index, ctx);
      const res = await withItemConflict(client, agent, change.id!, () => client.remove(agent, change.id!, revision));
      return { ...head, deleted: true, id: change.id, notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
    }
    case "trust_hook": {
      const revision = await writeRevision(client, agent, change, index, ctx);
      const res = await withItemConflict(client, agent, change.id!, () => client.trust(agent, change.id!, revision));
      return mutationResult(res, { ...head, trusted: true }, budget);
    }
    case "copy": {
      const res = await client.copy(agent, change.id!, change.toAgent!, onConflict);
      return mutationResult(res, { ...head, fromId: change.id, toAgent: change.toAgent }, budget);
    }
    case "write_instructions": {
      const revision = ctx.approval?.pins?.["instructions.revision"] ?? change.revision ?? (await client.instructions(agent)).info.revision;
      let res: ProfileMutationResponse;
      try {
        res = await client.writeInstructions(agent, change.text!, revision);
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== "PROFILE_CONFLICT") throw error;
        let info: ProfileInstructionsInfo | undefined;
        try { info = (await client.instructions(agent)).info; } catch { /* the conflict is the answer either way */ }
        throw new ToolError(
          "PROFILE_CONFLICT",
          `${error.message} The file changed since that revision was read${info ? `; it is now at revision ${JSON.stringify(info.revision)} (detail.instructions)` : ""}. Re-read it (get_agent_profile {agent, instructions: true}), merge your change, then write again.`,
          info ? { instructions: instructionsView(info) } : undefined
        );
      }
      return { ...head, written: true, instructions: instructionsView(res.snapshot.instructions), notes: (res.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)) };
    }
    case "import_scan": {
      const body = await client.importGit(agent, change.url!);
      const candidates = (body.candidates ?? []).map((c) => ({ ref: c.ref, kind: c.kind, name: c.name, ...(c.description ? { description: clipText(c.description, MAX_ROW_TEXT) } : {}), exists: c.exists }));
      const result: Record<string, unknown> = {
        ...head,
        importId: body.importId,
        notes: (body.notes ?? []).map((n) => clipText(String(n), MAX_NOTE_TEXT)),
        next: candidates.length > 0
          ? "Import with edit_agent_profile {agent, changes: [{action: \"import_pick\", importId, picks: [refs]}]} within 15 minutes; one with exists: true needs onConflict replace or keep-both."
          : "Nothing importable was found (skills are folders with a SKILL.md; commands are .md files)."
      };
      return fitRows(result, "candidates", candidates, "Candidates past the result size cap were left out.", budget);
    }
    case "import_pick": {
      const res = await client.create(agent, { import: { importId: change.importId!, picks: change.picks! }, onConflict });
      return mutationResult(res, head, budget);
    }
  }
}

const editAgentProfile = defineTool({
  name: "edit_agent_profile",
  title: "Edit agent config",
  description:
    "Change an agent CLI's global config: ≤ 10 changes per call, run in order, stopping at the first failure (the error's detail.completed lists what was done). Ids and revisions come from get_agent_profile. action: create (with one of mcp, skill, command, hook, plugin, marketplace), update {id + that kind's object, only what changes}, enable/disable/delete/trust_hook (Codex) {id}, copy {id, toAgent}, write_instructions {text}, import_scan {url} → importId, candidates; import_pick {importId, picks}.",
  chatNote:
    "MCP env/header secrets: pass {ask: true}; the user types the value in the approval card, never in chat.",
  externalNote: "MCP env/header values are write-only and never returned.",
  input: {
    agent: agentArg,
    changes: z.array(changeSchema).min(1).max(MAX_PROFILE_CHANGES),
    reason: z.string().max(300).optional().describe("Why, shown on the approval card.")
  },
  audiences: ["external", "chat"],
  toolset: "agent-profile-editing",
  tier: "admin",
  adminFamily: "agent-profile",
  scope: async (args, ctx) => {
    // Batch validation before any card (and before anything is read).
    validateChanges(args.agent, args.changes as ProfileChange[], ctx.caller);
    return GLOBAL_SCOPE(true);
  },
  approval: async (args, ctx) => editPreview(args.agent, args.changes as ProfileChange[], ctx),
  // The most dangerous action deletes; a create (keep-both) is not idempotent.
  annotations: { ...DESTRUCTIVE, idempotentHint: false },
  resultKind: "json",
  async run(args, ctx) {
    const changes = args.changes as ProfileChange[];
    validateChanges(args.agent, changes, ctx.caller);
    // What the user approved is what runs: every pin re-read before the first write.
    // Every carded call re-verifies, a card with no pins too (re-reading must still yield none).
    if (ctx.approval) await verifyPins(ctx.api, args.agent, changes, ctx.approval.pins ?? {});
    const budget = Math.floor(PROFILE_RESULT_BUDGET / changes.length);
    const results: Record<string, unknown>[] = [];
    for (const [index, change] of changes.entries()) {
      try {
        results.push(await applyChange(args.agent, change, index, ctx, budget));
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const done = results.length > 0 ? ` Changes 1–${results.length} were made (detail.completed).` : " Nothing was changed.";
        throw new ToolError(error.code, `changes[${index}] (${change.action}): ${error.message}${done}`, {
          failedIndex: index,
          completed: results,
          ...(error.detail !== undefined ? { cause: error.detail } : {})
        });
      }
    }
    return {
      agent: args.agent,
      changed: results.length,
      results,
      ...(ctx.approval ? { approval: { outcome: ctx.approval.outcome } } : {})
    };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const agentProfileFamily: readonly AnyOrquesterTool[] = [getAgentProfile, editAgentProfile];
