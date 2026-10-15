/**
 * `edit_agent_profile`'s batch: the change model, its validation (before any card), the daemon
 * reads a card needs, the card itself (unified MCP design 2026-10-15 §7.1) and the pins that make
 * what was approved what runs (§7.2).
 *
 * - **Validation first.** Every change of the batch is checked for its action's fields, the
 *   agent's creatable kinds, duplicates (one change per item; one instruction write) and `{ask:
 *   true}` (chat callers only — an external caller has no card to type it in) before anything is
 *   read or shown: a bad batch is `INVALID_ARGUMENT`, never a card.
 * - **Complete previews.** A skill or command is shown as its whole file; every other file of an
 *   item, an import pick or a plugin in full when it is text, else (and when executable) as a
 *   flagged `file` with size and SHA-256. A plugin lists what it `provides` (skills, commands,
 *   agents, hooks with their commands, MCP servers with their command lines) and the commit its
 *   marketplace is at; an instruction write is a unified diff against the current text. A tree
 *   too large to read whole is `PREVIEW_TOO_LARGE`, never shown in part.
 * - **Secrets.** MCP `env` / `headers` values are `string | null | {ask: true}`: an asked value is
 *   a masked card field (`c<i>.env.<KEY>`) the user types; the agent never sees it. Plain values
 *   that look like secrets are flagged and masked on the card.
 * - **Daemon-pointing.** An MCP server the change would leave pointing at this daemon's `/mcp`
 *   (bearer or URL, `daemon-mcp.ts`) is flagged in red.
 * - **Pins.** Every revision, file-tree digest and commit the preview read is pinned
 *   (`c<i>.revision`, `c<i>.files`, `c<i>.commit`, `instructions.revision`); `verifyPins` re-reads
 *   them immediately before the first write and refuses `PREVIEW_STALE` on any mismatch.
 *
 * Pure: reaches the daemon only through `DaemonApi` (the catalog's import-graph rule).
 */

import { createHash } from "node:crypto";
import {
  AGENT_PROFILE_CREATABLE_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  agentProfileRoutes,
  type AgentProfileAgentId,
  type AgentProfileOverviewResponse,
  type AgentProfileSnapshot,
  type ApprovalPreviewSection,
  type MarketplacePluginsResponse,
  type ProfileConflictPolicy,
  type ProfileImportScanResponse,
  type ProfileInstructionsResponse,
  type ProfileItem,
  type ProfileItemDetail,
  type ProfileItemKind,
  type ProfileMutationResponse,
  type CreateProfileItemRequest,
  type ProfileItemDraft
} from "@orquester/api";

import { serializeMarkdownDocument, mergeFrontmatter } from "../../agent-profile/infra/frontmatter.ts";
import {
  agentProfilePreviewRoutes,
  DAEMON_MCP_SERVERS_CHECK_ROUTE,
  type DaemonMcpCheckRequest,
  type DaemonMcpCheckResponse,
  type ProfileImportDetailResponse,
  type ProfileItemFilesResponse,
  type ProfilePluginPreviewResponse,
  type ProfilePreviewFile,
  type ProfilePreviewTree
} from "@orquester/api";
import type { ApprovalPreview, ScopeContext, ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, MAX_ECHO_CHARS } from "../result.ts";

export type Agent = AgentProfileAgentId;

/** The CLIs as a card names them. */
export const CLI_LABELS: Readonly<Record<Agent, string>> = { claude: "Claude Code", codex: "Codex", grok: "Grok", opencode: "OpenCode" };
const CALLER_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

// ---------------------------------------------------------------------------
// The change model (as the tool's schema parses it)
// ---------------------------------------------------------------------------

export const PROFILE_ACTIONS = ["create", "update", "enable", "disable", "delete", "copy", "trust_hook", "write_instructions", "import_scan", "import_pick"] as const;
export type ProfileAction = (typeof PROFILE_ACTIONS)[number];

/** An env / header value: a string, `null` (remove; update only), or `{ask: true}` (typed in the card). */
export type SecretInput = string | null | { ask: true };

export interface McpChange {
  name?: string;
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, SecretInput>;
  url?: string;
  headers?: Record<string, SecretInput>;
  advanced?: Record<string, unknown>;
}

