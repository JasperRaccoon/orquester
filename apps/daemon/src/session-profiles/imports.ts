/**
 * Agent Profiles — filling a profile (spec §4.5). Everything here gathers what an import brings
 * (outside the profile's queue: exports from Global, git clones, uploads), then hands it to ONE
 * store mutation (`store.importItems`, under the profile's queue and revision). Nothing here
 * writes a Global config or an agent's plugin directory.
 *
 * - **Import from Global** — an agent's own items through Agent config (`SessionProfileGlobalConfig`,
 *   the `AgentProfileService`): skills, commands and MCP servers exported with their real secret
 *   values (`exportItem`) and given the requested scope (default all agents); when that scope is
 *   ONE agent other than the source, frontmatter is mapped with `mapFrontmatter` and an MCP
 *   server's settings with the Agent config converter (`convert.ts`), their notes kept. Hooks
 *   (`readItem`) and plugins keep their agent. Instructions replace or append.
 * - **Git / .zip / .md** — the Agent config scan pipeline (`agent-profile/import.ts`) with the
 *   `portable` target: candidates are what the profile gets (commands stay commands); `exists` is
 *   checked against the profile; a scan can only be taken by the profile that opened it.
 * - **Copy from profile** — items of another profile with their files, plugin caches and secret
 *   values (`store.readSource`), keeping their scope and on/off state.
 * - **Plugins** — a marketplace plugin (Agent config's `pluginSource`: a folder of the
 *   marketplace's checkout, or a remote source cloned with the importer's safe `git clone`), or an
 *   installed Global plugin (OpenCode: a plugin file), copied whole into the profile's own cache
 *   (`plugins/<itemId>/`; layout in the README). Provenance (marketplace, version, commit, URL)
 *   is recorded on the item.
 * - **Export / import a profile** — `export.ts`.
 *
 * Every temp directory lives under `workDir` (Agent config's imports dir, whose import store
 * sweeps a leaked one after its TTL) and is removed when the request ends. Portable items carry
 * REAL secret values: never logged, never returned.
 */

