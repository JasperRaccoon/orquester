/**
 * Agent Profiles — the on-disk profile store (spec §4.4). Every profile is one directory under
 * `sessionProfileSourcesDir(appdir)` laid out as `layout.ts` describes; this is the ONLY writer.
 *
 * - Concurrency: one optimistic `revision` per profile (the manifest's counter, a decimal string
 *   on the wire). Every mutation names the revision it was based on and bumps it; a stale one is
 *   409 `PROFILE_CONFLICT`. Mutations of one profile run one at a time (a per-profile queue held
 *   HERE, so every writer — the service, later the import and plugin flows — is serialized);
 *   creating, renaming and duplicating also hold a catalog-wide slot so profile names stay unique.
 * - Writes are atomic (`agent-profile/infra/fs-write.ts`: temp file, fsync, rename). An item
 *   mutation writes the item's content first, its secrets next, and the manifest LAST — the
 *   manifest write is the commit; a failure before it removes a new item's files again. A new or
 *   duplicated profile is built in a hidden temp directory and renamed into place; a deleted one
 *   is renamed away before it is removed.
 * - Secrets: MCP env/header VALUES live only in `secrets.json` (0600, in a 0700 directory) and
 *   are never returned by anything here except {@link SessionProfileStore.readSource}, whose
 *   result is for preparers only. Error messages never quote a value.
 * - Tolerance: an item that does not read is reported and kept verbatim (it can still be
 *   deleted); a profile whose manifest does not read is listed as an error and never rewritten.
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_HOOK_EVENTS,
  type SessionProfileImportConflictPolicy,
  type SessionProfileInstructionsMode,
  type SessionProfilePluginDraft,
  type SessionProfilePluginSource,
  SESSION_PROFILE_DESCRIPTION_MAX,
  SESSION_PROFILE_ICON_MAX,
  SESSION_PROFILE_NAME_MAX,
  isSessionProfileAgentId,
  isValidCommandName,
  isValidMcpServerName,
  isValidSkillName,
  sessionProfileScopeProblem,
  type HookDraft,
  type McpServerDraft,
  type SecretEntryDraft,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileItemDraft,
  type SessionProfileSettingsDraft
} from "@orquester/api";
import {
  SESSION_PROFILE_MANIFEST_VERSION,
  emptySessionProfileDeleted,
  emptySessionProfileSecrets,
  parseSessionProfileDeleted,
  parseSessionProfileManifest,
  parseSessionProfileSecrets,
  serializeSessionProfileDeleted,
  serializeSessionProfileManifest,
  serializeSessionProfileSecrets,
  sessionProfileDeletedFile,
  sessionProfileDir,
  sessionProfileIdSchema,
  sessionProfileSourcesDir,
  type SessionProfileDeletedFile,
  type SessionProfileItemEntry,
  type SessionProfileItemRecord,
  type SessionProfileItemSecrets,
  type SessionProfileManifestFile,
  type SessionProfileManifestRecord,
  type SessionProfileSecretsFile,
  type SessionProfileSettingsRecord
} from "@orquester/config";
import { ProfileBackups } from "../agent-profile/infra/backups.ts";
import { mergeFrontmatter, parseMarkdownDocument, serializeMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";
import { readTextIfExists, writeProfileFile, writeProfileFileVerified } from "../agent-profile/infra/fs-write.ts";
import { readSkillFiles } from "../agent-profile/infra/markdown-items.ts";
import { copyEntry, copyTree, isMissing } from "../agent-profile/infra/tree.ts";
import type { PortableMcpServer } from "../agent-profile/adapters/types.ts";
import { sessionProfileErrors as errors } from "./errors.ts";
import { PLUGIN_TREE_CAPS, SKILL_TREE_CAPS, measureTree, normalizeProfileModes, type ZipEntry } from "./files.ts";
import { PROFILE_DIR_MODE, PROFILE_FILE_MODE, profileLayout, type ProfileLayout } from "./layout.ts";
import type { SessionProfileSource } from "./resolve.ts";

/** A profile as read from disk — no secret values. */
export interface StoredSessionProfile {
  dir: string;
  manifest: SessionProfileManifestRecord;
  items: SessionProfileItemEntry[];
  hasInstructions: boolean;
  /** Plugin items whose cache directory holds files. */
  cachedPlugins: ReadonlySet<string>;
}

/** One item with its content: a skill's or command's document, a skill's other files. */
export interface StoredSessionProfileItem {
  record: SessionProfileItemRecord;
  document?: { frontmatter: Record<string, unknown>; body: string };
  files?: string[];
  /** A plugin's cache holds files. */
  cached?: boolean;
}

export interface CreateStoredProfileInput {
  name: string;
  icon?: string;
  description?: string;
  settings?: SessionProfileSettingsDraft;
}

export interface UpdateStoredProfileInput {
  name?: string;
  /** `null` (or `""`) clears it. */
  icon?: string | null;
  description?: string;
  settings?: SessionProfileSettingsDraft;
}

/**
 * One item an import, a copy or the plugin flow adds (`importItems`). Daemon-internal: an MCP
 * server carries REAL secret values — never serialize, log or return one.
 */
export type SessionProfileImportEntry =
  | {
      kind: "skill";
      name: string;
      agents: SessionProfileAgentScope;
      enabled?: boolean;
      /** `SKILL.md`'s frontmatter and body as the profile will store them (`name` is set to the item's). */
      frontmatter: Record<string, unknown>;
      body: string;
      /** The skill's directory: its other files are copied too (no symlinks, capped). */
      dir?: string;
    }
  | { kind: "command"; name: string; agents: SessionProfileAgentScope; enabled?: boolean; frontmatter: Record<string, unknown>; body: string }
  | { kind: "mcp"; agents: SessionProfileAgentScope; enabled?: boolean; server: PortableMcpServer }
  | { kind: "hook"; agent: SessionProfileAgentId; enabled?: boolean; name?: string; hook: HookDraft }
  | {
      kind: "plugin";
      agent: SessionProfileAgentId;
      enabled?: boolean;
      plugin: SessionProfilePluginDraft & { source?: SessionProfilePluginSource };
      /** The plugin's root directory (or, OpenCode, a directory holding its file): copied whole into the plugin cache. */
      dir: string;
    };

export interface SessionProfileImportOptions {
  onConflict: SessionProfileImportConflictPolicy;
  /** Instructions brought in with the items (`""` text with `replace` removes them). */
  instructions?: { text: string; mode: SessionProfileInstructionsMode };
}

/** A profile's portable copy (`readExport`): its manifest — no secret values anywhere — and its files. */
export interface SessionProfileExportContent {
  name: string;
  manifest: SessionProfileManifestFile;
  files: ZipEntry[];
}

/** Largest export, in bytes of file content. */
const EXPORT_MAX_BYTES = 200 * 1024 * 1024;