export interface DocumentChange {
  name?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

export interface HookChange {
  event?: string;
  matcher?: string | null;
  command?: string;
  timeoutSec?: number | null;
}

export interface PluginChange {
  plugin?: string;
  marketplace?: string;
  spec?: string;
}

export type MarketplaceSourceInput =
  | { type: "github"; repo: string; ref?: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "path"; path: string };

export interface MarketplaceChange {
  name?: string;
  source: MarketplaceSourceInput;
}

export interface ProfileChange {
  action: ProfileAction;
  id?: string;
  revision?: string;
  mcp?: McpChange;
  skill?: DocumentChange;
  command?: DocumentChange;
  hook?: HookChange;
  plugin?: PluginChange;
  marketplace?: MarketplaceChange;
  toAgent?: Agent;
  onConflict?: ProfileConflictPolicy;
  text?: string;
  url?: string;
  importId?: string;
  picks?: string[];
}

export const KIND_KEYS = ["mcp", "skill", "command", "hook", "plugin", "marketplace"] as const satisfies readonly ProfileItemKind[];
const OTHER_KEYS = ["id", "revision", "toAgent", "onConflict", "text", "url", "importId", "picks"] as const;
type OtherKey = (typeof OTHER_KEYS)[number];

/** The fields each action takes (beyond `action`); `kind`: one kind object, from these. */
const ACTION_FIELDS: Record<ProfileAction, { required: OtherKey[]; optional: OtherKey[]; kinds?: readonly ProfileItemKind[] }> = {
  create: { required: [], optional: ["onConflict"], kinds: KIND_KEYS },
  update: { required: ["id"], optional: ["revision"], kinds: ["mcp", "skill", "command", "hook"] },
  enable: { required: ["id"], optional: ["revision"] },
  disable: { required: ["id"], optional: ["revision"] },
  delete: { required: ["id"], optional: ["revision"] },
  trust_hook: { required: ["id"], optional: ["revision"] },
  copy: { required: ["id", "toAgent"], optional: ["onConflict"] },
  write_instructions: { required: ["text"], optional: ["revision"] },
  import_scan: { required: ["url"], optional: [] },
  import_pick: { required: ["importId", "picks"], optional: ["onConflict"] }
};

export const isAsk = (value: unknown): value is { ask: true } =>
  value !== null && typeof value === "object" && (value as { ask?: unknown }).ask === true;

/** The one kind object a create/update carries. */
export function changeKind(change: ProfileChange): ProfileItemKind | null {
  return KIND_KEYS.find((key) => change[key] !== undefined) ?? null;
}

const where = (index: number) => `changes[${index}]`;

/**
 * Every change checked before anything is read or shown (batch validation before the card).
 * Throws `INVALID_ARGUMENT` / `KIND_NOT_SUPPORTED` naming the change.
 */
export function validateChanges(agent: Agent, changes: readonly ProfileChange[], caller: ToolCaller): void {
  const ids = new Set<string>();
  let instructions = 0;
  changes.forEach((change, index) => {
    const spec = ACTION_FIELDS[change.action];
    const at = `${where(index)} (${change.action})`;
    for (const key of spec.required) {
      if (change[key] === undefined) throw new ToolError("INVALID_ARGUMENT", `${at}: ${key} is required.`);
    }
    const extra = OTHER_KEYS.filter((key) => change[key] !== undefined && !spec.required.includes(key) && !spec.optional.includes(key));
    if (extra.length > 0) throw new ToolError("INVALID_ARGUMENT", `${at}: ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not used by ${change.action}.`);
    const kinds = KIND_KEYS.filter((key) => change[key] !== undefined);
    if (spec.kinds) {
      if (kinds.length !== 1 || !spec.kinds.includes(kinds[0]!)) {
        throw new ToolError("INVALID_ARGUMENT", `${at}: pass exactly one of ${spec.kinds.join(", ")}${kinds.length > 1 ? ` (got ${kinds.join(", ")})` : ""}.`);
      }
    } else if (kinds.length > 0) {
      throw new ToolError("INVALID_ARGUMENT", `${at}: ${kinds.join(", ")} ${kinds.length === 1 ? "is" : "are"} not used by ${change.action}.`);
    }
    const kind = kinds[0];
    if (change.action === "create" && kind && !AGENT_PROFILE_CREATABLE_KINDS[agent].includes(kind)) {
      throw new ToolError("KIND_NOT_SUPPORTED", `${at}: ${CLI_LABELS[agent]} cannot create ${PROFILE_ITEM_KIND_LABELS[kind].many.toLowerCase()} here; it can create: ${AGENT_PROFILE_CREATABLE_KINDS[agent].join(", ")}.`);
    }
    if (change.action === "create") validateCreate(change, kind!, at);
    if (change.action === "update" && kind === "mcp") validateMcpTransport(change.mcp!, change.mcp!.transport, at, false);
    if (change.action === "copy" && change.toAgent === agent) throw new ToolError("INVALID_ARGUMENT", `${at}: toAgent must be another agent.`);
    if (change.action === "write_instructions" && ++instructions > 1) throw new ToolError("INVALID_ARGUMENT", `${at}: one write_instructions per call.`);
    if (change.id !== undefined) {
      if (ids.has(change.id)) throw new ToolError("INVALID_ARGUMENT", `${at}: "${clipText(change.id, MAX_ECHO_CHARS)}" is changed twice in one call; merge the changes.`);
      ids.add(change.id);
    }
    for (const [field, map] of [["env", change.mcp?.env], ["headers", change.mcp?.headers]] as const) {
      for (const [key, value] of Object.entries(map ?? {})) {
        if (value === null && change.action === "create") throw new ToolError("INVALID_ARGUMENT", `${at}: mcp.${field}.${key}: null removes a value and only applies to update.`);
        if (isAsk(value) && caller.kind !== "thread") {
          throw new ToolError("INVALID_ARGUMENT", `${at}: mcp.${field}.${key}: {ask: true} asks the user in an approval card, which external callers do not get; pass the value.`);
        }
      }
    }
  });
}

function validateCreate(change: ProfileChange, kind: ProfileItemKind, at: string): void {
  switch (kind) {
    case "mcp": {
      const mcp = change.mcp!;
      if (!mcp.name) throw new ToolError("INVALID_ARGUMENT", `${at}: mcp.name is required.`);
      const transport = mcp.transport ?? (mcp.url !== undefined ? "http" : "stdio");
      validateMcpTransport(mcp, transport, at, true);
      return;
    }
    case "skill":
    case "command":
      if (!change[kind]!.name) throw new ToolError("INVALID_ARGUMENT", `${at}: ${kind}.name is required.`);
      return;
    case "hook":
      if (!change.hook!.event || !change.hook!.command) throw new ToolError("INVALID_ARGUMENT", `${at}: hook.event and hook.command are required.`);
      return;
    case "plugin": {
      const plugin = change.plugin!;
      const named = plugin.plugin !== undefined && plugin.marketplace !== undefined;
      if (named === (plugin.spec !== undefined) || (!named && (plugin.plugin !== undefined || plugin.marketplace !== undefined))) {
        throw new ToolError("INVALID_ARGUMENT", `${at}: plugin is {plugin, marketplace} or, for OpenCode, {spec}.`);
      }
      return;
    }
    case "marketplace":
      return;
  }
}

const REMOTE_ONLY = ["url", "headers"] as const;
const STDIO_ONLY = ["command", "args", "cwd", "env"] as const;

function validateMcpTransport(mcp: McpChange, transport: McpChange["transport"], at: string, create: boolean): void {
  if (transport === undefined) return;
  const wrong = (transport === "stdio" ? REMOTE_ONLY : STDIO_ONLY).filter((key) => mcp[key] !== undefined && mcp[key] !== null);
  if (wrong.length > 0) {
    throw new ToolError("INVALID_ARGUMENT", `${at}: mcp ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not for a${transport === "stdio" ? " stdio" : `n ${transport}`} server (stdio takes command, args, cwd, env; http and sse take url, headers).`);
  }
  if (create && transport === "stdio" && mcp.command === undefined) throw new ToolError("INVALID_ARGUMENT", `${at}: mcp.command is required for a stdio server (or pass url for an http one).`);
  if (create && transport !== "stdio" && mcp.url === undefined) throw new ToolError("INVALID_ARGUMENT", `${at}: mcp.url is required for an ${transport} server.`);
}

// ---------------------------------------------------------------------------
// The daemon's agent-profile routes (through DaemonApi only)
// ---------------------------------------------------------------------------

const ERROR_HINTS: Record<string, string> = {
  ITEM_NOT_FOUND: " get_agent_profile {agent} lists the items and their ids (a hook's id changes when it is edited).",
  AGENT_NOT_INSTALLED: " get_agent_profile {} shows which agents are installed.",
  UNKNOWN_AGENT: " get_agent_profile {} shows the agents.",
  KIND_NOT_SUPPORTED: " get_agent_profile {agent} → authoring.creatableKinds lists what the agent can create.",
  IMPORT_NOT_FOUND: " Scan again: edit_agent_profile {agent, changes: [{action: \"import_scan\", url}]}.",
  ITEM_EXISTS: " Pass onConflict \"replace\" or \"keep-both\" to create it anyway.",
  CONFIG_UNREADABLE: " The file must be fixed by hand first; get_agent_profile lists it under fileErrors.",
  ITEM_LOCKED: " Orquester or the agent CLI owns it.",
  NOT_EDITABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI.",
  NOT_TOGGLEABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI.",
  NOT_DELETABLE: " Its source (get_agent_profile) says who manages it: a plugin, another agent, or the CLI."
};

/**
 * A failed profile route as a ToolError: the daemon's `{error: {code, message}}` passes its code
 * through unchanged, a hint appended. No profile route quotes a secret value or a git URL.
 */
export function profileError(res: DaemonResponse): ToolError {
  const error = daemonError(res);
  const hint = ERROR_HINTS[error.code];
  if (!hint) return error;
  const message = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  return new ToolError(error.code, `${message}${hint}`, error.detail);
}

export function profileClient(api: DaemonApi) {
  const call = async <T>(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<T> => {
    const res = await api.request(method, path, opts);
    if (res.status >= 400) throw profileError(res);
    return res.body as T;
  };
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
      call<MarketplacePluginsResponse>("GET", agentProfileRoutes.marketplacePlugins(agent, marketplace)),
    itemFiles: (agent: Agent, id: string) => call<ProfileItemFilesResponse>("GET", agentProfilePreviewRoutes.itemFiles(agent, id)),
    importDetail: (agent: Agent, importId: string) => call<ProfileImportDetailResponse>("GET", agentProfilePreviewRoutes.importDetail(agent, importId)),
    pluginPreview: (agent: Agent, marketplace: string, plugin: string) =>
      call<ProfilePluginPreviewResponse>("GET", agentProfilePreviewRoutes.pluginPreview(agent, marketplace, plugin)),
    daemonPointing: (body: DaemonMcpCheckRequest) => call<DaemonMcpCheckResponse>("POST", DAEMON_MCP_SERVERS_CHECK_ROUTE, { body })
  };
}
export type ProfileClient = ReturnType<typeof profileClient>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A URL as a card or result shows it: credentials written into it replaced by `***`. */
export function redactUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/i, "$1***@");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The digest a `files` pin compares (paths, hashes, flags), as the daemon's `treeDigest`. */
export function treeDigest(tree: ProfilePreviewTree): string {
  const hash = createHash("sha256");
  for (const file of tree.files) hash.update(`${file.path}\0${file.sha256}\0${file.flag ?? ""}\n`);
  hash.update(tree.complete ? "complete" : "partial");
  return hash.digest("hex");
}

