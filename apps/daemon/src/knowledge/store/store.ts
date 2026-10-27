import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  KNOWLEDGE_COLLECTIONS_MAX,
  KNOWLEDGE_COLORS,
  KNOWLEDGE_MERGE_MAX_ENTRIES,
  KNOWLEDGE_SAVE_MAX_ENTRIES,
  knowledgeCitation,
  knowledgeMergeKeep,
  type CreateKnowledgeCollectionRequest,
  type KnowledgeCollection,
  type KnowledgeColor,
  type KnowledgeEntry,
  type KnowledgeEntryMeta,
  type KnowledgeEntrySource,
  type KnowledgeLinkState,
  type KnowledgeMergeRequest,
  type KnowledgeSaveRequest,
  type KnowledgeSaveResult,
  type UpdateKnowledgeCollectionRequest,
  type UpdateKnowledgeEntryRequest
} from "@orquester/api";
import {
  type KnowledgeCollectionsFile,
  isKnowledgeColorKey,
  isKnowledgeEntryId,
  knowledgeCollectionsPath,
  knowledgeEntriesDir,
  knowledgeMykgInputDir,
  parseKnowledgeCollectionsConfig,
  serializeKnowledgeCollectionsFile
} from "@orquester/config";
import type { KnowledgeEntryChange, KnowledgeStorePort } from "../ports.ts";
import { parseEntryFile, renderMykgInput, serializeEntryFile } from "./entry-file.ts";
import { KnowledgeError, type KnowledgeLogger } from "./errors.ts";
import { isTempName, readTextOrNull, removeIfExists, writeFileAtomic } from "./fs.ts";
import { newKnowledgeCollectionId, newKnowledgeEntryId } from "./ids.ts";
import {
  NEAR_DUPLICATE_JACCARD,
  type KnowledgeTextSignature,
  jaccard,
  knowledgeContentHash,
  knowledgeShingles,
  knowledgeTextSignature,
  mayBeNearDuplicate,
  normalizeKnowledgeUrl
} from "./normalize.ts";
import {
  checkAuthor,
  checkBody,
  checkCollectionDescription,
  checkCollectionName,
  checkHandle,
  checkKind,
  checkPostedAt,
  checkTitle,
  checkUrl,
  deriveTitle
} from "./validate.ts";

export interface KnowledgeStoreOptions {
  /** The appdir: paths come from the `packages/config` helpers. */
  appdir: string;
  logger?: KnowledgeLogger;
}

/** What one save request did (the route turns it into a `KnowledgeSaveResponse`). */
export interface KnowledgeSaveOutcome {
  results: KnowledgeSaveResult[];
  createdCollections: KnowledgeCollection[];
  /** The changes emitted, in order (also delivered to `onChange` listeners). */
  changes: KnowledgeEntryChange[];
}

/** What one merge did (the route turns it into a `KnowledgeMergeResponse`). */
export interface KnowledgeMergeOutcome {
  kept: KnowledgeEntry;
  /** The kept entry was rewritten (its title, text or collections changed). */
  keptChanged: boolean;
  collectionsChanged: boolean;
  deleted: string[];
  /** Entries still there after the edit landed (deleting them failed), with why. */
  notDeleted: { id: string; message: string }[];
}

interface StoredEntry {
  meta: KnowledgeEntryMeta;
  /** Frontmatter keys this build does not know, written back verbatim. */
  extra: Record<string, unknown>;
  signature: KnowledgeTextSignature;
  urlKey: string | null;
}

interface PlannedEntry {
  meta: KnowledgeEntryMeta;
  body: string;
  signature: KnowledgeTextSignature;
  shingles: Set<number>;
  urlKey: string | null;
}

const MIRROR_FILE = /^(ke_[a-z0-9]{12})\.md$/;

function frozenMeta(meta: KnowledgeEntryMeta): KnowledgeEntryMeta {
  return Object.freeze({ ...meta, savedFrom: Object.freeze({ ...meta.savedFrom }), collections: Object.freeze([...meta.collections]) as string[] });
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The knowledge base's durable record (spec "Storage"): `entries/<id>.md` (frontmatter + verbatim
 * body), `collections.json`, and the generated myKG input mirror `mykg/input/<id>.md`.
 *
 * - Every mutation runs on one serialized chain and validates everything before writing anything.
 * - Writes are atomic (hidden temp file + rename); memory changes only after the writes landed.
 * - A malformed entry file is skipped with a warning, never rewritten or deleted (and its mirror
 *   file is left alone). An unreadable `collections.json` is moved aside and the store starts with
 *   no collections (entries keep their ids, so restoring the file by hand restores the labels).
 *   One a newer version wrote is left in place, and collection changes are refused until then.
 * - Change events follow `ports.ts`: `edited` when a field the mirror carries changed, `relabelled`
 *   for every metadata-only change (collections — and the URL, which myKG never sees).
 */
