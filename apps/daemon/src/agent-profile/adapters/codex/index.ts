/**
 * Agent profile — the Codex adapter (spec §3 Codex column, §4.6 Codex).
 *
 * Where each kind lives and how it is written:
 *
 * | kind | read from | written through |
 * |---|---|---|
 * | instructions | `<CODEX_HOME>/AGENTS.md` (+ warning when a non-empty `AGENTS.override.md` shadows it) | `writeProfileFile` |
 * | mcp | `config/read` user layer `mcp_servers` | `config/batchWrite` (`expectedVersion`, `reloadUserConfig`); off = `enabled = false`, on = the key deleted |
 * | skill | `skills/list` merged with a scan of `<CODEX_HOME>/skills` and `~/.agents/skills` | `writeSkill` / `removeProfilePath`; off/on = `skills/config/write` |
 * | plugin | `plugin/installed` + the user layer's `[plugins."<id>"]` | `plugin/install`, `plugin/uninstall`; off/on = `config/batchWrite plugins."<id>".enabled` |
 * | marketplace | the user layer's `[marketplaces.<name>]` | `marketplace/add`, `marketplace/remove` |
 * | hook | `<CODEX_HOME>/hooks.json` + `hooks.state` + `hooks/list` | `writeProfileFileVerified` for `hooks.json`, then ONE `config/batchWrite` of `hooks.state` (re-keyed, `hooks.ts`) |
 * | command | legacy `<CODEX_HOME>/prompts/*.md` | read-only; delete = `removeProfilePath` |
 *
 * `config.toml` is never written by this module directly: every change goes
 * through the app-server's config API, which keeps comments, checks the user
 * layer's version (a mismatch is our 409), validates the whole config, and
 * writes through a symlinked `config.toml` to its target (verified on
 * 0.155.1). The app-server is `codex-config-client.ts`.
 *
 * Decisions worth knowing:
 * - Skills: bundled `.system` skills (`source: bundled`) and plugin skills
 *   (`source: plugin`) are toggled BY NAME through `skills/config/write`,
 *   which Codex supports natively and which affects Codex only; they are
 *   neither editable nor deletable here. `~/.agents/skills` skills are
 *   `inherited` ("Shared · ~/.agents") and toggled by path, for Codex only.
 * - Plugins: installs materialize into `<CODEX_HOME>/plugins/cache`, but every
 *   managed account home keeps its OWN `plugins/` cache while `config.toml`
 *   is shared, so a plugin installed here is enabled for every account yet
 *   materialized only in the system home. A plugin whose cache is missing in
 *   the system home carries a `plugin-cache-missing` warning.
 * - Plugin-provided MCP servers, skills and hooks are listed read-only with a
 *   plugin badge (plugin skills are toggleable, above).
 * - Hooks: one item per handler. Orquester's own groups (`agent-hook.sh`) are
 *   locked. A new or edited hook is written trusted (`trusted_hash`) and keeps
 *   (or gets) `enabled` for every path `hooks.json` is seen from: the system
 *   path and each managed account home whose `hooks.json` resolves to the same
 *   file. New groups go before Orquester's managed group, which stays last as
 *   `agent-hooks.ts` lays it out.
 * - Commands: Codex no longer loads custom prompts, so they are listed off,
 *   with a warning, and can only be deleted (or copied to another agent).
 */

import { SecretDigester } from "../../infra/secret-digest.ts";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  PROFILE_HOOK_EVENTS,
  PROFILE_HOOK_EVENTS_WITHOUT_MATCHER,
  type HookDraft,
  type MarketplacePluginEntry,
  type MarketplaceSource,
  type MarketplaceView,
  type ProfileConflictPolicy,
  type ProfileFileError,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemDetail,
  type ProfileItemDraft,
  type ProfileItemWarning
} from "@orquester/api";
import { agentProfileImportsDir, agentProfileStashDir } from "@orquester/config";
import { CodexRpcError } from "../../../agent-host/adapters/codex/protocol.ts";
import { profileErrors } from "../../errors.ts";
import {
  type ProfileBackups,
  type ProfileStash,
  type runAgentCliOrThrow,
  SKILL_FILE,
  assertSkillName,
  contentHash,
  copyTree,
  itemId,
  parseMarkdownDocument,
  pathKind,
  readSkillFiles,
  readTextIfExists,
  redactCliOutput,
  removeProfilePath,
  resolveWriteTarget,
  scanCommands,
  scanSkills,
  writeProfileFile,
  writeProfileFileVerified,
  writeSkill
} from "../../infra/index.ts";
import type {
  AdapterMutationResult,
  AdapterSnapshot,
  PortableItem,
  ProfileAdapter,
  ProfileAdapterContext
} from "../types.ts";
import {
  CODEX_PLUGIN_INSTALL_TIMEOUT_MS,
  type CodexConfigClient,
  type CodexConfigClientFactory,
  type CodexConfigEdit,
  type CodexConfigMethod,
  type CodexConfigMethods,
  type CodexHookMetadata,
  type CodexPluginListResult,
  type CodexPluginReadResult,
  type CodexPluginSummary,
  type CodexSkillMetadata,
  type JsonValue,
  createCodexAppServerClient,
  keyPath,
  toProfileError
} from "./codex-config-client.ts";
import {
  type CodexHookEntry,
  type CodexHookHandler,
  type CodexHooksDocument,
  type HookPosition,
  type HookStateEntry,
  codexHookHash,
  emptyHooksDocument,
  eventSnake,
  hookEntryIds,
  hookIdentity,
  hookPositionId,
  listHookEntries,
  parseHooksDocument,
  rekeyHookState,
  serializeHooksDocument,
  stateKey
} from "./hooks.ts";
import {
  type CodexMcpEntry,
  draftFromPortable,
  mcpEnabled,
  mcpEntryFromDraft,
  mcpSecretValues,
  mcpTransport,
  mcpView,
  portableFromEntry
} from "./mcp.ts";

export {
  CodexAppServerClient,
  type CodexConfigClient,
  type CodexConfigClientFactory,
  type CodexConfigClientOptions,
  createCodexAppServerClient
} from "./codex-config-client.ts";

const AGENT = "codex";
const LABEL = "Codex";

export interface CodexProfileAdapterDeps {
  backups: ProfileBackups;
  stash: ProfileStash;
  /** Unused by Codex (every write goes through the app-server); kept so the four adapters share one shape. */
  runCli?: typeof runAgentCliOrThrow;
  configClient?: CodexConfigClientFactory;
}

/** What an item id resolves to inside the adapter. */
type ItemRef =
  | { kind: "mcp"; name: string; entry: CodexMcpEntry; plugin?: string }
  | {
      kind: "skill";
      origin: "user" | "shared" | "bundled" | "plugin";
      /** The name Codex knows it by (plugin skills: `plugin:skill`). */
      codexName: string;
      /** The directory, for user and shared skills found on disk. */
      dir?: string;
      skillFile: string;
      /** The path `skills/config/write` matches (the realpath of `SKILL.md`). */
      configPath: string;
    }
  | {
      kind: "plugin";
      pluginId: string;
      name: string;
      marketplace: string;
      summary?: CodexPluginSummary;
      detail?: CodexPluginReadResult["plugin"];
    }
  | { kind: "marketplace"; name: string; entry?: Record<string, unknown> }
  | { kind: "hook"; entry?: CodexHookEntry; plugin?: CodexHookMetadata }
  | { kind: "command"; name: string; file: string };

interface UserConfig {
  /** The user layer's version (`expectedVersion` of the next write); `null` when Codex reported no user layer. */
  version: string | null;
  config: Record<string, unknown>;
}

interface Loaded {
  userConfig: UserConfig | null;
  configError: string | null;
  hooksDoc: CodexHooksDocument | null;
  /** `hooks.json` as read (`null`: missing); a write refuses when the file moved since. */
  hooksText: string | null;
  hooksError: string | null;
  hookEntries: CodexHookEntry[];
  /** `hooks/list` by key; its keys use {@link metaHooksPath}. */
  hooksMeta: Map<string, CodexHookMetadata>;
  /** The system `hooks.json` as the app-server keys it (canonical). */
  metaHooksPath: string;
  items: ProfileItem[];
  refs: Map<string, { item: ProfileItem; ref: ItemRef }>;
  fileErrors: ProfileFileError[];
  instructions: ProfileInstructionsInfo;
}

