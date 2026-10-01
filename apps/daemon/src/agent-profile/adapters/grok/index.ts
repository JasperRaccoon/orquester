/**
 * Agent profile — Grok Build (1.0.34) adapter: every read and write of
 * `~/.grok` the profile makes (spec §3, §4.6 "Grok").
 *
 * What lives where, and how "off" works:
 *
 * | Kind | Own items | Inherited (listed, not editable here) | Off |
 * |---|---|---|---|
 * | instructions | `AGENTS.md`; a dead `GROK.md` (Grok never reads it) is offered for migration | — | — |
 * | mcp | `[mcp_servers.<n>]` in `config.toml` | `~/.claude.json` `mcpServers`, Cursor, trusted plugins' `.mcp.json` — from `grok inspect --json` | `disabled_mcp_servers` (+ `enabled = false` on an own entry), as `grok mcp disable` writes it; works for inherited servers too and affects Grok only |
 * | skill | `skills/<n>/SKILL.md` | `~/.claude/skills`, `~/.agents/skills`, plugin skills, `bundled/skills` | `[skills] disabled` (by name) |
 * | command | `commands/<n>.md` (flat) | `~/.claude/commands`, `~/.agents/commands`, plugin commands | `[skills] disabled` — Grok loads commands as skills (verified: `grok inspect` marks a command named there `disabled`) |
 * | plugin | installed plugins, `plugins/*` | plugins found under `~/.claude` | `[plugins] enabled` / `disabled` (plugins are off unless listed in `enabled` — verified) |
 * | marketplace | `[[marketplace.sources]]` | `extraKnownMarketplaces` in `settings.json` (read-only) | — |
 * | hook | handlers in `hooks/*.json`; new ones in `hooks/profile.json` | — | stash (Grok has no per-hook off in its files) |
 *
 * Deliberate deviations from the spec's "through `grok …`", each observed
 * against the real CLI on a temp `GROK_HOME`:
 * - MCP create/edit/delete and every on/off write `config.toml` through
 *   `toml-patch.ts`, never `grok mcp add|remove|enable|disable`: `grok mcp
 *   add` takes env values and headers on argv (credentials must stay out of
 *   process arguments), and every `grok` config write rewrites the whole file,
 *   dropping its comments. Plugin on/off is the same `[plugins]` list edit
 *   `grok plugin enable|disable` makes, done comment-preserving.
 * - Plugin install/uninstall and marketplace add/remove do run `grok plugin …`
 *   (they clone, fetch and keep `installed-plugins/registry.json`); the file is
 *   backed up first and a note says so when Grok's rewrite dropped comments.
 *   Uninstall never passes `--confirm`: Grok removes a whole install, so with
 *   it deleting one of several plugins installed from one source silently
 *   uninstalls the others too. Such plugins are listed not deletable.
 * - `[[hooks.<Event>]]` tables in `config.toml` are listed read-only: they
 *   run, but Grok's own inspect flags `hooks` as an unknown config key, so
 *   the profile does not write them.
 *
 * `grok inspect --json` runs with `GROK_HOME`/`HOME` = the daemon user's own
 * and `cwd` = `~/.grok` (so no project layer joins in); it never starts an MCP
 * server. Its answer is cached 10 s and dropped after every write. When it
 * fails, inherited MCP servers are read from `~/.claude.json` alone and those
 * items, and every plugin, carry an `inspect-failed` warning (the snapshot has
 * no file to blame, so no `fileErrors` entry).
 *
 * `[compat.claude] hooks` (kept `false` by the host: Claude's hooks would
 * double-report status) and the per-thread `GROK_CONFIG_PATH` overlay are
 * never touched.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  type HookDraft,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  type MarketplaceDraft,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  type McpServerDraft,
  type McpServerView,
  type McpTransport,
  PROFILE_HOOK_EVENTS,
  PROFILE_HOOK_EVENTS_WITHOUT_MATCHER,
  type PluginInstallDraft,
  type ProfileConflictPolicy,
  type ProfileFileError,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemDetail,
  type ProfileItemDraft,
  type ProfileItemKind,
  type ProfileItemSource,
  type ProfileItemWarning,
  type SecretEntryDraft,
  type MarkdownDocumentDraft,
  PROFILE_SKILL_NAME_MAX,
  PROFILE_MCP_NAME_MAX
} from "@orquester/api";
import { agentProfileImportsDir } from "@orquester/config";
import { AgentProfileError, profileErrors } from "../../errors.ts";
import {
  type AgentCliResult,
  type ProfileBackups,
  type ProfileStash,
  type ScannedCommand,
  type ScannedSkill,
  assertCommandName,
  assertMcpServerName,
  assertSafeSegment,
  assertSkillName,
  contentHash,
  copyTree,
  isValidMcpServerName,
  isValidSkillName,
  itemId,
  parseMarkdownDocument,
  pathKind,
  readSkillFiles,
  readTextIfExists,
  removeProfilePath,
  resolveWriteTarget,
  runAgentCliOrThrow,
  scanCommands,
  scanSkills,
  writeCommand,
  writeProfileFile,
  writeProfileFileVerified,
  writeSkill
} from "../../infra/index.ts";
import type {
  AdapterMutationResult,
  AdapterSnapshot,
  PortableItem,
  PortableMcpServer,
  ProfileAdapter,
  ProfileAdapterContext
} from "../types.ts";
import {
  type HookLocation,
  type JsonObject,
  hookId,
  insertHandler,
  isJsonObject,
  listHandlers,
  normalizeMatcher,
  parseHookFile,
  removeHandler,
  replaceHandler,
  serializeHookFile
} from "./hooks.ts";
import { SecretDigester } from "../../infra/secret-digest.ts";
import { type GrokInspect, parseGrokInspect } from "./inspect.ts";
import { type TomlEdit, type TomlTable, editToml, getTomlPath, isTable, parseToml } from "./toml-patch.ts";

const AGENT = "grok";
/** How long one `grok inspect --json` answer is reused (dropped after every write). */
const GROK_INSPECT_TTL_MS = 10_000;
const TIMEOUTS = {
  inspect: 30_000,
  list: 60_000,
  install: 180_000,
  uninstall: 60_000,
  marketplaceAdd: 180_000,
  marketplaceRemove: 120_000
} as const;

/** Orquester's own status hooks: listed, locked, never written. */
const GROK_ORQUESTER_HOOK_FILE = "orquester.json";
/** Where hooks created from the panel go. */
const GROK_PROFILE_HOOK_FILE = "profile.json";
const CONFIG_TOML = "config.toml";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const USER: ProfileItemSource = { type: "user", label: "User" };
const FROM_CLAUDE: ProfileItemSource = { type: "inherited", label: "From Claude", ownerAgent: "claude" };
const SHARED_AGENTS: ProfileItemSource = { type: "inherited", label: "Shared · ~/.agents" };
const BUNDLED: ProfileItemSource = { type: "bundled", label: "Bundled" };
const ORQUESTER: ProfileItemSource = { type: "orquester", label: "Orquester" };

function pluginSource(plugin: string): ProfileItemSource {
  return { type: "plugin", label: `Plugin · ${plugin}`, pluginId: plugin };
}

type MarkdownScope = "user" | "agents" | "claude" | "bundled" | "plugin";
type PluginWhere = "installed" | "plugins-dir" | "claude" | "other";

type Ref =
  | { type: "mcp-own"; name: string; table: TomlTable }
  | {
      type: "mcp-inherited";
      name: string;
      origin: "claude" | "cursor" | "plugin" | "other";
      sourcePath?: string;
      pluginName?: string;
      transport?: string;
    }
  | { type: "skill"; scope: MarkdownScope; name: string; dirName: string; dir: string; file: string }
  | { type: "command"; scope: MarkdownScope; name: string; file: string }
  | { type: "hook-file"; location: HookLocation }
  | { type: "hook-stash"; location: HookLocation }
  | { type: "hook-toml"; location: HookLocation }
  | {
      type: "plugin";
      name: string;
      path?: string;
      where: PluginWhere;
      version?: string;
      marketplace?: string;
      description?: string;
      provides?: GrokInspect["plugins"][number]["provides"];
    }
  | { type: "marketplace"; name: string; source: MarketplaceSource; inConfig: boolean };

interface Entry {
  item: ProfileItem;
  ref: Ref;
}

interface ConfigState {
  path: string;
  /** `null` when the file does not exist (or could not be read — see `error`). */
  text: string | null;
  doc: TomlTable;
  error?: string;
}

interface HookFileState {
  path: string;
  text: string;
  data: JsonObject | null;
  error?: string;
}

interface InspectResult {
  data: GrokInspect | null;
  error?: string;
}

interface Model {
  config: ConfigState;
  hookFiles: Map<string, HookFileState>;
  entries: Entry[];
  fileErrors: ProfileFileError[];
}