export interface SessionProfileStoreOptions {
  appdir: string;
  now?: () => Date;
  /** Mints profile and item ids (tests pin them). Must answer path-safe, unique ids. */
  newId?: () => string;
}

/** The queue key of the catalog-wide slot (never a valid profile id). */
const CATALOG = "*catalog*";

/** The queue key of `deleted.json` (never a valid profile id); taken inside a profile's slot, never around one. */
const DELETED = "*deleted*";

/** The store never keeps backups of its own files: the profile itself is the owner's data, and a backup would copy secrets around. */
class NoBackups extends ProfileBackups {
  constructor() {
    super({ dir: "" });
  }

  override async save(): Promise<string | null> {
    return null;
  }
}
const NO_BACKUPS = new NoBackups();
const WRITE = { backups: NO_BACKUPS, agent: "session-profiles", defaultMode: PROFILE_FILE_MODE };

/** Runs tasks one at a time per key. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

interface MutationState {
  layout: ProfileLayout;
  file: SessionProfileManifestFile;
  now: string;
  /** The secrets file, read on first use. */
  secrets(): Promise<SessionProfileSecretsFile>;
  /** Set when the secrets file must be written before the manifest. */
  secretsDirty: boolean;
  /** Undo steps for files a failed mutation wrote before its commit. */
  rollback: (() => Promise<void>)[];
  /** Cleanups after the commit (a deleted item's files). Best effort. */
  afterCommit: (() => Promise<void>)[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function entryId(entry: SessionProfileItemEntry): string | undefined {
  return entry.ok ? entry.record.id : entry.id;
}

function scopesOverlap(a: SessionProfileItemRecord["agents"], b: SessionProfileItemRecord["agents"]): boolean {
  return a === "all" || b === "all" || a.some((agent) => b.includes(agent));
}

/** Copies `value` without the keys in `drop` (to rebuild a record while keeping its unknown fields). */
function without<T extends Record<string, unknown>>(value: T | undefined, drop: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (!drop.includes(key)) out[key] = entry;
  }
  return out;
}

