/**
 * Agent Profiles — the CRUD service behind `routes.ts` (and, later, the MCP tools and the
 * preparation lifecycle). It maps the store's records to the wire shapes of `@orquester/api`
 * `session-profiles.ts` — masking every MCP secret value — and announces every change on
 * {@link SessionProfileService.events} (`publishSessionProfileEvents` puts them on `/events`).
 *
 * Serialization and the revision check live in the store (its per-profile queue), so every
 * writer shares them. Preparation state comes from the `prepareStatus` option, which the
 * preparation lifecycle supplies; without it every agent reads `not-prepared`.
 */

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
  SESSION_PROFILES_CHANNEL,
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_ITEM_KINDS,
  type AddSessionProfilePluginRequest,
  type CopySessionProfileItemsRequest,
  type CreateSessionProfileRequest,
  type ImportSessionProfileFromGlobalRequest,
  type ImportSessionProfileResponse,
  type ProfileImportScanResponse,
  type SessionProfileGlobalSourceResponse,
  type SessionProfileImportResponse,
  type SessionProfilePluginSource,
  type TakeSessionProfileImportRequest,
  type DeleteSessionProfileResponse,
  type McpServerView,
  type SessionProfileAgentId,
  type SessionProfileChangedPayload,
  type SessionProfileDeletedPayload,
  type SessionProfileDetail,
  type SessionProfileInstructionsResponse,
  type SessionProfileItem,
  type SessionProfileItemCount,
  type SessionProfileItemDetail,
  type SessionProfileItemDraft,
  type SessionProfileItemError,
  type SessionProfileItemKind,
  type SessionProfileListResponse,
  type SessionProfileMutationResponse,
  type SessionProfilePrepareStatus,
  type SessionProfilePrepareStatusResponse,
  type SessionProfileSummary,
  type UpdateSessionProfileRequest
} from "@orquester/api";
import type { Skill, SlashCommand } from "@orquester/api/agent-chat";
import type { SessionProfileItemRecord } from "@orquester/config";
import { parseMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";
import type { Broadcaster } from "../broadcaster.ts";
import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import type { SessionProfileImports, StoredImportResult } from "./imports.ts";
import { itemUnsupportedReason, resolveForAgent, resolveSessionProfileSettings, wireScope, type ResolvedAgentProfile } from "./resolve.ts";
import type { SessionProfileStore, StoredSessionProfile } from "./store.ts";

/** Answers each agent's preparation state of a profile's current revision (the lifecycle's job). */
export type SessionProfilePrepareStatusSource = (profile: {
  profileId: string;
  revision: string;
  updatedAt: string;
}) => SessionProfilePrepareStatus[];

export interface SessionProfileServiceOptions {
  store: SessionProfileStore;
  prepareStatus?: SessionProfilePrepareStatusSource;
  /** Import from Global, git / zip / md, copy, plugins, export and import (`imports.ts`); absent → those routes answer 503. */
  imports?: SessionProfileImports;
}

export interface SessionProfileServiceEvents {
  changed: [SessionProfileChangedPayload];
  deleted: [SessionProfileDeletedPayload];
}

const notPrepared: SessionProfilePrepareStatusSource = ({ updatedAt }) =>
  SESSION_PROFILE_AGENTS.map((agent) => ({ agent, state: "not-prepared", updatedAt }));

export class SessionProfileService {
  readonly events = new EventEmitter<SessionProfileServiceEvents>();
  private readonly store: SessionProfileStore;
  private readonly prepareStatusSource: SessionProfilePrepareStatusSource;
  private readonly imports: SessionProfileImports | undefined;

  constructor(options: SessionProfileServiceOptions) {
    this.store = options.store;
    this.prepareStatusSource = options.prepareStatus ?? notPrepared;
    this.imports = options.imports;
  }

  /** Prepares the store's root and sweeps leftovers of an interrupted write. */
  init(): Promise<void> {
    return this.store.init();
  }

  async list(): Promise<SessionProfileListResponse> {
    const { profiles, errors } = await this.store.list();
    return {
      profiles: profiles.map((profile) => this.summary(profile)).sort((a, b) => a.name.localeCompare(b.name)),
      errors
    };
  }

  async get(profileId: string): Promise<SessionProfileDetail> {
    return this.detail(await this.store.read(profileId));
  }

  async create(request: CreateSessionProfileRequest): Promise<SessionProfileDetail> {
    return this.changed(await this.store.create(request));
  }

  async update(profileId: string, request: UpdateSessionProfileRequest): Promise<SessionProfileDetail> {
    const { revision, ...patch } = request;
    return this.changed(await this.store.update(profileId, revision, patch));
  }

  async remove(profileId: string, revision: string): Promise<DeleteSessionProfileResponse> {
    await this.store.delete(profileId, revision);
    this.events.emit("deleted", { profileId });
    return { profileId, deleted: true };
  }

  /** The name a deleted profile had (durable across restarts); `undefined` when unknown. Never rejects. */
  deletedName(profileId: string): Promise<string | undefined> {
    return this.store.deletedName(profileId);
  }

  async duplicate(profileId: string, name?: string): Promise<SessionProfileDetail> {
    return this.changed(await this.store.duplicate(profileId, name));
  }

  async readItem(profileId: string, itemId: string): Promise<SessionProfileItemDetail> {
    const stored = await this.store.readItem(profileId, itemId);
    const item = toWireItem(stored.record, stored.cached === true);
    if (item === null) throw sessionProfileErrors.invalidItem(`Item "${itemId}" applies to no agent this build knows.`);
    switch (item.kind) {
      case "skill":
      case "command":
        return {
          kind: item.kind,
          item,
          document: stored.document ?? { frontmatter: {}, body: "" },
          ...(item.kind === "skill" ? { files: stored.files ?? [] } : {})
        };
      case "mcp":
        return { kind: "mcp", item, mcp: item.mcp };
      case "hook":
        return { kind: "hook", item, hook: item.hook };
      case "plugin":
        return { kind: "plugin", item, plugin: item.plugin };
    }
  }

  async createItem(profileId: string, revision: string, draft: SessionProfileItemDraft): Promise<SessionProfileMutationResponse> {
    const { profile, itemId } = await this.store.createItem(profileId, revision, draft);
    return { profile: this.changed(profile), itemId };
  }

  async updateItem(
    profileId: string,
    itemId: string,
    revision: string,
    draft: SessionProfileItemDraft
  ): Promise<SessionProfileMutationResponse> {
    return { profile: this.changed(await this.store.updateItem(profileId, itemId, revision, draft)), itemId };
  }

  async setItemEnabled(profileId: string, itemId: string, revision: string, enabled: boolean): Promise<SessionProfileMutationResponse> {
    return { profile: this.changed(await this.store.setItemEnabled(profileId, itemId, revision, enabled)), itemId };
  }

  async deleteItem(profileId: string, itemId: string, revision: string): Promise<SessionProfileMutationResponse> {
    return { profile: this.changed(await this.store.deleteItem(profileId, itemId, revision)) };
  }

  readInstructions(profileId: string): Promise<SessionProfileInstructionsResponse> {
    return this.store.readInstructions(profileId);
  }

  async writeInstructions(profileId: string, revision: string, text: string): Promise<SessionProfileDetail> {
    return this.changed(await this.store.writeInstructions(profileId, revision, text));
  }

  async prepareStatus(profileId: string): Promise<SessionProfilePrepareStatusResponse> {
    const { manifest } = await this.store.read(profileId);
    const revision = String(manifest.revision);
    return { profileId, revision, agents: this.prepareStatusSource({ profileId, revision, updatedAt: manifest.updatedAt }) };
  }

  // --- Filling a profile (spec §4.5; `imports.ts`) -----------------------------------------------

  globalSource(profileId: string, agent: SessionProfileAgentId): Promise<SessionProfileGlobalSourceResponse> {
    return this.requireImports().globalSource(profileId, agent);
  }

  async importFromGlobal(profileId: string, request: ImportSessionProfileFromGlobalRequest): Promise<SessionProfileImportResponse> {
    return this.imported(await this.requireImports().importFromGlobal(profileId, request));
  }

  scanGit(profileId: string, url: string): Promise<ProfileImportScanResponse> {
    return this.requireImports().scanGit(profileId, url);
  }

  /** `filePath` stays the caller's. */
  scanUpload(profileId: string, name: string, filePath: string): Promise<ProfileImportScanResponse> {
    return this.requireImports().scanUpload(profileId, name, filePath);
  }

  /** The refusals an upload gets before its body is read (no imports, no such profile). */
  async assertCanScanUpload(profileId: string): Promise<void> {
    await this.requireImports().assertCanScan(profileId);
  }

  /** The refusals a profile import gets before its body is read. */
  assertCanImportProfile(): void {
    this.requireImports();
  }

  async takeScan(profileId: string, importId: string, request: TakeSessionProfileImportRequest): Promise<SessionProfileImportResponse> {
    return this.imported(await this.requireImports().takeScan(profileId, importId, request));
  }

  async copyFrom(profileId: string, request: CopySessionProfileItemsRequest): Promise<SessionProfileImportResponse> {
    return this.imported(await this.requireImports().copyFrom(profileId, request));
  }

  async addPlugin(profileId: string, request: AddSessionProfilePluginRequest): Promise<SessionProfileImportResponse> {
    return this.imported(await this.requireImports().addPlugin(profileId, request));
  }

  /** The profile's portable `.zip` — no secret values (`export.ts`). */
  exportProfile(profileId: string): Promise<{ fileName: string; data: Buffer }> {
    return this.requireImports().exportProfile(profileId);
  }

  /** A NEW profile from an export `.zip` at `filePath` (the caller's file). */
  async importProfile(name: string, filePath: string): Promise<ImportSessionProfileResponse> {
    const { profile, notes } = await this.requireImports().importProfile(name, filePath);
    return { profile: this.changed(profile), notes };
  }

  private imported(result: StoredImportResult): SessionProfileImportResponse {
    return { profile: this.changed(result.profile), itemIds: result.itemIds, notes: result.notes };
  }

  private requireImports(): SessionProfileImports {
    if (this.imports === undefined) throw new SessionProfileError(503, "IMPORTS_UNAVAILABLE", "Imports are not available in this daemon.");
    return this.imports;
  }

  /**
   * What `agent` gets from the profile now — WITH secret values. For the preparation lifecycle
   * only: never return it from a route, never log it.
   */
  async resolveForAgent(profileId: string, agent: SessionProfileAgentId): Promise<ResolvedAgentProfile> {
    return resolveForAgent(await this.store.readSource(profileId), agent);
  }

  /**
   * The composer's catalog for a profile chat of `agent` whose live session has not reported its
   * own (`GET …/catalog`, source `profile`): the profile's enabled, in-scope skills and commands
   * as the agent loads them — Codex runs a command as a skill — plus the host's `/compact`.
   * Never a Global item. Throws as {@link resolveForAgent} does (`PROFILE_NOT_FOUND`, …).
   */
  async composerCatalog(profileId: string, agent: SessionProfileAgentId): Promise<{ slashCommands: SlashCommand[]; skills: Skill[] }> {
    const resolved = await this.resolveForAgent(profileId, agent);
    const described = (description: string | undefined) =>
      description !== undefined && description.trim().length > 0 ? { description: description.trim() } : {};
    const skills: Skill[] = resolved.skills.map((skill) => ({
      name: skill.name,
      path: skill.skillFile,
      enabled: true,
      scope: "profile",
      ...described(skill.description)
    }));
    const slashCommands: SlashCommand[] = [{ name: "compact", description: "Compact this conversation's context." }];
    for (const command of resolved.commands) {
      if (agent === "codex") {
        skills.push({ name: command.name, path: command.file, enabled: true, scope: "profile", ...described(command.description) });
        continue;
      }
      const hint = await commandArgumentHint(command.file);
      slashCommands.push({ name: command.name, ...described(command.description), ...(hint !== undefined ? { input: { hint } } : {}) });
    }
    return { slashCommands, skills };
  }

  private changed(profile: StoredSessionProfile): SessionProfileDetail {
    const detail = this.detail(profile);
    this.events.emit("changed", { profileId: detail.id, revision: detail.revision });
    return detail;
  }

  private summary(profile: StoredSessionProfile): SessionProfileSummary {
    const { manifest } = profile;
    const counts = Object.fromEntries(
      SESSION_PROFILE_ITEM_KINDS.map((kind) => [kind, { total: 0, enabled: 0 }])
    ) as Record<SessionProfileItemKind, SessionProfileItemCount>;
    for (const entry of profile.items) {
      if (!entry.ok) continue;
      const count = counts[entry.record.kind];
      count.total += 1;
      if (entry.record.enabled) count.enabled += 1;
    }
    const revision = String(manifest.revision);
    return {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
      description: manifest.description,
      revision,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      counts,
      hasInstructions: profile.hasInstructions,
      preparation: this.prepareStatusSource({ profileId: manifest.id, revision, updatedAt: manifest.updatedAt })
    };
  }

  private detail(profile: StoredSessionProfile): SessionProfileDetail {
    const items: SessionProfileItem[] = [];
    const itemErrors: SessionProfileItemError[] = [];
    for (const entry of profile.items) {
      if (!entry.ok) {
        itemErrors.push({ ...(entry.id ? { itemId: entry.id } : {}), message: entry.error });
        continue;
      }
      const item = toWireItem(entry.record, profile.cachedPlugins.has(entry.record.id));
      if (item === null) itemErrors.push({ itemId: entry.record.id, message: "It applies to no agent this build knows." });
      else items.push(item);
    }
    return {
      ...this.summary(profile),
      settings: resolveSessionProfileSettings(profile.manifest.settings),
      items,
      itemErrors
    };
  }
}

/** A stored record as the wire shows it — secret values masked. `null` when its scope names no known agent. */
function toWireItem(record: SessionProfileItemRecord, cached: boolean): SessionProfileItem | null {
  const agents = wireScope(record.agents);
  if (agents === null) return null;
  const unsupported: { agent: SessionProfileAgentId; reason: string }[] = [];
  for (const agent of agents === "all" ? SESSION_PROFILE_AGENTS : agents) {
    const reason = itemUnsupportedReason(record, agent);
    if (reason !== null) unsupported.push({ agent, reason });
  }
  const base = {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    agents,
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(unsupported.length > 0 ? { unsupported } : {}),
    ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {})
  };
  switch (record.kind) {
    case "skill":
    case "command":
      return { ...base, kind: record.kind };
    case "mcp":
      return { ...base, kind: "mcp", mcp: mcpView(record) };
    case "hook":
      return {
        ...base,
        kind: "hook",
        hook: {
          event: record.hook.event,
          ...(record.hook.matcher !== undefined ? { matcher: record.hook.matcher } : {}),
          command: record.hook.command,
          ...(record.hook.timeoutSec !== undefined ? { timeoutSec: record.hook.timeoutSec } : {})
        }
      };
    case "plugin":
      return {
        ...base,
        kind: "plugin",
        plugin: {
          name: record.name,
          ...(record.plugin.marketplace !== undefined ? { marketplace: record.plugin.marketplace } : {}),
          ...(record.plugin.version !== undefined ? { version: record.plugin.version } : {}),
          cached,
          ...(record.plugin.source !== undefined ? { source: pluginSourceView(record.plugin.source) } : {})
        }
      };
  }
}