const SECRET_KEY = /(token|secret|passw|pwd|api[_-]?key|apikey|auth|bearer|credential|cookie|session|private[_-]?key|access[_-]?key|signature)/i;
const SECRET_PREFIX = /^(sk-|sk_|pk_live|rk_live|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abpres]-|AKIA|ASIA|AIza|eyJ[A-Za-z0-9_-]{10,}\.)/;
const ENV_REFERENCE = /^\s*(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{env:[A-Za-z_][A-Za-z0-9_]*\}|\$\{env:[A-Za-z_][A-Za-z0-9_]*\})\s*$/;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether a plain env / header value the AGENT wrote looks like a secret (flagged on the card). */
export function looksLikeSecret(key: string, value: string): boolean {
  if (value.trim() === "" || ENV_REFERENCE.test(value)) return false;
  if (SECRET_KEY.test(key)) return true;
  const bare = value.replace(/^\s*bearer\s+/i, "").trim();
  if (/^\s*bearer\s+\S{8,}/i.test(value) || SECRET_PREFIX.test(bare)) return true;
  // A path or an option (`/usr/lib/x.so`, `--require=…`) is not a token, however varied its letters.
  if (/^[-./~]/.test(bare) || /\/[^/]+\.[A-Za-z0-9]+$/.test(bare)) return false;
  return bare.length >= 24 && /^[A-Za-z0-9+/=_.~-]+$/.test(bare) && entropy(bare) >= 3.5;
}

/** A unified diff of two texts (3 lines of context). Falls back to whole-text replace for huge inputs. */
export function unifiedDiff(before: string, after: string, oldName: string, newName: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  type Op = { tag: " " | "-" | "+"; line: string };
  let ops: Op[];
  if (a.length * b.length > 4_000_000) {
    ops = [...a.map((line) => ({ tag: "-" as const, line })), ...b.map((line) => ({ tag: "+" as const, line }))];
  } else {
    // LCS table (lengths of the suffixes), then one walk.
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ tag: " ", line: a[i]! });
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        ops.push({ tag: "-", line: a[i++]! });
      } else {
        ops.push({ tag: "+", line: b[j++]! });
      }
    }
    while (i < n) ops.push({ tag: "-", line: a[i++]! });
    while (j < m) ops.push({ tag: "+", line: b[j++]! });
  }
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  const CONTEXT = 3;
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  const counters: { old: number; new: number }[] = [];
  for (const op of ops) {
    counters.push({ old: oldLine, new: newLine });
    if (op.tag !== "+") oldLine++;
    if (op.tag !== "-") newLine++;
  }
  while (index < ops.length) {
    while (index < ops.length && ops[index]!.tag === " ") index++;
    if (index >= ops.length) break;
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    let lastChange = index;
    while (end < ops.length && (ops[end]!.tag !== " " || end - lastChange <= CONTEXT * 2)) {
      if (ops[end]!.tag !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + CONTEXT + 1);
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.tag !== "+").length;
    const newCount = hunk.filter((op) => op.tag !== "-").length;
    const oldStart = oldCount === 0 ? counters[start]!.old - 1 : counters[start]!.old;
    const newStart = newCount === 0 ? counters[start]!.new - 1 : counters[start]!.new;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(`${op.tag}${op.line}`);
    index = end;
  }
  if (out.length === 2) out.push("(no change)");
  return out.join("\n");
}

/** The file text an agent's markdown item is written as (OpenCode's YAML 1.1 reader gets YAML 1.1). */
export function documentText(agent: Agent, frontmatter: Record<string, unknown>, body: string): string {
  return serializeMarkdownDocument(frontmatter, body, agent === "opencode" ? { yaml: "1.1" } : {});
}

// ---------------------------------------------------------------------------
// Facts: what a change's card shows and pins (read through DaemonApi)
// ---------------------------------------------------------------------------

interface ChangeFacts {
  /** The item the change targets, as the snapshot lists it now. */
  item?: ProfileItem;
  detail?: ProfileItemDetail;
  files?: ProfileItemFilesResponse;
  instructions?: ProfileInstructionsResponse;
  importDetail?: ProfileImportDetailResponse;
  plugin?: ProfilePluginPreviewResponse;
  /** create with onConflict "replace": the item it would replace. */
  replaces?: ProfileItem;
  /** create with onConflict "keep-both" over a taken name: the suffixed name the adapter will pick. */
  writtenName?: string;
  pointing?: DaemonMcpCheckResponse["reason"];
  /** A plugin's MCP servers that point at this daemon (install, or enabling an installed one). */
  pluginPointing?: { name: string; reason: NonNullable<DaemonMcpCheckResponse["reason"]> }[];
}

export interface BatchFacts {
  agent: Agent;
  changes: ProfileChange[];
  facts: ChangeFacts[];
  pins: Record<string, string>;
}

function itemName(item: ProfileItem | undefined, id: string | undefined): string {
  return item?.name ?? id ?? "";
}

/** The snapshot item a change names; ITEM_NOT_FOUND when it does not exist. */
function findItem(snapshot: AgentProfileSnapshot, agent: Agent, id: string, index: number): ProfileItem {
  const item = snapshot.items.find((entry) => entry.id === id);
  if (!item) throw new ToolError("ITEM_NOT_FOUND", `${where(index)}: ${CLI_LABELS[agent]} has no item "${clipText(id, MAX_ECHO_CHARS)}".${ERROR_HINTS.ITEM_NOT_FOUND}`);
  return item;
}

/**
 * The string values one MCP server of a plugin carries (its URL, command line, header and env
 * values), read from the plugin's own JSON files — what the CLI would load.
 */
function pluginServerValues(files: readonly ProfilePreviewFile[], name: string): { url?: string; values: string[] } {
  const out: { url?: string; values: string[] } = { values: [] };
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : value !== null && typeof value === "object" ? Object.values(value).filter((v): v is string => typeof v === "string") : [];
  for (const file of files) {
    if (file.text === undefined || !file.path.endsWith(".json")) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(file.text);
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== "object") continue;
    const record = doc as Record<string, unknown>;
    const servers = record.mcpServers !== null && typeof record.mcpServers === "object" ? (record.mcpServers as Record<string, unknown>) : record;
    const def = servers[name];
    if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
    const server = def as Record<string, unknown>;
    if (typeof server.url === "string") out.url = server.url;
    out.values.push(...strings(server.headers), ...strings(server.env), ...strings(server.args), ...strings(server.command));
  }
  return out;
}