interface GrokProfileAdapterDeps {
  backups: ProfileBackups;
  stash: ProfileStash;
  runCli?: typeof runAgentCliOrThrow;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A parser's complaint without the text it quotes: TOML and JSON errors
 * echo the offending line, which can hold a secret (an MCP env value).
 */
function safeParseError(kind: "TOML" | "JSON", error: unknown): string {
  const text = message(error);
  const at = /\((\d+), (\d+)\)/.exec(text) ?? /line (\d+) column (\d+)/i.exec(text);
  if (at !== null) {
    return `Not valid ${kind} (line ${at[1]}, column ${at[2]}).`;
  }
  const position = /position (\d+)/.exec(text);
  return position !== null ? `Not valid ${kind} (at character ${position[1]}).` : `Not valid ${kind}.`;
}

function verifyToml(text: string): void {
  try {
    parseToml(text);
  } catch (error) {
    throw new Error(safeParseError("TOML", error));
  }
}

function verifyHookFile(text: string): void {
  try {
    parseHookFile(text);
  } catch (error) {
    throw new Error(safeParseError("JSON", error));
  }
}

function makeItem(
  fields: Omit<ProfileItem, "revision" | "warnings"> & { warnings?: ProfileItemWarning[] },
  content: unknown
): ProfileItem {
  return { ...fields, warnings: fields.warnings ?? [], revision: contentHash({ content, enabled: fields.enabled }) };
}

function stringsIn(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function tableAt(doc: TomlTable, path: readonly string[]): TomlTable {
  const value = getTomlPath(doc, path);
  return isTable(value) ? value : {};
}

/** `[plugins]` entries are plain names or full ids `<scope>/<hash>/<name>`. */
function pluginListed(list: readonly string[], name: string): boolean {
  return list.some((entry) => entry === name || entry.endsWith(`/${name}`));
}

/**
 * The edit that adds `add` to and removes `remove` from the list at `path`
 * (entries that are not strings are kept); `null` when nothing changes.
 */
function listEdit(
  doc: TomlTable,
  path: readonly string[],
  change: { add?: string[]; remove?: (entry: string) => boolean },
  dropWhenEmpty: boolean
): TomlEdit | null {
  const raw = getTomlPath(doc, path);
  if (raw !== undefined && !Array.isArray(raw)) {
    throw profileErrors.invalidItem(`${path.join(".")} in config.toml is not a list; fix it by hand first.`);
  }
  const current = raw ?? [];
  const next = current.filter((entry) => typeof entry !== "string" || !(change.remove?.(entry) ?? false));
  for (const entry of change.add ?? []) {
    if (!next.includes(entry)) next.push(entry);
  }
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return null;
  }
  if (next.length === 0 && dropWhenEmpty) {
    return { op: "delete", path };
  }
  return { op: "set", path, value: next };
}

function transportOf(def: Record<string, unknown>): McpTransport {
  const type = typeof def.type === "string" ? def.type.toLowerCase() : "";
  if (type === "sse") return "sse";
  if (type === "http" || type === "streamable-http" || type === "streamable_http") return "http";
  if (typeof def.url === "string" && typeof def.command !== "string") return "http";
  return "stdio";
}

const GROK_ADVANCED_KEYS = (MCP_ADVANCED_FIELDS.grok ?? []).map((field) => field.key);

/** An MCP definition (Grok TOML or Claude JSON) as the panel sees it: secret values replaced by `{set: true}`. */
function mcpView(name: string, def: Record<string, unknown>): McpServerView {
  const view: McpServerView = { name, transport: transportOf(def) };
  if (typeof def.command === "string") view.command = def.command;
  if (Array.isArray(def.args)) view.args = stringsIn(def.args);
  if (typeof def.cwd === "string") view.cwd = def.cwd;
  if (typeof def.url === "string") view.url = def.url;
  if (isTable(def.env)) view.env = Object.keys(def.env).map((key) => ({ key, set: true }));
  if (isTable(def.headers)) view.headers = Object.keys(def.headers).map((key) => ({ key, set: true }));
  const advanced: Record<string, unknown> = {};
  for (const key of GROK_ADVANCED_KEYS) {
    if (def[key] !== undefined) advanced[key] = def[key];
  }
  if (Object.keys(advanced).length > 0) view.advanced = advanced;
  return view;
}

function portableMcp(name: string, def: Record<string, unknown>): PortableMcpServer {
  const view = mcpView(name, def);
  const secrets = (value: unknown): Record<string, string> | undefined => {
    if (!isTable(value)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") out[key] = entry;
    }
    return out;
  };
  const env = secrets(def.env);
  const headers = secrets(def.headers);
  return {
    name,
    transport: view.transport,
    ...(view.command !== undefined ? { command: view.command } : {}),
    ...(view.args !== undefined ? { args: view.args } : {}),
    ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
    ...(view.url !== undefined ? { url: view.url } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(view.advanced !== undefined ? { advanced: view.advanced } : {})
  };
}

/** Grok's skill name: the frontmatter `name` (spaces and `_` become `-`), else the directory name. */
function grokSkillName(frontmatter: Record<string, unknown>, fallback: string): string {
  const raw = frontmatter.name;
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  return raw.trim().replace(/[\s_]+/g, "-");
}

function isCommandPath(path: string | undefined): boolean {
  return path !== undefined && /[\\/]commands[\\/][^\\/]+\.md$/.test(path);
}

/** Next free `<base>-2`, `<base>-3`, … that passes `valid` and fits `max`. */
function nextFreeName(base: string, taken: (name: string) => boolean, max: number, valid: (name: string) => boolean): string {
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (valid(candidate) && !taken(candidate)) return candidate;
  }
  throw profileErrors.exists(base);
}

/** A client-supplied CLI argument: never empty, never read as a flag, one line. */
function cliArgument(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw profileErrors.invalidItem(`${what} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed) || trimmed.length > 2000) {
    throw profileErrors.invalidItem(`${what} is not valid: ${JSON.stringify(trimmed.slice(0, 80))}.`);
  }
  return trimmed;
}

/** Credentials must stay out of process arguments (AGENTS.md): no `scheme://user:secret@host` sources. */
function refuseUrlCredentials(value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(value)) {
    throw profileErrors.invalidItem("Put git credentials in a credential helper, not in the URL.");
  }
}

function countComments(text: string): number {
  return (text.match(/(^|[ \t])#/gm) ?? []).length;
}

export class GrokProfileAdapter implements ProfileAdapter {
  readonly agent = "grok" as const;
  private readonly backups: ProfileBackups;
  private readonly stash: ProfileStash;
  private readonly runCli: typeof runAgentCliOrThrow;
  private readonly secrets = new SecretDigester();
  private inspectCache: { at: number; result: InspectResult } | null = null;
  private inspectInFlight: Promise<InspectResult> | null = null;
  /** Bumped by every write: an inspect started before it never answers or caches for after it. */
  private inspectGeneration = 0;

  constructor(
    private readonly ctx: ProfileAdapterContext,
    deps: GrokProfileAdapterDeps
  ) {
    this.backups = deps.backups;
    this.stash = deps.stash;
    this.runCli = deps.runCli ?? runAgentCliOrThrow;
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private get grokHome(): string {
    return this.ctx.homes.grokHome;
  }

  private get configPath(): string {
    return join(this.grokHome, CONFIG_TOML);
  }

  private get hooksDir(): string {
    return join(this.grokHome, "hooks");
  }

  private get skillsDir(): string {
    return join(this.grokHome, "skills");
  }

  private get commandsDir(): string {
    return join(this.grokHome, "commands");
  }

  private get agentsPath(): string {
    return join(this.grokHome, "AGENTS.md");
  }

  private get legacyPath(): string {
    return join(this.grokHome, "GROK.md");
  }

  private get agentsCommandsDir(): string {
    return join(dirname(this.ctx.homes.agentsSkillsDir), "commands");
  }

  watchPaths(): string[] {
    return [
      this.configPath,
      this.agentsPath,
      this.legacyPath,
      this.skillsDir,
      this.commandsDir,
      this.hooksDir,
      join(this.grokHome, "plugins"),
      join(this.grokHome, "installed-plugins"),
      join(this.grokHome, "settings.json"),
      this.ctx.homes.claudeJson,
      join(this.ctx.homes.claudeDir, "skills"),
      join(this.ctx.homes.claudeDir, "commands"),
      this.ctx.homes.agentsSkillsDir,
      this.agentsCommandsDir,
      join(this.stash.dir, AGENT)
    ];
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async snapshot(): Promise<AdapterSnapshot> {
    const model = await this.load();
    return { instructions: await this.instructionsInfo(), items: model.entries.map((entry) => entry.item), fileErrors: model.fileErrors };
  }

  async readItem(id: string): Promise<ProfileItemDetail> {
    const model = await this.load();
    const { item, ref } = this.find(model, id);
    switch (ref.type) {
      case "mcp-own":
        return { kind: "mcp", item, mcp: mcpView(ref.name, ref.table) };
      case "mcp-inherited":
        return { kind: "mcp", item, mcp: mcpView(ref.name, (await this.inheritedMcpDefinition(ref)) ?? {}) };
      case "skill":
      case "command": {
        const document = await this.readDocument(ref.file);
        if (ref.type === "skill") {
          return { kind: "skill", item, document, files: await readSkillFiles(ref.dir) };
        }
        return { kind: "command", item, document };
      }
      case "hook-file":
      case "hook-stash":
      case "hook-toml": {
        const { location } = ref;
        const timeout = location.handler.timeout;
        return {
          kind: "hook",
          item,
          hook: {
            event: location.event,
            ...(location.matcher !== undefined ? { matcher: location.matcher } : {}),
            command: typeof location.handler.command === "string" ? location.handler.command : typeof location.handler.url === "string" ? location.handler.url : "",
            ...(typeof timeout === "number" ? { timeoutSec: timeout } : {})
          }
        };
      }
      case "plugin": {
        const provides = ref.provides;
        return {
          kind: "plugin",
          item,
          plugin: {
            id: item.id,
            name: ref.name,
            ...(ref.marketplace !== undefined ? { marketplace: ref.marketplace } : {}),
            ...(ref.version !== undefined ? { version: ref.version } : {}),
            ...(ref.description !== undefined ? { description: ref.description } : {}),
            ...(provides !== undefined
              ? {
                  provides: {
                    ...(provides.skills !== undefined ? { skills: provides.skills } : {}),
                    ...(provides.agents !== undefined ? { agents: provides.agents } : {}),
                    ...(provides.mcpServers !== undefined ? { mcpServers: provides.mcpServers } : {}),
                    hooks: provides.hooks === true ? 1 : 0
                  }
                }
              : {})
          }
        };
      }
      case "marketplace":
        return { kind: "marketplace", item, marketplace: { name: ref.name, source: ref.source } };
    }
  }

  private async readDocument(file: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw profileErrors.unreadable(file, message(error));
    }
    try {
      const { frontmatter, body } = parseMarkdownDocument(text);
      return { frontmatter, body };
    } catch (error) {
      throw profileErrors.unreadable(file, message(error));
    }
  }

  private find(model: Model, id: string, revision?: string): Entry {
    const entry = model.entries.find((candidate) => candidate.item.id === id);
    if (entry === undefined) {
      throw profileErrors.notFound(id);
    }
    if (revision !== undefined && entry.item.revision !== revision) {
      throw profileErrors.conflict();
    }
    return entry;
  }

  private async load(): Promise<Model> {
    const fileErrors: ProfileFileError[] = [];
    const config = await this.readConfig();
    if (config.error !== undefined) {
      fileErrors.push({ path: config.path, message: config.error });
    }
    const hookFiles = await this.readHookFiles();
    for (const state of hookFiles.values()) {
      if (state.error !== undefined) fileErrors.push({ path: state.path, message: state.error });
    }
    const inspect = await this.inspect();
    const entries: Entry[] = [
      ...(await this.mcpEntries(config.doc, inspect, fileErrors)),
      ...(await this.markdownEntries(config.doc, inspect)),
      ...(await this.hookEntries(config.doc, hookFiles)),
      ...(await this.pluginEntries(config.doc, inspect)),
      ...(await this.marketplaceEntries(config.doc, fileErrors))
    ];
    return { config, hookFiles, entries, fileErrors };
  }

  private async readConfig(): Promise<ConfigState> {
    const path = this.configPath;
    let text: string | null;
    try {
      text = await readTextIfExists(path);
    } catch (error) {
      return { path, text: null, doc: {}, error: message(error) };
    }
    if (text === null) {
      return { path, text: null, doc: {} };
    }
    try {
      return { path, text, doc: parseToml(text) };
    } catch (error) {
      return { path, text, doc: {}, error: safeParseError("TOML", error) };
    }
  }

  private async readHookFiles(): Promise<Map<string, HookFileState>> {
    const states = new Map<string, HookFileState>();
    let names: string[];
    try {
      names = (await readdir(this.hooksDir)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
    } catch {
      return states;
    }
    for (const name of names) {
      const path = join(this.hooksDir, name);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
        states.set(name, { path, text: "", data: null, error: message(error) });
        continue;
      }
      try {
        states.set(name, { path, text, data: parseHookFile(text) });
      } catch (error) {
        const detail = error instanceof SyntaxError ? safeParseError("JSON", error) : message(error);
        states.set(name, { path, text, data: null, error: detail });
      }
    }
    return states;
  }

  private inspect(): Promise<InspectResult> {
    const now = this.ctx.now().getTime();
    const cached = this.inspectCache;
    if (cached !== null && now >= cached.at && now - cached.at < GROK_INSPECT_TTL_MS) {
      return Promise.resolve(cached.result);
    }
    if (this.inspectInFlight !== null) {
      return this.inspectInFlight;
    }
    const generation = this.inspectGeneration;
    const inFlight: Promise<InspectResult> = this.runInspect()
      .then((result) => {
        // A write landed while this ran: its answer may predate the write, so it is not kept.
        if (generation === this.inspectGeneration) {
          this.inspectCache = { at: now, result };
        }
        return result;
      })
      .finally(() => {
        if (this.inspectInFlight === inFlight) {
          this.inspectInFlight = null;
        }
      });
    this.inspectInFlight = inFlight;
    return inFlight;
  }

  private async runInspect(): Promise<InspectResult> {
    if (this.ctx.bin === null) {
      return { data: null, error: "Grok is not installed." };
    }
    try {
      const output = await this.grok(["inspect", "--json"], TIMEOUTS.inspect);
      const data = parseGrokInspect(output.stdout);
      return data === null ? { data: null, error: "`grok inspect --json` did not print an inspect report." } : { data };
    } catch (error) {
      this.ctx.logger.warn(`agent-profile grok: grok inspect failed: ${message(error)}`);
      return { data: null, error: message(error) };
    }
  }

  /** Drops the cached inspect answer, and any run already under way, after every write. */
  private invalidate(): void {
    this.inspectCache = null;
    this.inspectInFlight = null;
    this.inspectGeneration += 1;
  }

  private inspectWarning(inspect: InspectResult): ProfileItemWarning[] {
    if (inspect.data !== null) return [];
    const detail = (inspect.error ?? "unknown error").slice(0, 300);
    return [
      {
        code: "inspect-failed",
        message: `Grok's own listing (grok inspect) failed, so servers, skills and commands from plugins and Cursor may be missing: ${detail}`
      }
    ];
  }

  // --- MCP ------------------------------------------------------------------

  private async mcpEntries(doc: TomlTable, inspect: InspectResult, fileErrors: ProfileFileError[]): Promise<Entry[]> {
    const entries: Entry[] = [];
    const disabled = new Set(stringsIn(getTomlPath(doc, ["disabled_mcp_servers"])));
    const servers = tableAt(doc, ["mcp_servers"]);
    for (const [name, table] of Object.entries(servers)) {
      if (!isTable(table)) continue;
      const enabled = table.enabled !== false && !disabled.has(name);
      const warnings: ProfileItemWarning[] = isValidMcpServerName(name)
        ? []
        : [{ code: "invalid-name", message: 'Grok skips the tools of a server whose name does not start with a letter or "_", or ends in "_".' }];
      entries.push({
        item: makeItem(
          {
            id: itemId("mcp", name),
            kind: "mcp",
            name,
            enabled,
            toggleable: true,
            editable: true,
            deletable: true,
            locked: false,
            source: USER,
            path: this.configPath,
            warnings,
            meta: { transport: transportOf(table) }
          },
          // Keyed digests of env/header values: the revision reaches clients and must not be brute-forceable into a secret.
          this.secrets.masked(table)
        ),
        ref: { type: "mcp-own", name, table }
      });
    }
    const taken = new Set(Object.keys(servers));
    const inherited = (ref: Extract<Ref, { type: "mcp-inherited" }>, warnings: ProfileItemWarning[]): Entry => {
      const source: ProfileItemSource =
        ref.origin === "claude"
          ? FROM_CLAUDE
          : ref.origin === "plugin" && ref.pluginName !== undefined
            ? pluginSource(ref.pluginName)
            : { type: "inherited", label: ref.origin === "cursor" ? "From Cursor" : "Inherited" };
      return {
        item: makeItem(
          {
            id: itemId("mcp", ref.name),
            kind: "mcp",
            name: ref.name,
            enabled: !disabled.has(ref.name),
            toggleable: true,
            editable: false,
            deletable: false,
            locked: false,
            source,
            ...(ref.sourcePath !== undefined ? { path: ref.sourcePath } : {}),
            warnings,
            ...(ref.transport !== undefined ? { meta: { transport: ref.transport } } : {})
          },
          { origin: ref.origin, sourcePath: ref.sourcePath, pluginName: ref.pluginName, transport: ref.transport }
        ),
        ref
      };
    };
    if (inspect.data !== null) {
      for (const server of inspect.data.mcpServers) {
        if (server.sourceType === "configToml" || taken.has(server.name)) continue;
        taken.add(server.name);
        const type = server.sourceType.toLowerCase();
        const origin = type.includes("claude") ? "claude" : type.includes("cursor") ? "cursor" : type === "plugin" ? "plugin" : "other";
        entries.push(
          inherited(
            {
              type: "mcp-inherited",
              name: server.name,
              origin,
              ...(server.sourcePath !== undefined ? { sourcePath: server.sourcePath } : {}),
              ...(server.pluginName !== undefined ? { pluginName: server.pluginName } : {}),
              ...(server.transport !== undefined ? { transport: server.transport } : {})
            },
            []
          )
        );
      }
    } else if (getTomlPath(doc, ["compat", "claude", "mcps"]) !== false) {
      const warnings = this.inspectWarning(inspect);
      for (const [name, def] of Object.entries(await this.readClaudeServers(fileErrors))) {
        if (taken.has(name)) continue;
        taken.add(name);
        entries.push(
          inherited(
            { type: "mcp-inherited", name, origin: "claude", sourcePath: this.ctx.homes.claudeJson, transport: transportOf(def) },
            warnings
          )
        );
      }
    }
    return entries;
  }

  /** `~/.claude.json`'s user-level `mcpServers` (never a project's). */
  private async readClaudeServers(fileErrors?: ProfileFileError[]): Promise<Record<string, Record<string, unknown>>> {
    const path = this.ctx.homes.claudeJson;
    let text: string | null;
    try {
      text = await readTextIfExists(path);
    } catch (error) {
      fileErrors?.push({ path, message: message(error) });
      return {};
    }
    if (text === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fileErrors?.push({ path, message: safeParseError("JSON", error) });
      return {};
    }
    const servers = isJsonObject(parsed) && isJsonObject(parsed.mcpServers) ? parsed.mcpServers : {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, def] of Object.entries(servers)) {
      if (isJsonObject(def)) out[name] = def;
    }
    return out;
  }

  private async inheritedMcpDefinition(ref: Extract<Ref, { type: "mcp-inherited" }>): Promise<Record<string, unknown> | null> {
    if (ref.origin === "claude") {
      return (await this.readClaudeServers())[ref.name] ?? null;
    }
    if (ref.origin === "plugin" && ref.sourcePath !== undefined) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(ref.sourcePath, ".mcp.json"), "utf8"));
        const servers = isJsonObject(parsed) && isJsonObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
        const def = isJsonObject(servers) ? servers[ref.name] : undefined;
        return isJsonObject(def) ? def : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // --- Skills and commands --------------------------------------------------

  private async markdownEntries(doc: TomlTable, inspect: InspectResult): Promise<Entry[]> {
    const disabled = new Set(stringsIn(getTomlPath(doc, ["skills", "disabled"])));
    const claudeCompat = getTomlPath(doc, ["compat", "claude", "skills"]) !== false;
    /** Grok name → the label of the source Grok loads it from (the first, by priority). */
    const winners = new Map<string, string>();
    const entries: Entry[] = [];

    const addSkill = async (skill: ScannedSkill, scope: Exclude<MarkdownScope, "plugin">, source: ProfileItemSource): Promise<void> => {
      const name = grokSkillName(skill.frontmatter, skill.name);
      const own = scope === "user";
      const id = own ? itemId("skill", skill.name) : itemId("skill", `${scope}/${skill.name}`);
      let content: unknown = { path: skill.skillFile, frontmatter: skill.frontmatter };
      const warnings: ProfileItemWarning[] = skill.error !== undefined ? [{ code: "unreadable", message: skill.error }] : [];
      if (own && skill.error === undefined) {
        content = await readFile(skill.skillFile, "utf8").catch(() => content);
      }
      const winner = winners.get(name);
      if (winner !== undefined) {
        warnings.push({ code: "shadowed", message: `Grok loads the ${winner} skill named "${name}" instead.` });
      } else {
        winners.set(name, source.label);
      }
      entries.push({
        item: makeItem(
          {
            id,
            kind: "skill",
            name,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            enabled: !disabled.has(name),
            toggleable: winner === undefined,
            editable: own && skill.error === undefined,
            deletable: own,
            locked: false,
            source,
            path: skill.dir,
            warnings
          },
          content
        ),
        ref: { type: "skill", scope, name, dirName: skill.name, dir: skill.dir, file: skill.skillFile }
      });
    };

    const addCommand = async (command: ScannedCommand, scope: Exclude<MarkdownScope, "plugin" | "bundled">, source: ProfileItemSource): Promise<void> => {
      const own = scope === "user";
      const id = own ? itemId("command", command.name) : itemId("command", `${scope}/${command.name}`);
      let content: unknown = { path: command.file, frontmatter: command.frontmatter };
      const warnings: ProfileItemWarning[] = command.error !== undefined ? [{ code: "unreadable", message: command.error }] : [];
      if (own && command.error === undefined) {
        content = await readFile(command.file, "utf8").catch(() => content);
      }
      const winner = winners.get(command.name);
      if (winner !== undefined) {
        warnings.push({ code: "shadowed", message: `Grok loads the ${winner} one named "${command.name}" instead.` });
      } else {
        winners.set(command.name, source.label);
      }
      entries.push({
        item: makeItem(
          {
            id,
            kind: "command",
            name: command.name,
            ...(command.description !== undefined ? { description: command.description } : {}),
            enabled: !disabled.has(command.name),
            toggleable: winner === undefined,
            editable: own && command.error === undefined,
            deletable: own,
            locked: false,
            source,
            path: command.file,
            warnings
          },
          content
        ),
        ref: { type: "command", scope, name: command.name, file: command.file }
      });
    };

    for (const skill of await scanSkills(this.skillsDir)) await addSkill(skill, "user", USER);
    for (const command of await scanCommands(this.commandsDir, { nested: false })) await addCommand(command, "user", USER);
    for (const skill of await scanSkills(this.ctx.homes.agentsSkillsDir)) await addSkill(skill, "agents", SHARED_AGENTS);
    for (const command of await scanCommands(this.agentsCommandsDir, { nested: false })) await addCommand(command, "agents", SHARED_AGENTS);
    if (claudeCompat) {
      for (const skill of await scanSkills(join(this.ctx.homes.claudeDir, "skills"))) await addSkill(skill, "claude", FROM_CLAUDE);
      for (const command of await scanCommands(join(this.ctx.homes.claudeDir, "commands"), { nested: false })) {
        await addCommand(command, "claude", FROM_CLAUDE);
      }
    }
    for (const skill of await scanSkills(join(this.grokHome, "bundled", "skills"))) await addSkill(skill, "bundled", BUNDLED);

    // Plugin skills and commands never override a native one (they stay
    // invocable as `plugin:name`), but `[skills] disabled` takes bare names:
    // turning one off would also turn off a native one of the same name.
    for (const skill of inspect.data?.skills ?? []) {
      if (skill.sourceType !== "plugin" || skill.pluginName === undefined || skill.path === undefined) continue;
      const kind: ProfileItemKind = isCommandPath(skill.path) ? "command" : "skill";
      const collides = winners.has(skill.name);
      const warnings: ProfileItemWarning[] = collides
        ? [{ code: "name-shared", message: `Shares its name with another ${kind}: Grok turns both on or off together, so turn that one off instead.` }]
        : [];
      const id = itemId(kind, `plugin/${skill.pluginName}/${skill.name}`);
      const item = makeItem(
        {
          id,
          kind,
          name: skill.name,
          ...(skill.description !== undefined ? { description: skill.description } : {}),
          enabled: !disabled.has(skill.name),
          toggleable: !collides,
          editable: false,
          deletable: false,
          locked: false,
          source: pluginSource(skill.pluginName),
          path: kind === "skill" ? dirname(skill.path) : skill.path,
          warnings
        },
        { path: skill.path, description: skill.description }
      );
      entries.push({
        item,
        ref:
          kind === "skill"
            ? { type: "skill", scope: "plugin", name: skill.name, dirName: basename(dirname(skill.path)), dir: dirname(skill.path), file: skill.path }
            : { type: "command", scope: "plugin", name: skill.name, file: skill.path }
      });
    }
    return entries;
  }

  // --- Hooks ----------------------------------------------------------------

  private hookItem(location: HookLocation, options: { locked: boolean; stashed: boolean; readOnly: boolean; path: string; warnings?: ProfileItemWarning[] }): ProfileItem {
    const { handler } = location;
    const isCommand = (handler.type === undefined || handler.type === "command") && typeof handler.command === "string";
    const name = typeof handler.command === "string" ? handler.command : typeof handler.url === "string" ? handler.url : "(hook)";
    const enabled = !options.stashed;
    return makeItem(
      {
        id: hookId(location),
        kind: "hook",
        name,
        description: location.matcher !== undefined ? `${location.event} · ${location.matcher}` : location.event,
        enabled,
        toggleable: !options.locked && !options.readOnly,
        editable: !options.locked && !options.readOnly && isCommand,
        deletable: !options.locked && !options.readOnly,
        locked: options.locked,
        source: options.locked ? ORQUESTER : location.file === CONFIG_TOML ? { type: "user", label: CONFIG_TOML } : USER,
        path: options.path,
        ...(options.stashed ? { stashed: true } : {}),
        warnings: options.warnings ?? [],
        meta: {
          event: location.event,
          file: location.file,
          ...(location.matcher !== undefined ? { matcher: location.matcher } : {}),
          ...(typeof handler.timeout === "number" ? { timeout: `${handler.timeout} s` } : {})
        }
      },
      location
    );
  }

  private async hookEntries(doc: TomlTable, hookFiles: Map<string, HookFileState>): Promise<Entry[]> {
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const push = (entry: Entry): void => {
      if (seen.has(entry.item.id)) return;
      seen.add(entry.item.id);
      entries.push(entry);
    };
    for (const [file, state] of hookFiles) {
      if (state.data === null) continue;
      const locked = file === GROK_ORQUESTER_HOOK_FILE;
      for (const location of listHandlers(file, state.data.hooks)) {
        push({ item: this.hookItem(location, { locked, stashed: false, readOnly: false, path: state.path }), ref: { type: "hook-file", location } });
      }
    }
    for (const location of listHandlers(CONFIG_TOML, doc.hooks)) {
      push({
        item: this.hookItem(location, {
          locked: false,
          stashed: false,
          readOnly: true,
          path: this.configPath,
          warnings: [{ code: "config-toml-hook", message: "Defined in config.toml: change it in that file.", action: "open-file" }]
        }),
        ref: { type: "hook-toml", location }
      });
    }
    for (const entry of await this.stash.list(AGENT)) {
      if (entry.kind !== "hook" || entry.original.type !== "fragment") continue;
      const location = this.fragmentLocation(entry.original.data);
      if (location === null || hookId(location) !== entry.id) {
        this.ctx.logger.warn(`agent-profile grok: skipping stashed hook ${entry.dir}: not a Grok hook fragment`);
        continue;
      }
      push({ item: this.hookItem(location, { locked: false, stashed: true, readOnly: false, path: entry.dir }), ref: { type: "hook-stash", location } });
    }
    return entries;
  }

  private fragmentLocation(data: unknown): HookLocation | null {
    if (!isJsonObject(data) || typeof data.file !== "string" || typeof data.event !== "string" || !isJsonObject(data.handler)) {
      return null;
    }
    if (!data.file.endsWith(".json") || data.file.includes("/") || data.file.includes("\\") || data.file.startsWith(".")) {
      return null;
    }
    const matcher = normalizeMatcher(data.matcher);
    return { file: data.file, event: data.event, ...(matcher !== undefined ? { matcher } : {}), handler: data.handler };
  }

  // --- Plugins --------------------------------------------------------------

  private pluginOn(doc: TomlTable, name: string): boolean {
    const enabled = stringsIn(getTomlPath(doc, ["plugins", "enabled"]));
    const disabled = stringsIn(getTomlPath(doc, ["plugins", "disabled"]));
    return !pluginListed(disabled, name) && pluginListed(enabled, name);
  }

  private classifyPlugin(path: string | undefined): PluginWhere {
    if (path === undefined) return "other";
    if (path.startsWith(join(this.grokHome, "installed-plugins") + sep)) return "installed";
    if (path.startsWith(join(this.grokHome, "plugins") + sep)) return "plugins-dir";
    if (path.startsWith(this.ctx.homes.claudeDir + sep)) return "claude";
    return "other";
  }

  /**
   * `installed-plugins/registry.json`: plugin name → its install, and the
   * other plugins installed from the same source (`siblings`: Grok uninstalls
   * those only together). Tolerant: an unreadable registry is empty.
   */
  private async readRegistry(): Promise<Map<string, { path?: string; version?: string; marketplace?: string; siblings: string[] }>> {
    const out = new Map<string, { path?: string; version?: string; marketplace?: string; siblings: string[] }>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.grokHome, "installed-plugins", "registry.json"), "utf8"));
    } catch {
      return out;
    }
    const repos = isJsonObject(parsed) && isJsonObject(parsed.repos) ? parsed.repos : {};
    for (const repo of Object.values(repos)) {
      if (!isJsonObject(repo) || !isJsonObject(repo.plugins)) continue;
      const marketplace = isJsonObject(repo.marketplace) && typeof repo.marketplace.source_display_name === "string" ? repo.marketplace.source_display_name : undefined;
      const names = Object.keys(repo.plugins);
      for (const [name, info] of Object.entries(repo.plugins)) {
        const version = isJsonObject(info) && typeof info.version === "string" ? info.version : undefined;
        out.set(name, {
          ...(typeof repo.path === "string" ? { path: repo.path } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(marketplace !== undefined ? { marketplace } : {}),
          siblings: names.filter((other) => other !== name)
        });
      }
    }
    return out;
  }

