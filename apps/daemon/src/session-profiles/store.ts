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
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_HOOK_EVENTS,
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
  type SessionProfileItemDraft,
  type SessionProfileSettingsDraft
} from "@orquester/api";
import {
  SESSION_PROFILE_MANIFEST_VERSION,
  emptySessionProfileSecrets,
  parseSessionProfileManifest,
  parseSessionProfileSecrets,
  serializeSessionProfileManifest,
  serializeSessionProfileSecrets,
  sessionProfileDir,
  sessionProfileIdSchema,
  sessionProfileSourcesDir,
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
import { copyEntry, isMissing } from "../agent-profile/infra/tree.ts";
import { sessionProfileErrors as errors } from "./errors.ts";
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

export interface SessionProfileStoreOptions {
  appdir: string;
  now?: () => Date;
  /** Mints profile and item ids (tests pin them). Must answer path-safe, unique ids. */
  newId?: () => string;
}

/** The queue key of the catalog-wide slot (never a valid profile id). */
const CATALOG = "*catalog*";

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
    return this.queue.run(profileId, async () => {
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
    });
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