/** A plugin's MCP servers that point at this daemon: URL, bearer where its files carry one, the name. */
async function pluginPointing(
  client: ProfileClient,
  agent: Agent,
  provides: ProfilePluginPreviewResponse["provides"],
  files: readonly ProfilePreviewFile[]
): Promise<NonNullable<ChangeFacts["pluginPointing"]>> {
  const out: NonNullable<ChangeFacts["pluginPointing"]> = [];
  for (const server of provides.mcpServers) {
    const found = pluginServerValues(files, server.name);
    const url = found.url ?? server.url;
    const values = [...found.values, ...(server.command ? [server.command] : []), ...(server.args ?? [])];
    const { reason } = await client.daemonPointing({ agent, name: server.name, ...(url ? { url } : {}), values });
    if (reason) out.push({ name: server.name, reason });
  }
  return out;
}

/** The MCP definition values a daemon-pointing check sends (plain values only; asked ones are unknown yet). */
function plainValues(mcp: McpChange): string[] {
  const values: string[] = [];
  for (const map of [mcp.env, mcp.headers]) for (const value of Object.values(map ?? {})) if (typeof value === "string") values.push(value);
  return [...values, ...(mcp.args ?? []), ...(mcp.command ? [mcp.command] : [])];
}

/**
 * Everything the batch's card shows, read now, and the pins over it. Throws `PROFILE_CONFLICT`
 * when the agent named a revision that is no longer current (before any card), and the codes a
 * read answers (ITEM_NOT_FOUND, IMPORT_NOT_FOUND, …).
 */
export async function readBatchFacts(api: DaemonApi, agent: Agent, changes: readonly ProfileChange[]): Promise<BatchFacts> {
  const client = profileClient(api);
  const pins: Record<string, string> = {};
  const facts: ChangeFacts[] = [];
  let snapshot: AgentProfileSnapshot | undefined;
  const snap = async () => (snapshot ??= await client.snapshot(agent));
  for (const [index, change] of changes.entries()) {
    const fact: ChangeFacts = {};
    const pin = (what: string, value: string) => {
      pins[`c${index}.${what}`] = value;
    };
    switch (change.action) {
      case "create": {
        const kind = changeKind(change)!;
        if (kind === "mcp") {
          const mcp = change.mcp!;
          fact.pointing = (await client.daemonPointing({ agent, name: mcp.name!, ...(mcp.url ? { url: mcp.url } : {}), values: plainValues(mcp) })).reason;
        }
        if (kind === "plugin" && change.plugin!.plugin !== undefined) {
          fact.plugin = await client.pluginPreview(agent, change.plugin!.marketplace!, change.plugin!.plugin);
          if (fact.plugin.source.type === "local") pin("files", treeDigest(fact.plugin.source));
          pin("commit", fact.plugin.commit ?? "none");
          fact.pluginPointing = await pluginPointing(client, agent, fact.plugin.provides, fact.plugin.source.type === "local" ? fact.plugin.source.files : []);
        }
        const name = kind === "mcp" ? change.mcp!.name : kind === "skill" || kind === "command" ? change[kind]!.name : kind === "marketplace" ? change.marketplace!.name : undefined;
        const policy = change.onConflict ?? "fail";
        if (name !== undefined && policy !== "fail") {
          const items = (await snap()).items;
          const existing = items.find((entry) => entry.id === `${kind}:${name}`);
          if (existing && policy === "replace") {
            fact.replaces = existing;
            pin("replaces", existing.revision);
          } else if (existing && policy === "keep-both") {
            // As the adapters' `uniqueName`: `<name>-2`, `-3`, … the first one free.
            let n = 2;
            while (items.some((entry) => entry.id === `${kind}:${name}-${n}`)) n += 1;
            fact.writtenName = `${name}-${n}`;
            pin("name", fact.writtenName);
          }
        }
        break;
      }
      case "update":
      case "enable":
      case "disable":
      case "delete":
      case "trust_hook":
      case "copy": {
        fact.item = findItem(await snap(), agent, change.id!, index);
        if (change.revision !== undefined && change.revision !== fact.item.revision) {
          throw new ToolError("PROFILE_CONFLICT", `${where(index)}: "${clipText(change.id!, MAX_ECHO_CHARS)}" changed since revision ${clipText(change.revision, MAX_ECHO_CHARS)} was read; it is now at ${fact.item.revision}. Re-read it (get_agent_profile) and check your change still applies.`);
        }
        pin("revision", fact.item.revision);
        if (change.action === "update" && changeKind(change) !== fact.item.kind) {
          throw new ToolError(
            fact.item.kind === "plugin" || fact.item.kind === "marketplace" ? "KIND_NOT_SUPPORTED" : "INVALID_ARGUMENT",
            fact.item.kind === "plugin" || fact.item.kind === "marketplace"
              ? `${where(index)}: ${PROFILE_ITEM_KIND_LABELS[fact.item.kind].many} cannot be edited; delete it and create it again.`
              : `${where(index)}: "${clipText(change.id!, MAX_ECHO_CHARS)}" is a ${KIND_ONE[fact.item.kind]}: pass its changes as ${fact.item.kind}.`
          );
        }
        if (fact.item.kind === "mcp" || fact.item.kind === "hook" || fact.item.kind === "plugin" || fact.item.kind === "marketplace" || change.action === "update") {
          fact.detail = await client.item(agent, change.id!);
        }
        const readsFiles =
          ((fact.item.kind === "skill" || fact.item.kind === "command") && change.action !== "enable" && change.action !== "disable") ||
          (fact.item.kind === "plugin" && change.action === "enable");
        if (readsFiles && fact.item.path !== undefined) {
          fact.files = await client.itemFiles(agent, change.id!);
          pin("files", treeDigest(fact.files));
          if (fact.files.provides) fact.pluginPointing = await pluginPointing(client, agent, fact.files.provides, fact.files.files);
        }
        // An MCP server turned on or copied elsewhere: does what it holds (secret values merged in
        // daemon-side by id) point at this daemon?
        if (fact.item.kind === "mcp" && (change.action === "enable" || change.action === "copy")) {
          fact.pointing = (await client.daemonPointing({ agent, id: change.id!, name: fact.item.name })).reason;
        }
        if (change.action === "update" && change.mcp) {
          const detail = fact.detail?.kind === "mcp" ? fact.detail.mcp : undefined;
          const url = change.mcp.url ?? detail?.url;
          fact.pointing = (await client.daemonPointing({ agent, id: change.id!, name: change.mcp.name ?? fact.item.name, ...(url ? { url } : {}), values: plainValues(change.mcp) })).reason;
        }
        break;
      }
      case "write_instructions": {
        fact.instructions = await client.instructions(agent);
        if (change.revision !== undefined && change.revision !== fact.instructions.info.revision) {
          throw new ToolError("PROFILE_CONFLICT", `${where(index)}: the instruction file changed since revision ${JSON.stringify(clipText(change.revision, MAX_ECHO_CHARS))} was read; it is now at ${JSON.stringify(fact.instructions.info.revision)}. Re-read it and merge your change.`);
        }
        pins["instructions.revision"] = fact.instructions.info.revision;
        break;
      }
      case "import_pick": {
        fact.importDetail = await client.importDetail(agent, change.importId!);
        const known = new Set(fact.importDetail.candidates.map((candidate) => candidate.ref));
        const missing = change.picks!.filter((ref) => !known.has(ref));
        if (missing.length > 0) throw new ToolError("INVALID_ARGUMENT", `${where(index)}: the import has no item ${missing.slice(0, 3).map((ref) => JSON.stringify(clipText(ref, MAX_ECHO_CHARS))).join(", ")}.`);
        for (const candidate of fact.importDetail.candidates.filter((entry) => change.picks!.includes(entry.ref))) {
          pin(`pick.${candidate.ref}`, treeDigest(candidate));
        }
        if (fact.importDetail.source.type === "git") pin("commit", fact.importDetail.source.commit ?? "none");
        break;
      }
      case "import_scan":
        break;
    }
    facts.push(fact);
  }
  return { agent, changes: [...changes], facts, pins };
}