  private async readPluginManifest(path: string | undefined): Promise<{ name?: string; version?: string; description?: string }> {
    if (path === undefined) return {};
    for (const candidate of [".grok-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(path, candidate), "utf8"));
        if (!isJsonObject(parsed)) continue;
        return {
          ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
          ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
          ...(typeof parsed.description === "string" ? { description: parsed.description } : {})
        };
      } catch {
        // next candidate
      }
    }
    return {};
  }

  private async pluginEntries(doc: TomlTable, inspect: InspectResult): Promise<Entry[]> {
    const registry = await this.readRegistry();
    const found: { name: string; path?: string; provides?: GrokInspect["plugins"][number]["provides"] }[] = [];
    if (inspect.data !== null) {
      found.push(...inspect.data.plugins);
    } else {
      for (const [name, info] of registry) {
        found.push({ name, ...(info.path !== undefined ? { path: info.path } : {}) });
      }
      let names: string[] = [];
      try {
        names = (await readdir(join(this.grokHome, "plugins"))).filter((name) => !name.startsWith(".")).sort();
      } catch {
        // no plugins directory
      }
      for (const dirName of names) {
        const path = join(this.grokHome, "plugins", dirName);
        const manifest = await this.readPluginManifest(path);
        found.push({ name: manifest.name ?? dirName, path });
      }
    }
    const warnings = this.inspectWarning(inspect);
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const plugin of found) {
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      const where = this.classifyPlugin(plugin.path);
      const manifest = await this.readPluginManifest(plugin.path);
      const installed = registry.get(plugin.name);
      const version = installed?.version ?? manifest.version;
      const marketplace = installed?.marketplace;
      const enabled = this.pluginOn(doc, plugin.name);
      // `grok plugin uninstall` removes a whole install: one of several
      // plugins installed from one source cannot be deleted alone.
      const siblings = where === "installed" ? (installed?.siblings ?? []) : [];
      const itemWarnings: ProfileItemWarning[] =
        siblings.length === 0
          ? warnings
          : [
              ...warnings,
              {
                code: "shared-install",
                message: `Installed together with ${siblings.join(", ")}: Grok uninstalls them only together (grok plugin uninstall ${plugin.name} --confirm). Turn it off instead.`
              }
            ];
      const ref: Extract<Ref, { type: "plugin" }> = {
        type: "plugin",
        name: plugin.name,
        where,
        ...(plugin.path !== undefined ? { path: plugin.path } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(marketplace !== undefined ? { marketplace } : {}),
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        ...(plugin.provides !== undefined ? { provides: plugin.provides } : {})
      };
      entries.push({
        item: makeItem(
          {
            id: itemId("plugin", plugin.name),
            kind: "plugin",
            name: plugin.name,
            ...(manifest.description !== undefined ? { description: manifest.description } : {}),
            enabled,
            toggleable: true,
            editable: false,
            deletable: (where === "installed" && siblings.length === 0) || where === "plugins-dir",
            locked: false,
            source: where === "claude" ? FROM_CLAUDE : where === "other" ? { type: "user", label: "Custom path" } : USER,
            ...(plugin.path !== undefined ? { path: plugin.path } : {}),
            warnings: itemWarnings,
            meta: { ...(version !== undefined ? { version } : {}), ...(marketplace !== undefined ? { marketplace } : {}) }
          },
          { path: plugin.path, where, version, siblings }
        ),
        ref
      });
    }
    return entries;
  }