export class KnowledgeStore implements KnowledgeStorePort {
  readonly entriesDir: string;
  readonly mykgInputDir: string;
  readonly collectionsPath: string;

  private readonly logger: KnowledgeLogger;
  private readonly entries = new Map<string, StoredEntry>();
  /** Ids with a file in `entries/` this build could not read: kept, and their mirror kept too. */
  private readonly unreadable = new Set<string>();
  private readonly byHash = new Map<string, string>();
  private readonly byUrl = new Map<string, string>();
  /** sha256 of each mirror file as last written or verified. */
  private readonly mirrorDigest = new Map<string, string>();
  private collectionsFile: KnowledgeCollectionsFile = { version: 1, collections: [], rejected: [], extra: {} };
  /** Set when `collections.json` was written by a newer version: it is kept as-is and never written. */
  private collectionsReadOnly: string | null = null;
  private metaCache: readonly KnowledgeEntryMeta[] | null = null;
  private readonly listeners = new Set<(change: KnowledgeEntryChange) => void>();
  private readonly linkStateListeners = new Set<(entryIds: readonly string[]) => void>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(options: KnowledgeStoreOptions) {
    this.entriesDir = knowledgeEntriesDir(options.appdir);
    this.mykgInputDir = knowledgeMykgInputDir(options.appdir);
    this.collectionsPath = knowledgeCollectionsPath(options.appdir);
    this.logger = options.logger ?? console;
  }

  /** Load the entries and collections into memory and reconcile the myKG mirror with them. */
  static async open(options: KnowledgeStoreOptions): Promise<KnowledgeStore> {
    const store = new KnowledgeStore(options);
    await store.load();
    return store;
  }

  // -------------------------------------------------------------------------
  // KnowledgeStorePort
  // -------------------------------------------------------------------------

  listMeta(): readonly KnowledgeEntryMeta[] {
    if (!this.metaCache) this.metaCache = Object.freeze([...this.entries.values()].map((entry) => entry.meta));
    return this.metaCache;
  }

  getMeta(id: string): KnowledgeEntryMeta | null {
    return this.entries.get(id)?.meta ?? null;
  }

  async getEntry(id: string): Promise<KnowledgeEntry | null> {
    const stored = this.entries.get(id);
    if (!stored) return null;
    const text = await readTextOrNull(this.entryPath(id));
    if (text === null) return null;
    try {
      const parsed = parseEntryFile(text, id);
      // Memory is the truth for metadata (it changes only after a write landed).
      return { ...this.entries.get(id)!.meta, body: parsed.body };
    } catch (error) {
      this.logger.warn(`knowledge: entry ${id} became unreadable (${(error as Error).message})`);
      return null;
    }
  }

  async setLinkState(ids: readonly string[], state: KnowledgeLinkState): Promise<void> {
    const changed: string[] = [];
    try {
      await this.serialize(async () => {
        for (const id of new Set(ids)) {
          const stored = this.entries.get(id);
          if (!stored || stored.meta.linkState === state) continue;
          const body = await this.readBody(id);
          if (body === null) continue;
          const meta = frozenMeta({ ...stored.meta, linkState: state });
          await writeFileAtomic(this.entryPath(id), serializeEntryFile(meta, stored.extra, body));
          this.entries.set(id, { ...stored, meta });
          this.metaCache = null;
          changed.push(id);
        }
      });
    } finally {
      if (changed.length > 0) {
        for (const listener of this.linkStateListeners) {
          try {
            listener(changed);
          } catch (error) {
            this.logger.error(`knowledge: a link-state listener failed (${(error as Error).message})`);
          }
        }
      }
    }
  }