/**
 * Re-read what the card pinned and refuse `PREVIEW_STALE` on any difference — immediately before
 * the first write (nothing has been written yet).
 */
export async function verifyPins(api: DaemonApi, agent: Agent, changes: readonly ProfileChange[], pins: Record<string, string>): Promise<void> {
  let current: BatchFacts;
  try {
    current = await readBatchFacts(api, agent, changes.map((change) => ({ ...change, revision: undefined })));
  } catch (error) {
    if (error instanceof ToolError && ["ITEM_NOT_FOUND", "IMPORT_NOT_FOUND", "INVALID_ARGUMENT"].includes(error.code)) {
      throw new ToolError("PREVIEW_STALE", `What the approval card showed no longer exists (${error.message}). Nothing was changed; read the profile again.`);
    }
    throw error;
  }
  const keys = new Set([...Object.keys(pins), ...Object.keys(current.pins)]);
  for (const key of keys) {
    if (pins[key] !== current.pins[key]) {
      const index = /^c(\d+)\./.exec(key)?.[1];
      const what = index !== undefined ? `change ${Number(index) + 1} (${changes[Number(index)]?.action})` : "the instruction file";
      throw new ToolError("PREVIEW_STALE", `${what} no longer matches what the user approved (${key.replace(/^c\d+\./, "")} changed). Nothing was changed; read it again and call edit_agent_profile again.`);
    }
  }
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const KIND_ONE: Record<ProfileItemKind, string> = { mcp: "MCP server", skill: "skill", plugin: "plugin", marketplace: "plugin marketplace", hook: "hook", command: "command" };

function quoted(text: string): string {
  return `\`${clipText(text, 80)}\``;
}

/** The change in words: "add the skill `x`", "delete the hook `Stop`", … */
export function changePhrase(agent: Agent, change: ProfileChange, fact: ChangeFacts | undefined): string {
  const label = CLI_LABELS[agent];
  const target = fact?.item;
  const kindOf = (item: ProfileItem | undefined) => (item ? KIND_ONE[item.kind] : "item");
  const named = quoted(itemName(target, change.id));
  switch (change.action) {
    case "create": {
      const kind = changeKind(change)!;
      if (kind === "plugin") {
        const plugin = change.plugin!;
        return plugin.spec !== undefined ? `install the plugin ${quoted(plugin.spec)} in ${label}` : `install the plugin ${quoted(plugin.plugin!)} from ${quoted(plugin.marketplace!)} in ${label}`;
      }
      if (kind === "hook") return `add a ${clipText(change.hook!.event!, 40)} hook to ${label}`;
      if (kind === "marketplace") {
        const source = change.marketplace!.source;
        const name = change.marketplace!.name ?? (source.type === "github" ? source.repo : source.type === "git" ? redactUrlCredentials(source.url) : source.path);
        return `add the plugin marketplace ${quoted(name)} to ${label}`;
      }
      const name = kind === "mcp" ? change.mcp!.name! : change[kind]!.name!;
      return `add the ${KIND_ONE[kind]} ${quoted(kind === "command" ? `/${name}` : name)} to ${label}`;
    }
    case "update":
      return `change the ${kindOf(target)} ${named} in ${label}`;
    case "enable":
      return `turn on the ${kindOf(target)} ${named} in ${label}`;
    case "disable":
      return `turn off the ${kindOf(target)} ${named} in ${label}`;
    case "delete":
      return `delete the ${kindOf(target)} ${named} from ${label}`;
    case "trust_hook":
      return `trust the hook ${named} in ${label}`;
    case "copy":
      return `copy the ${kindOf(target)} ${named} from ${label} to ${CLI_LABELS[change.toAgent!]}`;
    case "write_instructions":
      return `rewrite ${label}'s global instructions`;
    case "import_scan":
      return `download a Git repository to look for skills to import into ${label}`;
    case "import_pick":
      return `import ${change.picks!.length === 1 ? "1 item" : `${change.picks!.length} items`} into ${label}`;
  }
}

/** A tree's files as card sections: text in full (with its hash), executables and binaries flagged. */
function fileSections(files: readonly ProfilePreviewFile[], prefix: string): ApprovalPreviewSection[] {
  const sections: ApprovalPreviewSection[] = [];
  for (const file of files) {
    const path = prefix ? `${prefix}/${file.path}` : file.path;
    if (file.flag === "symlink") {
      sections.push({ kind: "warning", level: "caution", text: `${path} is a symbolic link to ${clipText(file.target ?? "", 300)}.` });
      continue;
    }
    if (file.flag === "binary" || file.flag === "executable") sections.push({ kind: "file", path, size: file.size, sha256: file.sha256, flag: file.flag });
    if (file.text !== undefined) {
      sections.push({ kind: "code", title: path, ...(languageOf(file.path) ? { language: languageOf(file.path)! } : {}), text: file.text, sha256: file.sha256 });
    }
  }
  return sections;
}

function languageOf(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  const map: Record<string, string> = { md: "markdown", json: "json", sh: "bash", bash: "bash", js: "javascript", mjs: "javascript", ts: "typescript", py: "python", toml: "toml", yaml: "yaml", yml: "yaml" };
  return ext ? map[ext] : undefined;
}

function tooLarge(what: string): ToolError {
  return new ToolError("PREVIEW_TOO_LARGE", `${what} is too large to show the user in full in one approval card. Split the change into smaller calls.`);
}

/**
 * Environment variables that make a process load code the variable names (an LD_PRELOAD library,
 * a NODE_OPTIONS `--require`, …): a value here is code that runs inside the server.
 */
const CODE_LOADING_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_SSH_COMMAND|PATH)$/i;

/**
 * The env / header rows of an MCP change. Every value the AGENT wrote is shown in full — what is
 * approved is what runs (a "secret-looking" value is still shown, flagged, with a caution). Only
 * values the user types in this card (`{ask: true}`) and values already on disk are never shown.
 */