/** A stored plugin provenance with only its known fields. */
function pluginSourceView(source: NonNullable<Extract<SessionProfileItemRecord, { kind: "plugin" }>["plugin"]["source"]>): SessionProfilePluginSource {
  return {
    type: source.type,
    ...(source.marketplace !== undefined ? { marketplace: source.marketplace } : {}),
    ...(source.commit !== undefined ? { commit: source.commit } : {}),
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    copiedAt: source.copiedAt
  };
}

/** The MCP server with its env and header KEYS only (`{key, set: true}`): values never leave the store. */
function mcpView(record: Extract<SessionProfileItemRecord, { kind: "mcp" }>): McpServerView {
  const { mcp } = record;
  return {
    name: record.name,
    transport: mcp.transport,
    ...(mcp.command !== undefined ? { command: mcp.command } : {}),
    ...(mcp.args !== undefined ? { args: [...mcp.args] } : {}),
    ...(mcp.cwd !== undefined ? { cwd: mcp.cwd } : {}),
    ...(mcp.envKeys && mcp.envKeys.length > 0 ? { env: mcp.envKeys.map((key) => ({ key, set: true as const })) } : {}),
    ...(mcp.url !== undefined ? { url: mcp.url } : {}),
    ...(mcp.headerKeys && mcp.headerKeys.length > 0 ? { headers: mcp.headerKeys.map((key) => ({ key, set: true as const })) } : {}),
    ...(mcp.advanced !== undefined ? { advanced: { ...mcp.advanced } } : {})
  };
}

/** A command file's `argument-hint`, when it has one that reads. */
async function commandArgumentHint(file: string): Promise<string | undefined> {
  try {
    const hint = parseMarkdownDocument(await readFile(file, "utf8")).frontmatter["argument-hint"];
    return typeof hint === "string" && hint.trim().length > 0 ? hint.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every change → the `/events` bus on {@link SESSION_PROFILES_CHANNEL}:
 * `sessionProfile.changed {profileId, revision}` and `sessionProfile.deleted {profileId}`.
 * (`sessionProfile.prepareStatus` is the preparation lifecycle's to publish.)
 */
export function publishSessionProfileEvents(service: SessionProfileService, broadcaster: Pick<Broadcaster, "publish">): void {
  service.events.on("changed", (payload) => broadcaster.publish(SESSION_PROFILES_CHANNEL, "sessionProfile.changed", payload));
  service.events.on("deleted", (payload) => broadcaster.publish(SESSION_PROFILES_CHANNEL, "sessionProfile.deleted", payload));
}
