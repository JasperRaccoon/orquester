/**
 * Agent profile — Claude Code (2.1.280) adapter: ALL of Claude's global
 * configuration format knowledge (spec §3, §4.6).
 *
 * | Kind | Where | Off |
 * |---|---|---|
 * | instructions | `<claudeDir>/CLAUDE.md` | — |
 * | mcp | `~/.claude.json` `mcpServers` (under Claude's lock, `claude-json.ts`) | `deniedMcpServers: [{serverName}]` in settings.json — also blocks a project server of that name |
 * | skill | `<claudeDir>/skills/<name>/SKILL.md` (`synced/` is CLI-owned and not listed) | `skillOverrides.<name> = "off"`; on deletes the key |
 * | plugin | `plugins/installed_plugins.json` (user scope); `claude plugin install/uninstall --scope user` | `enabledPlugins[id] = false` |
 * | marketplace | `plugins/known_marketplaces.json` + settings `extraKnownMarketplaces`; `claude plugin marketplace add/remove` | — |
 * | hook | settings.json `hooks` (one item per handler; Orquester's `agent-hook.sh` groups locked) | stash (Claude has no per-hook off) |
 * | command | `<claudeDir>/commands/**\/*.md` (one folder level) | stash |
 *
 * Plugin-shipped skills, commands and MCP servers are listed as `plugin`
 * items: on/off follows the plugin, nothing is editable here. Plugin hooks
 * are only counted (`provides`), not listed.
 *
 * Verified against the 2.1.280 binary: a missing `enabledPlugins` entry means
 * the manifest's `defaultEnabled`, which defaults to ON; `deniedMcpServers`
 * merges from every settings source, the user file included; `skillOverrides`
 * ignores plugin skills. The CLI runs with HOME = the daemon user's home and
 * no `CLAUDE_CONFIG_DIR`; installs never pass `-y`, so a marketplace-declared
 * install command is refused by the CLI instead of being run unseen.
 */

import { mkdir, mkdtemp, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_PROFILE_AGENT_LABELS,
  type HookDraft,
  type MarketplaceDraft,
  type MarketplacePluginEntry,
  type MarkdownDocumentDraft,
  PROFILE_HOOK_EVENTS,
  PROFILE_HOOK_EVENTS_WITHOUT_MATCHER,
  type PluginInstallDraft,
  type ProfileConflictPolicy,
  type ProfileFileError,
  type ProfileInstructionsInfo,
  type ProfileItem,
  type ProfileItemDetail,
  type MarketplaceSource,
  type McpServerDraft,
  type ProfileItemDraft,
  type ProfileItemSource
} from "@orquester/api";
import { agentProfileImportsDir } from "@orquester/config";
import { profileErrors } from "../../errors.ts";
import {
  type ProfileBackups,
  type ProfileStash,
  type ScannedCommand,
  type ScannedSkill,
  type StashEntry,
  assertCommandName,
  assertMcpServerName,
  assertSafeSegment,
  assertSkillName,
  contentHash,
  copyTree,
  itemId,
  parseMarkdownDocument,
  pathKind,
  readSkillFiles,
  readTextIfExists,
  removeProfilePath,
  runAgentCliOrThrow,
  scanCommands,
  scanSkills,
  writeCommand,
  writeProfileFile,
  writeProfileFileVerified,
  serializeMarkdownDocument,
  writeSkill
} from "../../infra/index.ts";
import type {
  AdapterMutationResult,
  AdapterSnapshot,
  PortableItem,
  ProfileAdapter,
  ProfileAdapterContext
} from "../types.ts";
import { type ClaudeJsonDoc, mcpServersOf, parseClaudeJson, updateClaudeJsonMcpServers } from "./claude-json.ts";
import {
  SecretDigester,
  definitionFromDraft,
  definitionFromPortable,
  mcpTarget,
  mcpTransportOf,
  mcpView,
  portableFromDefinition
} from "./mcp.ts";
import {
  type InstalledPlugin,
  type KnownMarketplace,
  type PluginProvides,
  marketplaceSourceArg,
  parseInstalledPlugins,
  parseKnownMarketplaces,
  pluginCachePresent,
  pluginProvides,
  readMarketplaceCatalog,
  readPluginManifest,
  readPluginMcpServers,
  toMarketplaceSource
} from "./plugins.ts";
import {
  type HookFragment,
  type SettingsDoc,
  type SettingsHook,
  allowMcp,
  claudeHookId,
  denyMcp,
  insertSettingsHook,
  isMcpDenied,
  isPluginEnabled,
  isRecord,
  listSettingsHooks,
  normalizeMatcher,
  parseSettings,
  patchSettings as patchSettingsFile,
  removeSettingsHook,
  replaceSettingsHook,
  setPluginEnabled,
  setSkillOverride,
  skillOverride
} from "./settings.ts";

const AGENT = "claude";
const LABEL = AGENT_PROFILE_AGENT_LABELS.claude;
/** The CLI-owned directory under `skills/` (and `plugins/`): never listed, never written. */
const SYNCED_DIR = "synced";
const INSTALL_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 120_000;
/** Plugin and marketplace names as argv tokens: never an option, never a path. */
const CLI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const USER_SOURCE: ProfileItemSource = { type: "user", label: "User" };
const ORQUESTER_SOURCE: ProfileItemSource = { type: "orquester", label: "Orquester" };