function secretRows(index: number, field: "env" | "headers", map: Record<string, SecretInput> | undefined, kept: readonly string[]): {
  rows: { label: string; value: string; state?: "set" | "asked" | "flagged" }[];
  asked: { key: string; label: string }[];
  flagged: string[];
  codeLoading: string[];
} {
  const codeLoading: string[] = [];
  const rows: { label: string; value: string; state?: "set" | "asked" | "flagged" }[] = [];
  const asked: { key: string; label: string }[] = [];
  const flagged: string[] = [];
  const name = field === "env" ? "env" : "header";
  for (const key of kept) if (!map || !Object.hasOwn(map, key)) rows.push({ label: `${name} ${key}`, value: "unchanged (its value is not shown)", state: "set" });
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value === null) rows.push({ label: `${name} ${key}`, value: "removed" });
    else if (isAsk(value)) {
      rows.push({ label: `${name} ${key}`, value: "you type it in this card", state: "asked" });
      asked.push({ key: `c${index}.${field}.${key}`, label: `${key} (${name})` });
    } else {
      const secretLooking = looksLikeSecret(key, value);
      rows.push({ label: `${name} ${key}`, value, state: secretLooking ? "flagged" : "set" });
      if (secretLooking) flagged.push(key);
      if (field === "env" && CODE_LOADING_ENV.test(key)) codeLoading.push(key);
    }
  }
  return { rows, asked, flagged, codeLoading };
}

function pointingWarning(name: string, reason: DaemonMcpCheckResponse["reason"]): ApprovalPreviewSection[] {
  if (reason === null || reason === undefined) return [];
  const why = reason === "bearer" ? "it carries this Orquester's own credential" : reason === "url" ? "its URL is this Orquester's own /mcp" : "it is named \"orquester\"";
  return [{
    kind: "warning",
    level: "danger",
    text: `The MCP server "${clipText(name, 80)}" points at this Orquester (${why}): it gives chats full control of Orquester without approvals. Orquester turns it off inside its own chats.`
  }];
}

function mcpSections(agent: Agent, index: number, change: ProfileChange, fact: ChangeFacts): { sections: ApprovalPreviewSection[]; asked: { key: string; label: string }[] } {
  const mcp = change.mcp!;
  const current = fact.detail?.kind === "mcp" ? fact.detail.mcp : undefined;
  const transport = mcp.transport ?? current?.transport ?? (mcp.url !== undefined ? "http" : "stdio");
  // keep-both over a taken name: the adapter writes the suffixed name.
  const name = fact.writtenName ?? mcp.name ?? current?.name ?? "";
  const rows: { label: string; value: string; state?: "set" | "asked" | "flagged" }[] = [
    {
      label: "Name",
      value: name + (current && mcp.name && mcp.name !== current.name ? ` (renamed from ${current.name})` : "") + (fact.writtenName ? ` ("${mcp.name}" is taken: keep-both)` : "")
    },
    { label: "Transport", value: transport }
  ];
  const sections: ApprovalPreviewSection[] = [];
  const carry = current !== undefined && (current.transport === "stdio") === (transport === "stdio");
  const asked: { key: string; label: string }[] = [];
  const flagged: string[] = [];
  const codeLoading: string[] = [];
  if (transport === "stdio") {
    const command = mcp.command ?? (carry ? current?.command : undefined) ?? "";
    const args = mcp.args ?? (carry ? current?.args : undefined) ?? [];
    sections.push({ kind: "code", title: "Command it runs", language: "bash", text: [command, ...args].map(shellWord).join(" ") });
    const cwd = mcp.cwd === null ? undefined : mcp.cwd ?? (carry ? current?.cwd : undefined);
    if (cwd) rows.push({ label: "Working directory", value: cwd });
    const env = secretRows(index, "env", mcp.env, carry ? (current?.env ?? []).map((entry) => entry.key) : []);
    rows.push(...env.rows);
    asked.push(...env.asked);
    flagged.push(...env.flagged);
    codeLoading.push(...env.codeLoading);
  } else {
    // A URL the agent wrote is shown as written; one already on disk has its credentials hidden.
    const url = mcp.url ?? (carry && current?.url !== undefined ? redactUrlCredentials(current.url) : "");
    rows.push({ label: "URL", value: url });
    const headers = secretRows(index, "headers", mcp.headers, carry ? (current?.headers ?? []).map((entry) => entry.key) : []);
    rows.push(...headers.rows);
    asked.push(...headers.asked);
    flagged.push(...headers.flagged);
  }
  const advanced = { ...(current?.advanced ?? {}), ...(mcp.advanced ?? {}) };
  for (const [key, value] of Object.entries(advanced)) {
    if (value !== null) rows.push({ label: key, value: typeof value === "string" ? value : JSON.stringify(value) });
  }
  sections.unshift({ kind: "fields", title: `MCP server ${name}`, rows });
  if (flagged.length > 0) {
    sections.push({
      kind: "warning",
      level: "caution",
      text: `${flagged.join(", ")} ${flagged.length === 1 ? "looks" : "look"} like a secret the agent wrote in plain text: it is shown above and stays in this chat's transcript. Deny and ask for {ask: true} to type it here instead.`
    });
  }
  if (codeLoading.length > 0) {
    sections.push({
      kind: "warning",
      level: "danger",
      text: `${codeLoading.join(", ")} ${codeLoading.length === 1 ? "makes" : "make"} the server's process load the code or search path it names: read the value above before approving.`
    });
  }
  sections.push(...pointingWarning(name, fact.pointing ?? null));
  if (asked.length > 0) {
    sections.push({ kind: "text", text: `The values you type here go straight into ${CLI_LABELS[agent]}'s config; the agent never sees them. Don't enter this Orquester's own credential.` });
  }
  return { sections, asked };
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** A skill's frontmatter as `writeSkill` writes it: its `name` key is its directory name (in place, or first). */
function skillFrontmatter(frontmatter: Record<string, unknown>, name: string): Record<string, unknown> {
  return "name" in frontmatter ? { ...frontmatter, name } : { name, ...frontmatter };
}

/** The new document an update writes: the current one with the patch applied (frontmatter merged). */
function updatedDocument(detail: ProfileItemDetail | undefined, patch: DocumentChange): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!detail || (detail.kind !== "skill" && detail.kind !== "command")) return null;
  return { frontmatter: mergeFrontmatter(detail.document.frontmatter, patch.frontmatter ?? {}), body: patch.body ?? detail.document.body };
}

function itemFields(item: ProfileItem): ApprovalPreviewSection {
  const rows = [
    { label: "Kind", value: PROFILE_ITEM_KIND_LABELS[item.kind].one },
    { label: "Name", value: item.name },
    { label: "Source", value: item.source.label },
    { label: "Now", value: item.enabled ? "on" : "off" }
  ];
  if (item.description) rows.push({ label: "Description", value: clipText(item.description, 500) });
  if (item.path) rows.push({ label: "Path", value: item.path });
  return { kind: "fields", rows };
}

function detailSections(detail: ProfileItemDetail | undefined): ApprovalPreviewSection[] {
  if (!detail) return [];
  switch (detail.kind) {
    case "hook":
      return [
        { kind: "fields", rows: [{ label: "Event", value: detail.hook.event }, ...(detail.hook.matcher ? [{ label: "Matcher", value: detail.hook.matcher }] : [])] },
        { kind: "code", title: "Command it runs", language: "bash", text: detail.hook.command }
      ];
    case "mcp": {
      const mcp = detail.mcp;
      const rows: { label: string; value: string }[] = [{ label: "Transport", value: mcp.transport }];
      if (mcp.url) rows.push({ label: "URL", value: redactUrlCredentials(mcp.url) });
      for (const entry of [...(mcp.env ?? []), ...(mcp.headers ?? [])]) rows.push({ label: entry.key, value: "set" });
      const sections: ApprovalPreviewSection[] = [{ kind: "fields", rows }];
      if (mcp.command) sections.push({ kind: "code", title: "Command it runs", language: "bash", text: [mcp.command, ...(mcp.args ?? [])].map(shellWord).join(" ") });
      return sections;
    }
    case "plugin":
      return [{ kind: "fields", rows: [{ label: "Plugin", value: detail.plugin.id }, ...(detail.plugin.version ? [{ label: "Version", value: detail.plugin.version }] : []), ...(detail.plugin.marketplace ? [{ label: "Marketplace", value: detail.plugin.marketplace }] : [])] }];
    case "marketplace": {
      const source = detail.marketplace.source;
      const value = source.type === "github" ? source.repo : source.type === "git" ? redactUrlCredentials(source.url) : source.path;
      return [{ kind: "fields", rows: [{ label: "Marketplace", value: detail.marketplace.name }, { label: "Source", value: `${source.type} ${value}` }] }];
    }
    default:
      return [];
  }
}