const USER_SOURCE = { type: "user", label: "User" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** `superpowers@openai-curated` → `{name: "superpowers", marketplace: "openai-curated"}`. */
function splitPluginId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
}

export class CodexProfileAdapter implements ProfileAdapter {
  /** Keyed digests of MCP secret values for revisions (never the values themselves). */
  private readonly secrets = new SecretDigester();
  readonly agent = AGENT;
  private client: CodexConfigClient | null = null;
  /** The `codex` binary {@link client} was made for. */
  private clientBin: string | null = null;

  constructor(
    private readonly ctx: ProfileAdapterContext,
    private readonly deps: CodexProfileAdapterDeps
  ) {}

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private get codexHome(): string {
    return this.ctx.homes.codexHome;
  }
  private get configPath(): string {
    return join(this.codexHome, "config.toml");
  }
  /** As Codex opens it (`$CODEX_HOME/hooks.json`) — the prefix of every system state key. */
  private get hooksPath(): string {
    return join(this.codexHome, "hooks.json");
  }
  private get instructionsPath(): string {
    return join(this.codexHome, "AGENTS.md");
  }
  private get overridePath(): string {
    return join(this.codexHome, "AGENTS.override.md");
  }
  private get skillsRoot(): string {
    return join(this.codexHome, "skills");
  }
  private get promptsRoot(): string {
    return join(this.codexHome, "prompts");
  }
  private get pluginsRoot(): string {
    return join(this.codexHome, "plugins");
  }

  watchPaths(): string[] {
    return [
      this.configPath,
      this.hooksPath,
      this.instructionsPath,
      this.overridePath,
      this.skillsRoot,
      this.promptsRoot,
      this.pluginsRoot,
      this.ctx.homes.agentsSkillsDir,
      join(agentProfileStashDir(this.ctx.appdir), AGENT)
    ];
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close();
  }

  // -------------------------------------------------------------------------
  // The app-server
  // -------------------------------------------------------------------------

  private clientFor(): CodexConfigClient {
    const bin = this.ctx.bin;
    if (bin === null) {
      throw profileErrors.notInstalled(LABEL);
    }
    if (this.client !== null && this.clientBin !== bin) {
      // Codex was reinstalled or moved (Settings → Agents): the old binary may be gone.
      const stale = this.client;
      this.client = null;
      void stale.close().catch((error: unknown) => this.warn("closing the previous app-server failed", error));
    }
    this.clientBin = bin;
    this.client ??= (this.deps.configClient ?? createCodexAppServerClient)({
      bin,
      codexHome: this.codexHome,
      home: this.ctx.homes.home,
      logger: this.ctx.logger
    });
    return this.client;
  }

  /** One call; an answered error is mapped (`toProfileError`), `literals` are redacted from it. */
  private async rpc<M extends CodexConfigMethod>(
    method: M,
    params: CodexConfigMethods[M]["params"],
    options: { timeoutMs?: number; literals?: string[] } = {}
  ): Promise<CodexConfigMethods[M]["result"]> {
    try {
      return await this.clientFor().call(method, params, { timeoutMs: options.timeoutMs });
    } catch (error) {
      throw toProfileError(method, error, { homeDirs: [this.ctx.homes.home], literals: options.literals });
    }
  }

  private async readUserConfig(): Promise<UserConfig> {
    let result: CodexConfigMethods["config/read"]["result"];
    try {
      result = await this.clientFor().call("config/read", { includeLayers: true });
    } catch (error) {
      if (error instanceof CodexRpcError) {
        // "failed to read configuration layers: <path>:<line>:<col>: …" — the file does not parse.
        throw profileErrors.unreadable(
          this.configPath,
          redactCliOutput(error.providerMessage, { homeDirs: [this.ctx.homes.home] }).trim()
        );
      }
      throw error;
    }
    const user = (result.layers ?? []).find((layer) => layer.name.type === "user");
    return { version: user?.version ?? null, config: record(user?.config) };
  }

  private async batchWrite(
    edits: CodexConfigEdit[],
    expectedVersion: string | null,
    literals: string[] = []
  ): Promise<void> {
    if (edits.length === 0) return;
    await this.rpc(
      "config/batchWrite",
      { edits, ...(expectedVersion !== null ? { expectedVersion } : {}), reloadUserConfig: true },
      { literals }
    );
  }

  private warn(what: string, error: unknown): void {
    this.ctx.logger.warn(
      `agent-profile codex: ${what}: ${redactCliOutput(message(error), { homeDirs: [this.ctx.homes.home] })}`
    );
  }

  // -------------------------------------------------------------------------
  // Reading everything
  // -------------------------------------------------------------------------

  async snapshot(): Promise<AdapterSnapshot> {
    const loaded = await this.load();
    return { instructions: loaded.instructions, items: loaded.items, fileErrors: loaded.fileErrors };
  }

  private async load(): Promise<Loaded> {
    const fileErrors: ProfileFileError[] = [];
    const installed = this.ctx.bin !== null;
    const [configResult, skillsResult, hooksResult, pluginsResult] = await Promise.allSettled([
      installed ? this.readUserConfig() : Promise.reject(new Error("not installed")),
      installed
        ? this.rpc("skills/list", { cwds: [this.ctx.homes.home], forceReload: true })
        : Promise.reject(new Error("not installed")),
      installed ? this.rpc("hooks/list", { cwds: [this.ctx.homes.home] }) : Promise.reject(new Error("not installed")),
      installed ? this.rpc("plugin/installed", {}) : Promise.reject(new Error("not installed"))
    ]);
    let userConfig: UserConfig | null = null;
    let configError: string | null = null;
    if (configResult.status === "fulfilled") {
      userConfig = configResult.value;
    } else if (installed) {
      configError = message(configResult.reason);
      fileErrors.push({ path: this.configPath, message: configError });
    }
    const skillsList = skillsResult.status === "fulfilled" ? skillsResult.value : null;
    if (skillsResult.status === "rejected" && installed) this.warn("skills/list failed", skillsResult.reason);
    const hooksList = hooksResult.status === "fulfilled" ? hooksResult.value : null;
    if (hooksResult.status === "rejected" && installed) this.warn("hooks/list failed", hooksResult.reason);
    const pluginsInstalled = pluginsResult.status === "fulfilled" ? pluginsResult.value : null;
    if (pluginsResult.status === "rejected" && installed) this.warn("plugin/installed failed", pluginsResult.reason);

    // hooks.json
    let hooksDoc: CodexHooksDocument | null = null;
    let hooksText: string | null = null;
    let hooksError: string | null = null;
    try {
      hooksText = await readTextIfExists(this.hooksPath);
      hooksDoc = hooksText === null ? emptyHooksDocument() : parseHooksDocument(hooksText);
    } catch (error) {
      hooksError = message(error);
      fileErrors.push({ path: this.hooksPath, message: hooksError });
    }
    const hookEntries = hooksDoc === null ? [] : listHookEntries(hooksDoc);
    const metaHooksPath = await this.canonicalHooksPath();
    let hookPaths = [this.hooksPath];
    if (hookEntries.length > 0) {
      try {
        hookPaths = await this.hookPaths();
      } catch (error) {
        this.warn("listing the account homes failed", error);
      }
    }
    const hooksMeta = new Map<string, CodexHookMetadata>();
    for (const entry of hooksList?.data ?? []) {
      for (const hook of entry.hooks) {
        hooksMeta.set(hook.key, hook);
      }
    }

    let instructions: ProfileInstructionsInfo;
    try {
      instructions = (await this.readInstructionsFile()).info;
    } catch (error) {
      fileErrors.push({ path: this.instructionsPath, message: message(error) });
      instructions = { path: this.instructionsPath, exists: true, bytes: 0, lines: 0, revision: "", warnings: [] };
    }

    const refs = new Map<string, { item: ProfileItem; ref: ItemRef }>();
    const add = (item: ProfileItem, ref: ItemRef): void => {
      if (!refs.has(item.id)) refs.set(item.id, { item, ref });
    };

    const pluginDetails = await this.pluginDetails(pluginsInstalled);
    if (userConfig !== null) this.mcpItems(userConfig, add);
    for (const detail of pluginDetails) {
      for (const server of detail.mcpServers) {
        add(this.pluginMcpItem(detail.summary.id, server), {
          kind: "mcp",
          name: server,
          entry: {},
          plugin: detail.summary.id
        });
      }
    }
    await this.skillItems(skillsList, userConfig, add, fileErrors);
    await this.pluginItems(userConfig, pluginsInstalled, pluginDetails, add);
    this.marketplaceItems(userConfig, pluginsInstalled, add);
    this.hookItems(hookEntries, userConfig, hooksMeta, metaHooksPath, hookPaths, add);
    await this.commandItems(add, fileErrors);

    return {
      userConfig,
      configError,
      hooksDoc,
      hooksText,
      hooksError,
      hookEntries,
      hooksMeta,
      metaHooksPath,
      items: [...refs.values()].map((entry) => entry.item),
      refs,
      fileErrors,
      instructions
    };
  }