  // --- Marketplaces ---------------------------------------------------------

  private async marketplaceEntries(doc: TomlTable, fileErrors: ProfileFileError[]): Promise<Entry[]> {
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const sources = getTomlPath(doc, ["marketplace", "sources"]);
    for (const raw of Array.isArray(sources) ? sources : []) {
      if (!isTable(raw) || typeof raw.name !== "string" || seen.has(raw.name)) continue;
      const source = this.marketplaceSourceOf(raw);
      if (source === null) continue;
      seen.add(raw.name);
      entries.push(this.marketplaceEntry(raw.name, source, true, USER, [], raw));
    }
    const settings: [string, ProfileItemSource, boolean][] = [
      [join(this.grokHome, "settings.json"), { type: "user", label: "settings.json" }, true],
      [join(this.ctx.homes.claudeDir, "settings.json"), FROM_CLAUDE, false]
    ];
    for (const [path, source, own] of settings) {
      let parsed: unknown;
      try {
        const text = await readTextIfExists(path);
        if (text === null) continue;
        parsed = JSON.parse(text);
      } catch (error) {
        if (own) fileErrors.push({ path, message: error instanceof SyntaxError ? safeParseError("JSON", error) : message(error) });
        continue;
      }
      const extra = isJsonObject(parsed) && isJsonObject(parsed.extraKnownMarketplaces) ? parsed.extraKnownMarketplaces : {};
      for (const [name, value] of Object.entries(extra)) {
        if (seen.has(name) || !isJsonObject(value) || !isJsonObject(value.source)) continue;
        const src = value.source;
        const kind = src.source;
        const market: MarketplaceSource | null =
          kind === "github" && typeof src.repo === "string"
            ? { type: "github", repo: src.repo }
            : kind === "git" && typeof src.url === "string"
              ? { type: "git", url: src.url }
              : (kind === "local" || kind === "directory") && typeof src.path === "string"
                ? { type: "path", path: src.path }
                : null;
        if (market === null) continue;
        seen.add(name);
        entries.push(
          this.marketplaceEntry(name, market, false, source, [
            { code: "settings-marketplace", message: `Declared in ${path}: change it in that file.`, action: "open-file" }
          ], value, path)
        );
      }
    }
    return entries;
  }

