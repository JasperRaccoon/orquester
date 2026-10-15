/**
 * The agent profile service (spec §4): the one door every route goes through
 * to each agent's {@link ProfileAdapter}. Adapters own the formats; this owns
 * everything around them.
 *
 * Invariants:
 *
 * - **One mutation queue per agent.** Every write runs in its agent's promise
 *   chain, so two writes to one agent never interleave and an adapter never
 *   sees two of its own mutations at once. A failing op does not break the
 *   chain. Writes to different agents run in parallel. Reads (`snapshot`,
 *   `readItem`, `readInstructions`, `listMarketplacePlugins`, `overview`) do
 *   not queue: adapters read from disk and tolerate a concurrent write.
 * - **Checks before any adapter call:** an unknown agent is 404
 *   `UNKNOWN_AGENT`; no adapter or a CLI the registry does not find is 404
 *   `AGENT_NOT_INSTALLED`; a kind the agent does not have (or cannot create)
 *   is 400 `KIND_NOT_SUPPORTED`; names follow the shared per-kind rules.
 *   Per-item revisions (409 `PROFILE_CONFLICT`) are the adapter's to check.
 * - **Every mutation answers the fresh snapshot** read inside the same queue
 *   slot, right after the write (a copy answers the TARGET's), then emits
 *   `changed` if the snapshot revision moved and calls `afterWrite(agent)`
 *   fire-and-forget. A mutation that fails re-reads the snapshot too (it may
 *   have written part of its work) and calls `afterWrite` when it moved.
 * - **`changed` is deduped per agent**: it is emitted only when the snapshot
 *   revision differs from the last one noted, whether a mutation, a read or
 *   the file watcher computed it. Revisions computed out of order (a slow read
 *   that started before a faster, later one) are dropped, never noted.
 * - **Change detection is best-effort** (spec §4.7): `fs.watch` on the
 *   realpath of every `watchPaths()` entry (a missing path: its nearest
 *   existing ancestor), debounced per agent; every debounced check re-arms the
 *   watchers first (an atomic replace leaves a file watch on a dead inode, a
 *   missing path may exist now). A watcher error closes that agent's watchers;
 *   the next `snapshot()` re-arms them. Nothing runs after `stop()`.
 * - **Portable items carry real secret values** and are never logged; a skill
 *   directory a copy exports or converts is removed once the copy finishes.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { watch as fsWatch } from "node:fs";
import { realpath as fsRealpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_PROFILE_AGENT_LABELS,
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_CHANNEL,
  AGENT_PROFILE_CREATABLE_KINDS,
  AGENT_PROFILE_KINDS,
  MCP_TRANSPORTS,
  PROFILE_COPYABLE_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  isAgentProfileAgentId,
  type AgentProfileAgentId,
  type AgentProfileAgentSummary,
  type AgentProfileChangedPayload,
  type AgentProfileOverviewResponse,
  type AgentProfileSnapshot,
  type MarketplacePluginEntry,
  type ProfileConflictPolicy,
  type ProfileImportScanResponse,
  type ProfileInstructionsResponse,
  type ProfileItemDetail,
  type ProfileItemDraft,
  type ProfileItemKind,
  type ProfileMutationResponse
} from "@orquester/api";
import type { Broadcaster } from "../broadcaster.ts";
import type {
  AdapterMutationResult,
  AdapterSnapshot,
  AgentHomes,
  PortableItem,
  ProfileAdapter
} from "./adapters/types.ts";
import { AgentProfileError, profileErrors } from "./errors.ts";
import type { ProfileConverter } from "./convert.ts";
import type { ProfileImports } from "./import.ts";
import { assertCommandName, assertMcpServerName, assertSkillName, contentHash, parseItemId, parseMarkdownDocument, serializeMarkdownDocument } from "./infra/index.ts";
import type { McpCandidate } from "./daemon-mcp.ts";
import { pluginProvidesOf, readGitCommit, readInstalledPlugin, readPreviewTree } from "./preview-reads.ts";
import type {
  ProfileCopyPreviewResponse,
  ProfileImportDetailResponse,
  ProfileItemFilesResponse,
  ProfilePluginPreviewResponse,
  ProfilePreviewFile
} from "@orquester/api";

/** What the registry knows about an agent's CLI. */
interface AgentInstallInfo {
  installed: boolean;
  version?: string;
}

/** An open watch; `close()` is idempotent. */
interface ProfileWatchHandle {
  close(): void;
}

/**
 * Starts watching one existing path (already a realpath). `onChange` fires for
 * any event on it; `onError` when the watch breaks. May throw synchronously
 * (ENOSPC: out of inotify watches). Defaults to `fs.watch(path, {persistent:
 * false})`, so a watch never keeps the daemon alive.
 */
export type ProfileWatchFn = (path: string, onChange: () => void, onError: (error: Error) => void) => ProfileWatchHandle;