  // --- mcp ---------------------------------------------------------------

  private mcpItems(userConfig: UserConfig, add: (item: ProfileItem, ref: ItemRef) => void): void {
    for (const [name, value] of Object.entries(record(userConfig.config.mcp_servers))) {
      if (!isRecord(value)) continue;
      const enabled = mcpEnabled(value);
      const transport = mcpTransport(value);
      add(
        {
          id: itemId("mcp", name),
          kind: "mcp",
          name,
          ...(transport === "stdio" && typeof value.command === "string"
            ? { description: value.command }
            : typeof value.url === "string"
              ? { description: value.url }
              : {}),
          enabled,
          toggleable: true,
          editable: true,
          deletable: true,
          locked: false,
          source: { ...USER_SOURCE },
          path: this.configPath,
          revision: contentHash({ entry: this.secrets.deepMasked(value), enabled }),
          warnings: [],
          meta: { transport }
        },
        { kind: "mcp", name, entry: value }
      );
    }
  }

  private pluginMcpItem(pluginId: string, server: string): ProfileItem {
    const plugin = splitPluginId(pluginId).name;
    return {
      id: itemId("mcp", `${pluginId}/${server}`),
      kind: "mcp",
      name: server,
      enabled: true,
      toggleable: false,
      editable: false,
      deletable: false,
      locked: false,
      source: { type: "plugin", label: `Plugin · ${plugin}`, pluginId },
      revision: contentHash({ pluginId, server: this.secrets.deepMasked(server) }),
      warnings: []
    };
  }

  // --- skills ------------------------------------------------------------