/** What a plugin ships, as a card section: hooks with their commands, MCP servers with their command lines; and the warnings they call for. */
function providesSections(provides: ProfilePluginPreviewResponse["provides"], pointing: ChangeFacts["pluginPointing"]): ApprovalPreviewSection[] {
  const items: { label: string; change: "added"; detail?: string }[] = [
    ...provides.skills.map((name) => ({ label: `skill ${name}`, change: "added" as const })),
    ...provides.commands.map((name) => ({ label: `command /${name}`, change: "added" as const })),
    ...provides.agents.map((name) => ({ label: `agent ${name}`, change: "added" as const })),
    ...provides.hooks.map((hook) => ({ label: `hook ${hook.event}${hook.matcher ? ` (${hook.matcher})` : ""}`, change: "added" as const, detail: hook.command })),
    ...provides.mcpServers.map((server) => ({
      label: `MCP server ${server.name}`,
      change: "added" as const,
      detail: server.url ?? [server.command ?? "", ...(server.args ?? [])].map(shellWord).join(" ") + (server.envKeys.length > 0 ? ` (env: ${server.envKeys.join(", ")})` : "")
    }))
  ];
  const sections: ApprovalPreviewSection[] = [{ kind: "changes", title: "What it provides", items }];
  if (provides.hooks.length > 0) sections.push({ kind: "warning", level: "caution", text: "Its hooks run their commands on every matching event in every chat of this agent." });
  for (const flagged of pointing ?? []) sections.push(...pointingWarning(flagged.name, flagged.reason));
  return sections;
}

function pluginSections(plugin: ProfilePluginPreviewResponse, pointing: ChangeFacts["pluginPointing"]): ApprovalPreviewSection[] {
  const sections: ApprovalPreviewSection[] = [{
    kind: "fields",
    rows: [
      { label: "Plugin", value: plugin.plugin },
      { label: "Marketplace", value: plugin.marketplace },
      ...(plugin.version ? [{ label: "Version", value: plugin.version }] : []),
      { label: "Marketplace commit", value: plugin.commit ?? "not a git checkout" }
    ]
  }];
  if (plugin.source.type !== "local") {
    sections.push({
      kind: "warning",
      level: "danger",
      text: plugin.source.type === "remote"
        ? `The plugin's files come from ${clipText(plugin.source.description, 300)}, fetched when it is installed: Orquester cannot show them here. Approve only if you trust that source.`
        : `${plugin.source.reason} Approve only if you trust this plugin.`
    });
    return sections;
  }
  if (!plugin.source.complete) throw tooLarge(`The plugin ${plugin.plugin}`);
  sections.push(...providesSections(plugin.provides, pointing));
  sections.push(...fileSections(plugin.source.files, ""));
  return sections;
}