interface ProfileServiceLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface AgentProfileServiceOptions {
  /** The adapters that exist; an agent without one reads as not installed. */
  adapters: Partial<Record<AgentProfileAgentId, ProfileAdapter>>;
  /** Read per call (an install from Settings → Agents flips it at runtime). */
  agentInfo: (agent: AgentProfileAgentId) => AgentInstallInfo;
  /** For the instruction file path a not-installed agent's empty snapshot names. */
  homes?: AgentHomes;
  converter: ProfileConverter;
  /** The import scanner; absent → every import answers 503. */
  imports?: ProfileImports;
  /**
   * Called after every successful write to `agent`, fire-and-forget: its
   * errors (thrown or rejected) are logged and swallowed. The OpenCode server
   * recycling hook (spec §4.8).
   */
  afterWrite?: (agent: AgentProfileAgentId) => void | Promise<void>;
  logger?: ProfileServiceLogger;
  now?: () => Date;
  /** Injected by tests; defaults to `fs.watch`. */
  watch?: ProfileWatchFn;
  /** Injected by tests; defaults to `fs.promises.realpath`. */
  realpath?: (path: string) => Promise<string>;
  /** The change-detection debounce per agent (spec §4.7: 500 ms). */
  debounceMs?: number;
}

/** Per-agent watcher state. */
interface WatchState {
  handles: ProfileWatchHandle[];
  /** True while `handles` are live and have not errored. */
  armed: boolean;
  /** The in-flight (re-)arm, shared by concurrent callers. */
  arming?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

type RevisionCause = "read" | "watch" | "mutation";

const DEFAULT_DEBOUNCE_MS = 500;

const defaultWatch: ProfileWatchFn = (path, onChange, onError) => {
  const watcher = fsWatch(path, { persistent: false }, () => onChange());
  watcher.on("error", onError);
  return watcher;
};

const noop = (): void => undefined;

export class AgentProfileService {
  /** Emits `"changed"` with an {@link AgentProfileChangedPayload}. */
  readonly lifecycle = new EventEmitter();

  private readonly adapters: Partial<Record<AgentProfileAgentId, ProfileAdapter>>;
  private readonly agentInfo: (agent: AgentProfileAgentId) => AgentInstallInfo;
  private readonly converter: ProfileConverter;
  private readonly logger: ProfileServiceLogger;
  private readonly now: () => Date;
  private readonly watchFn: ProfileWatchFn;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly debounceMs: number;

  /** Each agent's mutation chain tail; never rejects. */
  private readonly queues = new Map<AgentProfileAgentId, Promise<void>>();
  /** The last revision noted per agent, with the sequence number of the read that produced it. */
  private readonly revisions = new Map<AgentProfileAgentId, { revision: string; seq: number }>();
  private readonly watches = new Map<AgentProfileAgentId, WatchState>();
  /** Increments at the START of every snapshot read, so reads can be ordered by when they began. */
  private readSeq = 0;
  private started = false;
  private stopped = false;

  constructor(private readonly options: AgentProfileServiceOptions) {
    this.adapters = options.adapters;
    this.agentInfo = options.agentInfo;
    this.converter = options.converter;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.watchFn = options.watch ?? defaultWatch;
    this.realpath = options.realpath ?? fsRealpath;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Arms change detection for every installed agent. Idempotent; a no-op after `stop()`. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const agent of AGENT_PROFILE_AGENTS) {
      void this.arm(agent, false);
    }
  }

  /**
   * Closes every watcher and pending debounce timer, then every adapter's
   * long-lived resources. In-flight mutations are not awaited (a CLI call may
   * run to its own deadline; the daemon's stop backstop bounds shutdown).
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const state of this.watches.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      closeAll(state.handles);
      state.handles = [];
      state.armed = false;
    }
    await Promise.all(
      Object.values(this.adapters).map(async (adapter) => {
        try {
          await adapter?.close?.();
        } catch (error) {
          this.logger.warn(`agent profile: closing the ${adapter?.agent} adapter failed: ${describe(error)}`);
        }
      })
    );
  }

  // -------------------------------------------------------------------------
  // Reads (not queued)
  // -------------------------------------------------------------------------

  /**
   * The agent's snapshot read from disk now. A not-installed agent (or one
   * with no adapter yet) answers an empty snapshot with `installed: false`
   * rather than throwing, so the panel can say so.
   */
  async snapshot(agent: AgentProfileAgentId): Promise<AgentProfileSnapshot> {
    assertAgent(agent);
    const snapshot = await this.readSnapshot(agent, "read");
    // A watcher that errored (or an agent installed since `start()`) is re-armed lazily here.
    if (snapshot.installed && !this.watchState(agent).armed) {
      void this.arm(agent, false);
    }
    return snapshot;
  }

  /** Counts per kind per agent; one failing adapter reads as `counts: {}` (logged), never fails the whole. */
  async overview(): Promise<AgentProfileOverviewResponse> {
    const agents = await Promise.all(
      AGENT_PROFILE_AGENTS.map(async (agent): Promise<AgentProfileAgentSummary> => {
        try {
          const snapshot = await this.snapshot(agent);
          const counts: Partial<Record<ProfileItemKind, number>> = {};
          for (const item of snapshot.items) {
            counts[item.kind] = (counts[item.kind] ?? 0) + 1;
          }
          return withVersion({ agent, installed: snapshot.installed, counts }, snapshot.version);
        } catch (error) {
          this.logger.warn(`agent profile: reading ${AGENT_PROFILE_AGENT_LABELS[agent]} for the overview failed: ${describe(error)}`);
          const info = this.agentInfo(agent);
          return withVersion({ agent, installed: info.installed, counts: {} }, info.version);
        }
      })
    );
    return { agents };
  }