  private skillConfigEnabled(userConfig: UserConfig | null, path: string, name: string): boolean | undefined {
    const entries = record(userConfig?.config.skills).config;
    if (!Array.isArray(entries)) return undefined;
    let enabled: boolean | undefined;
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.enabled !== "boolean") continue;
      if (entry.path === path || entry.name === name) enabled = entry.enabled;
    }
    return enabled;
  }

  private async skillItems(
    skillsList: CodexConfigMethods["skills/list"]["result"] | null,
    userConfig: UserConfig | null,
    add: (item: ProfileItem, ref: ItemRef) => void,
    fileErrors: ProfileFileError[]
  ): Promise<void> {
    const listed = (skillsList?.data ?? []).flatMap((entry) => entry.skills);
    const errors = new Map<string, string>();
    for (const entry of skillsList?.data ?? []) {
      for (const error of entry.errors) errors.set(error.path, error.message);
    }
    const byPath = new Map<string, CodexSkillMetadata>(listed.map((skill) => [skill.path, skill]));
    const consumed = new Set<string>();

    const scan = async (root: string, origin: "user" | "shared"): Promise<void> => {
      let scanned;
      try {
        scanned = await scanSkills(root);
      } catch (error) {
        fileErrors.push({ path: root, message: message(error) });
        return;
      }
      for (const skill of scanned) {
        const real = await realOrSelf(skill.skillFile);
        const meta = byPath.get(real);
        if (meta !== undefined) consumed.add(real);
        const enabled = meta?.enabled ?? this.skillConfigEnabled(userConfig, real, skill.name) ?? true;
        const warnings: ProfileItemWarning[] = [];
        if (skill.error !== undefined) {
          warnings.push({ code: "skill-unreadable", message: skill.error });
        } else if (skillsList !== null && meta === undefined) {
          warnings.push({
            code: "skill-not-loaded",
            message: errors.get(real) ?? errors.get(skill.skillFile) ?? "Codex did not load this skill."
          });
        }
        const text = skill.error === undefined ? await readTextIfExists(skill.skillFile).catch(() => null) : null;
        const user = origin === "user";
        const item: ProfileItem = {
          id: itemId("skill", user ? skill.name : `agents/${skill.name}`),
          kind: "skill",
          name: skill.name,
          ...(skill.description !== undefined ? { description: skill.description } : {}),
          enabled,
          toggleable: true,
          editable: user && skill.error === undefined,
          deletable: user,
          locked: false,
          source: user ? { ...USER_SOURCE } : { type: "inherited", label: "Shared · ~/.agents" },
          path: skill.dir,
          revision: contentHash({ text, error: skill.error ?? null, enabled }),
          warnings
        };
        add(item, {
          kind: "skill",
          origin,
          codexName: meta?.name ?? skill.name,
          dir: skill.dir,
          skillFile: skill.skillFile,
          configPath: real
        });
      }
    };
    await scan(this.skillsRoot, "user");
    await scan(this.ctx.homes.agentsSkillsDir, "shared");

    for (const skill of listed) {
      if (consumed.has(skill.path)) continue;
      let origin: "bundled" | "plugin";
      let id: string;
      let source: ProfileItem["source"];
      if (skill.pluginId !== null) {
        origin = "plugin";
        id = itemId("skill", skill.name);
        source = { type: "plugin", label: `Plugin · ${splitPluginId(skill.pluginId).name}`, pluginId: skill.pluginId };
      } else if (skill.scope === "system" || skill.scope === "admin") {
        origin = "bundled";
        id = itemId("skill", `${skill.scope}/${skill.name}`);
        source = { type: "bundled", label: skill.scope === "system" ? "Bundled" : "Admin" };
      } else {
        // A repo skill (never with `cwds: [home]`), or a user skill outside the scanned roots.
        continue;
      }
      add(
        {
          id,
          kind: "skill",
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          enabled: skill.enabled,
          toggleable: true,
          editable: false,
          deletable: false,
          locked: false,
          source,
          path: skill.path,
          revision: contentHash({ path: skill.path, enabled: skill.enabled }),
          warnings: []
        },
        { kind: "skill", origin, codexName: skill.name, skillFile: skill.path, configPath: skill.path }
      );
    }
  }

  // --- plugins and marketplaces --------------------------------------------

  private installedSummaries(list: CodexPluginListResult | null): Map<string, { summary: CodexPluginSummary; path: string | null; marketplace: string }> {
    const out = new Map<string, { summary: CodexPluginSummary; path: string | null; marketplace: string }>();
    for (const marketplace of list?.marketplaces ?? []) {
      for (const plugin of marketplace.plugins) {
        if (plugin.installed) out.set(plugin.id, { summary: plugin, path: marketplace.path, marketplace: marketplace.name });
      }
    }
    return out;
  }

  /** `plugin/read` of every installed plugin whose marketplace is local (a remote one would mean a network call). */
  private async pluginDetails(list: CodexPluginListResult | null): Promise<CodexPluginReadResult["plugin"][]> {
    const reads = [...this.installedSummaries(list).values()]
      .filter((entry) => entry.path !== null)
      .map(async (entry) => {
        try {
          return (
            await this.rpc("plugin/read", { pluginName: entry.summary.name, marketplacePath: entry.path })
          ).plugin;
        } catch (error) {
          this.warn(`plugin/read ${entry.summary.id} failed`, error);
          return null;
        }
      });
    return (await Promise.all(reads)).filter((detail): detail is CodexPluginReadResult["plugin"] => detail !== null);
  }

  private async pluginItems(
    userConfig: UserConfig | null,
    list: CodexPluginListResult | null,
    details: CodexPluginReadResult["plugin"][],
    add: (item: ProfileItem, ref: ItemRef) => void
  ): Promise<void> {
    const configured = record(userConfig?.config.plugins);
    const installed = this.installedSummaries(list);
    const detailById = new Map(details.map((detail) => [detail.summary.id, detail]));
    const ids = [...new Set([...Object.keys(configured), ...installed.keys()])].sort();
    for (const id of ids) {
      const { name, marketplace } = splitPluginId(id);
      const summary = installed.get(id)?.summary;
      const detail = detailById.get(id);
      const configEnabled = record(configured[id]).enabled;
      const enabled = typeof configEnabled === "boolean" ? configEnabled : (summary?.enabled ?? true);
      const cacheDir = join(this.pluginsRoot, "cache", marketplace, name);
      const warnings: ProfileItemWarning[] = [];
      if ((await pathKind(cacheDir).catch(() => null)) === null) {
        warnings.push({
          code: "plugin-cache-missing",
          message: `Not installed in ${this.codexHome}/plugins: Codex skips it until it is installed again.`
        });
      }
      const version = summary?.localVersion ?? summary?.version ?? undefined;
      const description = summary?.interface?.shortDescription ?? detail?.description ?? undefined;
      add(
        {
          id: itemId("plugin", id),
          kind: "plugin",
          name,
          ...(description ? { description } : {}),
          enabled,
          toggleable: true,
          editable: false,
          deletable: true,
          locked: false,
          source: { ...USER_SOURCE },
          path: cacheDir,
          revision: contentHash({ id, version: version ?? null, enabled, installed: summary !== undefined }),
          warnings,
          meta: { marketplace, ...(version ? { version } : {}) }
        },
        { kind: "plugin", pluginId: id, name, marketplace, ...(summary ? { summary } : {}), ...(detail ? { detail } : {}) }
      );
    }
  }

  private marketplaceItems(
    userConfig: UserConfig | null,
    list: CodexPluginListResult | null,
    add: (item: ProfileItem, ref: ItemRef) => void
  ): void {
    const configured = record(userConfig?.config.marketplaces);
    for (const [name, value] of Object.entries(configured)) {
      const entry = record(value);
      add(
        {
          id: itemId("marketplace", name),
          kind: "marketplace",
          name,
          ...(typeof entry.source === "string" ? { description: entry.source } : {}),
          enabled: true,
          toggleable: false,
          editable: false,
          deletable: true,
          locked: false,
          source: { ...USER_SOURCE },
          path: this.configPath,
          revision: contentHash({ entry }),
          warnings: [],
          meta: { source: describeMarketplaceSource(marketplaceSource(entry)) }
        },
        { kind: "marketplace", name, entry }
      );
    }
    // Marketplaces Codex ships (the curated one) that an installed plugin comes from.
    for (const marketplace of list?.marketplaces ?? []) {
      if (Object.hasOwn(configured, marketplace.name)) continue;
      add(
        {
          id: itemId("marketplace", marketplace.name),
          kind: "marketplace",
          name: marketplace.name,
          ...(marketplace.interface?.displayName ? { description: marketplace.interface.displayName } : {}),
          enabled: true,
          toggleable: false,
          editable: false,
          deletable: false,
          locked: false,
          source: { type: "bundled", label: "Built in" },
          ...(marketplace.path !== null ? { path: marketplace.path } : {}),
          revision: contentHash({ name: marketplace.name, path: marketplace.path }),
          warnings: []
        },
        { kind: "marketplace", name: marketplace.name }
      );
    }
  }

  // --- hooks -------------------------------------------------------------

  private hookState(userConfig: UserConfig | null): Record<string, HookStateEntry> {
    const state: Record<string, HookStateEntry> = {};
    for (const [key, value] of Object.entries(record(record(userConfig?.config.hooks).state))) {
      if (isRecord(value)) state[key] = value;
    }
    return state;
  }

  private hookItems(
    entries: CodexHookEntry[],
    userConfig: UserConfig | null,
    hooksMeta: Map<string, CodexHookMetadata>,
    metaHooksPath: string,
    paths: readonly string[],
    add: (item: ProfileItem, ref: ItemRef) => void
  ): void {
    const state = this.hookState(userConfig);
    const ids = hookEntryIds(entries);
    entries.forEach((entry, index) => {
      const key = stateKey(this.hooksPath, entry);
      const meta = hooksMeta.get(stateKey(metaHooksPath, entry));
      const own = state[key];
      const enabled = meta?.enabled ?? own?.enabled !== false;
      const isCommand = entry.handler.type === "command" && typeof entry.handler.command === "string";
      const warnings: ProfileItemWarning[] = [];
      if (!isCommand) {
        warnings.push({
          code: "hook-unsupported",
          message: `Codex does not run "${String(entry.handler.type)}" hooks.`
        });
      } else if (!entry.managed && (meta !== undefined || userConfig !== null)) {
        // Without hooks/list or the config (Codex missing, config unreadable) trust is unknown: no warning.
        const hash = codexHookHash(entry.eventSnake, entry.handler, entry.matcher);
        const trust =
          meta?.trustStatus ??
          (typeof own?.trusted_hash !== "string" ? "untrusted" : own.trusted_hash === hash ? "trusted" : "modified");
        if (trust === "untrusted") {
          warnings.push({ code: "hook-untrusted", message: "Not trusted by Codex: it does not run until trusted.", action: "trust" });
        } else if (trust === "modified") {
          warnings.push({
            code: "hook-modified",
            message: "Changed since Codex trusted it: it does not run until trusted again.",
            action: "trust"
          });
        } else if (userConfig !== null) {
          // Trusted here, but each home Codex loads it from keeps its own trust: an account
          // added after the hook was trusted (or a hand edit) leaves it silently skipped there.
          const expected = meta?.currentHash ?? hash;
          const missing = paths.filter((path) => state[stateKey(path, entry)]?.trusted_hash !== expected).length;
          if (missing > 0) {
            warnings.push({
              code: "hook-untrusted-elsewhere",
              message: `Not trusted in ${missing} of the ${paths.length} Codex homes that load it: it does not run there until trusted.`,
              action: "trust"
            });
          }
        }
      }
      const command = typeof entry.handler.command === "string" ? entry.handler.command : String(entry.handler.type);
      add(
        {
          id: ids[index],
          kind: "hook",
          name: command,
          ...(entry.matcher !== undefined && entry.matcher !== "" ? { description: `Matcher: ${entry.matcher}` } : {}),
          enabled,
          toggleable: !entry.managed && isCommand,
          editable: !entry.managed && isCommand,
          deletable: !entry.managed,
          locked: entry.managed,
          source: entry.managed ? { type: "orquester", label: "Orquester" } : { ...USER_SOURCE },
          path: this.hooksPath,
          revision: contentHash({ event: entry.event, identity: hookIdentity(entry), enabled }),
          warnings,
          meta: {
            event: entry.event,
            ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
            ...(typeof entry.handler.timeout === "number" ? { timeout: `${entry.handler.timeout}s` } : {})
          }
        },
        { kind: "hook", entry }
      );
    });
    // Hooks a plugin ships: listed read-only under the plugin's badge.
    for (const meta of hooksMeta.values()) {
      if (meta.source !== "plugin" || meta.pluginId === null) continue;
      const event = meta.eventName.charAt(0).toUpperCase() + meta.eventName.slice(1);
      add(
        {
          id: itemId("hook", `${event}:plugin-${contentHash(meta.key)}`),
          kind: "hook",
          name: meta.command ?? meta.handlerType,
          enabled: meta.enabled,
          toggleable: false,
          editable: false,
          deletable: false,
          locked: false,
          source: { type: "plugin", label: `Plugin · ${splitPluginId(meta.pluginId).name}`, pluginId: meta.pluginId },
          path: meta.sourcePath,
          revision: contentHash({ key: meta.key, hash: meta.currentHash, enabled: meta.enabled }),
          warnings: [],
          meta: { event, ...(meta.matcher !== null ? { matcher: meta.matcher } : {}) }
        },
        { kind: "hook", plugin: meta }
      );
    }
  }

  // --- commands (legacy prompts) --------------------------------------------

  private async commandItems(add: (item: ProfileItem, ref: ItemRef) => void, fileErrors: ProfileFileError[]): Promise<void> {
    let commands;
    try {
      commands = await scanCommands(this.promptsRoot, { nested: false });
    } catch (error) {
      fileErrors.push({ path: this.promptsRoot, message: message(error) });
      return;
    }
    for (const command of commands) {
      const text = command.error === undefined ? await readTextIfExists(command.file).catch(() => null) : null;
      const warnings: ProfileItemWarning[] = [
        { code: "codex-prompts-deprecated", message: "Codex no longer loads custom prompts; convert it to a skill." }
      ];
      if (command.error !== undefined) warnings.push({ code: "command-unreadable", message: command.error });
      add(
        {
          id: itemId("command", command.name),
          kind: "command",
          name: command.name,
          ...(command.description !== undefined ? { description: command.description } : {}),
          enabled: false,
          toggleable: false,
          editable: false,
          deletable: true,
          locked: false,
          source: { type: "user", label: "Legacy prompt" },
          path: command.file,
          revision: contentHash({ text, error: command.error ?? null }),
          warnings
        },
        { kind: "command", name: command.name, file: command.file }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Item lookup
  // -------------------------------------------------------------------------

  private async locate(id: string, revision: string | null): Promise<{ loaded: Loaded; item: ProfileItem; ref: ItemRef }> {
    const loaded = await this.load();
    const found = loaded.refs.get(id);
    if (found === undefined) {
      throw profileErrors.notFound(id);
    }
    if (found.item.locked) {
      throw profileErrors.locked(found.item.name);
    }
    if (revision !== null && found.item.revision !== revision) {
      throw profileErrors.conflict();
    }
    return { loaded, item: found.item, ref: found.ref };
  }

  private requireConfig(loaded: Loaded): UserConfig {
    if (this.ctx.bin === null) {
      throw profileErrors.notInstalled(LABEL);
    }
    if (loaded.userConfig === null) {
      throw profileErrors.unreadable(this.configPath, loaded.configError ?? "Codex could not read it");
    }
    return loaded.userConfig;
  }

  async readItem(id: string): Promise<ProfileItemDetail> {
    const loaded = await this.load();
    const found = loaded.refs.get(id);
    if (found === undefined) {
      throw profileErrors.notFound(id);
    }
    const { item, ref } = found;
    switch (ref.kind) {
      case "mcp":
        return { kind: "mcp", item, mcp: ref.plugin !== undefined ? { name: ref.name, transport: "stdio" } : mcpView(ref.name, ref.entry) };
      case "skill": {
        const text = await readTextIfExists(ref.skillFile);
        const document = text === null ? { frontmatter: {}, body: "" } : parseDocumentOrUnreadable(ref.skillFile, text);
        const files = ref.dir !== undefined ? await readSkillFiles(ref.dir) : undefined;
        return { kind: "skill", item, document, ...(files !== undefined ? { files } : {}) };
      }
      case "command": {
        const text = (await readTextIfExists(ref.file)) ?? "";
        return { kind: "command", item, document: parseDocumentOrUnreadable(ref.file, text) };
      }
      case "hook": {
        if (ref.entry === undefined) {
          const meta = ref.plugin!;
          return {
            kind: "hook",
            item,
            hook: {
              event: item.meta?.event ?? meta.eventName,
              ...(meta.matcher !== null ? { matcher: meta.matcher } : {}),
              command: meta.command ?? "",
              timeoutSec: meta.timeoutSec
            }
          };
        }
        const handler = ref.entry.handler;
        return {
          kind: "hook",
          item,
          hook: {
            event: ref.entry.event,
            ...(ref.entry.matcher !== undefined ? { matcher: ref.entry.matcher } : {}),
            command: typeof handler.command === "string" ? handler.command : "",
            ...(typeof handler.timeout === "number" ? { timeoutSec: handler.timeout } : {})
          }
        };
      }
      case "plugin": {
        const detail = ref.detail;
        const provides: Partial<Record<"skills" | "hooks" | "mcpServers", number>> = {};
        if (detail !== undefined) {
          provides.skills = detail.skills.length;
          provides.hooks = detail.hooks.length;
          provides.mcpServers = detail.mcpServers.length;
        }
        const version = item.meta?.version;
        return {
          kind: "plugin",
          item,
          plugin: {
            id: ref.pluginId,
            name: ref.name,
            marketplace: ref.marketplace,
            ...(version !== undefined ? { version } : {}),
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(detail !== undefined ? { provides } : {})
          }
        };
      }
      case "marketplace": {
        const view: MarketplaceView = {
          name: ref.name,
          source: ref.entry !== undefined ? marketplaceSource(ref.entry) : { type: "path", path: item.path ?? "" }
        };
        return { kind: "marketplace", item, marketplace: view };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    switch (draft.kind) {
      case "mcp":
        return this.createMcp(draft.mcp, options.onConflict);
      case "skill":
        return this.createSkill(draft.document, options.onConflict);
      case "hook":
        return this.createHook(draft.hook, options.onConflict);
      case "plugin":
        return this.installPlugin(draft.plugin, options.onConflict);
      case "marketplace":
        return this.addMarketplace(draft.marketplace, options.onConflict);
      case "command":
        throw profileErrors.invalidItem("Codex no longer loads custom prompts; add a skill instead.");
      default:
        throw profileErrors.invalid(`Unknown item kind ${JSON.stringify((draft as { kind?: unknown }).kind)}.`);
    }
  }

  private async createMcp(
    draft: Extract<ProfileItemDraft, { kind: "mcp" }>["mcp"],
    onConflict: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    const loaded = await this.load();
    const config = this.requireConfig(loaded);
    const servers = record(config.config.mcp_servers);
    let name = draft.name;
    let existing: CodexMcpEntry | undefined;
    if (typeof name === "string" && Object.hasOwn(servers, name)) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        name = uniqueName(name, (candidate) => Object.hasOwn(servers, candidate));
      } else {
        existing = record(servers[name]);
      }
    }
    const entry = mcpEntryFromDraft({ ...draft, name }, existing);
    await this.batchWrite(
      [{ keyPath: keyPath("mcp_servers", name), value: entry as JsonValue, mergeStrategy: "replace" }],
      config.version,
      mcpSecretValues(entry)
    );
    return { itemIds: [itemId("mcp", name)], notes: name !== draft.name ? [`Added as "${name}".`] : [] };
  }

  private async createSkill(
    document: Extract<ProfileItemDraft, { kind: "skill" }>["document"],
    onConflict: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    let name = document.name;
    assertSkillName(name);
    const taken = async (candidate: string) => (await pathKind(join(this.skillsRoot, candidate))) !== null;
    if (await taken(name)) {
      if (onConflict === "fail") throw profileErrors.exists(name);
      if (onConflict === "keep-both") {
        name = await uniqueNameAsync(name, taken);
      } else {
        await removeProfilePath(join(this.skillsRoot, name), { backups: this.deps.backups, agent: AGENT });
      }
    }
    await writeSkill(this.skillsRoot, { ...document, name }, { backups: this.deps.backups, agent: AGENT, mergeExisting: false });
    return { itemIds: [itemId("skill", name)], notes: name !== document.name ? [`Added as "${name}".`] : [] };
  }

  private async installPlugin(
    draft: Extract<ProfileItemDraft, { kind: "plugin" }>["plugin"],
    onConflict: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    if (!("plugin" in draft) || typeof draft.plugin !== "string" || typeof draft.marketplace !== "string") {
      throw profileErrors.invalidItem("Codex installs a plugin from a marketplace: give the plugin and the marketplace.");
    }
    const pluginId = `${draft.plugin}@${draft.marketplace}`;
    const loaded = await this.load();
    if (loaded.refs.has(itemId("plugin", pluginId)) && loaded.refs.get(itemId("plugin", pluginId))!.item.warnings.length === 0) {
      if (onConflict === "fail") throw profileErrors.exists(pluginId);
      if (onConflict === "keep-both") throw profileErrors.invalidItem("A plugin can only be installed once.");
    }
    const listed = await this.rpc("plugin/list", {});
    const marketplace = listed.marketplaces.find((entry) => entry.name === draft.marketplace);
    if (marketplace === undefined) {
      throw profileErrors.invalidItem(`Codex has no marketplace "${draft.marketplace}".`);
    }
    await this.rpc(
      "plugin/install",
      {
        pluginName: draft.plugin,
        ...(marketplace.path !== null ? { marketplacePath: marketplace.path } : { remoteMarketplaceName: marketplace.name })
      },
      { timeoutMs: CODEX_PLUGIN_INSTALL_TIMEOUT_MS }
    );
    return { itemIds: [itemId("plugin", pluginId)], notes: [] };
  }

  private async addMarketplace(
    draft: Extract<ProfileItemDraft, { kind: "marketplace" }>["marketplace"],
    onConflict: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    const source = draft.source;
    let params: CodexConfigMethods["marketplace/add"]["params"];
    if (source?.type === "github" && /^[\w.-]+\/[\w.-]+$/.test(source.repo ?? "")) {
      params = { source: source.repo, ...(source.ref ? { refName: source.ref } : {}) };
    } else if (source?.type === "git" && typeof source.url === "string" && source.url.trim().length > 0) {
      params = { source: source.url.trim(), ...(source.ref ? { refName: source.ref } : {}) };
    } else if (source?.type === "path" && typeof source.path === "string" && source.path.startsWith("/")) {
      params = { source: source.path };
    } else {
      throw profileErrors.invalidItem("A marketplace needs a GitHub owner/repo, a git URL or an absolute local path.");
    }
    const result = await this.rpc("marketplace/add", params, { timeoutMs: CODEX_PLUGIN_INSTALL_TIMEOUT_MS });
    const notes: string[] = [];
    if (result.alreadyAdded) {
      if (onConflict === "fail") throw profileErrors.exists(result.marketplaceName);
      notes.push(`"${result.marketplaceName}" was already added.`);
    }
    if (draft.name !== undefined && draft.name !== result.marketplaceName) {
      notes.push(`Codex names this marketplace "${result.marketplaceName}" from its manifest.`);
    }
    return { itemIds: [itemId("marketplace", result.marketplaceName)], notes };
  }

  // -------------------------------------------------------------------------
  // Hooks: the one place `hooks.json` and `hooks.state` change together
  // -------------------------------------------------------------------------

  /**
   * `hooks.json` as Codex keys it when it is GIVEN `CODEX_HOME` (this
   * adapter's app-server, every managed-account session): Codex canonicalizes
   * that directory first. Without `CODEX_HOME` (a session on the daemon user's
   * own home) it keys `~/.codex/hooks.json` as it is — {@link hooksPath}.
   */
  private async canonicalHooksPath(home: string = this.codexHome): Promise<string> {
    return join(await realOrSelf(home), "hooks.json");
  }

  /**
   * Every path `hooks.json` is seen from, spelled as Codex spells it in state
   * keys: the system one, then each account home linked to the same file —
   * each also by its canonical spelling when a symlink makes it differ.
   */
  private async hookPaths(): Promise<string[]> {
    const paths: string[] = [];
    const add = (path: string): void => {
      if (!paths.includes(path)) paths.push(path);
    };
    add(this.hooksPath);
    add(await this.canonicalHooksPath());
    const target = await resolveWriteTarget(this.hooksPath);
    for (const home of await this.ctx.accountHomes()) {
      const path = join(home, "hooks.json");
      if ((await pathKind(path).catch(() => null)) === null) continue;
      if ((await resolveWriteTarget(path).catch(() => null)) !== target) continue;
      add(path);
      add(await this.canonicalHooksPath(home));
    }
    return paths;
  }

  private validHookDraft(draft: HookDraft): { event: string; matcher?: string; handler: CodexHookHandler } {
    if (!isRecord(draft)) throw profileErrors.invalidItem("A hook needs an event and a command.");
    const events = PROFILE_HOOK_EVENTS.codex ?? [];
    if (typeof draft.event !== "string" || !events.includes(draft.event)) {
      throw profileErrors.invalidItem(`Codex has no hook event ${JSON.stringify(draft.event)}.`);
    }
    const command = typeof draft.command === "string" ? draft.command.trim() : "";
    if (command.length === 0 || command.includes("\0")) {
      throw profileErrors.invalidItem("A hook needs a command.");
    }
    if (command.includes("agent-hook.sh")) {
      throw profileErrors.invalidItem("agent-hook.sh is Orquester's own hook and is managed by Orquester.");
    }
    const timeout = draft.timeoutSec;
    if (timeout !== undefined && timeout !== null && (!Number.isInteger(timeout) || timeout <= 0 || timeout > 86_400)) {
      throw profileErrors.invalidItem("The timeout must be a whole number of seconds between 1 and 86400.");
    }
    if (draft.matcher !== undefined && draft.matcher !== null && typeof draft.matcher !== "string") {
      throw profileErrors.invalidItem("The matcher must be a string.");
    }
    const matcher =
      typeof draft.matcher === "string" && draft.matcher.length > 0 && !PROFILE_HOOK_EVENTS_WITHOUT_MATCHER.includes(draft.event)
        ? draft.matcher
        : undefined;
    return {
      event: draft.event,
      ...(matcher !== undefined ? { matcher } : {}),
      handler: { type: "command", command, ...(typeof timeout === "number" ? { timeout } : {}) }
    };
  }

  /** Appends a one-handler group to `event`, before Orquester's managed group when there is one. */
  private insertGroup(doc: CodexHooksDocument, event: string, matcher: string | undefined, handler: CodexHookHandler): void {
    const groups = doc.hooks[event] ?? [];
    const group = { ...(matcher !== undefined ? { matcher } : {}), hooks: [handler] };
    const managedAt = listHookEntries({ hooks: { [event]: groups } }).find((entry) => entry.managed)?.groupIndex;
    if (managedAt === undefined) {
      groups.push(group);
    } else {
      groups.splice(managedAt, 0, group);
    }
    doc.hooks[event] = groups;
  }

  /** Removes one handler (and its group when it was the last, and the event when it was the last group). */
  private removeHandler(doc: CodexHooksDocument, entry: CodexHookEntry): void {
    const groups = doc.hooks[entry.event];
    const group = groups?.[entry.groupIndex];
    const handlers = Array.isArray(group?.hooks) ? (group.hooks as CodexHookHandler[]) : null;
    if (groups === undefined || group === undefined || handlers === null) return;
    const index = handlers.indexOf(entry.handler);
    if (index === -1) return;
    handlers.splice(index, 1);
    if (handlers.length === 0) {
      groups.splice(entry.groupIndex, 1);
    }
    if (groups.length === 0) {
      delete doc.hooks[entry.event];
    }
  }

  /**
   * Applies `edit` to the parsed `hooks.json`, writes it, then re-keys
   * `hooks.state` for every path in one `config/batchWrite` checked against the
   * version read. `edit` returns the handler object that should get fresh state
   * (a new or edited hook) and that state. A failed state write puts the
   * previous `hooks.json` back.
   */
  private async mutateHooks(
    loaded: Loaded,
    edit: (doc: CodexHooksDocument) => { handler?: CodexHookHandler; state?: HookStateEntry }
  ): Promise<{ position?: HookPosition; entries: CodexHookEntry[] }> {
    const config = this.requireConfig(loaded);
    if (loaded.hooksDoc === null) {
      throw profileErrors.unreadable(this.hooksPath, loaded.hooksError ?? "it does not parse");
    }
    const doc = loaded.hooksDoc;
    const before = loaded.hookEntries;
    const oldPositions = new Map<CodexHookHandler, string>(before.map((entry) => [entry.handler, hookPositionId(entry)]));
    const { handler: fresh, state: freshState } = edit(doc);
    const after = listHookEntries(doc);
    const moved = new Map<string, HookPosition>();
    for (const entry of after) {
      const old = oldPositions.get(entry.handler);
      if (old !== undefined) moved.set(old, entry);
    }
    const position = fresh !== undefined ? after.find((entry) => entry.handler === fresh) : undefined;
    const { write, remove } = rekeyHookState({
      before,
      after,
      moved,
      state: this.hookState(config),
      paths: await this.hookPaths(),
      ...(position !== undefined && freshState !== undefined ? { set: [{ position, entry: freshState }] } : {})
    });
    if ((await readTextIfExists(this.hooksPath)) !== loaded.hooksText) {
      // Something else (Orquester's own hook installer at a session launch, a hand edit)
      // rewrote it since it was read: writing ours would drop that change.
      throw profileErrors.conflict();
    }
    const written = await writeProfileFileVerified(this.hooksPath, serializeHooksDocument(doc), {
      backups: this.deps.backups,
      agent: AGENT,
      defaultMode: 0o644,
      verify: parseHooksDocument
    });
    const edits: CodexConfigEdit[] = [
      ...[...remove].sort().map((key) => ({ keyPath: keyPath("hooks", "state", key), value: null, mergeStrategy: "replace" as const })),
      ...[...write.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => ({ keyPath: keyPath("hooks", "state", key), value: entry as JsonValue, mergeStrategy: "replace" as const }))
    ];
    try {
      await this.batchWrite(edits, config.version);
    } catch (error) {
      try {
        if (written.backup !== null) {
          await this.deps.backups.restore(written.backup, written.path);
        } else {
          await removeProfilePath(written.path, { backups: this.deps.backups, agent: AGENT });
        }
      } catch (restoreError) {
        this.warn("putting hooks.json back failed", restoreError);
      }
      throw error;
    }
    return { ...(position !== undefined ? { position } : {}), entries: after };
  }

  private newHookId(entries: CodexHookEntry[], handler: CodexHookHandler | undefined): string[] {
    if (handler === undefined) return [];
    const index = entries.findIndex((entry) => entry.handler === handler);
    return index === -1 ? [] : [hookEntryIds(entries)[index]];
  }

  private async createHook(draft: HookDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    const hook = this.validHookDraft(draft);
    const loaded = await this.load();
    const snake = eventSnake(hook.event);
    const duplicate = loaded.hookEntries.find(
      (entry) =>
        entry.event === hook.event &&
        (entry.matcher ?? "") === (hook.matcher ?? "") &&
        JSON.stringify(entry.handler) === JSON.stringify(hook.handler)
    );
    if (duplicate !== undefined && onConflict !== "keep-both") {
      if (onConflict === "fail") throw profileErrors.exists(String(hook.handler.command));
      const index = loaded.hookEntries.indexOf(duplicate);
      return { itemIds: [hookEntryIds(loaded.hookEntries)[index]], notes: ["That hook already exists."] };
    }
    const trusted = codexHookHash(snake, hook.handler, hook.matcher);
    const handler = hook.handler;
    const result = await this.mutateHooks(loaded, (doc) => {
      this.insertGroup(doc, hook.event, hook.matcher, handler);
      return { handler, state: { enabled: true, ...(trusted !== null ? { trusted_hash: trusted } : {}) } };
    });
    return { itemIds: this.newHookId(result.entries, handler), notes: [] };
  }

  private async updateHook(
    loaded: Loaded,
    item: ProfileItem,
    entry: CodexHookEntry,
    draft: HookDraft
  ): Promise<AdapterMutationResult> {
    const hook = this.validHookDraft(draft);
    // Fields the editor does not show survive the edit.
    const handler: CodexHookHandler = { ...entry.handler, command: hook.handler.command };
    if (hook.handler.timeout !== undefined) {
      handler.timeout = hook.handler.timeout;
    } else {
      delete handler.timeout;
    }
    const trusted = codexHookHash(eventSnake(hook.event), handler, hook.matcher);
    const state: HookStateEntry = { enabled: item.enabled, ...(trusted !== null ? { trusted_hash: trusted } : {}) };
    const samePlace = hook.event === entry.event && (hook.matcher ?? "") === (entry.matcher ?? "");
    const result = await this.mutateHooks(loaded, (doc) => {
      if (samePlace) {
        const handlers = doc.hooks[entry.event][entry.groupIndex].hooks as CodexHookHandler[];
        handlers[entry.handlerIndex] = handler;
      } else {
        this.removeHandler(doc, entry);
        this.insertGroup(doc, hook.event, hook.matcher, handler);
      }
      return { handler, state };
    });
    return { itemIds: this.newHookId(result.entries, handler), notes: [] };
  }

  /** Writes one field of every path's state entry for `entry` (no re-keying: nothing moves). */
  private async writeHookStateField(loaded: Loaded, entry: CodexHookEntry, field: string, value: JsonValue): Promise<void> {
    const config = this.requireConfig(loaded);
    if (loaded.hooksDoc === null) {
      throw profileErrors.unreadable(this.hooksPath, loaded.hooksError ?? "it does not parse");
    }
    const edits = (await this.hookPaths()).map((path) => ({
      keyPath: keyPath("hooks", "state", stateKey(path, entry), field),
      value,
      mergeStrategy: "replace" as const
    }));
    await this.batchWrite(edits, config.version);
  }

  async trust(id: string, revision: string): Promise<AdapterMutationResult> {
    const { loaded, item, ref } = await this.locate(id, revision);
    if (ref.kind !== "hook" || ref.entry === undefined || !item.editable) {
      throw profileErrors.invalid("Only your own Codex hooks can be trusted here.");
    }
    const entry = ref.entry;
    const hash =
      loaded.hooksMeta.get(stateKey(loaded.metaHooksPath, entry))?.currentHash ??
      codexHookHash(entry.eventSnake, entry.handler, entry.matcher);
    if (hash === null) {
      throw profileErrors.invalid("Codex does not run this kind of hook.");
    }
    await this.writeHookStateField(loaded, entry, "trusted_hash", hash);
    return { itemIds: [id], notes: [] };
  }

  // -------------------------------------------------------------------------
  // Update, enable, remove
  // -------------------------------------------------------------------------

  async update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult> {
    const { loaded, item, ref } = await this.locate(id, revision);
    if (!item.editable) {
      throw profileErrors.notEditable(item.name);
    }
    if (draft.kind !== ref.kind) {
      throw profileErrors.invalid(`"${item.name}" is not a ${draft.kind}.`);
    }
    if (ref.kind === "mcp" && draft.kind === "mcp") {
      const config = this.requireConfig(loaded);
      const servers = record(config.config.mcp_servers);
      const name = draft.mcp.name;
      if (name !== ref.name && Object.hasOwn(servers, name)) {
        throw profileErrors.exists(name);
      }
      const entry = mcpEntryFromDraft(draft.mcp, ref.entry);
      const edits: CodexConfigEdit[] = [];
      if (name !== ref.name) {
        edits.push({ keyPath: keyPath("mcp_servers", ref.name), value: null, mergeStrategy: "replace" });
      }
      edits.push({ keyPath: keyPath("mcp_servers", name), value: entry as JsonValue, mergeStrategy: "replace" });
      await this.batchWrite(edits, config.version, [...mcpSecretValues(entry), ...mcpSecretValues(ref.entry)]);
      return { itemIds: [itemId("mcp", name)], notes: [] };
    }
    if (ref.kind === "skill" && draft.kind === "skill") {
      return this.updateSkill(item, ref, draft.document);
    }
    if (ref.kind === "hook" && draft.kind === "hook" && ref.entry !== undefined) {
      return this.updateHook(loaded, item, ref.entry, draft.hook);
    }
    throw profileErrors.notEditable(item.name);
  }

  private async updateSkill(
    item: ProfileItem,
    ref: Extract<ItemRef, { kind: "skill" }>,
    document: Extract<ProfileItemDraft, { kind: "skill" }>["document"]
  ): Promise<AdapterMutationResult> {
    const options = { backups: this.deps.backups, agent: AGENT };
    if (ref.origin !== "user" || ref.dir === undefined) {
      throw profileErrors.notEditable(item.name);
    }
    if (document.name === item.name) {
      await writeSkill(this.skillsRoot, document, options);
      return { itemIds: [item.id], notes: [] };
    }
    assertSkillName(document.name);
    const dest = join(this.skillsRoot, document.name);
    if ((await pathKind(dest)) !== null) {
      throw profileErrors.exists(document.name);
    }
    await copyTree(ref.dir, dest, { refuseSymlinks: false });
    await writeSkill(this.skillsRoot, document, options);
    if (!item.enabled) {
      // The off switch is keyed by path: carry it over, and drop the old entry while its path still resolves.
      await this.rpc("skills/config/write", { path: join(dest, SKILL_FILE), enabled: false });
      await this.clearSkillSwitch(ref.configPath);
    }
    await removeProfilePath(ref.dir, options);
    return { itemIds: [itemId("skill", document.name)], notes: [] };
  }

  /**
   * Drops a skill's `[[skills.config]]` off entry (enabling does that) before
   * the skill goes away: Codex canonicalizes the path, so it must still exist.
   * Best effort — a leftover entry for a missing path is harmless.
   */
  private async clearSkillSwitch(configPath: string): Promise<void> {
    await this.rpc("skills/config/write", { path: configPath, enabled: true }).catch((error: unknown) => {
      this.warn("clearing a skill's off switch failed", error);
    });
  }

  async setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult> {
    const { loaded, item, ref } = await this.locate(id, revision);
    if (!item.toggleable) {
      throw profileErrors.notToggleable(item.name);
    }
    switch (ref.kind) {
      case "mcp": {
        const config = this.requireConfig(loaded);
        await this.batchWrite(
          [{ keyPath: keyPath("mcp_servers", ref.name, "enabled"), value: enabled ? null : false, mergeStrategy: "replace" }],
          config.version
        );
        break;
      }
      case "skill": {
        const selector = ref.origin === "user" || ref.origin === "shared" ? { path: ref.configPath } : { name: ref.codexName };
        await this.rpc("skills/config/write", { ...selector, enabled });
        break;
      }
      case "plugin": {
        const config = this.requireConfig(loaded);
        await this.batchWrite(
          [{ keyPath: keyPath("plugins", ref.pluginId, "enabled"), value: enabled, mergeStrategy: "replace" }],
          config.version
        );
        break;
      }
      case "hook": {
        if (ref.entry === undefined) throw profileErrors.notToggleable(item.name);
        await this.writeHookStateField(loaded, ref.entry, "enabled", enabled);
        break;
      }
      default:
        throw profileErrors.notToggleable(item.name);
    }
    return { itemIds: [id], notes: [] };
  }

  async remove(id: string, revision: string): Promise<AdapterMutationResult> {
    const { loaded, item, ref } = await this.locate(id, revision);
    if (!item.deletable) {
      throw profileErrors.notDeletable(item.name);
    }
    const options = { backups: this.deps.backups, agent: AGENT };
    switch (ref.kind) {
      case "mcp": {
        const config = this.requireConfig(loaded);
        await this.batchWrite([{ keyPath: keyPath("mcp_servers", ref.name), value: null, mergeStrategy: "replace" }], config.version);
        break;
      }
      case "skill": {
        if (ref.dir === undefined) throw profileErrors.notDeletable(item.name);
        if (!item.enabled) {
          await this.clearSkillSwitch(ref.configPath);
        }
        await removeProfilePath(ref.dir, options);
        break;
      }
      case "command":
        await removeProfilePath(ref.file, options);
        break;
      case "plugin":
        await this.rpc("plugin/uninstall", { pluginId: ref.pluginId }, { timeoutMs: CODEX_PLUGIN_INSTALL_TIMEOUT_MS });
        break;
      case "marketplace":
        await this.rpc("marketplace/remove", { marketplaceName: ref.name });
        break;
      case "hook": {
        const entry = ref.entry;
        if (entry === undefined) throw profileErrors.notDeletable(item.name);
        await this.mutateHooks(loaded, (doc) => {
          this.removeHandler(doc, entry);
          return {};
        });
        break;
      }
    }
    return { itemIds: [id], notes: [] };
  }

  // -------------------------------------------------------------------------
  // Marketplace catalogue
  // -------------------------------------------------------------------------

  async listMarketplacePlugins(marketplace: string): Promise<MarketplacePluginEntry[]> {
    const listed = await this.rpc("plugin/list", {});
    const entry = listed.marketplaces.find((candidate) => candidate.name === marketplace);
    if (entry === undefined) {
      throw profileErrors.notFound(itemId("marketplace", marketplace));
    }
    return entry.plugins.map((plugin) => {
      const description = plugin.interface?.shortDescription ?? undefined;
      const version = plugin.version ?? plugin.localVersion ?? undefined;
      return {
        name: plugin.name,
        ...(description ? { description } : {}),
        ...(version ? { version } : {}),
        installed: plugin.installed
      };
    });
  }

  // -------------------------------------------------------------------------
  // Copy between agents
  // -------------------------------------------------------------------------

  async exportItem(id: string): Promise<PortableItem> {
    const { ref, item } = await this.locate(id, null);
    switch (ref.kind) {
      case "mcp":
        if (ref.plugin !== undefined) throw profileErrors.invalid(`"${item.name}" belongs to a plugin.`);
        return { kind: "mcp", server: portableFromEntry(ref.name, ref.entry) };
      case "skill": {
        const source = ref.dir ?? (ref.skillFile.endsWith(`${sep}${SKILL_FILE}`) ? ref.skillFile.slice(0, -SKILL_FILE.length - 1) : null);
        if (source === null) throw profileErrors.invalid(`"${item.name}" cannot be copied.`);
        const dir = join(agentProfileImportsDir(this.ctx.appdir), `codex-export-${randomUUID()}`, item.name.replaceAll(":", "-"));
        await copyTree(source, dir, { refuseSymlinks: false });
        return { kind: "skill", name: item.name, dir };
      }
      case "command": {
        const text = (await readTextIfExists(ref.file)) ?? "";
        const document = parseDocumentOrUnreadable(ref.file, text);
        return { kind: "command", name: ref.name, frontmatter: document.frontmatter, body: document.body };
      }
      default:
        throw profileErrors.invalid(`A Codex ${ref.kind} cannot be copied to another agent.`);
    }
  }

  async importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    switch (item.kind) {
      case "mcp":
        return this.createMcp(draftFromPortable(item.server), options.onConflict);
      case "skill": {
        let name = item.name;
        assertSkillName(name);
        const taken = async (candidate: string) => (await pathKind(join(this.skillsRoot, candidate))) !== null;
        if (await taken(name)) {
          if (options.onConflict === "fail") throw profileErrors.exists(name);
          if (options.onConflict === "keep-both") {
            name = await uniqueNameAsync(name, taken);
          } else {
            await removeProfilePath(join(this.skillsRoot, name), { backups: this.deps.backups, agent: AGENT });
          }
        }
        const copied = await copyTree(item.dir, join(this.skillsRoot, name), { refuseSymlinks: true });
        const notes = name !== item.name ? [`Added as "${name}".`] : [];
        if (copied.skipped.length > 0) notes.push(`Skipped: ${copied.skipped.join(", ")}.`);
        if (name !== item.name) {
          // The frontmatter name must match the directory.
          const text = await readTextIfExists(join(this.skillsRoot, name, SKILL_FILE));
          if (text !== null) {
            const document = parseDocumentOrUnreadable(join(this.skillsRoot, name, SKILL_FILE), text);
            await writeSkill(
              this.skillsRoot,
              { name, frontmatter: document.frontmatter, body: document.body },
              { backups: this.deps.backups, agent: AGENT }
            );
          }
        }
        return { itemIds: [itemId("skill", name)], notes };
      }
      case "command":
        throw profileErrors.invalidItem("Codex has no commands: copy it as a skill.");
      default:
        throw profileErrors.invalid("Unknown item.");
    }
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  private async readInstructionsFile(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    const text = await readTextIfExists(this.instructionsPath);
    const warnings: ProfileItemWarning[] = [];
    const override = await readTextIfExists(this.overridePath).catch(() => null);
    if (override !== null && override.trim().length > 0) {
      warnings.push({
        code: "agents-override",
        message: "AGENTS.override.md is not empty: Codex reads it instead of AGENTS.md.",
        action: "open-file"
      });
    }
    if (text === null) {
      return {
        text: "",
        info: { path: this.instructionsPath, exists: false, bytes: 0, lines: 0, revision: "", warnings }
      };
    }
    const info = await stat(this.instructionsPath);
    return {
      text,
      info: {
        path: this.instructionsPath,
        exists: true,
        bytes: Buffer.byteLength(text),
        lines: lineCount(text),
        mtime: info.mtime.toISOString(),
        revision: contentHash(text),
        warnings
      }
    };
  }

  async readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    return this.readInstructionsFile();
  }

  async writeInstructions(text: string, revision: string): Promise<AdapterMutationResult> {
    if (typeof text !== "string") {
      throw profileErrors.invalid("The instructions must be text.");
    }
    const current = await readTextIfExists(this.instructionsPath);
    const currentRevision = current === null ? "" : contentHash(current);
    if (revision !== currentRevision) {
      throw profileErrors.conflict();
    }
    await writeProfileFile(this.instructionsPath, text, { backups: this.deps.backups, agent: AGENT, defaultMode: 0o644 });
    return { itemIds: [], notes: [] };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDocumentOrUnreadable(path: string, text: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    const { frontmatter, body } = parseMarkdownDocument(text);
    return { frontmatter, body };
  } catch (error) {
    throw profileErrors.unreadable(path, message(error));
  }
}

function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

async function uniqueNameAsync(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/** A `[marketplaces.<name>]` table as the wire's source union. */
function marketplaceSource(entry: Record<string, unknown>): MarketplaceSource {
  const source = typeof entry.source === "string" ? entry.source : "";
  const ref = typeof entry.ref === "string" ? entry.ref : undefined;
  if (entry.source_type === "local") {
    return { type: "path", path: source };
  }
  const github = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(source);
  if (github !== null) {
    return { type: "github", repo: github[1], ...(ref ? { ref } : {}) };
  }
  return { type: "git", url: source, ...(ref ? { ref } : {}) };
}

function describeMarketplaceSource(source: MarketplaceSource): string {
  switch (source.type) {
    case "github":
      return source.repo;
    case "git":
      return source.url;
    case "path":
      return source.path;
  }
}