function pluginSource(plugin: InstalledPlugin): ProfileItemSource {
  return { type: "plugin", label: `Plugin · ${plugin.name}`, pluginId: plugin.id };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Entry =
  | { kind: "mcp"; item: ProfileItem; origin: "user"; name: string; def: Record<string, unknown> }
  | { kind: "mcp"; item: ProfileItem; origin: "plugin"; name: string; def: Record<string, unknown> }
  | { kind: "skill"; item: ProfileItem; origin: "user" | "plugin"; skill: ScannedSkill }
  | { kind: "command"; item: ProfileItem; origin: "user" | "plugin"; command: ScannedCommand }
  | { kind: "command"; item: ProfileItem; origin: "stash"; name: string; stash: StashEntry }
  | { kind: "hook"; item: ProfileItem; origin: "settings"; hook: SettingsHook }
  | { kind: "hook"; item: ProfileItem; origin: "stash"; fragment: HookFragment }
  | { kind: "plugin"; item: ProfileItem; plugin: InstalledPlugin; manifest: Record<string, unknown> | null; provides: PluginProvides }
  | { kind: "marketplace"; item: ProfileItem; name: string; known?: KnownMarketplace; declared?: Record<string, unknown> };

interface LoadedState {
  settings: SettingsDoc | null;
  settingsError?: string;
  claudeJson: ClaudeJsonDoc | null;
  claudeJsonError?: string;
  plugins: InstalledPlugin[];
  marketplaces: KnownMarketplace[];
  entries: Map<string, Entry>;
  /**
   * Stashed items whose id a live item took meanwhile (the same hook re-added,
   * a new file at the command's path): not listed, but a toggle carrying their
   * revision answers `STASH_CONFLICT` rather than a bare conflict.
   */
  shadowed: Map<string, Entry>;
  fileErrors: ProfileFileError[];
}

export interface ClaudeProfileAdapterDeps {
  backups: ProfileBackups;
  stash: ProfileStash;
  runCli?: typeof runAgentCliOrThrow;
}

export class ClaudeProfileAdapter implements ProfileAdapter {
  readonly agent = "claude" as const;
  private readonly backups: ProfileBackups;
  private readonly stash: ProfileStash;
  private readonly runCli: typeof runAgentCliOrThrow;
  private readonly secrets = new SecretDigester();

  constructor(
    private readonly ctx: ProfileAdapterContext,
    deps: ClaudeProfileAdapterDeps
  ) {
    this.backups = deps.backups;
    this.stash = deps.stash;
    this.runCli = deps.runCli ?? runAgentCliOrThrow;
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private get settingsPath(): string {
    return join(this.ctx.homes.claudeDir, "settings.json");
  }
  private get instructionsPath(): string {
    return join(this.ctx.homes.claudeDir, "CLAUDE.md");
  }
  private get skillsRoot(): string {
    return join(this.ctx.homes.claudeDir, "skills");
  }
  private get commandsRoot(): string {
    return join(this.ctx.homes.claudeDir, "commands");
  }
  private get installedPluginsPath(): string {
    return join(this.ctx.homes.claudeDir, "plugins", "installed_plugins.json");
  }
  private get knownMarketplacesPath(): string {
    return join(this.ctx.homes.claudeDir, "plugins", "known_marketplaces.json");
  }
  private get writeOptions(): { backups: ProfileBackups; agent: string } {
    return { backups: this.backups, agent: AGENT };
  }

  watchPaths(): string[] {
    return [
      this.ctx.homes.claudeJson,
      this.settingsPath,
      this.instructionsPath,
      this.skillsRoot,
      this.commandsRoot,
      this.installedPluginsPath,
      this.knownMarketplacesPath,
      join(this.stash.dir, AGENT)
    ];
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async snapshot(): Promise<AdapterSnapshot> {
    const state = await this.load();
    const instructions = await this.tolerant(
      state,
      this.instructionsPath,
      { path: this.instructionsPath, exists: false, bytes: 0, lines: 0, revision: "", warnings: [] },
      async () => (await this.readInstructions()).info
    );
    return {
      instructions,
      items: [...state.entries.values()].map((entry) => entry.item),
      fileErrors: state.fileErrors
    };
  }

  /** Runs one part of a read; a failure (EACCES, EIO, …) becomes a `fileErrors` entry and `fallback`. */
  private async tolerant<T>(state: LoadedState, path: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      state.fileErrors.push({ path, message: message(error) });
      return fallback;
    }
  }

  /** Reads a JSON file tolerantly: missing → `null`; unreadable → `null` plus a `fileErrors` entry. */
  private async readParsed<T>(
    path: string,
    parse: (text: string) => T,
    fileErrors: ProfileFileError[]
  ): Promise<{ value: T | null; error?: string }> {
    try {
      const text = await readTextIfExists(path);
      return { value: text === null ? null : parse(text) };
    } catch (error) {
      fileErrors.push({ path, message: message(error) });
      return { value: null, error: message(error) };
    }
  }

  private async load(): Promise<LoadedState> {
    const fileErrors: ProfileFileError[] = [];
    const settings = await this.readParsed(this.settingsPath, parseSettings, fileErrors);
    const claudeJson = await this.readParsed(
      this.ctx.homes.claudeJson,
      (text) => {
        const doc = parseClaudeJson(text);
        mcpServersOf(doc);
        return doc;
      },
      fileErrors
    );
    const plugins = await this.readParsed(this.installedPluginsPath, parseInstalledPlugins, fileErrors);
    const marketplaces = await this.readParsed(this.knownMarketplacesPath, parseKnownMarketplaces, fileErrors);
    const state: LoadedState = {
      settings: settings.value,
      ...(settings.error !== undefined ? { settingsError: settings.error } : {}),
      claudeJson: claudeJson.value,
      ...(claudeJson.error !== undefined ? { claudeJsonError: claudeJson.error } : {}),
      plugins: plugins.value ?? [],
      marketplaces: marketplaces.value ?? [],
      entries: new Map(),
      shadowed: new Map(),
      fileErrors
    };
    const pluginEntries = await this.loadPlugins(state);
    await this.loadMcp(state, pluginEntries.mcp);
    await this.loadSkills(state, pluginEntries.skills);
    for (const entry of pluginEntries.plugins) this.add(state, entry);
    this.loadMarketplaces(state);
    const stashed = await this.tolerant(state, join(this.stash.dir, AGENT), [], () => this.stash.list(AGENT));
    this.loadHooks(state, stashed);
    await this.loadCommands(state, pluginEntries.commands, stashed);
    return state;
  }

  private add(state: LoadedState, entry: Entry): void {
    if (state.entries.has(entry.item.id)) {
      this.ctx.logger.warn(`agent-profile claude: skipping a second item with id ${entry.item.id}`);
      return;
    }
    state.entries.set(entry.item.id, entry);
  }

  private item(
    fields: Omit<ProfileItem, "revision" | "warnings" | "locked"> & { warnings?: ProfileItem["warnings"]; locked?: boolean },
    content: unknown
  ): ProfileItem {
    const { warnings, locked, ...rest } = fields;
    return {
      ...rest,
      locked: locked ?? false,
      warnings: warnings ?? [],
      revision: contentHash({ content, enabled: fields.enabled })
    };
  }

  private mcpRevisionContent(def: Record<string, unknown>): unknown {
    return this.secrets.masked(def);
  }

  private async loadMcp(state: LoadedState, pluginMcp: Entry[]): Promise<void> {
    const servers = state.claudeJson === null ? {} : mcpServersOf(state.claudeJson);
    for (const [name, def] of Object.entries(servers)) {
      if (!isRecord(def)) continue;
      const enabled = !isMcpDenied(state.settings, name);
      const transport = mcpTransportOf(def);
      const target = mcpTarget(def);
      const warnings: ProfileItem["warnings"] = [];
      if (transport === null) {
        warnings.push({ code: "unsupported-transport", message: `Transport "${String(def.type)}" cannot be edited here.` });
      }
      this.add(state, {
        kind: "mcp",
        origin: "user",
        name,
        def,
        item: this.item(
          {
            id: itemId("mcp", name),
            kind: "mcp",
            name,
            enabled,
            toggleable: true,
            editable: transport !== null,
            deletable: true,
            source: USER_SOURCE,
            path: this.ctx.homes.claudeJson,
            warnings,
            meta: {
              transport: transport ?? String(def.type),
              ...(target !== undefined ? { target } : {}),
              offNote: `Turning it off adds it to deniedMcpServers in settings.json, which also blocks a project MCP server named "${name}".`
            }
          },
          this.mcpRevisionContent(def)
        )
      });
    }
    for (const entry of pluginMcp) this.add(state, entry);
  }

  private async loadSkills(state: LoadedState, pluginSkills: Entry[]): Promise<void> {
    for (const skill of await this.tolerant(state, this.skillsRoot, [], () => scanSkills(this.skillsRoot))) {
      if (skill.name === SYNCED_DIR) continue;
      const override = skillOverride(state.settings, skill.name);
      const enabled = override !== "off";
      const warnings: ProfileItem["warnings"] = [];
      if (skill.error !== undefined) {
        warnings.push({ code: "unreadable", message: skill.error, action: "open-file" });
        state.fileErrors.push({ path: skill.skillFile, message: skill.error });
      }
      const text = skill.error === undefined ? await readTextIfExists(skill.skillFile).catch(() => null) : null;
      this.add(state, {
        kind: "skill",
        origin: "user",
        skill,
        item: this.item(
          {
            id: itemId("skill", skill.name),
            kind: "skill",
            name: skill.name,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            enabled,
            toggleable: true,
            editable: skill.error === undefined,
            deletable: true,
            source: USER_SOURCE,
            path: skill.dir,
            warnings,
            meta: {
              ...(skill.isSymlink ? { symlink: "true" } : {}),
              ...(override !== undefined && override !== "off" && override !== "on" ? { override } : {})
            }
          },
          { text, error: skill.error ?? null }
        )
      });
    }
    for (const entry of pluginSkills) this.add(state, entry);
  }

  /** Plugin items plus what each ships (skills, commands, MCP servers), so the other loaders can place them. */
  private async loadPlugins(state: LoadedState): Promise<{ plugins: Entry[]; skills: Entry[]; commands: Entry[]; mcp: Entry[] }> {
    const out = { plugins: [] as Entry[], skills: [] as Entry[], commands: [] as Entry[], mcp: [] as Entry[] };
    for (const plugin of state.plugins) {
      const read = await this.tolerant(state, plugin.installPath, null, async () => {
        if (!(await pluginCachePresent(plugin.installPath))) return null;
        const manifest = await readPluginManifest(plugin.installPath);
        const skills = await scanSkills(join(plugin.installPath, "skills"));
        const commands = await scanCommands(join(plugin.installPath, "commands"), { nested: true });
        const mcp = await readPluginMcpServers(plugin.installPath, manifest);
        const provides = await pluginProvides(plugin.installPath, {
          skills: skills.length,
          commands: commands.length,
          mcpServers: Object.keys(mcp).length
        });
        return { manifest, skills, commands, mcp, provides };
      });
      const present = read !== null;
      const { manifest, skills, commands, mcp, provides } = read ?? { manifest: null, skills: [], commands: [], mcp: {}, provides: {} };
      const enabled = isPluginEnabled(state.settings, plugin.id, manifest?.defaultEnabled);
      const source = pluginSource(plugin);
      const readOnly = { toggleable: false, editable: false, deletable: false, source, enabled };
      for (const skill of skills) {
        const name = `${plugin.name}:${skill.name}`;
        out.skills.push({
          kind: "skill",
          origin: "plugin",
          skill,
          item: this.item(
            {
              id: itemId("skill", name),
              kind: "skill",
              name,
              ...(skill.description !== undefined ? { description: skill.description } : {}),
              ...readOnly,
              path: skill.dir
            },
            { plugin: plugin.id, frontmatter: skill.frontmatter }
          )
        });
      }
      for (const command of commands) {
        const name = `${plugin.name}:${command.name}`;
        out.commands.push({
          kind: "command",
          origin: "plugin",
          command,
          item: this.item(
            {
              id: itemId("command", name),
              kind: "command",
              name,
              ...(command.description !== undefined ? { description: command.description } : {}),
              ...readOnly,
              path: command.file
            },
            { plugin: plugin.id, frontmatter: command.frontmatter }
          )
        });
      }
      for (const [server, def] of Object.entries(mcp)) {
        const name = `plugin:${plugin.name}:${server}`;
        const target = mcpTarget(def);
        out.mcp.push({
          kind: "mcp",
          origin: "plugin",
          name: server,
          def,
          item: this.item(
            {
              id: itemId("mcp", name),
              kind: "mcp",
              name,
              ...readOnly,
              path: plugin.installPath,
              meta: { transport: mcpTransportOf(def) ?? String(def.type), ...(target !== undefined ? { target } : {}) }
            },
            { plugin: plugin.id, def: this.mcpRevisionContent(def) }
          )
        });
      }
      const warnings: ProfileItem["warnings"] = present
        ? []
        : [{ code: "plugin-cache-missing", message: `Plugin cache missing at ${plugin.installPath}; reinstall it.` }];
      const description = typeof manifest?.description === "string" ? manifest.description : undefined;
      const version = typeof manifest?.version === "string" ? manifest.version : plugin.version;
      out.plugins.push({
        kind: "plugin",
        plugin,
        manifest,
        provides,
        item: this.item(
          {
            id: itemId("plugin", plugin.id),
            kind: "plugin",
            name: plugin.id,
            ...(description !== undefined ? { description } : {}),
            enabled,
            toggleable: true,
            editable: false,
            deletable: true,
            source: USER_SOURCE,
            path: plugin.installPath,
            warnings,
            meta: {
              ...(version !== undefined ? { version } : {}),
              ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {})
            }
          },
          { installPath: plugin.installPath, version: plugin.version ?? null }
        )
      });
    }
    return out;
  }

  private loadMarketplaces(state: LoadedState): void {
    const declared = isRecord(state.settings?.extraKnownMarketplaces) ? state.settings.extraKnownMarketplaces : {};
    const names = new Set([...state.marketplaces.map((m) => m.name), ...Object.keys(declared)]);
    for (const name of [...names].sort()) {
      const known = state.marketplaces.find((m) => m.name === name);
      const declaredEntry = isRecord(declared[name]) ? declared[name] : undefined;
      const rawSource = known?.source ?? (isRecord(declaredEntry?.source) ? declaredEntry.source : {});
      const plugins = state.plugins.filter((p) => p.marketplace === name).length;
      this.add(state, {
        kind: "marketplace",
        name,
        ...(known !== undefined ? { known } : {}),
        ...(declaredEntry !== undefined ? { declared: declaredEntry } : {}),
        item: this.item(
          {
            id: itemId("marketplace", name),
            kind: "marketplace",
            name,
            enabled: true,
            toggleable: false,
            editable: false,
            deletable: true,
            source: USER_SOURCE,
            ...(known?.installLocation !== undefined ? { path: known.installLocation } : {}),
            warnings:
              known === undefined
                ? [{ code: "not-cloned", message: "Declared in settings.json but not fetched yet; Claude fetches it at its next start." }]
                : [],
            meta: { source: marketplaceSourceArg(toMarketplaceSource(rawSource)), installedPlugins: String(plugins) }
          },
          { source: rawSource, installLocation: known?.installLocation ?? null, declared: declaredEntry !== undefined }
        )
      });
    }
  }

  private hookItem(
    event: string,
    matcher: string | null,
    handler: Record<string, unknown>,
    options: { id: string; enabled: boolean; managed: boolean; stashed: boolean; path: string }
  ): ProfileItem {
    const type = typeof handler.type === "string" ? handler.type : "command";
    const command = typeof handler.command === "string" ? handler.command : undefined;
    const locked = options.managed;
    return this.item(
      {
        id: options.id,
        kind: "hook",
        name: command ?? `${type} hook`,
        description: matcher === null ? event : `${event} · ${matcher}`,
        enabled: options.enabled,
        toggleable: !locked,
        // Only command handlers fit the editor; stashed ones are edited after turning them back on.
        editable: !locked && !options.stashed && type === "command",
        deletable: !locked,
        locked,
        source: locked ? ORQUESTER_SOURCE : USER_SOURCE,
        path: options.path,
        ...(options.stashed ? { stashed: true } : {}),
        meta: { event, type, ...(matcher !== null ? { matcher } : {}) }
      },
      { event, matcher, handler }
    );
  }

  private loadHooks(state: LoadedState, stashed: StashEntry[]): void {
    for (const hook of listSettingsHooks(state.settings)) {
      const existing = state.entries.get(hook.id);
      if (existing !== undefined) {
        existing.item.warnings.push({ code: "duplicate", message: "The same hook is listed more than once in settings.json." });
        continue;
      }
      this.add(state, {
        kind: "hook",
        origin: "settings",
        hook,
        item: this.hookItem(hook.event, hook.matcher, hook.handler, {
          id: hook.id,
          enabled: true,
          managed: hook.managed,
          stashed: false,
          path: this.settingsPath
        })
      });
    }
    for (const entry of stashed) {
      if (entry.kind !== "hook") continue;
      const fragment = parseHookFragment(entry.original.type === "fragment" ? entry.original.data : null);
      if (fragment === null) {
        this.ctx.logger.warn(`agent-profile claude: stashed hook ${entry.dir} has no usable fragment`);
        continue;
      }
      const stashedEntry: Entry = {
        kind: "hook",
        origin: "stash",
        fragment,
        item: this.hookItem(fragment.event, fragment.matcher, fragment.handler, {
          id: entry.id,
          enabled: false,
          managed: false,
          stashed: true,
          path: entry.dir
        })
      };
      const live = state.entries.get(entry.id);
      if (live !== undefined) {
        live.item.warnings.push({ code: "stashed-copy", message: "A turned-off copy of this hook is also stashed." });
        state.shadowed.set(entry.id, stashedEntry);
        continue;
      }
      this.add(state, stashedEntry);
    }
  }

  private async loadCommands(state: LoadedState, pluginCommands: Entry[], stashed: StashEntry[]): Promise<void> {
    const commands = await this.tolerant(state, this.commandsRoot, [], () => scanCommands(this.commandsRoot, { nested: true }));
    for (const command of commands) {
      const warnings: ProfileItem["warnings"] = [];
      if (command.error !== undefined) {
        warnings.push({ code: "unreadable", message: command.error, action: "open-file" });
        state.fileErrors.push({ path: command.file, message: command.error });
      }
      const text = command.error === undefined ? await readTextIfExists(command.file).catch(() => null) : null;
      this.add(state, {
        kind: "command",
        origin: "user",
        command,
        item: this.item(
          {
            id: itemId("command", command.name),
            kind: "command",
            name: command.name,
            ...(command.description !== undefined ? { description: command.description } : {}),
            enabled: true,
            toggleable: true,
            editable: command.error === undefined,
            deletable: true,
            source: USER_SOURCE,
            path: command.file,
            warnings
          },
          { text, error: command.error ?? null }
        )
      });
    }
    for (const entry of stashed) {
      if (entry.kind !== "command" || entry.payloadPath === null) continue;
      const text = await readTextIfExists(entry.payloadPath).catch(() => null);
      let description: string | undefined;
      try {
        const value = text === null ? undefined : parseMarkdownDocument(text).frontmatter.description;
        description = typeof value === "string" && value.trim() ? value.trim() : undefined;
      } catch {
        description = undefined;
      }
      const stashedEntry: Entry = {
        kind: "command",
        origin: "stash",
        name: entry.name,
        stash: entry,
        item: this.item(
          {
            id: entry.id,
            kind: "command",
            name: entry.name,
            ...(description !== undefined ? { description } : {}),
            enabled: false,
            toggleable: true,
            editable: false,
            deletable: true,
            stashed: true,
            source: USER_SOURCE,
            path: entry.payloadPath
          },
          { text, error: null }
        )
      };
      const live = state.entries.get(entry.id);
      if (live !== undefined) {
        live.item.warnings.push({
          code: "stashed-copy",
          message: "A turned-off copy with the same name is stashed; delete this one to get it back."
        });
        state.shadowed.set(entry.id, stashedEntry);
        continue;
      }
      this.add(state, stashedEntry);
    }
    for (const entry of pluginCommands) this.add(state, entry);
  }

  async readItem(id: string): Promise<ProfileItemDetail> {
    const state = await this.load();
    const entry = this.find(state, id);
    switch (entry.kind) {
      case "mcp":
        return { kind: "mcp", item: entry.item, mcp: mcpView(entry.item.name, entry.def) };
      case "skill": {
        const document = await this.readDocument(entry.skill.skillFile);
        return { kind: "skill", item: entry.item, document, files: await readSkillFiles(entry.skill.dir) };
      }
      case "command": {
        const file = entry.origin === "stash" ? entry.stash.payloadPath! : entry.command.file;
        return { kind: "command", item: entry.item, document: await this.readDocument(file) };
      }
      case "hook": {
        const { event, matcher, handler } = entry.origin === "settings" ? entry.hook : entry.fragment;
        return {
          kind: "hook",
          item: entry.item,
          hook: {
            event,
            ...(matcher !== null ? { matcher } : {}),
            command: typeof handler.command === "string" ? handler.command : "",
            ...(typeof handler.timeout === "number" ? { timeoutSec: handler.timeout } : {})
          }
        };
      }
      case "plugin": {
        const version = typeof entry.manifest?.version === "string" ? entry.manifest.version : entry.plugin.version;
        const description = typeof entry.manifest?.description === "string" ? entry.manifest.description : undefined;
        return {
          kind: "plugin",
          item: entry.item,
          plugin: {
            id: entry.plugin.id,
            name: entry.plugin.name,
            ...(entry.plugin.marketplace ? { marketplace: entry.plugin.marketplace } : {}),
            ...(version !== undefined ? { version } : {}),
            ...(description !== undefined ? { description } : {}),
            provides: entry.provides
          }
        };
      }
      case "marketplace": {
        const rawSource = entry.known?.source ?? (isRecord(entry.declared?.source) ? entry.declared.source : {});
        return {
          kind: "marketplace",
          item: entry.item,
          marketplace: {
            name: entry.name,
            source: toMarketplaceSource(rawSource),
            pluginCount: state.plugins.filter((p) => p.marketplace === entry.name).length
          }
        };
      }
    }
  }

  private async readDocument(file: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    const text = await readTextIfExists(file);
    if (text === null) {
      throw profileErrors.notFound(file);
    }
    try {
      const { frontmatter, body } = parseMarkdownDocument(text);
      return { frontmatter, body };
    } catch (error) {
      throw profileErrors.unreadable(file, message(error));
    }
  }

  private find(state: LoadedState, id: string): Entry {
    const entry = state.entries.get(id);
    if (entry === undefined) {
      throw profileErrors.notFound(id);
    }
    return entry;
  }

  /** The entry for a mutation: found, not locked, capable of `need`, and still at `revision`. */
  private async target(
    id: string,
    revision: string,
    need: "edit" | "toggle" | "delete"
  ): Promise<{ state: LoadedState; entry: Entry }> {
    const state = await this.load();
    const entry = this.find(state, id);
    const { item } = entry;
    if (item.locked) throw profileErrors.locked(item.name);
    if (need === "edit" && !item.editable) throw profileErrors.notEditable(item.name);
    if (need === "toggle" && !item.toggleable) throw profileErrors.notToggleable(item.name);
    if (need === "delete" && !item.deletable) throw profileErrors.notDeletable(item.name);
    if (item.revision !== revision) {
      const shadow = state.shadowed.get(id);
      if (need === "toggle" && shadow !== undefined && shadow.item.revision === revision) {
        throw profileErrors.stashConflict(item.path ?? id);
      }
      throw profileErrors.conflict();
    }
    return { state, entry };
  }

  private requireSettings(state: LoadedState): void {
    if (state.settingsError !== undefined) {
      throw profileErrors.unreadable(this.settingsPath, state.settingsError);
    }
  }

  private requireClaudeJson(state: LoadedState): void {
    if (state.claudeJsonError !== undefined) {
      throw profileErrors.unreadable(this.ctx.homes.claudeJson, state.claudeJsonError);
    }
  }

  private patchSettings<T>(mutate: (doc: SettingsDoc) => T): Promise<T> {
    return patchSettingsFile(this.settingsPath, mutate, this.writeOptions);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    if (!isRecord(draft)) throw profileErrors.invalid("A draft is required.");
    switch (draft.kind) {
      case "mcp":
        if (!isRecord(draft.mcp)) throw profileErrors.invalid("The MCP server draft is missing.");
        return this.createMcp(draft.mcp.name, (existing) => definitionFromDraft(draft.mcp, existing), options.onConflict);
      case "skill":
        return this.createSkill(requireDocument(draft.document), options.onConflict);
      case "command":
        return this.createCommand(requireDocument(draft.document), options.onConflict);
      case "hook":
        return this.createHook(draft.hook, options.onConflict);
      case "plugin":
        return this.installPlugin(draft.plugin, options.onConflict);
      case "marketplace":
        return this.addMarketplace(draft.marketplace);
      default:
        throw profileErrors.kindNotSupported(LABEL, String((draft as { kind?: unknown }).kind));
    }
  }

  private async createMcp(
    name: string,
    build: (existing: Record<string, unknown> | undefined) => Record<string, unknown>,
    onConflict: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    assertMcpServerName(name);
    const state = await this.load();
    this.requireClaudeJson(state);
    const created = await updateClaudeJsonMcpServers(
      this.ctx.homes.claudeJson,
      (servers) => {
        let target = name;
        let existing: Record<string, unknown> | undefined;
        if (target in servers) {
          if (onConflict === "fail") throw profileErrors.exists(name);
          if (onConflict === "keep-both") {
            target = uniqueName(name, (candidate) => candidate in servers);
          } else {
            const current = servers[target];
            existing = isRecord(current) ? current : undefined;
          }
        }
        servers[target] = build(existing);
        return target;
      },
      this.writeOptions
    );
    const notes: string[] = [];
    if (isMcpDenied(state.settings, created)) {
      notes.push(`"${created}" is listed in deniedMcpServers, so it stays off until you turn it on.`);
    }
    return { itemIds: [itemId("mcp", created)], notes };
  }

  private async createSkill(document: MarkdownDocumentDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    const target = await this.claimSkillName(document.name, onConflict);
    await writeSkill(this.skillsRoot, { ...document, name: target }, { ...this.writeOptions, mergeExisting: false });
    return { itemIds: [itemId("skill", target)], notes: [] };
  }

  /** The directory name a new skill lands in, per `onConflict`; "replace" removes the old directory (backed up). */
  private async claimSkillName(name: string, onConflict: ProfileConflictPolicy): Promise<string> {
    assertSkillName(name);
    assertSafeSegment(name);
    if (name === SYNCED_DIR) {
      throw profileErrors.invalidName(`"${SYNCED_DIR}" is Claude's own directory under skills/.`);
    }
    const taken = async (candidate: string): Promise<boolean> =>
      candidate === SYNCED_DIR || (await pathKind(join(this.skillsRoot, candidate))) !== null;
    if (!(await taken(name))) return name;
    if (onConflict === "fail") throw profileErrors.exists(name);
    if (onConflict === "keep-both") return uniqueNameAsync(name, taken);
    await removeProfilePath(join(this.skillsRoot, name), this.writeOptions);
    return name;
  }

  private commandFile(name: string): string {
    assertCommandName(name);
    const segments = name.split("/");
    segments.forEach(assertSafeSegment);
    return `${join(this.commandsRoot, ...segments)}.md`;
  }

  /** The command name a new command takes, per `onConflict`; "replace" removes the file and any stashed copy. */
  private async claimCommandName(name: string, onConflict: ProfileConflictPolicy): Promise<string> {
    const taken = async (candidate: string): Promise<boolean> =>
      (await pathKind(this.commandFile(candidate))) !== null ||
      (await this.stash.get(AGENT, "command", itemId("command", candidate))) !== null;
    this.commandFile(name);
    if (!(await taken(name))) return name;
    if (onConflict === "fail") throw profileErrors.exists(name);
    if (onConflict === "keep-both") return uniqueNameAsync(name, taken);
    await removeProfilePath(this.commandFile(name), this.writeOptions);
    await this.stash.remove(AGENT, "command", itemId("command", name));
    return name;
  }

  private async createCommand(document: MarkdownDocumentDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    const target = await this.claimCommandName(document.name, onConflict);
    await writeCommand(this.commandsRoot, { ...document, name: target }, { ...this.writeOptions, mergeExisting: false });
    return { itemIds: [itemId("command", target)], notes: [] };
  }

  private async createHook(draft: HookDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    const fragment = hookFragmentFromDraft(draft, {});
    const id = claudeHookId(fragment.event, fragment.matcher, fragment.handler);
    const state = await this.load();
    this.requireSettings(state);
    if (state.entries.has(id)) {
      if (onConflict === "replace") return { itemIds: [id], notes: [] };
      throw profileErrors.exists(String(fragment.handler.command));
    }
    await this.patchSettings((doc) => insertSettingsHook(doc, fragment));
    return { itemIds: [id], notes: [] };
  }

  private async cli(args: string[], label: string, timeoutMs = CLI_TIMEOUT_MS): Promise<void> {
    if (this.ctx.bin === null) {
      throw profileErrors.notInstalled(LABEL);
    }
    const home = this.ctx.homes.home;
    await this.runCli({ bin: this.ctx.bin, args, timeoutMs, cwd: home, env: { HOME: home }, label, redact: { homeDirs: [home] } });
  }

  private async installPlugin(draft: PluginInstallDraft, onConflict: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isRecord(draft) || !("plugin" in draft)) {
      throw profileErrors.invalid("Claude installs plugins from a marketplace: pick a marketplace and a plugin.");
    }
    assertCliName(draft.plugin, "plugin");
    assertCliName(draft.marketplace, "marketplace");
    const pluginId = `${draft.plugin}@${draft.marketplace}`;
    const id = itemId("plugin", pluginId);
    const state = await this.load();
    if (state.entries.has(id) && onConflict !== "replace") {
      throw profileErrors.exists(pluginId);
    }
    await this.cli(["plugin", "install", pluginId, "--scope", "user"], "claude plugin install", INSTALL_TIMEOUT_MS);
    return { itemIds: [id], notes: ["Applies to new Claude sessions."] };
  }

  private async addMarketplace(draft: MarketplaceDraft): Promise<AdapterMutationResult> {
    if (!isRecord(draft) || !isRecord(draft.source)) {
      throw profileErrors.invalid("A marketplace source is required.");
    }
    const arg = marketplaceSourceArg(validateMarketplaceSource(draft.source));
    const before = new Set((await this.load()).marketplaces.map((m) => m.name));
    await this.cli(["plugin", "marketplace", "add", arg, "--scope", "user"], "claude plugin marketplace add", INSTALL_TIMEOUT_MS);
    const added = (await this.load()).marketplaces.map((m) => m.name).filter((name) => !before.has(name));
    const notes: string[] = [];
    if (typeof draft.name === "string" && draft.name.length > 0 && !added.includes(draft.name)) {
      notes.push(
        added.length > 0
          ? `Claude names a marketplace from its own manifest: it was added as "${added.join('", "')}".`
          : "Claude names a marketplace from its own manifest; the name you gave was not used."
      );
    }
    return { itemIds: added.map((name) => itemId("marketplace", name)), notes };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult> {
    const { state, entry } = await this.target(id, revision, "edit");
    if (!isRecord(draft) || draft.kind !== entry.kind) {
      throw profileErrors.invalid(`The draft must be a ${entry.kind} draft.`);
    }
    if (entry.kind === "mcp" && entry.origin === "user" && draft.kind === "mcp") {
      return this.updateMcp(state, entry.name, revision, draft.mcp);
    }
    if (entry.kind === "skill" && entry.origin === "user" && draft.kind === "skill") {
      return this.updateSkill(state, entry.skill, requireDocument(draft.document));
    }
    if (entry.kind === "command" && entry.origin === "user" && draft.kind === "command") {
      return this.updateCommand(entry.command, requireDocument(draft.document));
    }
    if (entry.kind === "hook" && entry.origin === "settings" && draft.kind === "hook") {
      return this.updateHook(state, entry.hook, draft.hook);
    }
    throw profileErrors.notEditable(entry.item.name);
  }

  private async updateMcp(
    state: LoadedState,
    name: string,
    revision: string,
    draft: McpServerDraft
  ): Promise<AdapterMutationResult> {
    if (!isRecord(draft)) throw profileErrors.invalid("The MCP server draft is missing.");
    this.requireClaudeJson(state);
    const nextName = draft.name;
    assertMcpServerName(nextName);
    const enabled = !isMcpDenied(state.settings, name);
    await updateClaudeJsonMcpServers(
      this.ctx.homes.claudeJson,
      (servers) => {
        const current = servers[name];
        // The lock's fresh copy must still be what the owner edited.
        if (!isRecord(current) || contentHash({ content: this.mcpRevisionContent(current), enabled }) !== revision) {
          throw profileErrors.conflict();
        }
        if (nextName !== name && nextName in servers) throw profileErrors.exists(nextName);
        const def = definitionFromDraft(draft, current);
        if (nextName === name) {
          servers[name] = def;
          return;
        }
        // Rename in place: the server keeps its position among the others.
        const entries = Object.entries(servers).map(([key, value]) => (key === name ? [nextName, def] : [key, value]));
        for (const key of Object.keys(servers)) delete servers[key];
        Object.assign(servers, Object.fromEntries(entries));
      },
      this.writeOptions
    );
    const notes: string[] = [];
    if (nextName !== name && !enabled) {
      this.requireSettings(state);
      await this.patchSettings((doc) => {
        allowMcp(doc, name);
        denyMcp(doc, nextName);
      });
      notes.push(`Its deniedMcpServers entry now names "${nextName}".`);
    }
    return { itemIds: [itemId("mcp", nextName)], notes };
  }

  private async updateSkill(state: LoadedState, skill: ScannedSkill, document: MarkdownDocumentDraft): Promise<AdapterMutationResult> {
    let name = skill.name;
    if (document.name !== skill.name) {
      assertSkillName(document.name);
      assertSafeSegment(document.name);
      if (document.name === SYNCED_DIR || (await pathKind(join(this.skillsRoot, document.name))) !== null) {
        throw profileErrors.exists(document.name);
      }
      const override = skillOverride(state.settings, skill.name);
      if (override !== undefined) this.requireSettings(state);
      // A rename loses nothing (a symlinked skill renames its link), so no backup is taken.
      await rename(skill.dir, join(this.skillsRoot, document.name));
      name = document.name;
      if (override !== undefined) {
        await this.patchSettings((doc) => {
          const overrides = isRecord(doc.skillOverrides) ? { ...doc.skillOverrides } : {};
          delete overrides[skill.name];
          overrides[name] = override;
          doc.skillOverrides = overrides;
        });
      }
    }
    await writeSkill(this.skillsRoot, { ...document, name }, this.writeOptions);
    return { itemIds: [itemId("skill", name)], notes: [] };
  }

  private async updateCommand(command: ScannedCommand, document: MarkdownDocumentDraft): Promise<AdapterMutationResult> {
    if (document.name !== command.name) {
      const next = this.commandFile(document.name);
      if ((await pathKind(next)) !== null || (await this.stash.get(AGENT, "command", itemId("command", document.name))) !== null) {
        throw profileErrors.exists(document.name);
      }
      await mkdir(join(next, ".."), { recursive: true });
      await rename(command.file, next);
    }
    await writeCommand(this.commandsRoot, document, this.writeOptions);
    return { itemIds: [itemId("command", document.name)], notes: [] };
  }

  private async updateHook(state: LoadedState, hook: SettingsHook, draft: HookDraft): Promise<AdapterMutationResult> {
    this.requireSettings(state);
    const fragment = hookFragmentFromDraft(draft, hook.handler, hook.event);
    const nextId = claudeHookId(fragment.event, fragment.matcher, fragment.handler);
    if (nextId === hook.id) return { itemIds: [hook.id], notes: [] };
    if (state.entries.has(nextId)) throw profileErrors.exists(String(fragment.handler.command));
    await this.patchSettings((doc) => {
      if (fragment.event === hook.event && fragment.matcher === hook.matcher) {
        if (!replaceSettingsHook(doc, hook.id, fragment.handler)) throw profileErrors.conflict();
        return;
      }
      if (!removeSettingsHook(doc, hook.id)) throw profileErrors.conflict();
      insertSettingsHook(doc, fragment);
    });
    return { itemIds: [nextId], notes: [] };
  }

  // -------------------------------------------------------------------------
  // On / off
  // -------------------------------------------------------------------------

  async setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult> {
    const { state, entry } = await this.target(id, revision, "toggle");
    const done: AdapterMutationResult = { itemIds: [id], notes: [] };
    if (entry.item.enabled === enabled) return done;
    switch (entry.kind) {
      case "mcp":
        this.requireSettings(state);
        await this.patchSettings((doc) => (enabled ? allowMcp(doc, entry.name) : denyMcp(doc, entry.name)));
        if (!enabled) {
          done.notes.push(`deniedMcpServers now lists "${entry.name}"; that also blocks a project MCP server with this name.`);
        }
        return done;
      case "skill":
        this.requireSettings(state);
        await this.patchSettings((doc) => setSkillOverride(doc, entry.skill.name, enabled));
        return done;
      case "plugin":
        this.requireSettings(state);
        await this.patchSettings((doc) => setPluginEnabled(doc, entry.plugin.id, enabled));
        done.notes.push("Applies to new Claude sessions.");
        return done;
      case "hook":
        this.requireSettings(state);
        if (entry.origin === "settings") {
          await this.stashHook(entry.hook);
        } else {
          await this.restoreHook(id, entry.fragment);
        }
        return done;
      case "command":
        if (entry.origin === "user") {
          await this.stash.stashPath(AGENT, "command", id, entry.command.name, entry.command.file, {
            ...(entry.item.description !== undefined ? { description: entry.item.description } : {})
          });
        } else if (entry.origin === "stash") {
          await this.stash.restorePath(AGENT, "command", id);
        }
        return done;
      case "marketplace":
        throw profileErrors.notToggleable(entry.item.name);
    }
  }

  private async stashHook(hook: SettingsHook): Promise<void> {
    const fragment: HookFragment = { event: hook.event, matcher: hook.matcher, handler: hook.handler };
    const name = typeof hook.handler.command === "string" ? hook.handler.command : hook.event;
    await this.stash.stashFragment(AGENT, "hook", hook.id, name, fragment);
    try {
      const removed = await this.patchSettings((doc) => removeSettingsHook(doc, hook.id));
      if (!removed) throw profileErrors.conflict();
    } catch (error) {
      await this.stash.remove(AGENT, "hook", hook.id);
      throw error;
    }
  }

  private async restoreHook(id: string, fragment: HookFragment): Promise<void> {
    // get → write → remove: a failed write leaves the stash entry in place.
    await this.patchSettings((doc) => {
      if (listSettingsHooks(doc).some((hook) => hook.id === id)) {
        throw profileErrors.stashConflict(`${this.settingsPath} (hooks.${fragment.event})`);
      }
      insertSettingsHook(doc, fragment);
    });
    await this.stash.remove(AGENT, "hook", id);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async remove(id: string, revision: string): Promise<AdapterMutationResult> {
    const { state, entry } = await this.target(id, revision, "delete");
    const done: AdapterMutationResult = { itemIds: [id], notes: [] };
    switch (entry.kind) {
      case "mcp": {
        this.requireClaudeJson(state);
        const enabled = entry.item.enabled;
        await updateClaudeJsonMcpServers(
          this.ctx.homes.claudeJson,
          (servers) => {
            const current = servers[entry.name];
            if (!isRecord(current) || contentHash({ content: this.mcpRevisionContent(current), enabled }) !== revision) {
              throw profileErrors.conflict();
            }
            delete servers[entry.name];
          },
          this.writeOptions
        );
        if (!enabled && state.settingsError === undefined) {
          await this.patchSettings((doc) => allowMcp(doc, entry.name));
          done.notes.push(`Its deniedMcpServers entry was removed too.`);
        }
        return done;
      }
      case "skill":
        await removeProfilePath(entry.skill.dir, this.writeOptions);
        if (skillOverride(state.settings, entry.skill.name) !== undefined && state.settingsError === undefined) {
          await this.patchSettings((doc) => setSkillOverride(doc, entry.skill.name, true));
        }
        return done;
      case "command":
        if (entry.origin === "stash") {
          await this.stash.remove(AGENT, "command", id);
        } else if (entry.origin === "user") {
          await removeProfilePath(entry.command.file, this.writeOptions);
        }
        return done;
      case "hook":
        if (entry.origin === "stash") {
          await this.stash.remove(AGENT, "hook", id);
        } else {
          this.requireSettings(state);
          const removed = await this.patchSettings((doc) => removeSettingsHook(doc, id));
          if (!removed) throw profileErrors.conflict();
        }
        return done;
      case "plugin":
        assertCliName(entry.plugin.name, "plugin");
        assertCliName(entry.plugin.marketplace, "marketplace");
        await this.cli(["plugin", "uninstall", entry.plugin.id, "--scope", "user"], "claude plugin uninstall");
        done.notes.push("Applies to new Claude sessions.");
        return done;
      case "marketplace": {
        assertCliName(entry.name, "marketplace");
        const plugins = state.plugins.filter((p) => p.marketplace === entry.name).map((p) => p.name);
        // No --scope: the declaration is removed from every scope Claude reads from the home.
        await this.cli(["plugin", "marketplace", "remove", entry.name], "claude plugin marketplace remove");
        if (plugins.length > 0) {
          done.notes.push(`Removing a marketplace also uninstalls its plugins: ${plugins.join(", ")}.`);
        }
        return done;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Instructions
  // -------------------------------------------------------------------------

  async readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    const path = this.instructionsPath;
    const text = await readTextIfExists(path);
    if (text === null) {
      return { text: "", info: { path, exists: false, bytes: 0, lines: 0, revision: "", warnings: [] } };
    }
    const info: ProfileInstructionsInfo = {
      path,
      exists: true,
      bytes: Buffer.byteLength(text, "utf8"),
      lines: countLines(text),
      revision: contentHash(text),
      warnings: []
    };
    try {
      info.mtime = (await stat(path)).mtime.toISOString();
    } catch {
      // Gone between the read and the stat: the text is still what was read.
    }
    return { text, info };
  }

  async writeInstructions(text: string, revision: string): Promise<AdapterMutationResult> {
    if (typeof text !== "string") throw profileErrors.invalid("The instructions text is required.");
    const current = await readTextIfExists(this.instructionsPath);
    const currentRevision = current === null ? "" : contentHash(current);
    if (currentRevision !== revision) throw profileErrors.conflict();
    await writeProfileFile(this.instructionsPath, text, { ...this.writeOptions, defaultMode: 0o644 });
    return { itemIds: [], notes: [] };
  }

  // -------------------------------------------------------------------------
  // Marketplaces, export and import
  // -------------------------------------------------------------------------

  async listMarketplacePlugins(marketplace: string): Promise<MarketplacePluginEntry[]> {
    const state = await this.load();
    const known = state.marketplaces.find((m) => m.name === marketplace);
    if (known === undefined) throw profileErrors.notFound(itemId("marketplace", marketplace));
    if (known.installLocation === undefined) return [];
    let catalog: Awaited<ReturnType<typeof readMarketplaceCatalog>>;
    try {
      catalog = await readMarketplaceCatalog(known.installLocation);
    } catch (error) {
      throw profileErrors.unreadable(join(known.installLocation, ".claude-plugin", "marketplace.json"), message(error));
    }
    const installed = new Set(state.plugins.map((p) => p.id));
    return catalog.map((entry) => ({ ...entry, installed: installed.has(`${entry.name}@${marketplace}`) }));
  }

  async exportItem(id: string): Promise<PortableItem> {
    const state = await this.load();
    const entry = this.find(state, id);
    switch (entry.kind) {
      case "mcp":
        return { kind: "mcp", server: portableFromDefinition(entry.name, entry.def) };
      case "skill": {
        if (entry.skill.error !== undefined) throw profileErrors.unreadable(entry.skill.skillFile, entry.skill.error);
        const root = agentProfileImportsDir(this.ctx.appdir);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const tmp = await mkdtemp(join(root, "export-claude-"));
        const dir = join(tmp, entry.skill.name);
        await copyTree(entry.skill.dir, dir, { refuseSymlinks: false });
        return { kind: "skill", name: entry.skill.name, dir };
      }
      case "command": {
        const file = entry.origin === "stash" ? entry.stash.payloadPath! : entry.command.file;
        const name = entry.origin === "stash" ? entry.name : entry.command.name;
        const { frontmatter, body } = await this.readDocument(file);
        return { kind: "command", name, frontmatter, body };
      }
      default:
        throw profileErrors.invalid(`A ${entry.kind} cannot be copied to another agent.`);
    }
  }

  async importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    switch (item.kind) {
      case "mcp":
        return this.createMcp(item.server.name, () => definitionFromPortable(item.server), options.onConflict);
      case "skill": {
        const target = await this.claimSkillName(item.name, options.onConflict);
        const dir = join(this.skillsRoot, target);
        await copyTree(item.dir, dir, { refuseSymlinks: true });
        await this.alignSkillName(dir, target);
        return { itemIds: [itemId("skill", target)], notes: [] };
      }
      case "command": {
        const target = await this.claimCommandName(item.name, options.onConflict);
        await writeCommand(
          this.commandsRoot,
          { name: target, frontmatter: item.frontmatter, body: item.body },
          { ...this.writeOptions, mergeExisting: false }
        );
        return { itemIds: [itemId("command", target)], notes: [] };
      }
      default:
        throw profileErrors.kindNotSupported(LABEL, String((item as { kind?: unknown }).kind));
    }
  }

  /** A copied skill's frontmatter `name` must match its directory (a keep-both copy was renamed). */
  private async alignSkillName(dir: string, name: string): Promise<void> {
    const file = join(dir, "SKILL.md");
    const text = await readTextIfExists(file);
    if (text === null) {
      throw profileErrors.invalidItem("The skill has no SKILL.md.");
    }
    let document;
    try {
      document = parseMarkdownDocument(text);
    } catch (error) {
      throw profileErrors.invalidItem(`SKILL.md does not parse: ${message(error)}`);
    }
    if (document.frontmatter.name === name) return;
    const frontmatter = "name" in document.frontmatter ? { ...document.frontmatter, name } : { name, ...document.frontmatter };
    await writeProfileFileVerified(file, serializeMarkdownDocument(frontmatter, document.body), {
      ...this.writeOptions,
      verify: parseMarkdownDocument
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

function requireDocument(document: unknown): MarkdownDocumentDraft {
  if (
    !isRecord(document) ||
    typeof document.name !== "string" ||
    typeof document.body !== "string" ||
    (document.frontmatter !== undefined && !isRecord(document.frontmatter))
  ) {
    throw profileErrors.invalid("The document draft needs a name, frontmatter and a body.");
  }
  return { name: document.name, frontmatter: (document.frontmatter as Record<string, unknown>) ?? {}, body: document.body };
}

function assertCliName(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || !CLI_NAME.test(value)) {
    throw profileErrors.invalidName(`"${String(value)}" is not a valid ${what} name.`);
  }
}

function validateMarketplaceSource(source: Record<string, unknown>): MarketplaceSource {
  const ref = source.ref;
  if (ref !== undefined && (typeof ref !== "string" || !GIT_REF.test(ref))) {
    throw profileErrors.invalid(`"${String(ref)}" is not a valid git ref.`);
  }
  const withRef = typeof ref === "string" && ref.length > 0 ? { ref } : {};
  switch (source.type) {
    case "github":
      if (typeof source.repo !== "string" || !GITHUB_REPO.test(source.repo)) {
        throw profileErrors.invalid("A GitHub marketplace is named owner/repo.");
      }
      return { type: "github", repo: source.repo, ...withRef };
    case "git":
      if (
        typeof source.url !== "string" ||
        /\s/.test(source.url) ||
        source.url.includes("#") ||
        !/^(https?:\/\/|ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(source.url)
      ) {
        throw profileErrors.invalid("A git marketplace needs an https://, ssh:// or git@host: URL.");
      }
      return { type: "git", url: source.url, ...withRef };
    case "path":
      if (typeof source.path !== "string" || !source.path.startsWith("/") || /[\0\n\r]/.test(source.path)) {
        throw profileErrors.invalid("A local marketplace needs an absolute path.");
      }
      return { type: "path", path: source.path };
    default:
      throw profileErrors.invalid("The marketplace source must be github, git or path.");
  }
}

/** A stash fragment as written by `stashHook`; `null` when it is not one. */
function parseHookFragment(data: unknown): HookFragment | null {
  if (!isRecord(data) || typeof data.event !== "string" || !isRecord(data.handler)) return null;
  if (data.matcher !== null && data.matcher !== undefined && typeof data.matcher !== "string") return null;
  return { event: data.event, matcher: normalizeMatcher(data.matcher), handler: data.handler };
}

/**
 * The fragment a hook draft writes. `base` is the handler being edited (its
 * unknown fields, like `async` or `statusMessage`, survive); `currentEvent`
 * lets an existing hook keep an event outside the editor's list.
 */
function hookFragmentFromDraft(draft: HookDraft, base: Record<string, unknown>, currentEvent?: string): HookFragment {
  if (!isRecord(draft)) throw profileErrors.invalid("The hook draft is missing.");
  const events = PROFILE_HOOK_EVENTS.claude ?? [];
  if (typeof draft.event !== "string" || (!events.includes(draft.event) && draft.event !== currentEvent)) {
    throw profileErrors.invalidItem(`Claude has no "${String(draft.event)}" hook event. Use one of: ${events.join(", ")}.`);
  }
  if (typeof draft.command !== "string" || draft.command.trim().length === 0) {
    throw profileErrors.invalidItem("A hook needs a command.");
  }
  if (draft.matcher !== undefined && draft.matcher !== null && typeof draft.matcher !== "string") {
    throw profileErrors.invalidItem("The matcher must be text.");
  }
  const timeout = draft.timeoutSec;
  if (timeout !== undefined && timeout !== null && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    throw profileErrors.invalidItem("The timeout must be a positive number of seconds.");
  }
  const handler: Record<string, unknown> = { ...base, type: "command", command: draft.command };
  delete handler.timeout;
  if (typeof timeout === "number") handler.timeout = timeout;
  // Keep Claude's own key order for a new handler: type, command, timeout.
  const ordered: Record<string, unknown> = { type: handler.type, command: handler.command };
  if (handler.timeout !== undefined) ordered.timeout = handler.timeout;
  const handlerOut = { ...ordered, ...handler };
  const matcher = PROFILE_HOOK_EVENTS_WITHOUT_MATCHER.includes(draft.event) ? null : normalizeMatcher(draft.matcher);
  return { event: draft.event, matcher, handler: handlerOut };
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