/** The card for the whole batch, from facts read now. */
export function buildPreview(batch: BatchFacts, caller: ToolCaller): ApprovalPreview {
  const { agent, changes, facts } = batch;
  const who = caller.kind === "thread" ? CALLER_LABELS[caller.agentId] ?? caller.agentId : "An agent";
  const sections: ApprovalPreviewSection[] = [];
  const secretFields: { key: string; label: string }[] = [];
  const targets = new Set<Agent>([agent, ...changes.flatMap((change) => (change.toAgent ? [change.toAgent] : []))]);
  if (changes.length > 1) {
    sections.push({
      kind: "changes",
      title: `${changes.length} changes`,
      items: changes.map((change, index) => ({ label: `${index + 1}. ${changePhrase(agent, change, facts[index])}`, change: change.action === "delete" ? "removed" : change.action === "create" || change.action === "import_pick" || change.action === "copy" ? "added" : "changed" }))
    });
  }
  for (const [index, change] of changes.entries()) {
    const fact = facts[index]!;
    const phrase = changePhrase(agent, change, fact);
    const heading = phrase.charAt(0).toUpperCase() + phrase.slice(1) + ".";
    sections.push(changes.length > 1 ? { kind: "text", title: `${index + 1}.`, text: heading } : { kind: "text", text: heading });
    if (fact.replaces) sections.push({ kind: "warning", level: "caution", text: `It replaces the existing ${KIND_ONE[fact.replaces.kind]} "${clipText(fact.replaces.name, 80)}" (onConflict: replace).` });
    switch (change.action) {
      case "create": {
        const kind = changeKind(change)!;
        if (kind === "mcp") {
          const built = mcpSections(agent, index, change, fact);
          sections.push(...built.sections);
          secretFields.push(...built.asked);
        } else if (kind === "skill" || kind === "command") {
          const doc = change[kind]!;
          // keep-both over a taken name: the adapter writes the suffixed name.
          const written = fact.writtenName ?? doc.name!;
          const file = kind === "skill" ? `${written}/SKILL.md` : `commands/${written}.md`;
          const frontmatter = kind === "skill" ? skillFrontmatter(doc.frontmatter ?? {}, written) : (doc.frontmatter ?? {});
          if (fact.writtenName) sections.push({ kind: "text", text: `"${clipText(doc.name!, 80)}" is taken, so it is written as "${fact.writtenName}" (onConflict: keep-both).` });
          sections.push({ kind: "code", title: file, language: "markdown", text: documentText(agent, frontmatter, doc.body ?? "") });
        } else if (kind === "hook") {
          const hook = change.hook!;
          sections.push(
            { kind: "fields", rows: [{ label: "Event", value: hook.event! }, ...(hook.matcher ? [{ label: "Matcher", value: hook.matcher }] : []), ...(hook.timeoutSec ? [{ label: "Timeout", value: `${hook.timeoutSec} s` }] : [])] },
            { kind: "code", title: "Command it runs", language: "bash", text: hook.command! },
            { kind: "warning", level: "caution", text: `The command runs on every ${clipText(hook.event!, 40)} event in every ${CLI_LABELS[agent]} chat.` }
          );
        } else if (kind === "plugin") {
          if (change.plugin!.spec !== undefined) {
            sections.push({ kind: "warning", level: "danger", text: `OpenCode loads ${quoted(change.plugin!.spec)} as code (an npm package or a local file) in every OpenCode session. Orquester cannot show its contents here.` });
          } else sections.push(...pluginSections(fact.plugin!, fact.pluginPointing));
        } else if (kind === "marketplace") {
          const source = change.marketplace!.source;
          const rows = [
            ...(change.marketplace!.name ? [{ label: "Name", value: change.marketplace!.name }] : []),
            { label: "Source", value: source.type === "github" ? `GitHub ${source.repo}` : source.type === "git" ? source.url : source.path },
            ...(source.type !== "path" && source.ref ? [{ label: "Ref", value: source.ref }] : []),
            { label: "Commit", value: source.type === "path" ? "the directory as it is" : "whatever the source holds when it is added" }
          ];
          sections.push(
            { kind: "fields", rows },
            {
              kind: "warning",
              level: "danger",
              text: source.type === "path"
                ? "This approval does not pin the directory: Orquester cannot show the marketplace's contents before it is added, and they may change after."
                : "This approval does not pin a commit: Orquester cannot show the marketplace's contents before it is added, and the source may hold something else by then."
            },
            { kind: "text", text: "Adding a marketplace installs nothing by itself: each plugin from it gets its own approval card, showing its files with the marketplace's commit pinned." }
          );
        }
        break;
      }
      case "update": {
        const kind = changeKind(change)!;
        if (kind === "mcp") {
          const built = mcpSections(agent, index, change, fact);
          sections.push(...built.sections);
          secretFields.push(...built.asked);
        } else if (kind === "skill" || kind === "command") {
          const doc = updatedDocument(fact.detail, change[kind]!);
          if (doc && fact.detail && (fact.detail.kind === "skill" || fact.detail.kind === "command")) {
            const name = change[kind]!.name ?? fact.item!.name;
            const file = kind === "skill" ? `${name}/SKILL.md` : `commands/${name}.md`;
            const before = documentText(agent, fact.detail.document.frontmatter, fact.detail.document.body);
            const after = documentText(agent, kind === "skill" ? skillFrontmatter(doc.frontmatter, name) : doc.frontmatter, doc.body);
            sections.push({ kind: "diff", title: `${file} — changes`, unifiedDiff: unifiedDiff(before, after, `a/${file}`, `b/${file}`) });
            sections.push({ kind: "code", title: `${file} — as it will be`, language: "markdown", text: after });
            const others = kind === "skill" ? (fact.files?.files ?? []).filter((entry) => entry.path !== "SKILL.md") : [];
            if (others.length > 0) sections.push({ kind: "text", text: `Its other files stay as they are: ${others.map((entry) => entry.path).join(", ")}.` });
          }
        } else if (kind === "hook" && fact.detail?.kind === "hook") {
          const hook = change.hook!;
          const current = fact.detail.hook;
          const next = {
            event: hook.event ?? current.event,
            matcher: hook.matcher === null ? undefined : hook.matcher ?? current.matcher,
            command: hook.command ?? current.command
          };
          sections.push(
            { kind: "fields", rows: [{ label: "Event", value: next.event }, ...(next.matcher ? [{ label: "Matcher", value: next.matcher }] : [])] },
            { kind: "diff", title: "Command", unifiedDiff: unifiedDiff(`${current.command}\n`, `${next.command}\n`, "a/command", "b/command") },
            { kind: "code", title: "Command it will run", language: "bash", text: next.command }
          );
        }
        break;
      }
      case "enable":
      case "disable":
      case "delete":
      case "trust_hook":
      case "copy": {
        sections.push(itemFields(fact.item!), ...detailSections(fact.detail));
        if (fact.files) {
          if (!fact.files.complete) throw tooLarge(`The ${KIND_ONE[fact.item!.kind]} ${fact.item!.name}`);
          // An installed plugin turned on: what it ships (its files are pinned); a skill or command: every file.
          if (fact.files.provides) sections.push(...providesSections(fact.files.provides, fact.pluginPointing));
          else sections.push(...fileSections(fact.files.files, fact.item!.kind === "skill" ? fact.item!.name : ""));
        }
        if (fact.item!.kind === "mcp") sections.push(...pointingWarning(fact.item!.name, fact.pointing ?? null));
        const effect =
          change.action === "delete" ? `It is removed from ${CLI_LABELS[agent]}'s config${fact.item!.kind === "plugin" ? " (the plugin is uninstalled)" : ""}. Orquester keeps a backup of every file it rewrites.`
          : change.action === "trust_hook" ? `${CLI_LABELS[agent]} will run this command on every matching event.`
          : change.action === "copy" ? `A copy converted for ${CLI_LABELS[change.toAgent!]} is added there (onConflict: ${change.onConflict ?? "fail"}); MCP secret values move inside Orquester, never through the agent.`
          : change.action === "enable" ? `Every ${CLI_LABELS[agent]} chat loads it again.`
          : `${CLI_LABELS[agent]} chats stop loading it.`;
        sections.push({ kind: "text", text: effect });
        break;
      }
      case "write_instructions": {
        const current = fact.instructions!;
        const name = current.info.path.split("/").pop() ?? "instructions";
        sections.push(
          { kind: "fields", rows: [{ label: "File", value: current.info.path }, { label: "Revision", value: current.info.revision || "(new file)" }] },
          { kind: "diff", title: name, unifiedDiff: unifiedDiff(current.text, change.text!, `a/${name}`, `b/${name}`) },
          { kind: "text", text: `Every ${CLI_LABELS[agent]} chat reads this file.` }
        );
        break;
      }
      case "import_scan":
        sections.push(
          { kind: "fields", rows: [{ label: "Repository", value: change.url! }] },
          { kind: "warning", level: "caution", text: "Orquester downloads this repository from the network to list what it holds. Nothing is installed: importing an item needs another approval showing its files." }
        );
        break;
      case "import_pick": {
        const detail = fact.importDetail!;
        const source = detail.source;
        sections.push({
          kind: "fields",
          rows: source.type === "git"
            ? [{ label: "Repository", value: redactUrlCredentials(source.url) }, ...(source.ref ? [{ label: "Ref", value: source.ref }] : []), { label: "Commit", value: source.commit ?? "unknown" }]
            : [{ label: "Upload", value: source.name }]
        });
        for (const candidate of detail.candidates.filter((entry) => change.picks!.includes(entry.ref))) {
          if (!candidate.complete) throw tooLarge(`The import item ${candidate.name}`);
          sections.push({ kind: "text", title: `${KIND_ONE[candidate.kind]} ${candidate.name}`, text: candidate.exists ? `${CLI_LABELS[agent]} already has one by that name (onConflict: ${change.onConflict ?? "fail"}).` : `New in ${CLI_LABELS[agent]}.` });
          if (candidate.notes?.length) sections.push({ kind: "text", text: `As imported: ${candidate.notes.map((note) => clipText(note, 300)).join(" ")}` });
          sections.push(...fileSections(candidate.files, candidate.kind === "skill" ? candidate.name : ""));
        }
        break;
      }
    }
  }
  const verb = changes.length === 1 ? changePhrase(agent, changes[0]!, facts[0]) : `make ${changes.length} changes to ${[...targets].map((target) => CLI_LABELS[target]).join(" and ")}'s profile`;
  const scopeLabel = `Global — every ${[...targets].map((target) => CLI_LABELS[target]).join(" and ")} chat`;
  return {
    title: `${who} wants to ${verb}`,
    scopeLabel,
    sections,
    ...(secretFields.length > 0 ? { secretFields } : {}),
    pins: { ...batch.pins }
  };
}

/** The card preview for `edit_agent_profile` (validation, reads, card). */
export async function editPreview(agent: Agent, changes: readonly ProfileChange[], ctx: ScopeContext): Promise<ApprovalPreview> {
  validateChanges(agent, changes, ctx.caller);
  return buildPreview(await readBatchFacts(ctx.api, agent, changes), ctx.caller);
}

/** sha256 of a string (tests and pins). */
export { sha256 };