  private marketplaceSourceOf(raw: TomlTable): MarketplaceSource | null {
    const branch = typeof raw.branch === "string" ? raw.branch : undefined;
    if (typeof raw.git === "string") {
      const github = GITHUB_URL.exec(raw.git);
      if (github !== null) {
        return { type: "github", repo: github[1] as string, ...(branch !== undefined ? { ref: branch } : {}) };
      }
      return { type: "git", url: raw.git, ...(branch !== undefined ? { ref: branch } : {}) };
    }
    if (typeof raw.path === "string") {
      return { type: "path", path: raw.path };
    }
    return null;
  }

  private marketplaceEntry(
    name: string,
    source: MarketplaceSource,
    inConfig: boolean,
    itemSource: ProfileItemSource,
    warnings: ProfileItemWarning[],
    content: unknown,
    path = this.configPath
  ): Entry {
    const where = source.type === "github" ? source.repo : source.type === "git" ? source.url : source.path;
    return {
      item: makeItem(
        {
          id: itemId("marketplace", name),
          kind: "marketplace",
          name,
          description: where,
          enabled: true,
          toggleable: false,
          editable: false,
          deletable: inConfig,
          locked: false,
          source: itemSource,
          path,
          warnings,
          meta: { source: where, ...(source.type !== "path" && source.ref !== undefined ? { branch: source.ref } : {}) }
        },
        content
      ),
      ref: { type: "marketplace", name, source, inConfig }
    };
  }

  // --- Instructions ---------------------------------------------------------

  private async instructionsInfo(text?: string | null): Promise<ProfileInstructionsInfo> {
    const path = this.agentsPath;
    let current: string | null;
    try {
      current = text !== undefined ? text : await readTextIfExists(path);
    } catch {
      current = null;
    }
    const warnings: ProfileItemWarning[] = [];
    let legacyPath: string | undefined;
    if ((await pathKind(this.legacyPath).catch(() => null)) !== null) {
      legacyPath = this.legacyPath;
      warnings.push({
        code: "legacy-grok-md",
        message: "~/.grok/GROK.md is never read by Grok. Move its text into AGENTS.md.",
        action: "open-file"
      });
    }
    let mtime: string | undefined;
    if (current !== null) {
      try {
        mtime = (await stat(path)).mtime.toISOString();
      } catch {
        mtime = undefined;
      }
    }
    return {
      path,
      exists: current !== null,
      bytes: current === null ? 0 : Buffer.byteLength(current, "utf8"),
      lines: current === null || current.length === 0 ? 0 : current.split("\n").length - (current.endsWith("\n") ? 1 : 0),
      ...(mtime !== undefined ? { mtime } : {}),
      revision: current === null ? "" : contentHash(current),
      warnings,
      ...(legacyPath !== undefined ? { legacyPath } : {})
    };
  }