  onChange(listener: (change: KnowledgeEntryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Entries whose link state moved (a linking run's verdict). Not a {@link KnowledgeEntryChange}:
   * nothing needs re-linking or re-indexing, only what shows the state (the UI) refetches.
   */
  onLinkStateChange(listener: (entryIds: readonly string[]) => void): () => void {
    this.linkStateListeners.add(listener);
    return () => this.linkStateListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Collections
  // -------------------------------------------------------------------------

  listCollections(): readonly KnowledgeCollection[] {
    return this.collectionsFile.collections.map(toCollection);
  }

  getCollection(id: string): KnowledgeCollection | null {
    const record = this.collectionsFile.collections.find((c) => c.id === id);
    return record ? toCollection(record) : null;
  }

  /** A collection by id or by exact (case-insensitive, trimmed) name. */
  resolveCollection(ref: string): KnowledgeCollection | null {
    const byId = this.getCollection(ref.trim());
    if (byId) return byId;
    const key = ref.replace(/\s+/g, " ").trim().toLowerCase();
    const record = this.collectionsFile.collections.find((c) => c.name.toLowerCase() === key);
    return record ? toCollection(record) : null;
  }

  async createCollection(request: CreateKnowledgeCollectionRequest): Promise<KnowledgeCollection> {
    return this.serialize(async () => {
      const name = checkCollectionName(request.name);
      const description = checkCollectionDescription(request.description);
      this.assertNameFree(name, null);
      if (this.collectionsFile.collections.length >= KNOWLEDGE_COLLECTIONS_MAX) {
        throw new KnowledgeError("KNOWLEDGE_INVALID", `There can be at most ${KNOWLEDGE_COLLECTIONS_MAX} collections.`);
      }
      const at = new Date().toISOString();
      const record = {
        id: this.freshCollectionId(new Set()),
        name,
        description,
        color: request.color ?? this.nextColor([]),
        createdAt: at,
        updatedAt: at
      };
      await this.writeCollections({ ...this.collectionsFile, collections: [...this.collectionsFile.collections, record] });
      return toCollection(record);
    });
  }

  async updateCollection(id: string, request: UpdateKnowledgeCollectionRequest): Promise<KnowledgeCollection> {
    return this.serialize(async () => {
      const index = this.collectionsFile.collections.findIndex((c) => c.id === id);
      if (index < 0) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such collection.");
      const current = this.collectionsFile.collections[index]!;
      const name = request.name === undefined ? current.name : checkCollectionName(request.name);
      if (name.toLowerCase() !== current.name.toLowerCase()) this.assertNameFree(name, id);
      const description = request.description === undefined ? current.description : checkCollectionDescription(request.description);
      const color = request.color ?? current.color;
      if (name === current.name && description === current.description && color === current.color) return toCollection(current);
      const next = { ...current, name, description, color, updatedAt: new Date().toISOString() };
      const collections = [...this.collectionsFile.collections];
      collections[index] = next;
      await this.writeCollections({ ...this.collectionsFile, collections });
      return toCollection(next);
    });
  }

  /** Removes the label from every entry (`relabelled`), then the collection. */
  async deleteCollection(id: string): Promise<void> {
    await this.serialize(async () => {
      if (!this.collectionsFile.collections.some((c) => c.id === id)) {
        throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such collection.");
      }
      const relabelled: string[] = [];
      for (const stored of [...this.entries.values()]) {
        if (!stored.meta.collections.includes(id)) continue;
        const body = await this.readBody(stored.meta.id);
        if (body === null) continue;
        const meta = frozenMeta({ ...stored.meta, collections: stored.meta.collections.filter((c) => c !== id) });
        await writeFileAtomic(this.entryPath(meta.id), serializeEntryFile(meta, stored.extra, body));
        this.entries.set(meta.id, { ...stored, meta });
        this.metaCache = null;
        relabelled.push(meta.id);
      }
      await this.writeCollections({
        ...this.collectionsFile,
        collections: this.collectionsFile.collections.filter((c) => c.id !== id)
      });
      if (relabelled.length > 0) this.emit({ kind: "relabelled", entryIds: relabelled });
    });
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  /**
   * Save one request, all or nothing: every item and new collection is validated (collections
   * resolved, duplicates found) before anything is written. A duplicate (same normalized URL, same
   * content hash, or near-identical text) keeps the existing entry and gains the item's
   * collections.
   */
  async save(request: KnowledgeSaveRequest): Promise<KnowledgeSaveOutcome> {
    return this.serialize(async () => {
      const items = request.entries;
      if (items.length === 0) throw new KnowledgeError("KNOWLEDGE_INVALID", "Nothing to save: `entries` is empty.");
      if (items.length > KNOWLEDGE_SAVE_MAX_ENTRIES) {
        throw new KnowledgeError(
          "KNOWLEDGE_TOO_LARGE",
          `At most ${KNOWLEDGE_SAVE_MAX_ENTRIES} entries per save; split the import into several calls.`
        );
      }
      const at = new Date().toISOString();
      const savedFrom: KnowledgeEntrySource = request.sessionId ? { by: "agent", sessionId: request.sessionId } : { by: "user" };

      // New collections first (an existing name is reused, not an error).
      const created: KnowledgeCollection[] = [];
      const plannedRecords = [...this.collectionsFile.collections];
      const takenIds = new Set<string>();
      for (const [index, item] of (request.newCollections ?? []).entries()) {
        const name = checkCollectionName(item.name);
        const description = checkCollectionDescription(item.description);
        if (description.length === 0) {
          throw new KnowledgeError("KNOWLEDGE_INVALID", `newCollections[${index}] ("${name}") needs a one-line description.`);
        }
        if (plannedRecords.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
        if (plannedRecords.length >= KNOWLEDGE_COLLECTIONS_MAX) {
          throw new KnowledgeError("KNOWLEDGE_INVALID", `There can be at most ${KNOWLEDGE_COLLECTIONS_MAX} collections.`);
        }
        const record = {
          id: this.freshCollectionId(takenIds),
          name,
          description,
          color: this.nextColor(created.map((c) => c.color)),
          createdAt: at,
          updatedAt: at
        };
        takenIds.add(record.id);
        plannedRecords.push(record);
        created.push(toCollection(record));
      }
      const resolve = (ref: string): string | null => {
        const key = ref.replace(/\s+/g, " ").trim();
        const record =
          plannedRecords.find((c) => c.id === key) ?? plannedRecords.find((c) => c.name.toLowerCase() === key.toLowerCase());
        return record?.id ?? null;
      };

      // Validate and dedup every item.
      type Step = { kind: "new"; plan: PlannedEntry } | { kind: "existing"; id: string; add: string[] } | { kind: "planned"; index: number; add: string[] };
      const steps: Step[] = [];
      const planned: PlannedEntry[] = [];
      const takenEntryIds = new Set<string>();
      for (const [index, item] of items.entries()) {
        const where = `entries[${index}]`;
        const body = checkBody(item.body, where);
        const title = item.title === undefined || item.title.trim() === "" ? deriveTitle(body) : checkTitle(item.title, where);
        const refs = item.collections;
        if (refs.length === 0) {
          throw new KnowledgeError("KNOWLEDGE_INVALID", `${where}: name at least one collection. ${this.validNamesHint(plannedRecords)}`);
        }
        const collections: string[] = [];
        for (const ref of refs) {
          const id = resolve(ref);
          if (!id) {
            throw new KnowledgeError(
              "KNOWLEDGE_UNKNOWN_COLLECTION",
              `${where}: no collection "${ref.slice(0, 80)}". ${this.validNamesHint(plannedRecords)} To make a new one, pass it in newCollections with a description.`
            );
          }
          if (!collections.includes(id)) collections.push(id);
        }
        const url = checkUrl(item.url, where);
        const urlKey = url ? normalizeKnowledgeUrl(url) : null;
        const contentHash = knowledgeContentHash(body);
        const shingles = knowledgeShingles(body);
        const signature = knowledgeTextSignature(shingles);

        const existing = await this.findDuplicate(urlKey, contentHash, signature, shingles);
        if (existing) {
          steps.push({ kind: "existing", id: existing, add: collections });
          continue;
        }
        const earlier = planned.findIndex(
          (p) =>
            (urlKey !== null && p.urlKey === urlKey) ||
            p.meta.contentHash === contentHash ||
            (mayBeNearDuplicate(p.signature, signature) && jaccard(p.shingles, shingles) >= NEAR_DUPLICATE_JACCARD)
        );
        if (earlier >= 0) {
          steps.push({ kind: "planned", index: earlier, add: collections });
          continue;
        }
        let id = newKnowledgeEntryId();
        while (this.entries.has(id) || this.unreadable.has(id) || takenEntryIds.has(id)) id = newKnowledgeEntryId();
        takenEntryIds.add(id);
        const meta: KnowledgeEntryMeta = {
          id,
          title,
          kind: checkKind(item.kind, where),
          author: checkAuthor(item.author, where),
          handle: checkHandle(item.handle, where),
          url,
          postedAt: checkPostedAt(item.postedAt, where),
          savedAt: at,
          updatedAt: at,
          savedFrom,
          collections,
          contentHash,
          linkState: "pending"
        };
        planned.push({ meta, body, signature, shingles, urlKey });
        steps.push({ kind: "new", plan: planned[planned.length - 1]! });
      }
      // A later duplicate of an item in this request adds its collections to that new entry.
      for (const step of steps) {
        if (step.kind !== "planned") continue;
        const target = planned[step.index]!;
        target.meta = { ...target.meta, collections: [...new Set([...target.meta.collections, ...step.add])] };
      }
      // Existing duplicates: the union of every item's collections, per entry.
      const additions = new Map<string, Set<string>>();
      for (const step of steps) {
        if (step.kind !== "existing") continue;
        const set = additions.get(step.id) ?? new Set(this.entries.get(step.id)!.meta.collections);
        for (const c of step.add) set.add(c);
        additions.set(step.id, set);
      }

      // Relabelled duplicates are read (and their rewrite prepared) before anything is written.
      const relabels: { id: string; stored: StoredEntry; meta: KnowledgeEntryMeta; previous: string; next: string }[] = [];
      for (const [id, set] of additions) {
        const stored = this.entries.get(id)!;
        const collections = [...set];
        if (collections.length === stored.meta.collections.length) continue;
        const current = await this.readEntryText(id);
        if (current === null) continue;
        const meta = frozenMeta({ ...stored.meta, collections, updatedAt: at });
        relabels.push({ id, stored, meta, previous: current.text, next: serializeEntryFile(meta, stored.extra, current.body) });
      }

      // Write: collections, then new entries (file, then mirror), then relabelled duplicates. Any
      // failure undoes what this request wrote, so memory and events see all of it or none.
      const collectionsBefore = this.collectionsFile;
      const written: string[] = [];
      const rewritten: (typeof relabels)[number][] = [];
      try {
        if (created.length > 0) await this.writeCollections({ ...this.collectionsFile, collections: plannedRecords });
        for (const plan of planned) {
          const meta = frozenMeta(plan.meta);
          await writeFileAtomic(this.entryPath(meta.id), serializeEntryFile(meta, {}, plan.body));
          written.push(meta.id);
          await this.writeMirror(meta, plan.body);
          plan.meta = meta;
        }
        for (const relabel of relabels) {
          await writeFileAtomic(this.entryPath(relabel.id), relabel.next);
          rewritten.push(relabel);
        }
      } catch (error) {
        for (const relabel of rewritten) await writeFileAtomic(this.entryPath(relabel.id), relabel.previous).catch(() => undefined);
        for (const id of written) {
          await removeIfExists(this.entryPath(id)).catch(() => undefined);
          await removeIfExists(this.mirrorPath(id)).catch(() => undefined);
          this.mirrorDigest.delete(id);
        }
        if (this.collectionsFile !== collectionsBefore) await this.writeCollections(collectionsBefore).catch(() => undefined);
        throw error;
      }
      for (const plan of planned) {
        this.entries.set(plan.meta.id, { meta: plan.meta, extra: {}, signature: plan.signature, urlKey: plan.urlKey });
        this.index(plan.meta.id, plan.meta.contentHash, plan.urlKey);
      }
      const relabelled: string[] = [];
      for (const relabel of relabels) {
        this.entries.set(relabel.id, { ...relabel.stored, meta: relabel.meta });
        relabelled.push(relabel.id);
      }
      this.metaCache = null;

      const changes: KnowledgeEntryChange[] = [];
      if (planned.length > 0) changes.push({ kind: "added", entryIds: planned.map((p) => p.meta.id) });
      if (relabelled.length > 0) changes.push({ kind: "relabelled", entryIds: relabelled });
      for (const change of changes) this.emit(change);

      const results: KnowledgeSaveResult[] = steps.map((step) => {
        const id = step.kind === "new" ? step.plan.meta.id : step.kind === "planned" ? planned[step.index]!.meta.id : step.id;
        const meta = this.entries.get(id)!.meta;
        return {
          entryId: id,
          status: step.kind === "new" ? "saved" : "duplicate",
          title: meta.title,
          collections: [...meta.collections],
          citation: knowledgeCitation(meta)
        };
      });
      return { results, createdCollections: created, changes };
    });
  }

  // -------------------------------------------------------------------------
  // Editing and deleting (the Knowledge tab)
  // -------------------------------------------------------------------------

  async updateEntry(id: string, request: UpdateKnowledgeEntryRequest): Promise<KnowledgeEntry> {
    return this.serialize(() => this.applyUpdate(id, request));
  }

  /**
   * One edit, already on the chain. Checks every field before writing; writes nothing when nothing
   * changes. `collectionIds` (a merge's union) sets the collections as they are, where
   * `request.collections` resolves names and ids.
   */
  private async applyUpdate(id: string, request: UpdateKnowledgeEntryRequest, collectionIds?: readonly string[]): Promise<KnowledgeEntry> {
    const stored = this.entries.get(id);
    if (!stored) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
    const currentBody = await this.readBody(id);
    if (currentBody === null) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
    const where = "entry";
    const body = request.body === undefined ? currentBody : checkBody(request.body, where);
    const before = stored.meta;
    let collections = collectionIds ? [...collectionIds] : before.collections;
    if (request.collections !== undefined) {
      collections = [];
      for (const ref of request.collections) {
        // By id (the Knowledge tab) or by name (an agent's knowledge_update), as saving resolves them.
        const collection = this.resolveCollection(ref);
        if (!collection) {
          throw new KnowledgeError(
            "KNOWLEDGE_UNKNOWN_COLLECTION",
            `No collection "${ref.slice(0, 80)}". ${this.validNamesHint(this.collectionsFile.collections)}`
          );
        }
        if (!collections.includes(collection.id)) collections.push(collection.id);
      }
    }
    const contentHash = body === currentBody ? before.contentHash : knowledgeContentHash(body);
    const next: KnowledgeEntryMeta = {
      ...before,
      title: request.title === undefined ? before.title : checkTitle(request.title, where),
      kind: request.kind === undefined ? before.kind : checkKind(request.kind, where),
      author: request.author === undefined ? before.author : checkAuthor(request.author, where),
      handle: request.handle === undefined ? before.handle : checkHandle(request.handle, where),
      url: request.url === undefined ? before.url : checkUrl(request.url, where),
      postedAt: request.postedAt === undefined ? before.postedAt : checkPostedAt(request.postedAt, where),
      collections,
      contentHash
    };
    const edited =
      body !== currentBody ||
      next.title !== before.title ||
      next.kind !== before.kind ||
      next.author !== before.author ||
      next.handle !== before.handle ||
      next.postedAt !== before.postedAt;
    const relabelled =
      next.url !== before.url ||
      next.collections.length !== before.collections.length ||
      next.collections.some((c, i) => c !== before.collections[i]);
    if (!edited && !relabelled) return { ...before, body: currentBody };
    const meta = frozenMeta({
      ...next,
      updatedAt: new Date().toISOString(),
      linkState: edited ? "pending" : before.linkState
    });
    await writeFileAtomic(this.entryPath(id), serializeEntryFile(meta, stored.extra, body));
    const shingles = body === currentBody ? null : knowledgeShingles(body);
    const urlKey = meta.url ? normalizeKnowledgeUrl(meta.url) : null;
    this.unindex(id, before.contentHash, stored.urlKey);
    this.entries.set(id, { meta, extra: stored.extra, signature: shingles ? knowledgeTextSignature(shingles) : stored.signature, urlKey });
    this.index(id, meta.contentHash, urlKey);
    this.metaCache = null;
    if (edited) await this.writeMirror(meta, body);
    this.emit({ kind: edited ? "edited" : "relabelled", entryIds: [id] });
    return { ...meta, body };
  }

  async deleteEntry(id: string): Promise<void> {
    await this.serialize(() => this.removeEntry(id));
  }

  /** One delete, already on the chain. */
  private async removeEntry(id: string): Promise<void> {
    const stored = this.entries.get(id);
    if (!stored) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", "No such entry.");
    await removeIfExists(this.entryPath(id));
    await removeIfExists(this.mirrorPath(id));
    this.mirrorDigest.delete(id);
    this.unindex(id, stored.meta.contentHash, stored.urlKey);
    this.entries.delete(id);
    this.metaCache = null;
    this.emit({ kind: "deleted", entryIds: [id] });
  }

  /**
   * Merge entries into one, on one turn of the chain (nothing else writes in between). Checks the
   * ids, the kept one and the new title and text before writing anything; then edits the kept entry
   * (the union of every merged entry's collections, its own first; not rewritten when nothing
   * changes) and deletes the others. A delete that fails after the edit landed is reported in
   * `notDeleted`, not thrown, so the caller can say exactly what happened.
   */
  async mergeEntries(request: Pick<KnowledgeMergeRequest, "ids" | "keep" | "title" | "body">): Promise<KnowledgeMergeOutcome> {
    return this.serialize(async () => {
      const ids = request.ids;
      if (ids.length < 2 || ids.length > KNOWLEDGE_MERGE_MAX_ENTRIES) {
        throw new KnowledgeError("KNOWLEDGE_INVALID", `A merge takes 2 to ${KNOWLEDGE_MERGE_MAX_ENTRIES} entry ids.`);
      }
      const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
      if (repeated !== undefined) throw new KnowledgeError("KNOWLEDGE_INVALID", `Entry ${repeated.slice(0, 80)} is named twice.`);
      if (request.keep !== undefined && !ids.includes(request.keep)) throw new KnowledgeError("KNOWLEDGE_INVALID", "keep must be one of the ids merged.");
      const metas = ids.map((id) => {
        const meta = this.entries.get(id)?.meta;
        if (!meta) throw new KnowledgeError("KNOWLEDGE_NOT_FOUND", `No such entry: ${id.slice(0, 80)}.`);
        return meta;
      });
      const kept = request.keep !== undefined ? metas[ids.indexOf(request.keep)]! : knowledgeMergeKeep(metas)!;
      const others = metas.filter((meta) => meta.id !== kept.id);
      // Ids as they are (a label whose collection is gone stays, as on the entries merged).
      const collections = [...new Set([...kept.collections, ...others.flatMap((meta) => meta.collections)])];
      const edit: UpdateKnowledgeEntryRequest = {
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      };
      const entry = await this.applyUpdate(kept.id, edit, collections);
      // A write replaces the stored meta; no change leaves it as it was.
      const keptChanged = this.entries.get(kept.id)?.meta !== kept;
      const deleted: string[] = [];
      const notDeleted: { id: string; message: string }[] = [];
      for (const other of others) {
        try {
          await this.removeEntry(other.id);
          deleted.push(other.id);
        } catch (error) {
          this.logger.error(`knowledge: merging into ${kept.id}, ${other.id} could not be deleted (${(error as Error).message})`);
          notDeleted.push({ id: other.id, message: error instanceof KnowledgeError ? error.message : "It could not be deleted." });
        }
      }
      return {
        kept: entry,
        keptChanged,
        collectionsChanged: entry.collections.join() !== kept.collections.join(),
        deleted,
        notDeleted
      };
    });
  }

  /** Resolves once every queued write has finished (tests and shutdown). */
  async idle(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private emit(change: KnowledgeEntryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger.error(`knowledge: a store listener failed (${(error as Error).message})`);
      }
    }
  }

  private entryPath(id: string): string {
    return join(this.entriesDir, `${id}.md`);
  }

  private mirrorPath(id: string): string {
    return join(this.mykgInputDir, `${id}.md`);
  }

  private async readBody(id: string): Promise<string | null> {
    return (await this.readEntryText(id))?.body ?? null;
  }

  /** The entry file's text and body; null when it is gone or no longer parses. */
  private async readEntryText(id: string): Promise<{ text: string; body: string } | null> {
    const text = await readTextOrNull(this.entryPath(id));
    if (text === null) return null;
    try {
      return { text, body: parseEntryFile(text, id).body };
    } catch (error) {
      this.logger.warn(`knowledge: entry ${id} became unreadable (${(error as Error).message})`);
      return null;
    }
  }

  /** Writes the mirror file only when its bytes change. */
  private async writeMirror(meta: KnowledgeEntryMeta, body: string): Promise<void> {
    const content = renderMykgInput(meta, body);
    const digest = sha(content);
    if (this.mirrorDigest.get(meta.id) === digest) return;
    await writeFileAtomic(this.mirrorPath(meta.id), content, 0o644);
    this.mirrorDigest.set(meta.id, digest);
  }

  private index(id: string, hash: string, urlKey: string | null): void {
    if (!this.byHash.has(hash)) this.byHash.set(hash, id);
    if (urlKey && !this.byUrl.has(urlKey)) this.byUrl.set(urlKey, id);
  }

  private unindex(id: string, hash: string, urlKey: string | null): void {
    if (this.byHash.get(hash) === id) {
      this.byHash.delete(hash);
      for (const other of this.entries.values()) {
        if (other.meta.id !== id && other.meta.contentHash === hash) {
          this.byHash.set(hash, other.meta.id);
          break;
        }
      }
    }
    if (urlKey && this.byUrl.get(urlKey) === id) {
      this.byUrl.delete(urlKey);
      for (const other of this.entries.values()) {
        if (other.meta.id !== id && other.urlKey === urlKey) {
          this.byUrl.set(urlKey, other.meta.id);
          break;
        }
      }
    }
  }

  private async findDuplicate(
    urlKey: string | null,
    hash: string,
    signature: KnowledgeTextSignature,
    shingles: Set<number>
  ): Promise<string | null> {
    if (urlKey) {
      const byUrl = this.byUrl.get(urlKey);
      if (byUrl) return byUrl;
    }
    const byHash = this.byHash.get(hash);
    if (byHash) return byHash;
    for (const stored of this.entries.values()) {
      if (!mayBeNearDuplicate(stored.signature, signature)) continue;
      const body = await this.readBody(stored.meta.id);
      if (body !== null && jaccard(knowledgeShingles(body), shingles) >= NEAR_DUPLICATE_JACCARD) return stored.meta.id;
    }
    return null;
  }

  private validNamesHint(records: readonly { name: string }[]): string {
    if (records.length === 0) return "There are no collections yet.";
    return `Valid collections: ${records.map((c) => `"${c.name}"`).join(", ")}.`;
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const clash = this.collectionsFile.collections.find((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new KnowledgeError("KNOWLEDGE_COLLECTION_EXISTS", `A collection named "${clash.name}" already exists.`);
  }

  private freshCollectionId(taken: ReadonlySet<string>): string {
    const used = new Set(this.collectionsFile.collections.map((c) => c.id));
    let id = newKnowledgeCollectionId();
    while (used.has(id) || taken.has(id)) id = newKnowledgeCollectionId();
    return id;
  }

  /** Round-robin through the palette, continuing from the most recently created collection. */
  private nextColor(pending: readonly KnowledgeColor[]): KnowledgeColor {
    const last =
      pending[pending.length - 1] ??
      [...this.collectionsFile.collections].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)?.color;
    if (!last) return KNOWLEDGE_COLORS[0]!;
    const index = KNOWLEDGE_COLORS.indexOf(last as KnowledgeColor);
    return KNOWLEDGE_COLORS[(index + 1) % KNOWLEDGE_COLORS.length]!;
  }

  private async writeCollections(file: KnowledgeCollectionsFile): Promise<void> {
    if (this.collectionsReadOnly) throw new KnowledgeError("KNOWLEDGE_INVALID", this.collectionsReadOnly, 409);
    await writeFileAtomic(this.collectionsPath, `${JSON.stringify(serializeKnowledgeCollectionsFile(file), null, 2)}\n`);
    this.collectionsFile = file;
  }

  private async load(): Promise<void> {
    await mkdir(this.entriesDir, { recursive: true });
    await mkdir(this.mykgInputDir, { recursive: true });
    await this.loadCollections();
    for (const name of (await readdir(this.entriesDir)).sort()) {
      if (isTempName(name)) {
        await rm(join(this.entriesDir, name), { force: true }).catch(() => undefined);
        continue;
      }
      const match = MIRROR_FILE.exec(name);
      if (!match) continue;
      const id = match[1]!;
      if (!isKnowledgeEntryId(id)) continue;
      let text: string;
      try {
        text = await readFile(join(this.entriesDir, name), "utf8");
      } catch (error) {
        this.unreadable.add(id);
        this.logger.warn(`knowledge: skipped entry ${id} (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`);
        continue;
      }
      try {
        const parsed = parseEntryFile(text, id);
        const meta = frozenMeta(parsed.meta);
        const urlKey = meta.url ? normalizeKnowledgeUrl(meta.url) : null;
        this.entries.set(id, { meta, extra: parsed.extra, signature: knowledgeTextSignature(knowledgeShingles(parsed.body)), urlKey });
        this.index(id, meta.contentHash, urlKey);
        await this.reconcileMirror(meta, parsed.body);
      } catch (error) {
        this.unreadable.add(id);
        this.logger.warn(`knowledge: skipped malformed entry ${id} (${(error as Error).message})`);
      }
    }
    // Orphans: mirror files with no entry file at all (an unreadable entry keeps its mirror).
    for (const name of await readdir(this.mykgInputDir)) {
      const path = join(this.mykgInputDir, name);
      if (isTempName(name)) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      if (!name.endsWith(".md")) continue;
      const match = MIRROR_FILE.exec(name);
      if (match && (this.entries.has(match[1]!) || this.unreadable.has(match[1]!))) continue;
      await rm(path, { force: true, recursive: false }).catch((error: Error) =>
        this.logger.warn(`knowledge: could not remove orphan mirror file ${name} (${error.message})`)
      );
    }
    this.metaCache = null;
  }

  private async reconcileMirror(meta: KnowledgeEntryMeta, body: string): Promise<void> {
    const content = renderMykgInput(meta, body);
    const digest = sha(content);
    const existing = await readTextOrNull(this.mirrorPath(meta.id));
    if (existing === content) {
      this.mirrorDigest.set(meta.id, digest);
      return;
    }
    await writeFileAtomic(this.mirrorPath(meta.id), content, 0o644);
    this.mirrorDigest.set(meta.id, digest);
  }

  private async loadCollections(): Promise<void> {
    const text = await readTextOrNull(this.collectionsPath);
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const version = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as { version?: unknown }).version : undefined;
    if (typeof version === "number" && version > 1) {
      // Not damage: a newer build's format. Moving it aside would let the next write replace it.
      this.collectionsReadOnly = `collections.json was written by a newer version of Orquester (version ${version}); collections can't be changed until Orquester is updated.`;
      this.logger.error(`knowledge: ${this.collectionsReadOnly}`);
      return;
    }
    try {
      this.collectionsFile = parseKnowledgeCollectionsConfig(raw === undefined ? JSON.parse(text) : raw);
      if (this.collectionsFile.rejected.length > 0) {
        this.logger.warn(`knowledge: ${this.collectionsFile.rejected.length} collection record(s) could not be read; kept as-is`);
      }
    } catch (error) {
      const aside = `${this.collectionsPath}.corrupt-${Date.now()}`;
      this.logger.error(`knowledge: collections.json is unreadable (${(error as Error).message}); moved to ${aside}`);
      await rename(this.collectionsPath, aside);
    }
  }
}

/** A colour this build does not know (a newer build's palette key) shows as the first; the record keeps it. */
function toCollection(record: KnowledgeCollectionsFile["collections"][number]): KnowledgeCollection {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    color: isKnowledgeColorKey(record.color) ? record.color : KNOWLEDGE_COLORS[0]!,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