  async readItem(agent: AgentProfileAgentId, id: string): Promise<ProfileItemDetail> {
    return this.installedAdapter(agent).readItem(id);
  }

  async readInstructions(agent: AgentProfileAgentId): Promise<ProfileInstructionsResponse> {
    return this.installedAdapter(agent).readInstructions();
  }

  async listMarketplacePlugins(agent: AgentProfileAgentId, marketplace: string): Promise<MarketplacePluginEntry[]> {
    const adapter = this.installedAdapter(agent);
    if (!AGENT_PROFILE_KINDS[agent].includes("marketplace") || !adapter.listMarketplacePlugins) {
      throw profileErrors.kindNotSupported(AGENT_PROFILE_AGENT_LABELS[agent], "marketplace");
    }
    return adapter.listMarketplacePlugins(marketplace);
  }

  // -------------------------------------------------------------------------
  // Approval-card reads (unified MCP design 2026-10-15 §7.1, §7.2; `@orquester/api` agent-profile.ts)
  // -------------------------------------------------------------------------

  /** A skill's, command's or installed plugin's files in full, with hashes, and the item's revision now; a plugin's `provides` too. */
  async itemFiles(agent: AgentProfileAgentId, id: string): Promise<ProfileItemFilesResponse> {
    this.installedAdapter(agent);
    const item = (await this.snapshot(agent)).items.find((entry) => entry.id === id);
    if (item === undefined) throw profileErrors.notFound(id);
    if ((item.kind !== "skill" && item.kind !== "command" && item.kind !== "plugin") || item.path === undefined) {
      throw profileErrors.invalid(`Only a skill's, a command's or an installed plugin's files can be read.`);
    }
    try {
      if (item.kind === "plugin") {
        // Codex reports the unversioned cache directory; the files are in its version directory.
        const installed = await readInstalledPlugin(item.path, item.meta?.version);
        return { itemId: id, revision: item.revision, ...installed.tree, provides: installed.provides, ...(installed.unreadable ? { unreadable: installed.unreadable } : {}) };
      }
      const tree = await readPreviewTree(item.path);
      return { itemId: id, revision: item.revision, ...tree };
    } catch (error) {
      throw profileErrors.unreadable(item.path, describe(error));
    }
  }

  /** An open import scan in full (its source, commit and every candidate's files). */
  async importDetail(agent: AgentProfileAgentId, importId: string, onConflict: ProfileConflictPolicy = "fail"): Promise<ProfileImportDetailResponse> {
    const adapter = this.installedAdapter(agent);
    const imports = this.requireImports();
    if (!imports.inspect) throw new AgentProfileError(503, "AGENT_PROFILE_ERROR", "Imports cannot be inspected.");
    const detail = await imports.inspect(agent, importId);
    if (onConflict !== "keep-both") return detail;
    // keep-both: each candidate as the import will write it — under the name the agent's own
    // naming picks, its `SKILL.md` carrying that name (as every adapter's import aligns it).
    const candidates = [];
    for (const candidate of detail.candidates) {
      const name = await this.keepBothName(agent, candidate.kind, candidate.name, adapter);
      candidates.push({ ...candidate, writtenName: name, ...(candidate.kind === "skill" ? { files: renameSkillFile(candidate.files, name, agent) } : {}) });
    }
    return { ...detail, candidates };
  }

  /** The name a keep-both create of this kind lands on, by the agent's own naming (`name` when free). */
  async keepBothName(agent: AgentProfileAgentId, kind: "mcp" | "skill" | "command", name: string, adapter = this.installedAdapter(agent)): Promise<string> {
    if (!adapter.keepBothName) throw new AgentProfileError(503, "AGENT_PROFILE_ERROR", `${AGENT_PROFILE_AGENT_LABELS[agent]} cannot name a keep-both copy ahead.`);
    return adapter.keepBothName(kind, name);
  }