  async readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    let text: string | null;
    try {
      text = await readTextIfExists(this.agentsPath);
    } catch (error) {
      throw profileErrors.unreadable(this.agentsPath, message(error));
    }
    return { text: text ?? "", info: await this.instructionsInfo(text) };
  }

  async writeInstructions(text: string, revision: string): Promise<AdapterMutationResult> {
    const current = await this.readAgentsForWrite();
    if (revision !== (current === null ? "" : contentHash(current))) {
      throw profileErrors.conflict("AGENTS.md changed on disk since you opened it.");
    }
    await writeProfileFile(this.agentsPath, text, { backups: this.backups, agent: AGENT });
    return { itemIds: [], notes: [] };
  }

  async migrateLegacyInstructions(revision: string): Promise<AdapterMutationResult> {
    const current = await this.readAgentsForWrite();
    if (revision !== (current === null ? "" : contentHash(current))) {
      throw profileErrors.conflict("AGENTS.md changed on disk since you opened it.");
    }
    let legacy: string | null;
    try {
      legacy = await readTextIfExists(this.legacyPath);
    } catch (error) {
      throw profileErrors.unreadable(this.legacyPath, message(error));
    }
    if (legacy === null) {
      throw profileErrors.invalid("There is no GROK.md to move.");
    }
    const merged =
      current === null || current.trim().length === 0
        ? legacy
        : `${current}${current.endsWith("\n") ? "" : "\n"}\n<!-- moved from GROK.md -->\n${legacy}`;
    await writeProfileFile(this.agentsPath, merged, { backups: this.backups, agent: AGENT });
    await removeProfilePath(this.legacyPath, { backups: this.backups, agent: AGENT });
    return { itemIds: [], notes: ["GROK.md's text is now at the end of AGENTS.md, and GROK.md is gone (a backup of both is kept)."] };
  }

  private async readAgentsForWrite(): Promise<string | null> {
    try {
      return await readTextIfExists(this.agentsPath);
    } catch (error) {
      throw profileErrors.unreadable(this.agentsPath, message(error));
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private requireConfig(model: Model): void {
    if (model.config.error !== undefined) {
      throw profileErrors.unreadable(model.config.path, model.config.error);
    }
  }

  /** Applies `edits` to `config.toml`, comment-preserving and verified; refuses an unreadable or moved file. */
  private async writeConfig(model: Model, edits: readonly (TomlEdit | null)[]): Promise<void> {
    const list = edits.filter((edit): edit is TomlEdit => edit !== null);
    if (list.length === 0) return;
    this.requireConfig(model);
    const { config } = model;
    const onDisk = await readTextIfExists(config.path);
    if (onDisk !== config.text) {
      throw profileErrors.conflict("config.toml changed on disk while this change was being made. The list has been refreshed.");
    }
    const before = config.text ?? "";
    let next: string;
    try {
      next = editToml(before, list);
    } catch (error) {
      throw new AgentProfileError(500, "WRITE_VERIFY_FAILED", `${config.path} could not be edited safely (${message(error)}); nothing was written.`);
    }
    if (next === before) return;
    try {
      await writeProfileFileVerified(config.path, next, { backups: this.backups, agent: AGENT, verify: verifyToml });
    } finally {
      this.invalidate();
    }
  }

  private async writeHookFile(model: Model, file: string, data: JsonObject): Promise<void> {
    if (file === GROK_ORQUESTER_HOOK_FILE) {
      throw profileErrors.locked(file);
    }
    assertSafeSegment(file);
    const state = model.hookFiles.get(file);
    const path = join(this.hooksDir, file);
    if (state?.error !== undefined) {
      throw profileErrors.unreadable(state.path, state.error);
    }
    const onDisk = await readTextIfExists(path);
    if ((onDisk ?? null) !== (state?.text ?? null)) {
      throw profileErrors.conflict(`${file} changed on disk while this change was being made. The list has been refreshed.`);
    }
    try {
      await writeProfileFileVerified(path, serializeHookFile(data), { backups: this.backups, agent: AGENT, verify: verifyHookFile });
    } finally {
      this.invalidate();
    }
  }

  private async grok(args: string[], timeoutMs: number): Promise<AgentCliResult> {
    const bin = this.ctx.bin;
    if (bin === null) {
      throw profileErrors.notInstalled("Grok");
    }
    const cwd = await stat(this.grokHome).then(
      (st) => (st.isDirectory() ? this.grokHome : tmpdir()),
      () => tmpdir()
    );
    const words = args[0] === "plugin" && args[1] === "marketplace" ? 3 : 2;
    return this.runCli({
      bin,
      args,
      timeoutMs,
      cwd,
      env: { HOME: this.ctx.homes.home, GROK_HOME: this.grokHome },
      label: ["grok", ...args.slice(0, words)].join(" "),
      redact: { homeDirs: [this.ctx.homes.home] }
    });
  }

  /**
   * A `grok plugin …` call that rewrites `config.toml` itself: refused when
   * the file is unreadable, backed up first, and followed by a note when
   * Grok's rewrite dropped comments.
   */
  private async grokRewritingConfig(model: Model, args: string[], timeoutMs: number): Promise<{ output: AgentCliResult; notes: string[] }> {
    this.requireConfig(model);
    const before = model.config.text;
    if (before !== null) {
      await this.backups.save(AGENT, await resolveWriteTarget(this.configPath));
    }
    let output: AgentCliResult;
    try {
      output = await this.grok(args, timeoutMs);
    } finally {
      this.invalidate();
    }
    const notes: string[] = [];
    const after = await readTextIfExists(this.configPath).catch(() => null);
    if (before !== null && after !== null && countComments(after) < countComments(before)) {
      notes.push("Grok rewrote config.toml and dropped comments from it; the previous version is kept in the agent profile backups.");
    }
    return { output, notes };
  }

  // --- create -----------------------------------------------------------------

  async create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    switch (draft.kind) {
      case "mcp":
        return this.createMcp(draft.mcp, options.onConflict);
      case "skill":
        return this.createSkill(draft.document, options.onConflict);
      case "command":
        return this.createCommand(draft.document, options.onConflict);
      case "hook":
        return this.createHook(draft.hook, options.onConflict);
      case "plugin":
        return this.installPlugin(draft.plugin, options.onConflict);
      case "marketplace":
        return this.addMarketplace(draft.marketplace, options.onConflict);
      default:
        throw profileErrors.invalid("Unknown item kind.");
    }
  }

  private async createMcp(draft: McpServerDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft)) throw profileErrors.invalid("An MCP server draft is required.");
    assertMcpServerName(draft.name);
    const model = await this.load();
    this.requireConfig(model);
    const servers = tableAt(model.config.doc, ["mcp_servers"]);
    const mcpNames = new Set(model.entries.filter((entry) => entry.item.kind === "mcp").map((entry) => entry.item.name));
    let name = draft.name;
    const notes: string[] = [];
    let existing: TomlTable | undefined;
    if (mcpNames.has(name) || servers[name] !== undefined) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        name = nextFreeName(name, (candidate) => mcpNames.has(candidate) || servers[candidate] !== undefined, PROFILE_MCP_NAME_MAX, isValidMcpServerName);
        notes.push(`Added as "${name}".`);
      } else if (isTable(servers[name])) {
        existing = servers[name] as TomlTable;
      } else {
        notes.push(`Grok now uses this server instead of the inherited one named "${name}".`);
      }
    }
    const table = this.buildMcpTable(draft, existing, false);
    await this.writeConfig(model, [{ op: "set", path: ["mcp_servers", name], value: table }]);
    return { itemIds: [itemId("mcp", name)], notes };
  }

  /**
   * The `[mcp_servers.<name>]` table for a draft. `existing` resolves `keep`
   * secrets; with `preserve` its keys the draft does not describe (`enabled`,
   * `tool_timeouts`, `oauth`, …) survive, and advanced fields the draft does
   * not mention keep their value.
   */
  private buildMcpTable(draft: McpServerDraft, existing: TomlTable | undefined, preserve: boolean): TomlTable {
    const transports = MCP_TRANSPORTS.grok ?? [];
    if (!transports.includes(draft.transport)) {
      throw profileErrors.invalidItem(`Grok MCP servers use ${transports.join(", ")}; not "${String(draft.transport)}".`);
    }
    const table: TomlTable = {};
    const known = new Set(["command", "args", "cwd", "env", "url", "type", "headers", ...GROK_ADVANCED_KEYS]);
    const noNul = (value: string, what: string): string => {
      if (value.includes("\0")) throw profileErrors.invalidItem(`${what} contains a NUL byte.`);
      return value;
    };
    if (draft.transport === "stdio") {
      if (typeof draft.command !== "string" || draft.command.trim().length === 0) {
        throw profileErrors.invalidItem("A stdio MCP server needs a command.");
      }
      table.command = noNul(draft.command.trim(), "The command");
      if (draft.args !== undefined) {
        if (!Array.isArray(draft.args) || draft.args.some((arg) => typeof arg !== "string")) {
          throw profileErrors.invalidItem("The arguments must be a list of strings.");
        }
        if (draft.args.length > 0) table.args = draft.args.map((arg) => noNul(arg, "An argument"));
      }
      if (typeof draft.cwd === "string" && draft.cwd.trim().length > 0) table.cwd = noNul(draft.cwd.trim(), "The working directory");
    } else {
      if (typeof draft.url !== "string" || draft.url.trim().length === 0 || /\s/.test(draft.url.trim())) {
        throw profileErrors.invalidItem("An http or sse MCP server needs a URL (no spaces).");
      }
      table.url = noNul(draft.url.trim(), "The URL");
      if (draft.transport === "sse") table.type = "sse";
    }
    const env = this.resolveSecrets(draft.env, isTable(existing?.env) ? existing.env : {}, ENV_KEY, "environment variable");
    if (Object.keys(env).length > 0) table.env = env;
    if (draft.headers !== undefined && draft.headers.length > 0 && draft.transport === "stdio") {
      throw profileErrors.invalidItem("Headers apply to http and sse servers only.");
    }
    const headers = this.resolveSecrets(draft.headers, isTable(existing?.headers) ? existing.headers : {}, HEADER_KEY, "header");
    if (Object.keys(headers).length > 0) table.headers = headers;

    const advanced = draft.advanced ?? {};
    if (!isJsonObject(advanced)) throw profileErrors.invalidItem("Advanced settings must be an object.");
    for (const key of Object.keys(advanced)) {
      if (!GROK_ADVANCED_KEYS.includes(key)) throw profileErrors.invalidItem(`Grok has no MCP setting "${key}".`);
    }
    for (const field of MCP_ADVANCED_FIELDS.grok ?? []) {
      const mentioned = Object.hasOwn(advanced, field.key);
      const value = mentioned ? advanced[field.key] : preserve ? existing?.[field.key] : undefined;
      if (value === undefined || value === null || value === "") continue;
      if (field.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw profileErrors.invalidItem(`${field.label} must be a positive number.`);
        }
      } else if (typeof value !== "string" || !ENV_KEY.test(value)) {
        throw profileErrors.invalidItem(`${field.label} must be an environment variable name.`);
      }
      table[field.key] = value;
    }
    if (preserve && existing !== undefined) {
      // Keys the draft does not describe keep their place and value.
      const merged: TomlTable = {};
      for (const [key, value] of Object.entries(existing)) {
        if (!known.has(key)) merged[key] = value;
        else if (table[key] !== undefined) merged[key] = table[key];
      }
      for (const [key, value] of Object.entries(table)) {
        if (!(key in merged)) merged[key] = value;
      }
      return merged;
    }
    return table;
  }

  /** Env or header entries with `keep` resolved against the values on disk; never echoes a value in an error. */
  private resolveSecrets(
    entries: SecretEntryDraft[] | undefined,
    current: TomlTable,
    keyPattern: RegExp,
    what: string
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (entries === undefined) return out;
    if (!Array.isArray(entries)) throw profileErrors.invalidItem(`The ${what}s must be a list.`);
    for (const entry of entries) {
      if (!isJsonObject(entry) || typeof entry.key !== "string" || !keyPattern.test(entry.key)) {
        throw profileErrors.invalidItem(`${JSON.stringify(isJsonObject(entry) ? entry.key : entry)} is not a valid ${what} name.`);
      }
      if (Object.hasOwn(out, entry.key)) throw profileErrors.invalidItem(`The ${what} ${entry.key} is listed twice.`);
      if ("keep" in entry && entry.keep === true) {
        const value = current[entry.key];
        if (typeof value !== "string") throw profileErrors.invalidItem(`The ${what} ${entry.key} has no saved value to keep.`);
        out[entry.key] = value;
      } else if ("value" in entry && typeof entry.value === "string") {
        if (entry.value.includes("\0")) throw profileErrors.invalidItem(`The ${what} ${entry.key} contains a NUL byte.`);
        out[entry.key] = entry.value;
      } else {
        throw profileErrors.invalidItem(`The ${what} ${entry.key} needs a value or keep.`);
      }
    }
    return out;
  }

  private async createSkill(document: MarkdownDocumentDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(document)) throw profileErrors.invalid("A skill document is required.");
    assertSkillName(document.name);
    assertSafeSegment(document.name);
    let name = document.name;
    const notes: string[] = [];
    const taken = async (candidate: string): Promise<boolean> => (await pathKind(join(this.skillsDir, candidate))) !== null;
    let replace = false;
    if (await taken(name)) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        const used = new Set((await readdir(this.skillsDir).catch(() => [] as string[])));
        name = nextFreeName(name, (candidate) => used.has(candidate), PROFILE_SKILL_NAME_MAX, isValidSkillName);
        notes.push(`Added as "${name}".`);
      } else {
        replace = true;
      }
    }
    if (replace) {
      // The old skill goes (backed up) before the new one is written: its other
      // files must not linger, and a symlinked skill loses only its link — never
      // is the shared skill it points at (Claude's, ~/.agents') overwritten.
      await removeProfilePath(join(this.skillsDir, name), { backups: this.backups, agent: AGENT });
    }
    await writeSkill(this.skillsDir, { ...document, name }, { backups: this.backups, agent: AGENT, mergeExisting: false });
    this.invalidate();
    return { itemIds: [itemId("skill", name)], notes };
  }

  private assertFlatCommand(name: string): void {
    assertCommandName(name);
    if (name.includes("/")) {
      throw profileErrors.invalidName(`Grok loads commands only from the top of ~/.grok/commands: "${name}" cannot have a folder.`);
    }
  }

  private async createCommand(document: MarkdownDocumentDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(document)) throw profileErrors.invalid("A command document is required.");
    this.assertFlatCommand(document.name);
    let name = document.name;
    const notes: string[] = [];
    const taken = async (candidate: string): Promise<boolean> => (await pathKind(join(this.commandsDir, `${candidate}.md`))) !== null;
    let replace = false;
    if (await taken(name)) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        const used = new Set((await readdir(this.commandsDir).catch(() => [] as string[])).map((file) => file.replace(/\.md$/, "")));
        name = nextFreeName(name, (candidate) => used.has(candidate), PROFILE_SKILL_NAME_MAX, isValidSkillName);
        notes.push(`Added as "${name}".`);
      } else {
        replace = true;
      }
    }
    if (replace) {
      // As for skills: a symlinked command loses only its link, never its target's text.
      await removeProfilePath(join(this.commandsDir, `${name}.md`), { backups: this.backups, agent: AGENT });
    }
    await writeCommand(this.commandsDir, { ...document, name }, { backups: this.backups, agent: AGENT, mergeExisting: false });
    this.invalidate();
    return { itemIds: [itemId("command", name)], notes };
  }

  /** A hook draft as Grok's handler JSON; `base` keeps a handler's other fields on edit. */
  private hookFromDraft(draft: HookDraft, file: string, base?: JsonObject): HookLocation {
    if (!isJsonObject(draft)) throw profileErrors.invalid("A hook draft is required.");
    const events = PROFILE_HOOK_EVENTS.grok ?? [];
    if (typeof draft.event !== "string" || !events.includes(draft.event)) {
      throw profileErrors.invalidItem(`"${String(draft.event)}" is not a Grok hook event (${events.join(", ")}).`);
    }
    if (typeof draft.command !== "string" || draft.command.trim().length === 0 || draft.command.includes("\0")) {
      throw profileErrors.invalidItem("A hook needs a command.");
    }
    const timeout = draft.timeoutSec;
    if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86_400)) {
      throw profileErrors.invalidItem("The timeout must be between 0 and 86400 seconds.");
    }
    if (draft.matcher !== undefined && draft.matcher !== null && (typeof draft.matcher !== "string" || /[\0\r\n]/.test(draft.matcher))) {
      throw profileErrors.invalidItem("The matcher must be one line of text.");
    }
    const matcher = PROFILE_HOOK_EVENTS_WITHOUT_MATCHER.includes(draft.event) ? undefined : normalizeMatcher(draft.matcher?.trim());
    const handler: JsonObject = { ...(base ?? {}), type: "command", command: draft.command.trim() };
    if (typeof timeout === "number") handler.timeout = timeout;
    else delete handler.timeout;
    return { file, event: draft.event, ...(matcher !== undefined ? { matcher } : {}), handler };
  }

  private async createHook(draft: HookDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    const location = this.hookFromDraft(draft, GROK_PROFILE_HOOK_FILE);
    const id = hookId(location);
    const model = await this.load();
    if (model.entries.some((entry) => entry.item.id === id)) {
      if (onConflict === "fail") throw profileErrors.exists(draft.command);
      return { itemIds: [id], notes: ["An identical hook already exists."] };
    }
    const data = model.hookFiles.get(GROK_PROFILE_HOOK_FILE)?.data ?? { hooks: {} };
    await this.writeHookFile(model, GROK_PROFILE_HOOK_FILE, insertHandler(data, location));
    return { itemIds: [id], notes: [] };
  }

  private async installPlugin(draft: PluginInstallDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft)) throw profileErrors.invalid("A plugin draft is required.");
    let source: string;
    let knownName: string | undefined;
    if ("spec" in draft) {
      source = cliArgument(draft.spec, "The plugin source");
      refuseUrlCredentials(source);
    } else {
      knownName = cliArgument(draft.plugin, "The plugin name");
      const marketplace = cliArgument(draft.marketplace, "The marketplace");
      if (/[@\s]/.test(knownName)) throw profileErrors.invalidItem(`"${knownName}" is not a plugin name.`);
      source = `${knownName}@${marketplace}`;
    }
    const model = await this.load();
    if (knownName !== undefined && model.entries.some((entry) => entry.item.id === itemId("plugin", knownName)) && onConflict === "fail") {
      throw profileErrors.exists(knownName);
    }
    const { output, notes } = await this.grokRewritingConfig(model, ["plugin", "install", source, "--trust"], TIMEOUTS.install);
    const installed = /Installed \d+ plugin\(s\) from .*?: (.+)$/m.exec(output.stdout)?.[1];
    const names = installed !== undefined ? installed.split(",").map((name) => name.trim()).filter(Boolean) : knownName !== undefined ? [knownName] : [];
    return { itemIds: names.map((name) => itemId("plugin", name)), notes: ["Installed and turned on for new Grok sessions.", ...notes] };
  }

  private async addMarketplace(draft: MarketplaceDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft) || !isJsonObject(draft.source)) throw profileErrors.invalid("A marketplace source is required.");
    const source = draft.source;
    let argument: string;
    let ref: string | undefined;
    if (source.type === "github") {
      argument = cliArgument(source.repo, "The GitHub repository");
      if (!GITHUB_REPO.test(argument)) throw profileErrors.invalidItem(`"${argument}" is not an owner/repo name.`);
      ref = source.ref;
    } else if (source.type === "git") {
      argument = cliArgument(source.url, "The git URL");
      refuseUrlCredentials(argument);
      ref = source.ref;
    } else if (source.type === "path") {
      argument = cliArgument(source.path, "The path");
      if (!argument.startsWith("/")) throw profileErrors.invalidItem("A marketplace path must be absolute.");
    } else {
      throw profileErrors.invalidItem("Unknown marketplace source.");
    }
    if (ref !== undefined && (typeof ref !== "string" || ref.trim().length === 0 || /[\0\r\n]/.test(ref))) {
      throw profileErrors.invalidItem("The branch must be one line of text.");
    }
    const model = await this.load();
    if (typeof draft.name === "string" && model.entries.some((entry) => entry.item.id === itemId("marketplace", draft.name as string))) {
      if (onConflict === "fail") throw profileErrors.exists(draft.name);
    }
    const before = new Set(model.entries.filter((entry) => entry.ref.type === "marketplace").map((entry) => entry.item.name));
    const { output, notes } = await this.grokRewritingConfig(model, ["plugin", "marketplace", "add", argument], TIMEOUTS.marketplaceAdd);
    const after = await this.load();
    const added = after.entries.find((entry) => entry.ref.type === "marketplace" && entry.ref.inConfig && !before.has(entry.item.name));
    const name = added?.item.name ?? /Added marketplace source: (.+?) \(/.exec(output.stdout)?.[1];
    if (name === undefined) {
      return { itemIds: [], notes };
    }
    if (typeof draft.name === "string" && draft.name.trim().length > 0 && draft.name.trim() !== name) {
      notes.push(`Grok named this marketplace "${name}".`);
    }
    if (ref !== undefined) {
      const sources = getTomlPath(after.config.doc, ["marketplace", "sources"]);
      if (Array.isArray(sources)) {
        const next = sources.map((entry) => (isTable(entry) && entry.name === name ? { ...entry, branch: ref.trim() } : entry));
        await this.writeConfig(after, [{ op: "set", path: ["marketplace", "sources"], value: next }]);
      }
    }
    return { itemIds: [itemId("marketplace", name)], notes };
  }

  // --- update -----------------------------------------------------------------

  async update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult> {
    const model = await this.load();
    const entry = this.find(model, id, revision);
    const { item, ref } = entry;
    if (item.locked) throw profileErrors.locked(item.name);
    if (!isJsonObject(draft) || draft.kind !== item.kind) {
      throw profileErrors.invalid(`The draft is not a ${item.kind}.`);
    }
    if (!item.editable) throw profileErrors.notEditable(item.name);
    switch (ref.type) {
      case "mcp-own":
        if (draft.kind === "mcp") return this.updateMcp(model, ref, draft.mcp);
        break;
      case "skill":
        if (draft.kind === "skill" && ref.scope === "user") return this.updateSkill(ref, draft.document);
        break;
      case "command":
        if (draft.kind === "command" && ref.scope === "user") return this.updateCommand(model, ref, draft.document);
        break;
      case "hook-file":
      case "hook-stash":
        if (draft.kind === "hook") return this.updateHook(model, ref, draft.hook);
        break;
      default:
        break;
    }
    throw profileErrors.notEditable(item.name);
  }

  private async updateMcp(model: Model, ref: Extract<Ref, { type: "mcp-own" }>, draft: McpServerDraft): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft)) throw profileErrors.invalid("An MCP server draft is required.");
    assertMcpServerName(draft.name);
    const table = this.buildMcpTable(draft, ref.table, true);
    if (draft.name === ref.name) {
      await this.writeConfig(model, [{ op: "set", path: ["mcp_servers", ref.name], value: table }]);
      return { itemIds: [itemId("mcp", ref.name)], notes: [] };
    }
    if (model.entries.some((entry) => entry.item.kind === "mcp" && entry.item.name === draft.name)) {
      throw profileErrors.exists(draft.name);
    }
    const wasOff = stringsIn(getTomlPath(model.config.doc, ["disabled_mcp_servers"])).includes(ref.name);
    await this.writeConfig(model, [
      { op: "delete", path: ["mcp_servers", ref.name] },
      { op: "set", path: ["mcp_servers", draft.name], value: table },
      wasOff
        ? listEdit(model.config.doc, ["disabled_mcp_servers"], { add: [draft.name], remove: (entry) => entry === ref.name }, true)
        : null
    ]);
    return { itemIds: [itemId("mcp", draft.name)], notes: [] };
  }

  private async updateSkill(ref: Extract<Ref, { type: "skill" }>, document: MarkdownDocumentDraft): Promise<AdapterMutationResult> {
    if (!isJsonObject(document)) throw profileErrors.invalid("A skill document is required.");
    if (document.name !== ref.dirName) {
      throw profileErrors.invalid("Grok skills cannot be renamed here: create one under the new name and delete this one.");
    }
    await writeSkill(this.skillsDir, document, { backups: this.backups, agent: AGENT, mergeExisting: true });
    this.invalidate();
    return { itemIds: [itemId("skill", ref.dirName)], notes: [] };
  }

  private async updateCommand(model: Model, ref: Extract<Ref, { type: "command" }>, document: MarkdownDocumentDraft): Promise<AdapterMutationResult> {
    if (!isJsonObject(document)) throw profileErrors.invalid("A command document is required.");
    this.assertFlatCommand(document.name);
    if (document.name === ref.name) {
      await writeCommand(this.commandsDir, document, { backups: this.backups, agent: AGENT, mergeExisting: true });
      this.invalidate();
      return { itemIds: [itemId("command", ref.name)], notes: [] };
    }
    if ((await pathKind(join(this.commandsDir, `${document.name}.md`))) !== null) {
      throw profileErrors.exists(document.name);
    }
    const current = await this.readDocument(ref.file);
    const wasOff = stringsIn(getTomlPath(model.config.doc, ["skills", "disabled"])).includes(ref.name);
    if (wasOff) this.requireConfig(model);
    await writeCommand(
      this.commandsDir,
      { name: document.name, frontmatter: { ...current.frontmatter, ...document.frontmatter }, body: document.body },
      { backups: this.backups, agent: AGENT, mergeExisting: false }
    );
    await removeProfilePath(ref.file, { backups: this.backups, agent: AGENT });
    this.invalidate();
    if (wasOff) {
      await this.writeConfig(await this.load(), [
        listEdit(model.config.doc, ["skills", "disabled"], { add: [document.name], remove: (entry) => entry === ref.name }, true)
      ]);
    }
    return { itemIds: [itemId("command", document.name)], notes: [] };
  }

  private async updateHook(
    model: Model,
    ref: Extract<Ref, { type: "hook-file" | "hook-stash" }>,
    draft: HookDraft
  ): Promise<AdapterMutationResult> {
    const from = ref.location;
    const to = this.hookFromDraft(draft, from.file, from.handler);
    const newId = hookId(to);
    const oldId = hookId(from);
    if (newId === oldId) {
      return { itemIds: [oldId], notes: [] };
    }
    if (model.entries.some((entry) => entry.item.id === newId)) {
      throw profileErrors.exists(draft.command);
    }
    if (ref.type === "hook-stash") {
      await this.stash.remove(AGENT, "hook", oldId);
      await this.stash.stashFragment(AGENT, "hook", newId, to.handler.command as string, to);
      return { itemIds: [newId], notes: [] };
    }
    const data = model.hookFiles.get(from.file)?.data;
    const next = data ? replaceHandler(data, from, to) : null;
    if (next === null) throw profileErrors.conflict();
    await this.writeHookFile(model, from.file, next);
    return { itemIds: [newId], notes: [] };
  }

  // --- on/off -----------------------------------------------------------------

  async setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult> {
    if (typeof enabled !== "boolean") throw profileErrors.invalid("enabled must be true or false.");
    const model = await this.load();
    const { item, ref } = this.find(model, id, revision);
    if (item.locked) throw profileErrors.locked(item.name);
    if (!item.toggleable) throw profileErrors.notToggleable(item.name);
    if (item.enabled === enabled) {
      return { itemIds: [id], notes: [] };
    }
    const doc = model.config.doc;
    switch (ref.type) {
      case "mcp-own":
      case "mcp-inherited": {
        const name = ref.name;
        const listChange = listEdit(
          doc,
          ["disabled_mcp_servers"],
          enabled ? { remove: (entry) => entry === name } : { add: [name] },
          true
        );
        // As `grok mcp disable|enable` does: an own entry also gets `enabled`.
        const flag: TomlEdit | null =
          ref.type === "mcp-own" && (!enabled || ref.table.enabled === false)
            ? { op: "set", path: ["mcp_servers", name, "enabled"], value: enabled }
            : null;
        await this.writeConfig(model, [listChange, flag]);
        return { itemIds: [id], notes: [] };
      }
      case "skill":
      case "command": {
        const name = ref.name;
        await this.writeConfig(model, [
          listEdit(doc, ["skills", "disabled"], enabled ? { remove: (entry) => entry === name } : { add: [name] }, true)
        ]);
        return { itemIds: [id], notes: [] };
      }
      case "plugin": {
        const name = ref.name;
        const matches = (entry: string): boolean => entry === name || entry.endsWith(`/${name}`);
        await this.writeConfig(model, [
          listEdit(doc, ["plugins", "enabled"], enabled ? { add: [name] } : { remove: matches }, false),
          listEdit(doc, ["plugins", "disabled"], enabled ? { remove: matches } : { add: [name] }, false)
        ]);
        return { itemIds: [id], notes: [] };
      }
      case "hook-file": {
        const data = model.hookFiles.get(ref.location.file)?.data;
        const next = data ? removeHandler(data, ref.location) : null;
        if (next === null) throw profileErrors.conflict();
        // A stashed copy whose fragment hashes to this id is this very hook,
        // re-added by hand meanwhile (the snapshot hides it behind the live
        // one): dropping it loses nothing; keeping it would refuse this "off".
        const stashed = await this.stash.get(AGENT, "hook", id);
        const twin = stashed?.original.type === "fragment" ? this.fragmentLocation(stashed.original.data) : null;
        if (twin !== null && hookId(twin) === id) {
          await this.stash.remove(AGENT, "hook", id);
        }
        await this.stash.stashFragment(AGENT, "hook", id, item.name, ref.location);
        try {
          await this.writeHookFile(model, ref.location.file, next);
        } catch (error) {
          await this.stash.remove(AGENT, "hook", id);
          throw error;
        }
        return { itemIds: [id], notes: [] };
      }
      case "hook-stash": {
        const { location } = ref;
        const state = model.hookFiles.get(location.file);
        const data = state?.data ?? { hooks: {} };
        const present = listHandlers(location.file, data.hooks).some((candidate) => hookId(candidate) === id);
        if (!present) {
          await this.writeHookFile(model, location.file, insertHandler(data, location));
        }
        await this.stash.remove(AGENT, "hook", id);
        return { itemIds: [id], notes: [] };
      }
      default:
        throw profileErrors.notToggleable(item.name);
    }
  }

  // --- delete -----------------------------------------------------------------

  async remove(id: string, revision: string): Promise<AdapterMutationResult> {
    const model = await this.load();
    const { item, ref } = this.find(model, id, revision);
    if (item.locked) throw profileErrors.locked(item.name);
    if (!item.deletable) throw profileErrors.notDeletable(item.name);
    const doc = model.config.doc;
    const notes: string[] = [];
    switch (ref.type) {
      case "mcp-own":
        await this.writeConfig(model, [
          { op: "delete", path: ["mcp_servers", ref.name] },
          listEdit(doc, ["disabled_mcp_servers"], { remove: (entry) => entry === ref.name }, true)
        ]);
        break;
      case "skill":
      case "command": {
        if (ref.scope !== "user") throw profileErrors.notDeletable(item.name);
        await removeProfilePath(ref.type === "skill" ? ref.dir : ref.file, { backups: this.backups, agent: AGENT });
        this.invalidate();
        const cleanup = model.config.error === undefined ? listEdit(doc, ["skills", "disabled"], { remove: (entry) => entry === ref.name }, true) : null;
        if (cleanup !== null) {
          await this.writeConfig(await this.load(), [cleanup]);
        }
        break;
      }
      case "hook-file": {
        const data = model.hookFiles.get(ref.location.file)?.data;
        const next = data ? removeHandler(data, ref.location) : null;
        if (next === null) throw profileErrors.conflict();
        await this.writeHookFile(model, ref.location.file, next);
        break;
      }
      case "hook-stash":
        await this.stash.remove(AGENT, "hook", id);
        break;
      case "plugin":
        if (ref.where === "installed") {
          // Never `--confirm`: it makes Grok also uninstall every plugin
          // installed from the same source. Without it Grok refuses that case.
          const { notes: cliNotes } = await this.grokRewritingConfig(model, ["plugin", "uninstall", ref.name], TIMEOUTS.uninstall);
          notes.push(...cliNotes);
        } else if (ref.where === "plugins-dir" && ref.path !== undefined) {
          await removeProfilePath(ref.path, { backups: this.backups, agent: AGENT });
          this.invalidate();
        } else {
          throw profileErrors.notDeletable(item.name);
        }
        break;
      case "marketplace": {
        if (!ref.inConfig) throw profileErrors.notDeletable(item.name);
        const { output, notes: cliNotes } = await this.grokRewritingConfig(model, ["plugin", "marketplace", "remove", ref.name], TIMEOUTS.marketplaceRemove);
        const uninstalled = /uninstalled (\d+) plugin/i.exec(output.stdout)?.[1];
        notes.push(
          uninstalled !== undefined && uninstalled !== "0"
            ? `Grok also uninstalled the ${uninstalled} plugin(s) that came from it.`
            : "Removing a marketplace also uninstalls the plugins that came from it.",
          ...cliNotes
        );
        break;
      }
      default:
        throw profileErrors.notDeletable(item.name);
    }
    return { itemIds: [id], notes };
  }

  // --- marketplaces, copy ---------------------------------------------------

  async listMarketplacePlugins(marketplace: string): Promise<MarketplacePluginEntry[]> {
    const output = await this.grok(["plugin", "list", "--json", "--available"], TIMEOUTS.list);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      throw profileErrors.cliFailed("grok plugin list", "it did not print JSON.");
    }
    const byName = new Map<string, MarketplacePluginEntry>();
    for (const raw of Array.isArray(parsed) ? parsed : []) {
      if (!isJsonObject(raw) || raw.marketplace !== marketplace || typeof raw.name !== "string") continue;
      const installed = raw.status === "installed";
      const previous = byName.get(raw.name);
      byName.set(raw.name, {
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : previous?.description !== undefined ? { description: previous.description } : {}),
        ...(typeof raw.version === "string" ? { version: raw.version } : {}),
        installed: installed || previous?.installed === true
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async exportItem(id: string): Promise<PortableItem> {
    const model = await this.load();
    const { item, ref } = this.find(model, id);
    switch (ref.type) {
      case "mcp-own":
        return { kind: "mcp", server: portableMcp(ref.name, ref.table) };
      case "mcp-inherited": {
        const def = await this.inheritedMcpDefinition(ref);
        if (def === null) throw profileErrors.invalid(`"${item.name}" cannot be copied: its definition could not be read.`);
        return { kind: "mcp", server: portableMcp(ref.name, def) };
      }
      case "skill": {
        const dir = join(agentProfileImportsDir(this.ctx.appdir), `export-grok-${randomUUID()}`);
        await copyTree(ref.dir, dir, { refuseSymlinks: false });
        return { kind: "skill", name: isValidSkillName(ref.name) ? ref.name : ref.dirName, dir };
      }
      case "command": {
        const document = await this.readDocument(ref.file);
        return { kind: "command", name: ref.name, frontmatter: document.frontmatter, body: document.body };
      }
      default:
        throw profileErrors.invalid(`"${item.name}" cannot be copied to another agent.`);
    }
  }

  async importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    switch (item.kind) {
      case "mcp": {
        const server = item.server;
        const advanced: Record<string, unknown> = {};
        for (const key of GROK_ADVANCED_KEYS) {
          if (server.advanced?.[key] !== undefined) advanced[key] = server.advanced[key];
        }
        const toEntries = (values: Record<string, string> | undefined): SecretEntryDraft[] | undefined =>
          values === undefined ? undefined : Object.entries(values).map(([key, value]) => ({ key, value }));
        const env = toEntries(server.env);
        const headers = toEntries(server.headers);
        return this.createMcp(
          {
            name: server.name,
            transport: server.transport,
            ...(server.command !== undefined ? { command: server.command } : {}),
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
            ...(server.url !== undefined ? { url: server.url } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(headers !== undefined && server.transport !== "stdio" ? { headers } : {}),
            ...(Object.keys(advanced).length > 0 ? { advanced } : {})
          },
          options.onConflict
        );
      }
      case "command": {
        const notes: string[] = [];
        let name = item.name;
        if (name.includes("/")) {
          name = name.replaceAll("/", "-");
          notes.push(`Grok commands have no folders: added as "${name}".`);
        }
        const result = await this.createCommand({ name, frontmatter: item.frontmatter, body: item.body }, options.onConflict);
        return { itemIds: result.itemIds, notes: [...notes, ...result.notes] };
      }
      case "skill":
        return this.importSkill(item.name, item.dir, options.onConflict);
      default:
        throw profileErrors.invalid("Grok cannot import that kind of item.");
    }
  }

  private async importSkill(requested: string, dir: string, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    assertSkillName(requested);
    assertSafeSegment(requested);
    let name = requested;
    const notes: string[] = [];
    const target = (candidate: string): string => join(this.skillsDir, candidate);
    if ((await pathKind(target(name))) !== null) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        const used = new Set(await readdir(this.skillsDir).catch(() => [] as string[]));
        name = nextFreeName(name, (candidate) => used.has(candidate), PROFILE_SKILL_NAME_MAX, isValidSkillName);
        notes.push(`Added as "${name}".`);
      } else {
        await removeProfilePath(target(name), { backups: this.backups, agent: AGENT });
      }
    }
    await copyTree(dir, target(name), { refuseSymlinks: true });
    const document = await this.readDocument(join(target(name), "SKILL.md"));
    if (document.frontmatter.name !== name) {
      await writeSkill(this.skillsDir, { name, frontmatter: {}, body: document.body }, { backups: this.backups, agent: AGENT, mergeExisting: true });
    }
    this.invalidate();
    return { itemIds: [itemId("skill", name)], notes };
  }
}