async function dirHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export class SessionProfileStore {
  private readonly appdir: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly queue = new KeyedQueue();

  constructor(options: SessionProfileStoreOptions) {
    this.appdir = options.appdir;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** The directory every profile lives in. */
  get root(): string {
    return sessionProfileSourcesDir(this.appdir);
  }

  /** Creates the root (0700) and removes what an interrupted create, duplicate or delete left behind. */
  async init(): Promise<void> {
    await this.ensureRoot();
    for (const name of await readdir(this.root)) {
      if (name.startsWith(".tmp-") || name.startsWith(".trash-")) {
        await rm(join(this.root, name), { recursive: true, force: true });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every profile; one that cannot be read is an error entry, never a failed list. */
  async list(): Promise<{ profiles: StoredSessionProfile[]; errors: { profileId: string; message: string }[] }> {
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
        .map((dirent) => dirent.name)
        .sort();
    } catch (error) {
      if (isMissing(error)) return { profiles: [], errors: [] };
      throw error;
    }
    const profiles: StoredSessionProfile[] = [];
    const listErrors: { profileId: string; message: string }[] = [];
    for (const name of names) {
      try {
        profiles.push(await this.read(name));
      } catch (error) {
        listErrors.push({ profileId: name, message: message(error) });
      }
    }
    return { profiles, errors: listErrors };
  }

  /** One profile. 404 `PROFILE_NOT_FOUND`; 500 `PROFILE_UNREADABLE` when its manifest does not read. */
  async read(profileId: string): Promise<StoredSessionProfile> {
    const layout = this.layout(profileId);
    return this.readStored(layout, await this.readManifest(profileId, layout));
  }

  /** One item with its content. */
  async readItem(profileId: string, itemId: string): Promise<StoredSessionProfileItem> {
    const layout = this.layout(profileId);
    const file = await this.readManifest(profileId, layout);
    const entry = file.items.find((candidate) => entryId(candidate) === itemId);
    if (!entry) throw errors.itemNotFound(itemId);
    if (!entry.ok) throw errors.invalidItem(`Item "${itemId}" could not be read: ${entry.error}`);
    const record = entry.record;
    switch (record.kind) {
      case "skill":
        return {
          record,
          document: await this.readDocument(layout.skillFile(record.id)),
          files: (await readSkillFiles(layout.skillDir(record.id))).filter((path) => path !== "SKILL.md")
        };
      case "command":
        return { record, document: await this.readDocument(layout.commandFile(record.id)) };
      case "plugin":
        return { record, cached: await dirHasEntries(layout.pluginCacheDir(record.id)) };
      default:
        return { record };
    }
  }

  /** The instructions (`""` when there are none) and the profile's revision. */
  async readInstructions(profileId: string): Promise<{ text: string; revision: string }> {
    return this.queue.run(profileId, async () => {
      const layout = this.layout(profileId);
      const file = await this.readManifest(profileId, layout);
      return { text: (await readTextIfExists(layout.instructions)) ?? "", revision: String(file.manifest.revision) };
    });
  }

  /**
   * Everything a preparer needs, read as one consistent snapshot (under the profile's queue) —
   * WITH secret values. Throws `PROFILE_UNREADABLE` when the secrets file does not read: a
   * profile chat must never launch with an MCP server silently missing its credentials.
   */
  async readSource(profileId: string): Promise<SessionProfileSource> {
    return this.queue.run(profileId, () => this.readSourceNow(profileId));
  }

  /**
   * {@link readSource} plus a private copy of the chosen items' content, all taken in ONE turn of
   * the profile's queue, so an edit of the profile cannot tear it (copy from profile): the skill
   * and plugin directories are copied into `into` with the profile's layout (`skills/<id>/`,
   * `plugins/<id>/`) and the skill and command documents are parsed. The answer's `dir` is
   * `into`. Ids the profile does not have are skipped (the caller reports them).
   */
  async snapshotSource(
    profileId: string,
    itemIds: readonly string[],
    into: string
  ): Promise<{ source: SessionProfileSource; documents: Map<string, { frontmatter: Record<string, unknown>; body: string }> }> {
    return this.queue.run(profileId, async () => {
      const source = await this.readSourceNow(profileId);
      const layout = this.layout(profileId);
      const copy = profileLayout(into);
      const documents = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();
      const copyDir = async (src: string, dest: string): Promise<void> => {
        if ((await lstat(src).catch(() => null)) === null) return;
        await copyTree(src, dest, { refuseSymlinks: true });
      };
      for (const itemId of new Set(itemIds)) {
        const entry = source.items.find((candidate) => entryId(candidate) === itemId);
        if (entry === undefined || !entry.ok) continue;
        const { kind } = entry.record;
        if (kind === "skill") {
          documents.set(itemId, await this.readDocument(layout.skillFile(itemId)));
          await copyDir(layout.skillDir(itemId), copy.skillDir(itemId));
        } else if (kind === "command") {
          documents.set(itemId, await this.readDocument(layout.commandFile(itemId)));
        } else if (kind === "plugin") {
          await copyDir(layout.pluginCacheDir(itemId), copy.pluginCacheDir(itemId));
        }
      }
      return { source: { ...source, dir: into }, documents };
    });
  }

  private async readSourceNow(profileId: string): Promise<SessionProfileSource> {
    const layout = this.layout(profileId);
    const file = await this.readManifest(profileId, layout);
    const secrets = await this.readSecrets(profileId, layout);
    const missingContent = new Set<string>();
    for (const entry of file.items) {
      if (!entry.ok) continue;
      const { id, kind } = entry.record;
      const present =
        kind === "skill"
          ? await fileExists(layout.skillFile(id))
          : kind === "command"
            ? await fileExists(layout.commandFile(id))
            : kind === "plugin"
              ? await dirHasEntries(layout.pluginCacheDir(id))
              : true;
      if (!present) missingContent.add(id);
    }
    return {
      profileId,
      revision: String(file.manifest.revision),
      name: file.manifest.name,
      dir: layout.dir,
      settings: file.manifest.settings,
      instructions: (await readTextIfExists(layout.instructions)) ?? "",
      items: file.items,
      secrets: secrets.items,
      missingContent
    };
  }

  /** The name a deleted profile had when it was deleted (`deleted.json`); `undefined` when unknown. Never throws. */
  async deletedName(profileId: string): Promise<string | undefined> {
    const file = await this.readDeleted().catch(() => null);
    return file !== null && Object.hasOwn(file.profiles, profileId) ? file.profiles[profileId]!.name : undefined;
  }

  /** A plugin item's cache slot: where the plugin flow puts its files (spec §4.5). */
  pluginCacheDir(profileId: string, itemId: string): string {
    return this.layout(profileId).pluginCacheDir(itemId);
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  async create(input: CreateStoredProfileInput): Promise<StoredSessionProfile> {
    return this.queue.run(CATALOG, async () => {
      const name = profileName(input.name);
      await this.assertNameFree(name);
      const id = this.newId();
      const now = this.now().toISOString();
      const manifest: SessionProfileManifestRecord = {
        version: SESSION_PROFILE_MANIFEST_VERSION,
        id,
        name,
        ...iconField(input.icon),
        description: profileDescription(input.description ?? ""),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        settings: mergeSettings({}, input.settings)
      };
      await this.materialize(id, async (tmp) => {
        await this.writeManifest(profileLayout(tmp), { manifest, items: [] });
      });
      return this.read(id);
    });
  }

  async update(profileId: string, revision: string, patch: UpdateStoredProfileInput): Promise<StoredSessionProfile> {
    const apply = () =>
      this.mutate(profileId, revision, async (state) => {
        const manifest = state.file.manifest;
        if (patch.name !== undefined) {
          const name = profileName(patch.name);
          if (name.toLowerCase() !== manifest.name.toLowerCase()) await this.assertNameFree(name, profileId);
          manifest.name = name;
        }
        if (patch.icon !== undefined) {
          delete manifest.icon;
          Object.assign(manifest, iconField(patch.icon ?? undefined));
        }
        if (patch.description !== undefined) manifest.description = profileDescription(patch.description);
        if (patch.settings !== undefined) manifest.settings = mergeSettings(manifest.settings, patch.settings);
      });
    const { profile } = patch.name !== undefined ? await this.queue.run(CATALOG, apply) : await apply();
    return profile;
  }

  async delete(profileId: string, revision: string): Promise<void> {
    await this.queue.run(profileId, async () => {
      const layout = this.layout(profileId);
      const file = await this.readManifest(profileId, layout);
      if (String(file.manifest.revision) !== revision) throw errors.conflict();
      // Its name first (kept for good): a chat of this profile falls back to Global at its next
      // start, maybe after a restart, with a notice that names the profile (spec §5.6).
      await this.queue.run(DELETED, () => this.recordDeleted(profileId, file.manifest.name));
      const trash = join(this.root, `.trash-${profileId}-${randomUUID()}`);
      await rename(layout.dir, trash);
      await rm(trash, { recursive: true, force: true });
    });
  }

  /** A full copy — items, instructions, secrets, plugin cache — under a new id and name. */
  async duplicate(profileId: string, name?: string): Promise<StoredSessionProfile> {
    return this.queue.run(CATALOG, () =>
      this.queue.run(profileId, async () => {
        const source = this.layout(profileId);
        const file = await this.readManifest(profileId, source);
        const newName = name !== undefined ? profileName(name) : await this.copyName(file.manifest.name);
        await this.assertNameFree(newName);
        const id = this.newId();
        const now = this.now().toISOString();
        await this.materialize(id, async (tmp) => {
          await rm(tmp, { recursive: true, force: true });
          await copyEntry(source.dir, tmp, { symlinks: "preserve" });
          await chmod(tmp, PROFILE_DIR_MODE);
          const manifest = { ...file.manifest, id, name: newName, revision: 1, createdAt: now, updatedAt: now };
          await this.writeManifest(profileLayout(tmp), { manifest, items: file.items });
        });
        return this.read(id);
      })
    );
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async createItem(
    profileId: string,
    revision: string,
    draft: SessionProfileItemDraft
  ): Promise<{ profile: StoredSessionProfile; itemId: string }> {
    const { profile, result } = await this.mutate(profileId, revision, async (state) => {
      const id = this.newId();
      const record = await this.applyDraft(state, id, null, draft);
      state.file.items.push({ ok: true, record });
      return id;
    });
    return { profile, itemId: result };
  }

  async updateItem(
    profileId: string,
    itemId: string,
    revision: string,
    draft: SessionProfileItemDraft
  ): Promise<StoredSessionProfile> {
    const { profile } = await this.mutate(profileId, revision, async (state) => {
      const index = this.itemIndex(state.file, itemId);
      const entry = state.file.items[index]!;
      if (!entry.ok) throw errors.invalidItem(`Item "${itemId}" could not be read; delete it instead.`);
      if (entry.record.kind !== draft.kind) throw errors.invalidItem(`Item "${itemId}" is a ${entry.record.kind}, not a ${draft.kind}.`);
      state.file.items[index] = { ok: true, record: await this.applyDraft(state, itemId, entry.record, draft) };
    });
    return profile;
  }

  async setItemEnabled(profileId: string, itemId: string, revision: string, enabled: boolean): Promise<StoredSessionProfile> {
    const { profile } = await this.mutate(profileId, revision, async (state) => {
      const entry = state.file.items[this.itemIndex(state.file, itemId)]!;
      if (!entry.ok) throw errors.invalidItem(`Item "${itemId}" could not be read; delete it instead.`);
      entry.record.enabled = enabled;
      entry.record.updatedAt = state.now;
    });
    return profile;
  }

  /** Removes the item — an unreadable one too — then its files and secrets. */
  async deleteItem(profileId: string, itemId: string, revision: string): Promise<StoredSessionProfile> {
    const { profile } = await this.mutate(profileId, revision, async (state) => {
      const [entry] = state.file.items.splice(this.itemIndex(state.file, itemId), 1);
      const { layout } = state;
      const kind = entry?.ok ? entry.record.kind : undefined;
      state.afterCommit.push(async () => {
        if (kind === undefined || kind === "skill") await rm(layout.skillDir(itemId), { recursive: true, force: true });
        if (kind === undefined || kind === "command") await rm(layout.commandFile(itemId), { force: true });
        if (kind === undefined || kind === "plugin") await rm(layout.pluginCacheDir(itemId), { recursive: true, force: true });
        const secrets = await state.secrets();
        if (itemId in secrets.items || itemId in secrets.unreadable) {
          delete secrets.items[itemId];
          delete secrets.unreadable[itemId];
          await this.writeSecrets(layout, secrets);
        }
      });
    });
    return profile;
  }

  /** `""` removes the instructions. */
  async writeInstructions(profileId: string, revision: string, text: string): Promise<StoredSessionProfile> {
    const { profile } = await this.mutate(profileId, revision, async (state) => {
      if (text === "") {
        await rm(state.layout.instructions, { force: true });
      } else {
        await writeProfileFile(state.layout.instructions, text, WRITE);
      }
    });
    return profile;
  }

  // -------------------------------------------------------------------------
  // Imports, copies, plugins, export (spec §4.5)
  // -------------------------------------------------------------------------

  /**
   * Adds `entries` (and the instructions) to the profile in ONE mutation: one revision bump, all
   * or nothing. A name the profile already has for an overlapping scope follows
   * `options.onConflict` (`fail` refuses the whole import); every rename, replace or skip is a
   * note. Skill and plugin directories are copied without symlinks, capped, with the profile's
   * modes; MCP secret values go to the secrets file.
   */
  async importItems(
    profileId: string,
    revision: string,
    entries: readonly SessionProfileImportEntry[],
    options: SessionProfileImportOptions
  ): Promise<{ profile: StoredSessionProfile; itemIds: string[]; notes: string[] }> {
    const { profile, result } = await this.mutate(profileId, revision, async (state) => {
      const itemIds: string[] = [];
      const notes: string[] = [];
      if (options.instructions !== undefined) await this.importInstructions(state, options.instructions);
      for (const entry of entries) {
        const kind = entry.kind;
        const agents = importScope(entry);
        let name = importName(entry);
        const clashes = this.clashing(state.file, entry, name, agents);
        if (clashes.length > 0) {
          const label = `${KIND_WORD[kind]} "${name}"`;
          // A plugin cannot be kept twice, nor can the same hook: keep-both skips them.
          const policy = options.onConflict === "keep-both" && (kind === "plugin" || kind === "hook") ? "skip" : options.onConflict;
          if (policy === "fail") throw errors.itemExists(KIND_WORD[kind], name);
          if (policy === "skip") {
            notes.push(`Skipped the ${label}: the profile already has it.`);
            continue;
          }
          if (policy === "replace") {
            for (const clash of clashes) this.dropItem(state, clash);
            notes.push(`Replaced the profile's ${label}.`);
          } else if (kind !== "hook" && kind !== "plugin") {
            // keep-both
            const free = this.freeName(state.file, kind, name, agents);
            notes.push(`Added the ${label} as "${free}": the profile already has one.`);
            name = free;
          }
        }
        const id = this.newId();
        const record = await this.applyImport(state, id, entry, name, agents);
        state.file.items.push({ ok: true, record });
        itemIds.push(id);
      }
      return { itemIds, notes };
    });
    return { profile, ...result };
  }

  /**
   * The profile as its export holds it, read under its queue: the manifest (unreadable items left
   * out) and every file of its readable items and instructions. Never `secrets.json`.
   */
  async readExport(profileId: string): Promise<SessionProfileExportContent> {
    return this.queue.run(profileId, async () => {
      const layout = this.layout(profileId);
      const file = await this.readManifest(profileId, layout);
      const items = file.items.filter((entry): entry is Extract<SessionProfileItemEntry, { ok: true }> => entry.ok);
      const files: ZipEntry[] = [];
      let bytes = 0;
      const add = async (path: string, rel: string): Promise<void> => {
        let st;
        try {
          st = await lstat(path);
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        if (st.isDirectory()) {
          for (const name of (await readdir(path)).sort()) await add(join(path, name), `${rel}/${name}`);
        } else if (st.isFile()) {
          bytes += st.size;
          if (bytes > EXPORT_MAX_BYTES) throw errors.invalid(`The profile is larger than ${EXPORT_MAX_BYTES / 1024 / 1024} MB and cannot be exported.`);
          files.push({ path: rel, data: await readFile(path), mode: st.mode & 0o777 });
        }
        // Symlinks and special files are never part of a profile (see `files.ts`): left out.
      };
      await add(layout.instructions, "instructions.md");
      for (const { record } of items) {
        if (record.kind === "skill") await add(layout.skillDir(record.id), `skills/${record.id}`);
        else if (record.kind === "command") await add(layout.commandFile(record.id), `commands/${record.id}.md`);
        else if (record.kind === "plugin") await add(layout.pluginCacheDir(record.id), `plugins/${record.id}`);
      }
      return { name: file.manifest.name, manifest: { manifest: { ...file.manifest }, items }, files };
    });
  }

  /**
   * A NEW profile from an export already extracted to `dir` and validated (`export.ts`): its
   * items and files, a fresh id, revision 1, its name made unique. No secrets file: MCP secret
   * values are never in an export.
   */
  async createFromExport(dir: string, source: SessionProfileManifestFile): Promise<StoredSessionProfile> {
    return this.queue.run(CATALOG, async () => {
      const wanted = profileName(source.manifest.name);
      const { profiles } = await this.list();
      const taken = profiles.some((profile) => profile.manifest.name.toLowerCase() === wanted.toLowerCase());
      const name = taken ? await this.copyName(wanted) : wanted;
      const id = this.newId();
      const now = this.now().toISOString();
      await this.materialize(id, async (tmp) => {
        const target = profileLayout(tmp);
        const from = profileLayout(dir);
        const copy = async (src: string, dest: string): Promise<void> => {
          if ((await lstat(src).catch(() => null)) === null) return;
          await mkdir(join(dest, ".."), { recursive: true, mode: PROFILE_DIR_MODE });
          await copyTree(src, dest, { refuseSymlinks: true });
        };
        await copy(from.instructions, target.instructions);
        for (const entry of source.items) {
          if (!entry.ok) continue;
          const { record } = entry;
          if (record.kind === "skill") await copy(from.skillDir(record.id), target.skillDir(record.id));
          else if (record.kind === "command") await copy(from.commandFile(record.id), target.commandFile(record.id));
          else if (record.kind === "plugin") await copy(from.pluginCacheDir(record.id), target.pluginCacheDir(record.id));
        }
        await normalizeProfileModes(tmp);
        const manifest: SessionProfileManifestRecord = {
          ...source.manifest,
          version: SESSION_PROFILE_MANIFEST_VERSION,
          id,
          name,
          revision: 1,
          createdAt: now,
          updatedAt: now
        };
        await this.writeManifest(target, { manifest, items: source.items });
      });
      return this.read(id);
    });
  }

  /** The instructions brought by an import: replace them, or append below the profile's own. Undone on a failed mutation. */
  private async importInstructions(state: MutationState, input: { text: string; mode: SessionProfileInstructionsMode }): Promise<void> {
    const path = state.layout.instructions;
    const current = await readTextIfExists(path);
    const next =
      input.mode === "replace" || current === null || current.trim() === ""
        ? input.text
        : input.text.trim() === ""
          ? current
          : `${current.replace(/\s+$/, "")}\n\n${input.text}`;
    state.rollback.push(async () => {
      if (current === null) await rm(path, { force: true });
      else await writeProfileFile(path, current, WRITE);
    });
    if (next === "") await rm(path, { force: true });
    else await writeProfileFile(path, next, WRITE);
  }

  /** The profile's readable items an imported one clashes with (see {@link SessionProfileImportConflictPolicy}). */
  private clashing(
    file: SessionProfileManifestFile,
    entry: SessionProfileImportEntry,
    name: string,
    agents: SessionProfileItemRecord["agents"]
  ): string[] {
    const ids: string[] = [];
    for (const candidate of file.items) {
      if (!candidate.ok) continue;
      const { record } = candidate;
      if (record.kind !== entry.kind || !scopesOverlap(record.agents, agents)) continue;
      const same =
        entry.kind === "hook" && record.kind === "hook"
          ? record.hook.event === entry.hook.event &&
            (record.hook.matcher ?? "") === (entry.hook.matcher ?? "") &&
            record.hook.command === entry.hook.command
          : record.name === name;
      if (same) ids.push(record.id);
    }
    return ids;
  }

  /** Removes an item inside a mutation; its files and secrets go after the commit (as `deleteItem`). */
  private dropItem(state: MutationState, itemId: string): void {
    const index = state.file.items.findIndex((entry) => entryId(entry) === itemId);
    if (index < 0) return;
    const [entry] = state.file.items.splice(index, 1);
    const kind = entry?.ok ? entry.record.kind : undefined;
    const { layout } = state;
    state.afterCommit.push(async () => {
      if (kind === "skill") await rm(layout.skillDir(itemId), { recursive: true, force: true });
      if (kind === "command") await rm(layout.commandFile(itemId), { force: true });
      if (kind === "plugin") await rm(layout.pluginCacheDir(itemId), { recursive: true, force: true });
      const secrets = await state.secrets();
      if (itemId in secrets.items) {
        delete secrets.items[itemId];
        await this.writeSecrets(layout, secrets);
      }
    });
  }

  /** `name-2`, `name-3`… — the first the kind's name rule accepts and no overlapping item has. */
  private freeName(
    file: SessionProfileManifestFile,
    kind: "mcp" | "skill" | "command",
    name: string,
    agents: SessionProfileItemRecord["agents"]
  ): string {
    const valid = kind === "mcp" ? isValidMcpServerName : kind === "skill" ? isValidSkillName : isValidCommandName;
    const taken = (candidate: string) =>
      file.items.some((entry) => entry.ok && entry.record.kind === kind && entry.record.name === candidate && scopesOverlap(entry.record.agents, agents));
    for (let n = 2; n < 10_000; n += 1) {
      const suffix = `-${n}`;
      const candidate = `${name.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
      if (valid(candidate) && !taken(candidate)) return candidate;
    }
    throw errors.itemExists(KIND_WORD[kind], name);
  }

  /** Writes one imported item's content through {@link applyDraft} (its validation, its rollback) and answers its record. */
  private async applyImport(
    state: MutationState,
    id: string,
    entry: SessionProfileImportEntry,
    name: string,
    agents: SessionProfileItemRecord["agents"]
  ): Promise<SessionProfileItemRecord> {
    const { layout } = state;
    const enabled = entry.enabled !== undefined ? { enabled: entry.enabled } : {};
    const scope = agents as SessionProfileAgentScope;
    switch (entry.kind) {
      case "skill": {
        if (entry.dir !== undefined) {
          await measureTree(entry.dir, SKILL_TREE_CAPS, `The skill "${name}"`);
          await mkdir(layout.skillsDir, { recursive: true, mode: PROFILE_DIR_MODE });
          state.rollback.push(() => rm(layout.skillDir(id), { recursive: true, force: true }));
          await copyTree(entry.dir, layout.skillDir(id), { refuseSymlinks: true });
          await normalizeProfileModes(layout.skillDir(id));
        }
        return this.applyDraft(state, id, null, {
          kind: "skill",
          agents: scope,
          ...enabled,
          document: { name, frontmatter: entry.frontmatter, body: entry.body }
        });
      }
      case "command":
        return this.applyDraft(state, id, null, {
          kind: "command",
          agents: scope,
          ...enabled,
          document: { name, frontmatter: entry.frontmatter, body: entry.body }
        });
      case "mcp": {
        const server = entry.server;
        const secrets = (values: Record<string, string> | undefined) =>
          values === undefined ? undefined : Object.entries(values).map(([key, value]) => ({ key, value }));
        const mcp: McpServerDraft =
          server.transport === "stdio"
            ? {
                name,
                transport: "stdio",
                ...(server.command !== undefined ? { command: server.command } : {}),
                ...(server.args !== undefined ? { args: [...server.args] } : {}),
                ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
                ...(server.env !== undefined ? { env: secrets(server.env) } : {}),
                ...(server.advanced !== undefined ? { advanced: { ...server.advanced } } : {})
              }
            : {
                name,
                transport: server.transport,
                ...(server.url !== undefined ? { url: server.url } : {}),
                ...(server.headers !== undefined ? { headers: secrets(server.headers) } : {}),
                ...(server.advanced !== undefined ? { advanced: { ...server.advanced } } : {})
              };
        return this.applyDraft(state, id, null, { kind: "mcp", agents: scope, ...enabled, mcp });
      }
      case "hook":
        return this.applyDraft(state, id, null, {
          kind: "hook",
          agents: [entry.agent],
          ...enabled,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          hook: entry.hook
        });
      case "plugin": {
        await measureTree(entry.dir, PLUGIN_TREE_CAPS, `The plugin "${name}"`);
        const { source, ...draft } = entry.plugin;
        const record = await this.applyDraft(state, id, null, { kind: "plugin", agents: [entry.agent], ...enabled, plugin: { ...draft, name } });
        // `applyDraft` made the empty cache slot (and its rollback); the plugin's files take its place.
        const cacheDir = layout.pluginCacheDir(id);
        await rm(cacheDir, { recursive: true, force: true });
        await copyTree(entry.dir, cacheDir, { refuseSymlinks: true });
        await normalizeProfileModes(cacheDir);
        if (record.kind !== "plugin") return record;
        return { ...record, plugin: { ...record.plugin, ...(source !== undefined ? { source: { ...source } } : {}) } };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private layout(profileId: string): ProfileLayout {
    if (!sessionProfileIdSchema.safeParse(profileId).success) throw errors.notFound(profileId);
    return profileLayout(sessionProfileDir(this.appdir, profileId));
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: PROFILE_DIR_MODE });
    await chmod(this.root, PROFILE_DIR_MODE);
  }

  /** Builds a new profile directory in a hidden temp dir, then renames it into place. */
  private async materialize(id: string, build: (tmp: string) => Promise<void>): Promise<void> {
    await this.ensureRoot();
    const tmp = join(this.root, `.tmp-${id}-${randomUUID()}`);
    try {
      await mkdir(tmp, { mode: PROFILE_DIR_MODE });
      await build(tmp);
      await rename(tmp, this.layout(id).dir);
    } catch (error) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readManifest(profileId: string, layout: ProfileLayout): Promise<SessionProfileManifestFile> {
    let text: string | null;
    try {
      text = await readTextIfExists(layout.manifest);
    } catch (error) {
      throw errors.unreadable(profileId, message(error));
    }
    if (text === null) {
      try {
        await stat(layout.dir);
      } catch {
        throw errors.notFound(profileId);
      }
      throw errors.unreadable(profileId, "its profile.json is missing.");
    }
    let file: SessionProfileManifestFile;
    try {
      file = parseSessionProfileManifest(JSON.parse(text));
    } catch (error) {
      throw errors.unreadable(profileId, message(error));
    }
    if (file.manifest.id !== profileId) throw errors.unreadable(profileId, "its manifest names another profile id.");
    return file;
  }

  private async readStored(layout: ProfileLayout, file: SessionProfileManifestFile): Promise<StoredSessionProfile> {
    const instructions = await stat(layout.instructions).catch(() => null);
    const cachedPlugins = new Set<string>();
    for (const entry of file.items) {
      if (entry.ok && entry.record.kind === "plugin" && (await dirHasEntries(layout.pluginCacheDir(entry.record.id)))) {
        cachedPlugins.add(entry.record.id);
      }
    }
    return {
      dir: layout.dir,
      manifest: file.manifest,
      items: file.items,
      hasInstructions: instructions !== null && instructions.isFile() && instructions.size > 0,
      cachedPlugins
    };
  }

  private async readSecrets(profileId: string, layout: ProfileLayout): Promise<SessionProfileSecretsFile> {
    const text = await readTextIfExists(layout.secrets);
    if (text === null) return emptySessionProfileSecrets();
    try {
      return parseSessionProfileSecrets(JSON.parse(text));
    } catch {
      // Never the parser's message: it could quote a value.
      throw errors.unreadable(profileId, "its secrets.json does not read.");
    }
  }

  /** `deleted.json`: empty when missing; throws when it does not read (another version's, damaged). */
  private async readDeleted(): Promise<SessionProfileDeletedFile> {
    const text = await readTextIfExists(sessionProfileDeletedFile(this.appdir));
    return text === null ? emptySessionProfileDeleted() : parseSessionProfileDeleted(JSON.parse(text));
  }

  /** Adds a deleted profile's name to `deleted.json`. A file that does not read is left alone (the notice then names no profile). */
  private async recordDeleted(profileId: string, name: string): Promise<void> {
    let file: SessionProfileDeletedFile;
    try {
      file = await this.readDeleted();
    } catch {
      return;
    }
    delete file.unreadable[profileId];
    file.profiles[profileId] = { ...file.profiles[profileId], name, deletedAt: this.now().toISOString() };
    await writeProfileFile(sessionProfileDeletedFile(this.appdir), serializeSessionProfileDeleted(file), WRITE);
  }

  private async writeManifest(layout: ProfileLayout, file: SessionProfileManifestFile): Promise<void> {
    await writeProfileFileVerified(layout.manifest, serializeSessionProfileManifest(file), {
      ...WRITE,
      verify: (text) => parseSessionProfileManifest(JSON.parse(text))
    });
  }

  private async writeSecrets(layout: ProfileLayout, file: SessionProfileSecretsFile): Promise<void> {
    // A write keeps an existing file's mode: make sure that mode is 0600 first.
    await chmod(layout.secrets, PROFILE_FILE_MODE).catch(() => undefined);
    await writeProfileFile(layout.secrets, serializeSessionProfileSecrets(file), WRITE);
  }

  private async readDocument(path: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    const text = await readTextIfExists(path);
    if (text === null) return { frontmatter: {}, body: "" };
    try {
      const { frontmatter, body } = parseMarkdownDocument(text);
      return { frontmatter, body };
    } catch (error) {
      throw errors.invalidItem(`The item's file does not parse: ${message(error)}`);
    }
  }

  /** Runs one mutation of a profile under its queue: revision check, change, secrets, manifest (the commit). */
  private mutate<T>(
    profileId: string,
    revision: string,
    change: (state: MutationState) => Promise<T>
  ): Promise<{ profile: StoredSessionProfile; result: T }> {
    return this.queue.run(profileId, async () => {
      const layout = this.layout(profileId);
      const file = await this.readManifest(profileId, layout);
      if (String(file.manifest.revision) !== revision) throw errors.conflict();
      let secrets: SessionProfileSecretsFile | null = null;
      const state: MutationState = {
        layout,
        file,
        now: this.now().toISOString(),
        secrets: async () => (secrets ??= await this.readSecrets(profileId, layout)),
        secretsDirty: false,
        rollback: [],
        afterCommit: []
      };
      let result: T;
      try {
        result = await change(state);
        if (state.secretsDirty && secrets !== null) await this.writeSecrets(layout, secrets);
        file.manifest.revision += 1;
        file.manifest.updatedAt = state.now;
        await this.writeManifest(layout, file);
      } catch (error) {
        for (const undo of state.rollback.reverse()) await undo().catch(() => undefined);
        throw error;
      }
      for (const cleanup of state.afterCommit) await cleanup().catch(() => undefined);
      return { profile: await this.readStored(layout, file), result };
    });
  }

  private itemIndex(file: SessionProfileManifestFile, itemId: string): number {
    const index = file.items.findIndex((entry) => entryId(entry) === itemId);
    if (index < 0) throw errors.itemNotFound(itemId);
    return index;
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const { profiles } = await this.list();
    const lower = name.toLowerCase();
    if (profiles.some((profile) => profile.manifest.id !== exceptId && profile.manifest.name.toLowerCase() === lower)) {
      throw errors.nameTaken(name);
    }
  }

  private async copyName(name: string): Promise<string> {
    const { profiles } = await this.list();
    const taken = new Set(profiles.map((profile) => profile.manifest.name.toLowerCase()));
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? " copy" : ` copy ${n}`;
      const candidate = `${name.slice(0, SESSION_PROFILE_NAME_MAX - suffix.length)}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /**
   * Validates `draft` against the profile and writes the item's content (skill / command
   * document, secrets into the pending secrets file, a plugin's empty cache slot). Answers the
   * record to store; `existing` is the stored record on an update (its unknown fields survive).
   */
  private async applyDraft(
    state: MutationState,
    id: string,
    existing: SessionProfileItemRecord | null,
    draft: SessionProfileItemDraft
  ): Promise<SessionProfileItemRecord> {
    const agents = draft.agents ?? existing?.agents ?? "all";
    if (draft.agents !== undefined || existing === null) {
      const problem = sessionProfileScopeProblem(draft.kind, agents);
      if (problem !== null) throw errors.invalidItem(problem);
    }
    const base = {
      ...without(existing ?? undefined, ["mcp", "hook", "plugin", "description"]),
      id,
      enabled: draft.enabled ?? existing?.enabled ?? true,
      agents,
      createdAt: existing?.createdAt ?? state.now,
      updatedAt: state.now
    };
    const { layout } = state;

    switch (draft.kind) {
      case "skill":
      case "command": {
        const name = draft.document.name;
        if (draft.kind === "skill" ? !isValidSkillName(name) : !isValidCommandName(name)) {
          throw errors.invalidName(
            `"${name}" is not a valid ${draft.kind} name: use lowercase letters, digits and single hyphens${
              draft.kind === "command" ? ', with at most one "/" folder level' : ""
            }.`
          );
        }
        this.assertUnique(state.file, draft.kind, name, agents, id);
        const path = draft.kind === "skill" ? layout.skillFile(id) : layout.commandFile(id);
        const current = existing ? (await this.readDocument(path)).frontmatter : {};
        const merged = mergeFrontmatter(current, draft.document.frontmatter);
        const frontmatter = draft.kind === "skill" ? ("name" in merged ? { ...merged, name } : { name, ...merged }) : merged;
        const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
        if (draft.kind === "skill" && description === "") {
          throw errors.invalidItem("A skill needs a description: the agent reads it to decide when to use the skill.");
        }
        const text = serializeMarkdownDocument(frontmatter, draft.document.body);
        try {
          parseMarkdownDocument(text);
        } catch (error) {
          throw errors.invalidItem(`The frontmatter cannot be written: ${message(error)}`);
        }
        await mkdir(draft.kind === "skill" ? layout.skillDir(id) : layout.commandsDir, { recursive: true, mode: PROFILE_DIR_MODE });
        if (!existing) state.rollback.push(() => rm(draft.kind === "skill" ? layout.skillDir(id) : path, { recursive: true, force: true }));
        await writeProfileFileVerified(path, text, { ...WRITE, verify: (written) => parseMarkdownDocument(written) });
        return { ...base, kind: draft.kind, name, ...(description ? { description } : {}) };
      }

      case "mcp": {
        const mcp = validateMcpDraft(draft.mcp);
        this.assertUnique(state.file, "mcp", mcp.name, agents, id);
        const secrets = await state.secrets();
        const current = secrets.items[id];
        const env = applySecretDrafts(draft.mcp.env, current?.env, "env");
        const headers = applySecretDrafts(draft.mcp.headers, current?.headers, "headers");
        const entry: SessionProfileItemSecrets = { ...without(current, ["env", "headers"]) };
        if (env.keys.length > 0) entry.env = env.values;
        if (headers.keys.length > 0) entry.headers = headers.values;
        if (Object.keys(entry).length > 0) secrets.items[id] = entry;
        else delete secrets.items[id];
        delete secrets.unreadable[id];
        state.secretsDirty = true;
        const previous = existing?.kind === "mcp" ? existing.mcp : undefined;
        return {
          ...base,
          kind: "mcp",
          name: mcp.name,
          mcp: {
            ...without(previous, ["transport", "command", "args", "cwd", "envKeys", "url", "headerKeys", "advanced"]),
            transport: mcp.transport,
            ...(mcp.command !== undefined ? { command: mcp.command } : {}),
            ...(mcp.args !== undefined ? { args: mcp.args } : {}),
            ...(mcp.cwd !== undefined ? { cwd: mcp.cwd } : {}),
            ...(env.keys.length > 0 ? { envKeys: env.keys } : {}),
            ...(mcp.url !== undefined ? { url: mcp.url } : {}),
            ...(headers.keys.length > 0 ? { headerKeys: headers.keys } : {}),
            ...(mcp.advanced !== undefined ? { advanced: mcp.advanced } : {})
          }
        };
      }

      case "hook": {
        const agent = (agents as SessionProfileAgentId[])[0]!;
        const hook = validateHookDraft(draft.hook, agent);
        const name = draft.name?.trim() || existing?.name || hook.event;
        if (hasControlChars(name) || name.length > 200) throw errors.invalidName("A hook's name must be one line of at most 200 characters.");
        const previous = existing?.kind === "hook" ? existing.hook : undefined;
        return {
          ...base,
          kind: "hook",
          name,
          hook: {
            ...without(previous, ["event", "matcher", "command", "timeoutSec"]),
            event: hook.event,
            ...(hook.matcher !== undefined && hook.matcher !== "" ? { matcher: hook.matcher } : {}),
            command: hook.command,
            ...(hook.timeoutSec !== undefined ? { timeoutSec: hook.timeoutSec } : {})
          }
        };
      }

      case "plugin": {
        const plugin = draft.plugin;
        for (const [field, value, max] of [
          ["name", plugin.name, 200],
          ["marketplace", plugin.marketplace, 200],
          ["version", plugin.version, 100],
          ["description", plugin.description, SESSION_PROFILE_DESCRIPTION_MAX]
        ] as const) {
          if (value === undefined) continue;
          if (value.trim() === "" || value.length > max || (field !== "description" && hasControlChars(value))) {
            throw errors.invalidItem(`plugin.${field} must be a non-empty string of at most ${max} characters.`);
          }
        }
        const clash = state.file.items.some(
          (entry) =>
            entry.ok &&
            entry.record.id !== id &&
            entry.record.kind === "plugin" &&
            entry.record.name === plugin.name &&
            entry.record.plugin.marketplace === plugin.marketplace &&
            scopesOverlap(entry.record.agents, agents)
        );
        if (clash) throw errors.itemExists("plugin", plugin.name);
        const cacheDir = layout.pluginCacheDir(id);
        if (!existing) {
          await mkdir(cacheDir, { recursive: true, mode: PROFILE_DIR_MODE });
          state.rollback.push(() => rm(cacheDir, { recursive: true, force: true }));
        }
        const previous = existing?.kind === "plugin" ? existing.plugin : undefined;
        return {
          ...base,
          kind: "plugin",
          name: plugin.name,
          ...(plugin.description !== undefined ? { description: plugin.description } : {}),
          plugin: {
            ...without(previous, ["marketplace", "version"]),
            ...(plugin.marketplace !== undefined ? { marketplace: plugin.marketplace } : {}),
            ...(plugin.version !== undefined ? { version: plugin.version } : {})
          }
        };
      }
    }
  }

  /** MCP servers, skills and commands: one name per kind among items whose agent scopes overlap. */
  private assertUnique(
    file: SessionProfileManifestFile,
    kind: "mcp" | "skill" | "command",
    name: string,
    agents: SessionProfileItemRecord["agents"],
    exceptId: string
  ): void {
    const clash = file.items.some(
      (entry) =>
        entry.ok &&
        entry.record.id !== exceptId &&
        entry.record.kind === kind &&
        entry.record.name === name &&
        scopesOverlap(entry.record.agents, agents)
    );
    if (clash) throw errors.itemExists(kind === "mcp" ? "MCP server" : kind, name);
  }
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

const KIND_WORD: Record<SessionProfileImportEntry["kind"], string> = {
  skill: "skill",
  command: "command",
  mcp: "MCP server",
  hook: "hook",
  plugin: "plugin"
};

function importScope(entry: SessionProfileImportEntry): SessionProfileItemRecord["agents"] {
  return entry.kind === "hook" || entry.kind === "plugin" ? [entry.agent] : entry.agents;
}

function importName(entry: SessionProfileImportEntry): string {
  switch (entry.kind) {
    case "mcp":
      return entry.server.name;
    case "hook":
      return entry.name?.trim() || entry.hook.event;
    case "plugin":
      return entry.plugin.name;
    default:
      return entry.name;
  }
}

function profileName(raw: string): string {
  const name = raw.trim();
  if (name === "" || name.length > SESSION_PROFILE_NAME_MAX || hasControlChars(name)) {
    throw errors.invalidName(`A profile name is one line of 1 to ${SESSION_PROFILE_NAME_MAX} characters.`);
  }
  return name;
}

function profileDescription(raw: string): string {
  if (raw.length > SESSION_PROFILE_DESCRIPTION_MAX) {
    throw errors.invalid(`The description is longer than ${SESSION_PROFILE_DESCRIPTION_MAX} characters.`);
  }
  return raw;
}

function iconField(raw: string | undefined): { icon?: string } {
  if (raw === undefined || raw === "") return {};
  if (raw.length > SESSION_PROFILE_ICON_MAX || hasControlChars(raw)) {
    throw errors.invalid(`The icon is one line of at most ${SESSION_PROFILE_ICON_MAX} characters.`);
  }
  return { icon: raw };
}

/** `record` with `draft` applied: only the named fields (and agents) change; unknown keys survive. */
function mergeSettings(record: SessionProfileSettingsRecord, draft: SessionProfileSettingsDraft | undefined): SessionProfileSettingsRecord {
  if (!draft) return record;
  const next: SessionProfileSettingsRecord = { ...record };
  if (draft.hideBuiltinSkills !== undefined) {
    const hide: Record<string, unknown> = { ...(record.hideBuiltinSkills ?? {}) };
    for (const [agent, value] of Object.entries(draft.hideBuiltinSkills)) {
      if (!isSessionProfileAgentId(agent)) throw errors.invalid(`settings.hideBuiltinSkills names an unknown agent "${agent.slice(0, 40)}".`);
      if (value !== undefined) hide[agent] = value;
    }
    next.hideBuiltinSkills = hide;
  }
  if (draft.claudeWorkflowTool !== undefined) next.claudeWorkflowTool = draft.claudeWorkflowTool;
  return next;
}

function validateMcpDraft(draft: McpServerDraft): McpServerDraft {
  if (!isValidMcpServerName(draft.name)) {
    throw errors.invalidName(
      `"${draft.name}" is not a valid MCP server name: start with a letter or "_", then letters, digits, "_" or "-", not ending in "_".`
    );
  }
  if (draft.transport === "stdio") {
    if (!draft.command || draft.command.trim() === "") throw errors.invalidItem("A stdio MCP server needs a command.");
    if (draft.url !== undefined || draft.headers !== undefined) throw errors.invalidItem("url and headers are only for http and sse servers.");
  } else if (draft.transport === "http" || draft.transport === "sse") {
    if (!draft.url || draft.url.trim() === "") throw errors.invalidItem(`A ${draft.transport} MCP server needs a url.`);
    if (draft.command !== undefined || draft.args !== undefined || draft.cwd !== undefined || draft.env !== undefined) {
      throw errors.invalidItem("command, args, cwd and env are only for stdio servers.");
    }
  } else {
    throw errors.invalidItem("transport must be stdio, http or sse.");
  }
  return draft;
}

/** The keys (in order) and values a secret draft leaves; `keep` needs a stored value. Never quotes a value. */
function applySecretDrafts(
  drafts: SecretEntryDraft[] | undefined,
  current: Record<string, string> | undefined,
  field: "env" | "headers"
): { keys: string[]; values: Record<string, string> } {
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const entry of drafts ?? []) {
    if (entry.key === "" || hasControlChars(entry.key) || entry.key.length > 256) throw errors.invalidItem(`${field} has an invalid key.`);
    if (entry.key in values) throw errors.invalidItem(`${field} names the key "${entry.key}" twice.`);
    if ("value" in entry) {
      values[entry.key] = entry.value;
    } else {
      const kept = current?.[entry.key];
      if (kept === undefined) throw errors.invalidItem(`${field} ${entry.key}: there is no stored value to keep; enter one.`);
      values[entry.key] = kept;
    }
    keys.push(entry.key);
  }
  return { keys, values };
}

function validateHookDraft(draft: HookDraft, agent: SessionProfileAgentId): HookDraft {
  const events = PROFILE_HOOK_EVENTS[agent] ?? [];
  if (!events.includes(draft.event)) {
    throw errors.invalidItem(`"${draft.event}" is not a hook event of ${agent}; use one of ${events.join(", ")}.`);
  }
  if (draft.command.trim() === "") throw errors.invalidItem("A hook needs a command.");
  if (draft.timeoutSec !== undefined && !(Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0)) {
    throw errors.invalidItem("timeoutSec must be a positive number of seconds.");
  }
  return draft;
}