  /**
   * An item as a copy to `toAgent` will write it: exported, converted (exactly as `copy` does),
   * named by the target's own keep-both naming when asked, a skill's `SKILL.md` carrying that name.
   * Nothing is written; the exported and converted copies are removed.
   */
  async copyPreview(
    fromAgent: AgentProfileAgentId,
    id: string,
    toAgent: AgentProfileAgentId,
    onConflict: ProfileConflictPolicy
  ): Promise<ProfileCopyPreviewResponse> {
    assertAgent(fromAgent);
    assertAgent(toAgent);
    if (fromAgent === toAgent) throw profileErrors.invalid("Copy to a different agent: an item cannot be copied onto its own agent.");
    const idKind = kindOfId(id);
    if (idKind && !PROFILE_COPYABLE_KINDS.includes(idKind)) throw notCopyable(idKind);
    const source = this.installedAdapter(fromAgent);
    const target = this.installedAdapter(toAgent);
    const item = (await this.snapshot(fromAgent)).items.find((entry) => entry.id === id);
    if (item === undefined) throw profileErrors.notFound(id);
    const portable = await this.enqueue(fromAgent, () => source.exportItem(id));
    const owned: PortableItem[] = [portable];
    try {
      if (!PROFILE_COPYABLE_KINDS.includes(portable.kind)) throw notCopyable(portable.kind);
      const conversion = await this.converter(portable, fromAgent, toAgent);
      owned.push(conversion.item);
      assertPortableReceivable(toAgent, conversion.item);
      const converted = conversion.item;
      const base = converted.kind === "mcp" ? converted.server.name : converted.name;
      const name = onConflict === "keep-both" ? await this.keepBothName(toAgent, converted.kind, base, target) : base;
      const head = { itemId: id, revision: item.revision, kind: converted.kind, name, notes: [...conversion.notes] };
      if (converted.kind === "mcp") return head;
      if (converted.kind === "skill") {
        const tree = await readPreviewTree(converted.dir);
        return { ...head, tree: { ...tree, files: renameSkillFile(tree.files, name, toAgent) } };
      }
      const text = serializeMarkdownDocument(converted.frontmatter, converted.body, toAgent === "opencode" ? { yaml: "1.1" } : {});
      const bytes = Buffer.from(text, "utf8");
      return { ...head, tree: { complete: true, files: [{ path: `${name}.md`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), text }] } };
    } finally {
      await this.disposePortable(owned);
    }
  }

  /** A marketplace plugin before it is installed: its files, what it ships, the marketplace's commit. */
  async pluginPreview(agent: AgentProfileAgentId, marketplace: string, plugin: string): Promise<ProfilePluginPreviewResponse> {
    const adapter = this.installedAdapter(agent);
    if (!AGENT_PROFILE_KINDS[agent].includes("marketplace")) {
      throw profileErrors.kindNotSupported(AGENT_PROFILE_AGENT_LABELS[agent], "marketplace");
    }
    const provides: ProfilePluginPreviewResponse["provides"] = { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] };
    if (!adapter.pluginSource) {
      const reason = `Orquester cannot read a ${AGENT_PROFILE_AGENT_LABELS[agent]} plugin before it is installed.`;
      return { marketplace, plugin, commit: null, source: { type: "unavailable", reason }, provides };
    }
    const location = await adapter.pluginSource(marketplace, plugin);
    const commit = location.marketplaceDir !== null ? await readGitCommit(location.marketplaceDir) : null;
    const head = { marketplace, plugin, ...(location.version !== undefined ? { version: location.version } : {}), commit };
    if (location.source.type === "remote") return { ...head, source: location.source, provides };
    // The commit pins the plugin only when its directory really lies in the checkout (realpaths).
    if (location.marketplaceDir === null || !(await realpathInside(location.marketplaceDir, location.source.dir))) {
      Object.assign(head, { outsideCheckout: true });
    }
    let tree;
    try {
      tree = await readPreviewTree(location.source.dir);
    } catch (error) {
      throw profileErrors.unreadable(location.source.dir, describe(error));
    }
    return { ...head, source: { type: "local", ...tree }, provides: pluginProvidesOf(tree) };
  }

  /**
   * An MCP item's current definition as a daemon-pointing candidate (`daemon-mcp.ts`): REAL
   * header/env values, for the daemon's own check only — never serialised or logged.
   */
  async mcpCandidate(agent: AgentProfileAgentId, id: string): Promise<McpCandidate | null> {
    if (!id.startsWith("mcp:")) return null;
    const item = await this.installedAdapter(agent).exportItem(id);
    if (item.kind !== "mcp") return null;
    const server = item.server;
    // Codex names its bearer by environment variable: `bearer_token_env_var`, the header → variable
    // map `env_http_headers`, and the passed-through `env_vars`.
    const names = (value: unknown): string[] =>
      typeof value === "string" ? [value]
      : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string")
      : value !== null && typeof value === "object" ? Object.values(value).filter((entry): entry is string => typeof entry === "string")
      : [];
    const advanced = server.advanced ?? {};
    return {
      name: server.name,
      ...(server.url !== undefined ? { url: server.url } : {}),
      values: [...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {}), ...(server.args ?? []), ...(server.command ? [server.command] : [])],
      envRefs: [...names(advanced.bearer_token_env_var), ...names(advanced.env_http_headers), ...names(advanced.env_vars)]
    };
  }

  // -------------------------------------------------------------------------
  // Mutations (queued per agent)
  // -------------------------------------------------------------------------

  /** Creates an item from a draft (the editor, a plugin or marketplace install). */
  async create(
    agent: AgentProfileAgentId,
    draft: ProfileItemDraft,
    onConflict: ProfileConflictPolicy = "fail"
  ): Promise<ProfileMutationResponse> {
    this.installedAdapter(agent);
    assertCanCreate(agent, draft.kind);
    assertDraftValid(agent, draft);
    return this.mutate(agent, (adapter) => adapter.create(draft, { onConflict }));
  }

  /**
   * Imports the picked candidates of a scan (spec §6). The import seam already
   * produced items for this agent, so no conversion runs; `release()` is called
   * whatever happens.
   */
  async createFromImport(
    agent: AgentProfileAgentId,
    importId: string,
    picks: string[],
    onConflict: ProfileConflictPolicy = "fail"
  ): Promise<ProfileMutationResponse> {
    this.installedAdapter(agent);
    const imports = this.requireImports();
    const taken = await imports.take(agent, importId, picks);
    try {
      if (taken.items.length === 0) {
        throw profileErrors.importFailed("None of the picked items could be imported.");
      }
      // Refuse the whole import before anything is written if any item cannot land.
      for (const item of taken.items) {
        assertPortableReceivable(agent, item);
      }
      return await this.mutate(agent, async (adapter) => {
        const itemIds: string[] = [];
        const notes: string[] = [];
        for (const item of taken.items) {
          const result = await adapter.importItem(item, { onConflict });
          itemIds.push(...result.itemIds);
          notes.push(...result.notes);
        }
        return { itemIds, notes };
      });
    } finally {
      await taken.release().catch((error) =>
        this.logger.warn(`agent profile: releasing import ${importId} failed: ${describe(error)}`)
      );
    }
  }

  async update(
    agent: AgentProfileAgentId,
    id: string,
    revision: string,
    draft: ProfileItemDraft
  ): Promise<ProfileMutationResponse> {
    this.installedAdapter(agent);
    if (!AGENT_PROFILE_KINDS[agent].includes(draft.kind)) {
      throw profileErrors.kindNotSupported(AGENT_PROFILE_AGENT_LABELS[agent], draft.kind);
    }
    if (draft.kind === "plugin" || draft.kind === "marketplace") {
      throw new AgentProfileError(
        400,
        "KIND_NOT_SUPPORTED",
        `${PROFILE_ITEM_KIND_LABELS[draft.kind].many} cannot be edited; remove it and install it again.`
      );
    }
    const idKind = kindOfId(id);
    if (idKind && idKind !== draft.kind) {
      throw profileErrors.invalid(`The draft is a ${draft.kind} but the item is a ${idKind}.`);
    }
    assertDraftValid(agent, draft);
    return this.mutate(agent, (adapter) => adapter.update(id, revision, draft));
  }

  async setEnabled(agent: AgentProfileAgentId, id: string, revision: string, enabled: boolean): Promise<ProfileMutationResponse> {
    return this.mutate(agent, (adapter) => adapter.setEnabled(id, revision, enabled));
  }

  async remove(agent: AgentProfileAgentId, id: string, revision: string): Promise<ProfileMutationResponse> {
    return this.mutate(agent, (adapter) => adapter.remove(id, revision));
  }

  /** Codex hooks only (spec §4.6). */
  async trust(agent: AgentProfileAgentId, id: string, revision: string): Promise<ProfileMutationResponse> {
    const adapter = this.installedAdapter(agent);
    if (!adapter.trust) {
      throw new AgentProfileError(400, "KIND_NOT_SUPPORTED", `${AGENT_PROFILE_AGENT_LABELS[agent]} has no hook trust to grant.`);
    }
    const trust = adapter.trust.bind(adapter);
    return this.mutate(agent, () => trust(id, revision));
  }

  async writeInstructions(agent: AgentProfileAgentId, text: string, revision: string): Promise<ProfileMutationResponse> {
    return this.mutate(agent, (adapter) => adapter.writeInstructions(text, revision));
  }

  /** Grok only: fold the dead `GROK.md` into `AGENTS.md`. */
  async migrateLegacyInstructions(agent: AgentProfileAgentId, revision: string): Promise<ProfileMutationResponse> {
    const adapter = this.installedAdapter(agent);
    if (!adapter.migrateLegacyInstructions) {
      throw new AgentProfileError(
        400,
        "KIND_NOT_SUPPORTED",
        `${AGENT_PROFILE_AGENT_LABELS[agent]} has no legacy instruction file to migrate.`
      );
    }
    const migrate = adapter.migrateLegacyInstructions.bind(adapter);
    return this.mutate(agent, () => migrate(revision));
  }

  /**
   * Copies a copyable item from one agent to another (spec §6). The export
   * runs in the SOURCE's queue and the import in the TARGET's, one after the
   * other — never nested, so two opposite copies cannot deadlock. The response
   * is the target's; converter notes come first. Any skill directory the
   * export or the conversion produced is removed afterwards.
   */
  async copy(
    fromAgent: AgentProfileAgentId,
    id: string,
    toAgent: AgentProfileAgentId,
    onConflict: ProfileConflictPolicy = "fail"
  ): Promise<ProfileMutationResponse> {
    assertAgent(fromAgent);
    assertAgent(toAgent);
    if (fromAgent === toAgent) {
      throw profileErrors.invalid("Copy to a different agent: an item cannot be copied onto its own agent.");
    }
    const idKind = kindOfId(id);
    if (idKind && !PROFILE_COPYABLE_KINDS.includes(idKind)) {
      throw notCopyable(idKind);
    }
    const source = this.installedAdapter(fromAgent);
    this.installedAdapter(toAgent);

    const portable = await this.enqueue(fromAgent, () => source.exportItem(id));
    const owned: PortableItem[] = [portable];
    try {
      if (!PROFILE_COPYABLE_KINDS.includes(portable.kind)) {
        throw notCopyable(portable.kind);
      }
      const conversion = await this.converter(portable, fromAgent, toAgent);
      owned.push(conversion.item);
      assertPortableReceivable(toAgent, conversion.item);
      const response = await this.mutate(toAgent, (adapter) => adapter.importItem(conversion.item, { onConflict }));
      return { ...response, notes: [...conversion.notes, ...response.notes] };
    } finally {
      await this.disposePortable(owned);
    }
  }

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  async scanGit(agent: AgentProfileAgentId, url: string): Promise<ProfileImportScanResponse> {
    this.installedAdapter(agent);
    return this.requireImports().scanGit(agent, url);
  }

  /** `filePath` stays the caller's: see {@link ProfileImports.scanUpload}. */
  async scanUpload(agent: AgentProfileAgentId, name: string, filePath: string): Promise<ProfileImportScanResponse> {
    this.installedAdapter(agent);
    return this.requireImports().scanUpload(agent, name, filePath);
  }

  /**
   * Every refusal `scanUpload` would answer before looking at the file
   * (unknown agent, not installed, no import seam): the upload route calls it
   * BEFORE reading the body, so a refused upload is never streamed to disk.
   */
  assertCanScanUpload(agent: AgentProfileAgentId): void {
    this.installedAdapter(agent);
    this.requireImports();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireImports(): ProfileImports {
    if (!this.options.imports) {
      throw new AgentProfileError(503, "AGENT_PROFILE_ERROR", "Imports are not available yet.");
    }
    return this.options.imports;
  }

  /** The adapter of an installed agent, or the 404 the route answers. */
  private installedAdapter(agent: AgentProfileAgentId): ProfileAdapter {
    assertAgent(agent);
    const adapter = this.adapters[agent];
    if (!adapter || !this.agentInfo(agent).installed) {
      throw profileErrors.notInstalled(AGENT_PROFILE_AGENT_LABELS[agent]);
    }
    return adapter;
  }

  /** Runs `op` after every earlier op of this agent has settled; a failure does not break the chain. */
  private enqueue<T>(agent: AgentProfileAgentId, op: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(agent) ?? Promise.resolve();
    const result = tail.then(op);
    this.queues.set(agent, result.then(noop, noop));
    return result;
  }

  /**
   * One queued write: the adapter call, `afterWrite`, then the fresh snapshot
   * read in the same queue slot (so it shows exactly this write) — which notes
   * the revision and emits `changed` when it moved.
   */
  private mutate(
    agent: AgentProfileAgentId,
    run: (adapter: ProfileAdapter) => Promise<AdapterMutationResult>
  ): Promise<ProfileMutationResponse> {
    const adapter = this.installedAdapter(agent);
    return this.enqueue(agent, async () => {
      const before = this.revisions.get(agent)?.revision;
      let result: AdapterMutationResult;
      try {
        result = await run(adapter);
      } catch (error) {
        await this.settleFailedMutation(agent, before);
        throw error;
      }
      this.notifyAfterWrite(agent);
      const snapshot = await this.readSnapshot(agent, "mutation");
      return { snapshot, itemIds: [...result.itemIds], notes: [...result.notes] };
    });
  }

  /**
   * A mutation that failed may still have written part of its work (the first
   * items of a multi-item import, a hook written before its trust state): the
   * snapshot is re-read in the same queue slot so a moved revision is announced,
   * and `afterWrite` runs when it moved. Never throws: the caller rethrows the
   * mutation's own error.
   */
  private async settleFailedMutation(agent: AgentProfileAgentId, before: string | undefined): Promise<void> {
    try {
      const snapshot = await this.readSnapshot(agent, "mutation");
      if (before !== undefined && snapshot.revision !== before) {
        this.notifyAfterWrite(agent);
      }
    } catch (error) {
      this.logger.warn(`agent profile: re-reading ${AGENT_PROFILE_AGENT_LABELS[agent]} after a failed change failed: ${describe(error)}`);
    }
  }

  private notifyAfterWrite(agent: AgentProfileAgentId): void {
    const hook = this.options.afterWrite;
    if (!hook) return;
    const report = (error: unknown) =>
      this.logger.warn(`agent profile: the after-write hook for ${AGENT_PROFILE_AGENT_LABELS[agent]} failed: ${describe(error)}`);
    try {
      void Promise.resolve(hook(agent)).catch(report);
    } catch (error) {
      report(error);
    }
  }

  private async readSnapshot(agent: AgentProfileAgentId, cause: RevisionCause): Promise<AgentProfileSnapshot> {
    const seq = ++this.readSeq;
    const info = this.agentInfo(agent);
    const adapter = this.adapters[agent];
    const raw: AdapterSnapshot =
      adapter && info.installed ? await adapter.snapshot() : this.emptyAdapterSnapshot(agent);
    const installed = Boolean(adapter && info.installed);
    const version = installed ? info.version : undefined;
    const snapshot: AgentProfileSnapshot = {
      agent,
      installed,
      ...(version !== undefined ? { version } : {}),
      revision: snapshotRevision(installed, version, raw),
      instructions: raw.instructions,
      items: raw.items,
      fileErrors: raw.fileErrors,
      readAt: this.now().toISOString()
    };
    this.noteRevision(agent, snapshot.revision, seq, cause);
    return snapshot;
  }

  private emptyAdapterSnapshot(agent: AgentProfileAgentId): AdapterSnapshot {
    return {
      instructions: {
        path: this.options.homes ? instructionsPathFor(agent, this.options.homes) : "",
        exists: false,
        bytes: 0,
        lines: 0,
        revision: "",
        warnings: []
      },
      items: [],
      fileErrors: []
    };
  }

  /**
   * Records `revision` as the agent's current one and emits `changed` when it
   * moved. A result from a read that began before the one already noted is
   * stale and dropped. The first revision seen by a plain read is a baseline
   * (nobody can hold an older one); a watcher or a mutation announces even
   * the first.
   */
  private noteRevision(agent: AgentProfileAgentId, revision: string, seq: number, cause: RevisionCause): void {
    const known = this.revisions.get(agent);
    if (known && seq < known.seq) return;
    this.revisions.set(agent, { revision, seq });
    if (known?.revision === revision) return;
    if (!known && cause === "read") return;
    const payload: AgentProfileChangedPayload = { agent, revision };
    this.lifecycle.emit("changed", payload);
  }

  private async disposePortable(items: PortableItem[]): Promise<void> {
    const dirs = new Set<string>();
    for (const item of items) {
      if (item.kind === "skill") dirs.add(item.dir);
    }
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch((error) =>
        this.logger.warn(`agent profile: removing the copy's temp dir ${dir} failed: ${describe(error)}`)
      );
    }
  }

  // --- change detection ----------------------------------------------------

  private watchState(agent: AgentProfileAgentId): WatchState {
    let state = this.watches.get(agent);
    if (!state) {
      state = { handles: [], armed: false };
      this.watches.set(agent, state);
    }
    return state;
  }

  private canWatch(agent: AgentProfileAgentId): boolean {
    return this.started && !this.stopped && Boolean(this.adapters[agent]) && this.agentInfo(agent).installed;
  }

  /**
   * (Re-)opens the agent's watchers. `force` replaces live ones (the debounced
   * check does, see the class doc); otherwise an armed agent is left alone.
   * The new watchers are opened before the old are closed, so no event falls
   * between them.
   */
  private arm(agent: AgentProfileAgentId, force: boolean): Promise<void> {
    if (!this.canWatch(agent)) return Promise.resolve();
    const state = this.watchState(agent);
    if (state.arming) return state.arming;
    if (state.armed && !force) return Promise.resolve();
    const run = this.openWatchers(agent)
      .then((handles) => {
        if (!this.canWatch(agent)) {
          closeAll(handles);
          return;
        }
        const previous = state.handles;
        state.handles = handles;
        state.armed = true;
        closeAll(previous);
      })
      .catch((error) => {
        this.logger.warn(`agent profile: watching ${AGENT_PROFILE_AGENT_LABELS[agent]}'s files failed: ${describe(error)}`);
        this.disarm(agent);
      })
      .finally(() => {
        state.arming = undefined;
      });
    state.arming = run;
    return run;
  }

  private async openWatchers(agent: AgentProfileAgentId): Promise<ProfileWatchHandle[]> {
    const adapter = this.adapters[agent];
    if (!adapter) return [];
    const targets = new Set<string>();
    for (const path of adapter.watchPaths()) {
      targets.add(await this.watchTarget(path));
    }
    const handles: ProfileWatchHandle[] = [];
    try {
      for (const target of targets) {
        handles.push(
          this.watchFn(
            target,
            () => this.onWatchEvent(agent),
            (error) => this.onWatchError(agent, error)
          )
        );
      }
    } catch (error) {
      closeAll(handles);
      throw error;
    }
    return handles;
  }

  /** The realpath of `path`, or of its nearest existing ancestor when it does not exist (yet). */
  private async watchTarget(path: string): Promise<string> {
    let current = resolve(path);
    for (;;) {
      try {
        return await this.realpath(current);
      } catch (error) {
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  private disarm(agent: AgentProfileAgentId): void {
    const state = this.watchState(agent);
    closeAll(state.handles);
    state.handles = [];
    state.armed = false;
  }

  private onWatchEvent(agent: AgentProfileAgentId): void {
    if (this.stopped) return;
    const state = this.watchState(agent);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.check(agent);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private onWatchError(agent: AgentProfileAgentId, error: Error): void {
    if (this.stopped) return;
    this.logger.warn(
      `agent profile: a watcher on ${AGENT_PROFILE_AGENT_LABELS[agent]}'s files failed (${describe(error)}); it is re-armed on the next read.`
    );
    this.disarm(agent);
  }

  /** The debounced check: re-arm, then recompute the revision (emitting `changed` when it moved). */
  private async check(agent: AgentProfileAgentId): Promise<void> {
    if (!this.canWatch(agent)) return;
    await this.arm(agent, true);
    if (!this.canWatch(agent)) return;
    try {
      await this.readSnapshot(agent, "watch");
    } catch (error) {
      this.logger.warn(`agent profile: re-reading ${AGENT_PROFILE_AGENT_LABELS[agent]} after a change failed: ${describe(error)}`);
    }
  }
}

/**
 * Every profile change → the `/events` bus on {@link AGENT_PROFILE_CHANNEL} as
 * `agentProfile.changed {agent, revision}` (clients refetch when the revision
 * differs from theirs). Mirrors `publishSavedPromptEvents`.
 */
export function publishAgentProfileEvents(
  service: AgentProfileService,
  broadcaster: Pick<Broadcaster, "publish">
): void {
  service.lifecycle.on("changed", (payload: AgentProfileChangedPayload) =>
    broadcaster.publish(AGENT_PROFILE_CHANNEL, "agentProfile.changed", payload)
  );
}

/** The global instruction file each agent loads (spec §3). */
function instructionsPathFor(agent: AgentProfileAgentId, homes: AgentHomes): string {
  switch (agent) {
    case "claude":
      return join(homes.claudeDir, "CLAUDE.md");
    case "codex":
      return join(homes.codexHome, "AGENTS.md");
    case "grok":
      return join(homes.grokHome, "AGENTS.md");
    case "opencode":
      return join(homes.opencodeDir, "AGENTS.md");
  }
}

/**
 * The snapshot's event-dedupe revision: a hash over everything the panel
 * shows, independent of the order the adapter listed items and file errors in
 * and of object key order. `readAt` is excluded.
 */
function snapshotRevision(installed: boolean, version: string | undefined, raw: AdapterSnapshot): string {
  const items = [...raw.items].sort((a, b) => compare(a.id, b.id));
  const fileErrors = [...raw.fileErrors].sort((a, b) => compare(a.path, b.path) || compare(a.message, b.message));
  return contentHash({ installed, version: version ?? null, instructions: raw.instructions, items, fileErrors });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertAgent(agent: string): asserts agent is AgentProfileAgentId {
  if (!isAgentProfileAgentId(agent)) {
    throw profileErrors.unknownAgent(excerpt(agent));
  }
}

/** The kind an id names (`<kind>:…`), when its prefix is one. */
function kindOfId(id: string): ProfileItemKind | undefined {
  return parseItemId(id)?.kind;
}

function assertCanCreate(agent: AgentProfileAgentId, kind: ProfileItemKind): void {
  const label = AGENT_PROFILE_AGENT_LABELS[agent];
  if (!AGENT_PROFILE_KINDS[agent].includes(kind)) {
    throw profileErrors.kindNotSupported(label, kind);
  }
  if (!AGENT_PROFILE_CREATABLE_KINDS[agent].includes(kind)) {
    throw new AgentProfileError(
      400,
      "KIND_NOT_SUPPORTED",
      `${label} cannot create ${PROFILE_ITEM_KIND_LABELS[kind].many.toLowerCase()} here.`
    );
  }
}

function notCopyable(kind: ProfileItemKind): AgentProfileError {
  return new AgentProfileError(
    400,
    "KIND_NOT_SUPPORTED",
    `${PROFILE_ITEM_KIND_LABELS[kind].many} cannot be copied between agents.`
  );
}

/** The shared per-kind name rules and the agent's MCP transports (spec §4.5). */
function assertDraftValid(agent: AgentProfileAgentId, draft: ProfileItemDraft): void {
  switch (draft.kind) {
    case "mcp":
      assertMcpServerName(draft.mcp.name);
      assertTransport(agent, draft.mcp.transport);
      return;
    case "skill":
      assertSkillName(draft.document.name);
      return;
    case "command":
      assertCommandName(draft.document.name);
      return;
    default:
      return;
  }
}

/** A portable item (copied or imported) can land on `agent`: a creatable kind, a valid name. */
function assertPortableReceivable(agent: AgentProfileAgentId, item: PortableItem): void {
  assertCanCreate(agent, item.kind);
  switch (item.kind) {
    case "mcp":
      assertMcpServerName(item.server.name);
      assertTransport(agent, item.server.transport);
      return;
    case "skill":
      assertSkillName(item.name);
      return;
    case "command":
      assertCommandName(item.name);
      return;
  }
}

function assertTransport(agent: AgentProfileAgentId, transport: string): void {
  if (!(MCP_TRANSPORTS[agent] as readonly string[]).includes(transport)) {
    throw profileErrors.invalidItem(`${AGENT_PROFILE_AGENT_LABELS[agent]} does not support ${excerpt(transport)} MCP servers.`);
  }
}

function withVersion(summary: AgentProfileAgentSummary, version: string | undefined): AgentProfileAgentSummary {
  return version !== undefined ? { ...summary, version } : summary;
}

function closeAll(handles: ProfileWatchHandle[]): void {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Already closed.
    }
  }
}

/** A user-supplied string quoted in a message, bounded. */
function excerpt(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** An error for a log line. Adapter errors never carry secret values (the adapter contract). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A skill's files with its `SKILL.md` frontmatter `name` set to `name`, as the adapters align a
 * renamed import or copy (in place, or first). A file that already carries it is left as it is.
 */
function renameSkillFile(files: ProfilePreviewFile[], name: string, agent: AgentProfileAgentId): ProfilePreviewFile[] {
  return files.map((file) => {
    if (file.path !== "SKILL.md" || file.text === undefined) return file;
    let document;
    try {
      document = parseMarkdownDocument(file.text);
    } catch {
      return file;
    }
    if (document.frontmatter.name === name) return file;
    const frontmatter = "name" in document.frontmatter ? { ...document.frontmatter, name } : { name, ...document.frontmatter };
    const text = serializeMarkdownDocument(frontmatter, document.body, agent === "opencode" ? { yaml: "1.1" } : {});
    const bytes = Buffer.from(text, "utf8");
    return { ...file, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), text };
  });
}

/** Whether `path`'s realpath lies inside (or is) `root`'s realpath; false when either cannot be resolved. */
async function realpathInside(root: string, path: string): Promise<boolean> {
  try {
    const [realRoot, realPath] = await Promise.all([fsRealpath(root), fsRealpath(path)]);
    return realPath === realRoot || realPath.startsWith(realRoot.endsWith("/") ? realRoot : `${realRoot}/`);
  } catch {
    return false;
  }
}