import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  AGENT_PROFILE_AGENT_LABELS,
  type AgentProfileSnapshot,
  type CopySessionProfileItemsRequest,
  type ImportSessionProfileFromGlobalRequest,
  type ProfileImportScanResponse,
  type ProfileInstructionsResponse,
  type ProfileItem,
  type ProfileItemDetail,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileGlobalItem,
  type SessionProfileGlobalSourceResponse,
  type SessionProfileImportConflictPolicy,
  type SessionProfileItemKind,
  type SessionProfilePluginSource,
  type SessionProfilePluginSourceRequest,
  type TakeSessionProfileImportRequest
} from "@orquester/api";
import type { PluginFetchSource, PluginSourceLocation, PortableItem } from "../agent-profile/adapters/types.ts";
import { catalogPluginSource } from "../agent-profile/adapters/claude/plugins.ts";
import { createProfileConverter, droppedKeysNote, mapFrontmatter, type ProfileConverter } from "../agent-profile/convert.ts";
import { AgentProfileError, profileErrors } from "../agent-profile/errors.ts";
import { gitClone, type GitCloneFn } from "../agent-profile/import/git-clone.ts";
import { parseGitImportUrl } from "../agent-profile/import/git-url.ts";
import { parseMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";
import { copyTree } from "../agent-profile/infra/tree.ts";
import { installedPluginRoot, readGitCommit } from "../agent-profile/preview-reads.ts";
import { sessionProfileErrors as errors } from "./errors.ts";
import { buildProfileExport, exportFileName, readProfileExport } from "./export.ts";
import { measureTree, PLUGIN_TREE_CAPS } from "./files.ts";
import { profileLayout, PROFILE_SKILL_FILE } from "./layout.ts";
import type { SessionProfileImportEntry, SessionProfileStore, StoredSessionProfile } from "./store.ts";

/** What Import from Global and the plugin flow read of an agent's Global setup (`AgentProfileService`). */
export interface SessionProfileGlobalConfig {
  snapshot(agent: SessionProfileAgentId): Promise<AgentProfileSnapshot>;
  readItem(agent: SessionProfileAgentId, id: string): Promise<ProfileItemDetail>;
  readInstructions(agent: SessionProfileAgentId): Promise<ProfileInstructionsResponse>;
  /** REAL secret values; a skill's `dir` is the caller's to remove. */
  exportItem(agent: SessionProfileAgentId, id: string): Promise<PortableItem>;
  pluginSource(agent: SessionProfileAgentId, marketplace: string, plugin: string): Promise<PluginSourceLocation>;
}

/** The Agent config scan pipeline (`ProfileImportStore`) with the `portable` target. */
export interface SessionProfileScanner {
  scanGit(target: "portable", url: string): Promise<ProfileImportScanResponse>;
  scanUpload(target: "portable", name: string, filePath: string): Promise<ProfileImportScanResponse>;
  take(target: "portable", importId: string, picks: string[]): Promise<{ items: PortableItem[]; notes: string[]; release(): Promise<void> }>;
}

export interface SessionProfileImportsOptions {
  store: SessionProfileStore;
  global: SessionProfileGlobalConfig;
  scanner: SessionProfileScanner;
  /** `agentProfileImportsDir(appdir)`: every temp tree goes here. */
  workDir: string;
  /** Defaults to the importer's {@link gitClone} (`https`/`ssh` only, no prompts, a deadline). */
  clone?: GitCloneFn;
  cloneTimeoutMs?: number;
  now?: () => Date;
}

/** A store result: the fresh profile, the items created, the notes. */
export interface StoredImportResult {
  profile: StoredSessionProfile;
  itemIds: string[];
  notes: string[];
}

const KINDS: readonly SessionProfileItemKind[] = ["mcp", "skill", "plugin", "hook", "command"];
const CLONE_TIMEOUT_MS = 60_000;
/** Scans remembered per profile; the oldest is forgotten past this (its scan expires on its own). */
const MAX_TRACKED_SCANS = 64;

const label = (agent: SessionProfileAgentId): string => AGENT_PROFILE_AGENT_LABELS[agent];

/** `superpowers@claude-plugins-official` → `superpowers` (Claude lists plugins by id). */
function pluginName(item: ProfileItem): string {
  const marketplace = item.meta?.marketplace;
  return marketplace && item.name.endsWith(`@${marketplace}`) ? item.name.slice(0, -marketplace.length - 1) : item.name;
}

/** Why a Global item cannot be imported, or `null` (see {@link SessionProfileGlobalItem.unavailable}). */
function unavailableReason(agent: SessionProfileAgentId, item: ProfileItem): string | null {
  switch (item.source.type) {
    case "user":
      break;
    case "plugin":
      return `It comes with the plugin ${item.source.pluginId ?? ""}: add the plugin instead.`.replace("  ", " ");
    case "inherited":
      return item.source.ownerAgent ? `${label(item.source.ownerAgent)} owns it: import it from ${label(item.source.ownerAgent)}.` : `It is shared (${item.source.label}).`;
    case "bundled":
      return "It ships with the CLI.";
    default:
      return "Orquester or the CLI manages it.";
  }
  if (item.stashed) return "It is off in Agent config: turn it on there first.";
  if (item.kind === "plugin") {
    if (agent === "opencode" && item.meta?.source !== "file") return "An npm plugin: OpenCode installs it itself, so there are no files to copy.";
    if (item.path === undefined) return "Its files cannot be found.";
    if (item.warnings.some((warning) => warning.code === "plugin-cache-missing")) return "Its files are not installed.";
  }
  return null;
}

function scopeIsOther(scope: SessionProfileAgentScope, source: SessionProfileAgentId): SessionProfileAgentId | null {
  return scope !== "all" && scope.length === 1 && scope[0] !== source ? scope[0]! : null;
}

export class SessionProfileImports {
  private readonly store: SessionProfileStore;
  private readonly global: SessionProfileGlobalConfig;
  private readonly scanner: SessionProfileScanner;
  private readonly workDir: string;
  private readonly clone: GitCloneFn;
  private readonly cloneTimeoutMs: number;
  private readonly now: () => Date;
  private readonly converter: ProfileConverter;
  /** Open scans → the profile that opened them. */
  private readonly scans = new Map<string, string>();

  constructor(options: SessionProfileImportsOptions) {
    this.store = options.store;
    this.global = options.global;
    this.scanner = options.scanner;
    this.workDir = options.workDir;
    this.clone = options.clone ?? gitClone;
    this.cloneTimeoutMs = options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.converter = createProfileConverter({ tempRoot: options.workDir });
  }

  // -------------------------------------------------------------------------
  // Import from Global
  // -------------------------------------------------------------------------

  async globalSource(profileId: string, agent: SessionProfileAgentId): Promise<SessionProfileGlobalSourceResponse> {
    const profile = await this.store.read(profileId);
    const snapshot = await this.global.snapshot(agent);
    if (!snapshot.installed) return { agent, installed: false, instructions: { exists: false, bytes: 0 }, items: [] };
    const have = existingNames(profile);
    const items: SessionProfileGlobalItem[] = [];
    for (const item of snapshot.items) {
      if (item.locked || !(KINDS as readonly string[]).includes(item.kind)) continue;
      const kind = item.kind as SessionProfileItemKind;
      const name = kind === "plugin" ? pluginName(item) : item.name;
      const reason = unavailableReason(agent, item);
      items.push({
        id: item.id,
        kind,
        name,
        ...(item.description !== undefined ? { description: item.description } : {}),
        exists: kind !== "hook" && have.has(`${kind}:${name}`),
        ...(reason !== null ? { unavailable: reason } : {})
      });
    }
    return { agent, installed: true, instructions: { exists: snapshot.instructions.exists, bytes: snapshot.instructions.bytes }, items };
  }

  async importFromGlobal(profileId: string, request: ImportSessionProfileFromGlobalRequest): Promise<StoredImportResult> {
    const { agent } = request;
    await this.store.read(profileId);
    const snapshot = await this.global.snapshot(agent);
    if (!snapshot.installed) throw profileErrors.notInstalled(label(agent));
    const scope = request.agents ?? "all";
    const other = scopeIsOther(scope, agent);
    const entries: SessionProfileImportEntry[] = [];
    const notes: string[] = [];
    const temps: string[] = [];
    try {
      for (const id of new Set(request.itemIds)) {
        const item = snapshot.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.locked || !(KINDS as readonly string[]).includes(item.kind)) {
          throw errors.invalidItem(`${label(agent)} has no item "${id.slice(0, 120)}" to import.`);
        }
        const reason = unavailableReason(agent, item);
        if (reason !== null) throw errors.invalidItem(`"${item.name}" cannot be imported: ${reason}`);
        switch (item.kind) {
          case "skill":
          case "command":
          case "mcp": {
            const portable = await this.global.exportItem(agent, id);
            // An adapter exports a skill into `<workDir>/<export dir>/<name>`: the whole export dir goes.
            if (portable.kind === "skill") temps.push(dirname(dirname(portable.dir)) === this.workDir ? dirname(portable.dir) : portable.dir);
            entries.push(await this.portableEntry(portable, scope, other === null ? null : { from: agent, to: other }, notes));
            break;
          }
          case "hook": {
            const detail = await this.global.readItem(agent, id);
            if (detail.kind !== "hook") throw errors.invalidItem(`"${item.name}" is not a hook.`);
            entries.push({ kind: "hook", agent, name: item.name.slice(0, 200), hook: { ...detail.hook } });
            break;
          }
          case "plugin": {
            const { dir, temp } = await this.globalPluginDir(agent, item);
            if (temp !== null) temps.push(temp);
            const marketplace = item.meta?.marketplace;
            const version = item.meta?.version;
            entries.push({
              kind: "plugin",
              agent,
              plugin: {
                name: pluginName(item),
                ...(marketplace ? { marketplace } : {}),
                ...(version ? { version } : {}),
                ...(item.description !== undefined ? { description: item.description.slice(0, 2000) } : {}),
                source: { type: "global", ...(marketplace ? { marketplace } : {}), copiedAt: this.now().toISOString() }
              },
              dir
            });
            break;
          }
        }
      }
      const instructions =
        request.instructions !== undefined
          ? { text: (await this.global.readInstructions(agent)).text, mode: request.instructions }
          : undefined;
      if (entries.length === 0 && instructions === undefined) throw errors.invalid("Pick at least one item to import.");
      const result = await this.store.importItems(profileId, request.revision, entries, {
        onConflict: request.onConflict ?? "fail",
        ...(instructions !== undefined ? { instructions } : {})
      });
      return { ...result, notes: [...notes, ...result.notes] };
    } finally {
      await removeAll(temps);
    }
  }

  // -------------------------------------------------------------------------
  // Git / .zip / .md
  // -------------------------------------------------------------------------

  async scanGit(profileId: string, url: string): Promise<ProfileImportScanResponse> {
    await this.store.read(profileId);
    return this.opened(profileId, await this.scanner.scanGit("portable", url));
  }

  /** `filePath` stays the caller's (the upload route deletes it). */
  async scanUpload(profileId: string, name: string, filePath: string): Promise<ProfileImportScanResponse> {
    await this.store.read(profileId);
    return this.opened(profileId, await this.scanner.scanUpload("portable", name, filePath));
  }

  /** Refusals decided before an upload is read (a missing profile). */
  async assertCanScan(profileId: string): Promise<void> {
    await this.store.read(profileId);
  }

  async takeScan(profileId: string, importId: string, request: TakeSessionProfileImportRequest): Promise<StoredImportResult> {
    if (this.scans.get(importId) !== profileId) throw profileErrors.importNotFound(importId);
    // A take is single-use: a revision already stale must not burn the scan (the store checks again).
    const current = await this.store.read(profileId);
    if (String(current.manifest.revision) !== request.revision) throw errors.conflict();
    const taken = await this.scanner.take("portable", importId, request.picks);
    this.scans.delete(importId);
    try {
      const scope = request.agents ?? "all";
      const entries: SessionProfileImportEntry[] = [];
      for (const item of taken.items) entries.push(await this.portableEntry(item, scope, null, []));
      const result = await this.store.importItems(profileId, request.revision, entries, { onConflict: request.onConflict ?? "fail" });
      return { ...result, notes: [...taken.notes, ...result.notes] };
    } finally {
      await taken.release().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Copy from profile
  // -------------------------------------------------------------------------

  async copyFrom(profileId: string, request: CopySessionProfileItemsRequest): Promise<StoredImportResult> {
    if (request.fromProfileId === profileId) throw errors.invalid("Pick another profile to copy from.");
    await this.store.read(profileId);
    const source = await this.store.readSource(request.fromProfileId);
    const layout = profileLayout(source.dir);
    const entries: SessionProfileImportEntry[] = [];
    const notes: string[] = [];
    for (const itemId of new Set(request.itemIds)) {
      const found = source.items.find((entry) => (entry.ok ? entry.record.id : entry.id) === itemId);
      if (found === undefined) throw errors.itemNotFound(itemId);
      if (!found.ok) throw errors.invalidItem(`Item "${itemId}" of ${source.name} could not be read.`);
      const record = found.record;
      const enabled = record.enabled;
      const single = (record.agents === "all" ? null : record.agents[0]) as SessionProfileAgentId | null;
      switch (record.kind) {
        case "skill":
        case "command": {
          const { document } = await this.store.readItem(request.fromProfileId, itemId);
          const doc = document ?? { frontmatter: {}, body: "" };
          entries.push(
            record.kind === "skill"
              ? { kind: "skill", name: record.name, agents: record.agents as SessionProfileAgentScope, enabled, frontmatter: doc.frontmatter, body: doc.body, dir: layout.skillDir(itemId) }
              : { kind: "command", name: record.name, agents: record.agents as SessionProfileAgentScope, enabled, frontmatter: doc.frontmatter, body: doc.body }
          );
          break;
        }
        case "mcp": {
          const secrets = source.secrets[itemId];
          const pick = (keys: string[] | undefined, values: Record<string, string> | undefined, missing: string[]) => {
            const out: Record<string, string> = {};
            for (const key of keys ?? []) {
              if (typeof values?.[key] === "string") out[key] = values[key]!;
              else missing.push(key);
            }
            return out;
          };
          const missing: string[] = [];
          const env = pick(record.mcp.envKeys, secrets?.env, missing);
          const headers = pick(record.mcp.headerKeys, secrets?.headers, missing);
          if (missing.length > 0) notes.push(`"${record.name}": ${missing.join(", ")} had no stored value; enter ${missing.length === 1 ? "it" : "them"} again.`);
          const { mcp } = record;
          entries.push({
            kind: "mcp",
            agents: record.agents as SessionProfileAgentScope,
            enabled,
            server: {
              name: record.name,
              transport: mcp.transport,
              ...(mcp.command !== undefined ? { command: mcp.command } : {}),
              ...(mcp.args !== undefined ? { args: [...mcp.args] } : {}),
              ...(mcp.cwd !== undefined ? { cwd: mcp.cwd } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
              ...(mcp.url !== undefined ? { url: mcp.url } : {}),
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
              ...(mcp.advanced !== undefined ? { advanced: { ...mcp.advanced } } : {})
            }
          });
          break;
        }
        case "hook":
          if (single === null) throw errors.invalidItem(`The hook "${record.name}" names no agent.`);
          entries.push({ kind: "hook", agent: single, enabled, name: record.name, hook: { ...record.hook } });
          break;
        case "plugin": {
          if (single === null) throw errors.invalidItem(`The plugin "${record.name}" names no agent.`);
          if (source.missingContent.has(itemId)) throw errors.invalidItem(`The plugin "${record.name}" has no files in ${source.name}.`);
          const sourceRecord = record.plugin.source;
          entries.push({
            kind: "plugin",
            agent: single,
            enabled,
            plugin: {
              name: record.name,
              ...(record.plugin.marketplace !== undefined ? { marketplace: record.plugin.marketplace } : {}),
              ...(record.plugin.version !== undefined ? { version: record.plugin.version } : {}),
              ...(record.description !== undefined ? { description: record.description } : {}),
              ...(sourceRecord !== undefined ? { source: sourceRecord as SessionProfilePluginSource } : {})
            },
            dir: layout.pluginCacheDir(itemId)
          });
          break;
        }
      }
    }
    const instructions = request.instructions !== undefined ? { text: source.instructions, mode: request.instructions } : undefined;
    if (entries.length === 0 && instructions === undefined) throw errors.invalid("Pick at least one item to copy.");
    const result = await this.store.importItems(profileId, request.revision, entries, {
      onConflict: request.onConflict ?? "fail",
      ...(instructions !== undefined ? { instructions } : {})
    });
    return { ...result, notes: [...notes, ...result.notes] };
  }

  // -------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------

  async addPlugin(
    profileId: string,
    request: { revision: string; agent: SessionProfileAgentId; source: SessionProfilePluginSourceRequest; onConflict?: SessionProfileImportConflictPolicy }
  ): Promise<StoredImportResult> {
    const { agent, source } = request;
    await this.store.read(profileId);
    const temps: string[] = [];
    try {
      let entry: SessionProfileImportEntry;
      if (source.type === "global") {
        const snapshot = await this.global.snapshot(agent);
        if (!snapshot.installed) throw profileErrors.notInstalled(label(agent));
        const item = snapshot.items.find((candidate) => candidate.id === source.itemId && candidate.kind === "plugin");
        if (item === undefined) throw errors.invalidItem(`${label(agent)} has no plugin "${source.itemId.slice(0, 120)}".`);
        const reason = unavailableReason(agent, item);
        if (reason !== null) throw errors.invalidItem(`"${item.name}" cannot be added: ${reason}`);
        const { dir, temp } = await this.globalPluginDir(agent, item);
        if (temp !== null) temps.push(temp);
        const marketplace = item.meta?.marketplace;
        const version = item.meta?.version;
        entry = {
          kind: "plugin",
          agent,
          plugin: {
            name: pluginName(item),
            ...(marketplace ? { marketplace } : {}),
            ...(version ? { version } : {}),
            ...(item.description !== undefined ? { description: item.description.slice(0, 2000) } : {}),
            source: { type: "global", ...(marketplace ? { marketplace } : {}), copiedAt: this.now().toISOString() }
          },
          dir
        };
      } else {
        if (agent === "opencode") throw errors.invalidItem("OpenCode has no marketplaces: add one of its plugin files from Global.");
        const fetched = await this.marketplacePlugin(agent, source.marketplace, source.plugin, temps);
        entry = {
          kind: "plugin",
          agent,
          plugin: {
            name: source.plugin,
            marketplace: source.marketplace,
            ...(fetched.version !== undefined ? { version: fetched.version } : {}),
            ...(fetched.description !== undefined ? { description: fetched.description } : {}),
            source: {
              type: "marketplace",
              marketplace: source.marketplace,
              ...(fetched.commit !== null ? { commit: fetched.commit } : {}),
              ...(fetched.url !== undefined ? { url: fetched.url } : {}),
              ...(fetched.ref !== undefined ? { ref: fetched.ref } : {}),
              copiedAt: this.now().toISOString()
            }
          },
          dir: fetched.dir
        };
      }
      return await this.store.importItems(profileId, request.revision, [entry], { onConflict: request.onConflict ?? "fail" });
    } finally {
      await removeAll(temps);
    }
  }

  // -------------------------------------------------------------------------
  // Export / import a whole profile
  // -------------------------------------------------------------------------

  async exportProfile(profileId: string): Promise<{ fileName: string; data: Buffer }> {
    const content = await this.store.readExport(profileId);
    return { fileName: exportFileName(content.name), data: buildProfileExport(content, this.now()) };
  }

  /** `filePath` stays the caller's (the upload route deletes it). */
  async importProfile(name: string, filePath: string): Promise<{ profile: StoredSessionProfile; notes: string[] }> {
    if (!/\.zip$/i.test(name)) throw profileErrors.importFailed("Upload an Agent Profile export (.zip).");
    const read = await readProfileExport(filePath, this.workDir);
    try {
      return { profile: await this.store.createFromExport(read.dir, read.manifest), notes: read.notes };
    } finally {
      await read.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async opened(profileId: string, scan: ProfileImportScanResponse): Promise<ProfileImportScanResponse> {
    this.scans.set(scan.importId, profileId);
    while (this.scans.size > MAX_TRACKED_SCANS) this.scans.delete(this.scans.keys().next().value!);
    const have = existingNames(await this.store.read(profileId));
    return { ...scan, candidates: scan.candidates.map((candidate) => ({ ...candidate, exists: have.has(`${candidate.kind}:${candidate.name}`) })) };
  }

  /**
   * A skill, command or MCP server lifted out of an agent or a scan as the profile stores it:
   * scope `scope`; `convert` set when that scope is one agent other than the source (frontmatter
   * mapped, MCP settings converted, their notes added).
   */
  private async portableEntry(
    item: PortableItem,
    scope: SessionProfileAgentScope,
    convert: { from: SessionProfileAgentId; to: SessionProfileAgentId } | null,
    notes: string[]
  ): Promise<SessionProfileImportEntry> {
    switch (item.kind) {
      case "skill": {
        let text: string;
        try {
          text = await readFile(join(item.dir, PROFILE_SKILL_FILE), "utf8");
        } catch {
          throw errors.invalidItem(`The skill "${item.name}" has no readable ${PROFILE_SKILL_FILE}.`);
        }
        const document = parseMarkdownDocument(text);
        let frontmatter = document.frontmatter;
        if (convert !== null) {
          const mapped = mapFrontmatter(frontmatter, "skill", convert.to);
          frontmatter = mapped.frontmatter;
          notes.push(...droppedKeysNote(mapped.dropped, convert.to).map((note) => `${item.name}: ${note}`));
        }
        return { kind: "skill", name: item.name, agents: scope, frontmatter, body: document.body, dir: item.dir };
      }
      case "command": {
        let frontmatter = item.frontmatter;
        if (convert !== null) {
          const mapped = mapFrontmatter(frontmatter, "command", convert.to);
          frontmatter = mapped.frontmatter;
          notes.push(...droppedKeysNote(mapped.dropped, convert.to).map((note) => `${item.name}: ${note}`));
        }
        return { kind: "command", name: item.name, agents: scope, frontmatter, body: item.body };
      }
      case "mcp": {
        if (convert === null) return { kind: "mcp", agents: scope, server: item.server };
        const converted = this.converter(item, convert.from, convert.to);
        notes.push(...converted.notes.map((note) => `${item.server.name}: ${note}`));
        if (converted.item.kind !== "mcp") throw errors.invalidItem(`"${item.server.name}" could not be converted.`);
        return { kind: "mcp", agents: scope, server: converted.item.server };
      }
    }
  }

  /**
   * An installed Global plugin's files: its root directory (Codex: the version directory of its
   * cache), or — an OpenCode plugin file — a temp directory holding a copy of that one file.
   */
  private async globalPluginDir(agent: SessionProfileAgentId, item: ProfileItem): Promise<{ dir: string; temp: string | null }> {
    const path = item.path!;
    try {
      if (agent === "opencode") {
        const real = await realpath(path);
        if (!(await lstat(real)).isFile()) throw new Error("it is not a file");
        const temp = await this.tempDir("plugin-file-");
        const dir = join(temp, "plugin");
        await mkdir(dir, { mode: 0o700 });
        await copyFile(real, join(dir, basename(path)));
        return { dir, temp };
      }
      const dir = agent === "codex" ? await installedPluginRoot(path, item.meta?.version) : await realpath(path);
      if (!(await lstat(dir)).isDirectory()) throw new Error("it is not a folder");
      return { dir, temp: null };
    } catch (error) {
      if (error instanceof AgentProfileError) throw error;
      throw errors.invalidItem(`The plugin "${item.name}"'s files cannot be read (${(error as Error).message}).`);
    }
  }

  /** A marketplace plugin's files: in the marketplace's checkout, or cloned (see the module header). */
  private async marketplacePlugin(
    agent: SessionProfileAgentId,
    marketplace: string,
    plugin: string,
    temps: string[]
  ): Promise<{ dir: string; version?: string; description?: string; commit: string | null; url?: string; ref?: string }> {
    const location = await this.global.pluginSource(agent, marketplace, plugin);
    let dir: string;
    let commit: string | null;
    let url: string | undefined;
    let ref: string | undefined;
    if (location.source.type === "local") {
      dir = location.source.dir;
      commit = location.marketplaceDir !== null ? await readGitCommit(location.marketplaceDir) : null;
      if ((await lstat(dir).catch(() => null))?.isDirectory() !== true) {
        throw profileErrors.importFailed(`The marketplace "${marketplace}" has no folder for "${plugin}".`);
      }
    } else {
      const fetch = location.source.fetch;
      if (fetch === undefined) {
        throw profileErrors.importFailed(
          `Orquester cannot fetch "${plugin}" (${location.source.description}). Install it in Agent config, then add it from Global.`
        );
      }
      const cloned = await this.cloneSource(fetch, temps);
      dir = cloned.dir;
      commit = cloned.commit;
      url = cloned.url;
      ref = cloned.ref;
    }
    const manifest = await readPluginManifest(dir);
    const version = location.version ?? manifest.version ?? (commit !== null ? commit.slice(0, 12) : undefined);
    // Claude loads a plugin directory by its manifest: a catalogue-only (`strict: false`) plugin gets one.
    if (agent === "claude" && !manifest.claude) {
      const temp = await this.tempDir("plugin-");
      temps.push(temp);
      const staged = join(temp, "plugin");
      await measureTree(dir, PLUGIN_TREE_CAPS, `The plugin "${plugin}"`);
      await copyTree(dir, staged, { refuseSymlinks: true });
      await mkdir(join(staged, ".claude-plugin"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(staged, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: plugin, ...(version !== undefined ? { version } : {}) }, null, 2)}\n`,
        { mode: 0o600 }
      );
      dir = staged;
    }
    return {
      dir,
      ...(version !== undefined ? { version } : {}),
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      commit,
      ...(url !== undefined ? { url } : {}),
      ...(ref !== undefined ? { ref } : {})
    };
  }

  /** Clones a remote plugin source (the importer's URL rules and clone) into a temp dir; the plugin's folder inside it. */
  private async cloneSource(fetch: PluginFetchSource, temps: string[]): Promise<{ dir: string; commit: string | null; url: string; ref?: string }> {
    const parsed = parseGitImportUrl(fetch.url);
    const ref = fetch.ref ?? parsed.ref;
    if (ref !== undefined && (!/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,249}$/.test(ref) || ref.includes(".."))) {
      throw profileErrors.importFailed(`"${ref.slice(0, 80)}" is not a branch or tag name that can be cloned.`);
    }
    const temp = await this.tempDir("plugin-clone-");
    temps.push(temp);
    const tree = join(temp, "tree");
    try {
      await this.clone(parsed.cloneUrl, ref, tree, { timeoutMs: this.cloneTimeoutMs });
    } catch (error) {
      if (error instanceof AgentProfileError) throw error;
      throw profileErrors.importFailed(`Could not clone ${parsed.cloneUrl}: ${(error as Error).message.slice(0, 500)}`);
    }
    const commit = await readGitCommit(tree);
    await rm(join(tree, ".git"), { recursive: true, force: true });
    let dir = await subFolder(tree, [parsed.subPath, fetch.path].filter((part): part is string => part !== undefined).join("/"));
    if (fetch.catalogPlugin !== undefined) {
      for (const catalog of [join(".claude-plugin", "marketplace.json"), join(".grok-plugin", "marketplace.json")]) {
        if ((await lstat(join(dir, catalog)).catch(() => null))?.isSymbolicLink()) {
          throw profileErrors.importFailed(`The marketplace's ${catalog} is a symlink.`);
        }
      }
      let inner;
      try {
        inner = await catalogPluginSource(dir, fetch.catalogPlugin);
      } catch (error) {
        throw profileErrors.importFailed(`The marketplace at ${parsed.cloneUrl} does not list "${fetch.catalogPlugin}" (${(error as Error).message}).`);
      }
      if (inner.source.type !== "local") {
        throw profileErrors.importFailed(`"${fetch.catalogPlugin}" lives outside its marketplace (${inner.source.description}); Orquester fetches one level only.`);
      }
      dir = await subFolder(tree, inner.source.dir.slice(tree.length + 1));
    }
    return { dir, commit, url: parsed.cloneUrl, ...(ref !== undefined ? { ref } : {}) };
  }

  private async tempDir(prefix: string): Promise<string> {
    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    return mkdtemp(join(this.workDir, `session-profile-${prefix}`));
  }
}

/** `"<kind>:<name>"` of the profile's readable items. */
function existingNames(profile: StoredSessionProfile): Set<string> {
  return new Set(profile.items.flatMap((entry) => (entry.ok ? [`${entry.record.kind}:${entry.record.name}`] : [])));
}

/** `root/<rel>`, refusing `..`, a missing folder, and one reached through a symlink. `""` is the root. */
async function subFolder(root: string, rel: string): Promise<string> {
  let current = root;
  for (const segment of rel.split("/").filter((part) => part !== "" && part !== ".")) {
    if (segment === ".." || segment.includes("\0")) throw profileErrors.importFailed("The plugin's folder is not a plain path inside the repository.");
    current = join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
      throw profileErrors.importFailed(st?.isSymbolicLink() ? `"${rel}" goes through a symlink.` : `The repository has no folder "${rel}".`);
    }
  }
  return current;
}

/** The plugin manifest's version and description (`.claude-plugin`, `.codex-plugin`, `.grok-plugin`, `plugin.json`), if any. */
async function readPluginManifest(dir: string): Promise<{ claude: boolean; version?: string; description?: string }> {
  for (const rel of [join(".claude-plugin", "plugin.json"), join(".codex-plugin", "plugin.json"), join(".grok-plugin", "plugin.json"), "plugin.json"]) {
    const path = join(dir, rel);
    const st = await lstat(path).catch(() => null);
    // A symlink is never read (`lstat`: it is not a file).
    if (st === null || !st.isFile() || st.size > 1024 * 1024) continue;
    try {
      const doc = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      return {
        claude: rel.startsWith(".claude-plugin"),
        ...(typeof doc.version === "string" && doc.version.length <= 100 ? { version: doc.version } : {}),
        ...(typeof doc.description === "string" ? { description: doc.description.slice(0, 2000) } : {})
      };
    } catch {
      continue;
    }
  }
  return { claude: false };
}

async function removeAll(paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true }).catch(() => undefined);
}
