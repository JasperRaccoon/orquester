import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SECRET_FILE_HISTORY_MAX, SECRET_FILE_MAX_BYTES, type SecretFileUpdatedBy, repoKeyProblem } from "@orquester/api";
import {
  SECRET_BLOBS_DIR_NAME,
  SECRET_VAULT_INDEX_FILE,
  type SecretVaultRecordConfig,
  isSecretBlobSha256,
  isValidName,
  parseSecretVaultsConfig,
  secretVaultKey,
  secretVaultRecordSchema,
  serializeSecretVaultsFile
} from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";

/**
 * The secret-files vault store (spec §3): `<appdir>/daemon/secret-files/`
 * (dir 0700) holding `vaults.json` (0600, a tolerant schema in
 * `packages/config`) and content blobs (0600) keyed by content sha256.
 *
 * Host-only. Nothing here is ever sent to a client as-is: the service maps
 * records to the wire types in `@orquester/api` (`secret-files.ts`), which
 * carry opaque version ids, never content or content hashes. Nothing here logs
 * content or content hashes either.
 *
 * Durability:
 * - every load and update runs on ONE serialized chain for the whole store;
 * - a blob is written atomically (temp file, fsync, rename) BEFORE the index
 *   that points at it, and the in-memory index changes only after the index
 *   write landed — a failed write leaves memory and disk on the old record;
 * - after each successful write (and at load) blobs no record references are
 *   deleted, best effort (a retired file's kept history is a reference too) — but never while a moved-aside
 *   `vaults.json.corrupt-*` exists (restoring it by hand needs its blobs), and
 *   never a blob whose sha256 appears in a record this build could not read;
 * - a corrupt index is moved aside and the store starts empty; an unreadable
 *   one (permissions, EIO, …) makes the store read-only for this run.
 */

/** One stored version of one file. */
export interface VaultFileVersion {
  /** Opaque, random; what the wire calls `version`. */
  id: string;
  /** sha256 (hex) of the content — host-only, never sent. */
  sha256: string;
  updatedAt: string;
  updatedBy: SecretFileUpdatedBy;
}

export interface VaultFileRecord {
  /** Relative to the clone root, `/`-separated. */
  path: string;
  /** Newest first; `versions[0]` is current. At most SECRET_FILE_HISTORY_MAX. */
  versions: VaultFileVersion[];
}

/** Per clone, per managed path: the vault version id that clone last received or pushed. */
export interface VaultCloneRecord {
  baselines: Record<string, string>;
  /** Since when the clone is no longer listed with the repo (absent: listed); see the service's pruning grace. */
  unlistedAt?: string;
}

export interface VaultRecord {
  workspace: string;
  repoKey: string;
  files: VaultFileRecord[];
  /**
   * Files no longer managed (unmanaged or excluded), their history kept for manual recovery: these
   * versions count as blob references and are capped like a managed file's. Absent on older records.
   */
  retired?: VaultFileRecord[];
  /** Candidate paths the user turned off. */
  excluded: string[];
  /** Keyed by project directory (as `ProjectSummary.path`). */
  clones: Record<string, VaultCloneRecord>;
  createdAt: string;
  updatedAt: string;
}

/** Inside an `update`: store content first, get its new version (deduplicated by sha256). */
export interface VaultTransaction {
  putContent(content: Uint8Array, updatedBy: SecretFileUpdatedBy): Promise<VaultFileVersion>;
}

export class SecretVaultStoreError extends Error {
  constructor(
    public readonly code: "SECRET_FILES_UNAVAILABLE" | "SECRET_FILES_ERROR",
    message: string
  ) {
    super(message);
    this.name = "SecretVaultStoreError";
  }
}

export interface SecretVaultStoreOptions {
  /** `<appdir>/daemon/secret-files` (a packages/config path helper). */
  dir: string;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
}

const MOVED_ASIDE_PREFIX = `${SECRET_VAULT_INDEX_FILE}.corrupt-`;
/** A blob's temp file while it is written: `.<sha256>.<uuid>.tmp`. */
const BLOB_TEMP_PATTERN = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/;
const noop = (): void => undefined;

export class SecretVaultStore {
  private readonly dir: string;
  private readonly indexFile: string;
  private readonly blobsDir: string;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "warn" | "error">;
  /** Never mutated in place: an update swaps in a new map once its write landed. */
  private records = new Map<string, VaultRecord>();
  /** `vaults` entries this build cannot read, written back verbatim. */
  private rejected: unknown[] = [];
  /** Unknown top-level keys, written back verbatim. */
  private extra: Record<string, unknown> = {};
  /** Null: writable. */
  private blockedReason: string | null = "the vault store is not loaded";
  /** The tail of the one write chain. Never rejects. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: SecretVaultStoreOptions) {
    this.dir = options.dir;
    this.indexFile = join(options.dir, SECRET_VAULT_INDEX_FILE);
    this.blobsDir = join(options.dir, SECRET_BLOBS_DIR_NAME);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  /** Read (or create) the store; a corrupt index is moved aside, an unreadable one makes the store read-only. */
  async load(): Promise<void> {
    return this.enqueue(() => this.loadNow());
  }

  /** False after an unreadable index: every `update`/`delete` throws SECRET_FILES_UNAVAILABLE. */
  get writable(): boolean {
    return this.blockedReason === null;
  }

  list(): VaultRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  get(workspace: string, repoKey: string): VaultRecord | undefined {
    const record = this.records.get(secretVaultKey(workspace, repoKey));
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Serialized read-modify-write of one vault. `mutate` gets a deep copy of the
   * current record (undefined: none yet) and returns the next one (null: delete
   * it). Content stored through `tx` is durable before the index points at it;
   * versions beyond SECRET_FILE_HISTORY_MAX are dropped and their blobs swept
   * when unreferenced.
   *
   * The store owns the record's `workspace`/`repoKey` (a change is refused),
   * `createdAt` (kept from the current record) and `updatedAt` (stamped when
   * anything else changed; a no-op result writes nothing). Unknown fields on
   * the copy `mutate` gets are written back if `mutate` keeps them. A result
   * the index schema would not read back fails with SECRET_FILES_ERROR.
   */
  async update(
    workspace: string,
    repoKey: string,
    mutate: (current: VaultRecord | undefined, tx: VaultTransaction) => Promise<VaultRecord | null> | VaultRecord | null
  ): Promise<VaultRecord | null> {
    return this.enqueue(() => this.updateNow(workspace, repoKey, mutate));
  }

  /** The content of a version (by its sha256). Throws SECRET_FILES_ERROR when the blob is gone. */
  async readContent(sha256: string): Promise<Uint8Array> {
    if (!isSecretBlobSha256(sha256)) throw new SecretVaultStoreError("SECRET_FILES_ERROR", "Not a stored content id.");
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.blobsDir, sha256));
    } catch (error) {
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", `The stored content could not be read (${errorCode(error)}).`);
    }
    if (sha256Hex(bytes) !== sha256) {
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", "The stored content is damaged.");
    }
    return bytes;
  }

  // -------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(noop, noop);
    return result;
  }

  private async loadNow(): Promise<void> {
    this.records = new Map();
    this.rejected = [];
    this.extra = {};
    this.blockedReason = null;
    try {
      await mkdir(dirname(this.dir), { recursive: true });
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.block(`the secret files directory could not be created (${errorCode(error)})`);
      return;
    }
    // An existing directory keeps whatever mode it had: tighten it.
    for (const path of [this.dir, this.blobsDir]) {
      await chmod(path, 0o700).catch((error: unknown) =>
        this.logger.warn(`Could not restrict ${path} to 0700 (${errorCode(error)}).`)
      );
    }
    let text: string;
    try {
      text = await readFile(this.indexFile, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        await this.sweepBlobs(true);
        return;
      }
      this.block(`${SECRET_VAULT_INDEX_FILE} could not be read (${errorCode(error)})`);
      return;
    }
    let parsed: ReturnType<typeof parseSecretVaultsConfig>;
    try {
      parsed = parseSecretVaultsConfig(JSON.parse(text));
    } catch (error) {
      // A JSON syntax error's message can quote the file; say only what kind of failure it was.
      await this.quarantine(error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : "invalid");
      return;
    }
    for (const record of parsed.vaults) {
      this.records.set(secretVaultKey(record.workspace, record.repoKey), record as VaultRecord);
    }
    this.rejected = parsed.rejected;
    this.extra = parsed.extra;
    if (this.rejected.length > 0) {
      this.logger.warn(
        `${SECRET_VAULT_INDEX_FILE}: ${this.rejected.length} vault(s) this build cannot read (malformed, a newer shape, ` +
          "or a repeated workspace and repo) are not listed; they stay in the file untouched, and so does their content."
      );
    }
    await this.sweepBlobs(true);
  }

  private async updateNow(
    workspace: string,
    repoKey: string,
    mutate: (current: VaultRecord | undefined, tx: VaultTransaction) => Promise<VaultRecord | null> | VaultRecord | null
  ): Promise<VaultRecord | null> {
    if (this.blockedReason !== null) {
      throw new SecretVaultStoreError(
        "SECRET_FILES_UNAVAILABLE",
        `Secret files are read-only: ${this.blockedReason}. Nothing is saved until it is fixed and the daemon restarts.`
      );
    }
    if (!isValidName(workspace) || repoKeyProblem(repoKey) !== null) {
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", "Not a vault's workspace and repo.");
    }
    const key = secretVaultKey(workspace, repoKey);
    const current = this.records.get(key);
    const stored = new Set<string>();
    let open = true;
    const tx: VaultTransaction = {
      putContent: async (content, updatedBy) => {
        if (!open) throw new SecretVaultStoreError("SECRET_FILES_ERROR", "The vault update is already over.");
        if (content.byteLength > SECRET_FILE_MAX_BYTES) {
          throw new SecretVaultStoreError("SECRET_FILES_ERROR", "The file is too large for the vault.");
        }
        const sha256 = sha256Hex(content);
        await this.storeBlob(sha256, content);
        stored.add(sha256);
        return { id: newVersionId(), sha256, updatedAt: this.now().toISOString(), updatedBy: copyUpdatedBy(updatedBy) };
      }
    };
    let next: VaultRecord | null;
    try {
      next = await mutate(current ? structuredClone(current) : undefined, tx);
    } finally {
      open = false;
    }

    if (next === null) {
      if (!current) return null;
      const records = new Map(this.records);
      records.delete(key);
      await this.writeIndex(records);
      this.records = records;
      await this.sweepBlobs(false);
      return null;
    }

    const record = this.normalize(next, workspace, repoKey, current);
    if (current && canonicalJson({ ...current, updatedAt: "" }) === canonicalJson({ ...record, updatedAt: "" })) {
      return structuredClone(current);
    }
    await this.requireBlobs(record, current, stored);
    const records = new Map(this.records);
    records.set(key, record);
    await this.writeIndex(records);
    this.records = records;
    await this.sweepBlobs(false);
    return structuredClone(record);
  }

  /** The record as stored: history trimmed, timestamps stamped, checked against the index schema. */
  private normalize(next: VaultRecord, workspace: string, repoKey: string, current: VaultRecord | undefined): VaultRecord {
    if (next === undefined || typeof next !== "object" || next.workspace !== workspace || next.repoKey !== repoKey) {
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", "A vault update may not change the vault's workspace or repo.");
    }
    const copy = structuredClone(next);
    const stamp = this.now().toISOString();
    const candidate = {
      ...copy,
      files: Array.isArray(copy.files) ? copy.files.map(trimHistory) : copy.files,
      ...(Array.isArray(copy.retired) ? { retired: copy.retired.map(trimHistory) } : {}),
      createdAt: current?.createdAt ?? stamp,
      updatedAt: stamp
    };
    const parsed = secretVaultRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the record";
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", `The vault record is invalid (${where}: ${issue?.message ?? "invalid"}).`);
    }
    return parsed.data as SecretVaultRecordConfig as VaultRecord;
  }

  /**
   * Every version the record adds must point at content on disk: stored in this update, or
   * already referenced by the current record (whose blobs were durable before it was written).
   */
  private async requireBlobs(record: VaultRecord, current: VaultRecord | undefined, stored: Set<string>): Promise<void> {
    const known = new Set(stored);
    if (current) for (const sha256 of referencedBlobs(current)) known.add(sha256);
    for (const file of [...record.files, ...(record.retired ?? [])]) {
      for (const version of file.versions) {
        if (known.has(version.sha256)) continue;
        try {
          if (!(await stat(join(this.blobsDir, version.sha256))).isFile()) throw new Error("not a file");
        } catch {
          throw new SecretVaultStoreError("SECRET_FILES_ERROR", "A version points at content the vault does not have.");
        }
        known.add(version.sha256);
      }
    }
  }

  /** The whole index (0600), atomically. Throws SECRET_FILES_ERROR when it did not land. */
  private async writeIndex(records: Map<string, VaultRecord>): Promise<void> {
    const data = serializeSecretVaultsFile({
      version: 1,
      vaults: [...records.values()] as SecretVaultRecordConfig[],
      rejected: this.rejected,
      extra: this.extra
    });
    try {
      await writeFileAtomic(this.indexFile, `${JSON.stringify(data, null, 2)}\n`, 0o600, false);
    } catch (error) {
      this.logger.error(`Could not write the secret files vault index (${errorCode(error)}).`);
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", `The vault could not be saved (${errorCode(error)}).`);
    }
  }

  /** `blobs/<sha256>` (0600), atomically and synced; an intact existing blob is reused. */
  private async storeBlob(sha256: string, content: Uint8Array): Promise<void> {
    const target = join(this.blobsDir, sha256);
    try {
      if (sha256Hex(await readFile(target)) === sha256) {
        await chmod(target, 0o600).catch(noop);
        return;
      }
      this.logger.warn("A stored secret file blob was damaged; writing it again.");
    } catch {
      // Missing (or unreadable): write it.
    }
    const temp = join(this.blobsDir, `.${sha256}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temp, 0o600);
      await rename(temp, target);
    } catch (error) {
      await handle?.close().catch(noop);
      await unlink(temp).catch(noop);
      throw new SecretVaultStoreError("SECRET_FILES_ERROR", `The content could not be stored (${errorCode(error)}).`);
    }
    // The rename itself durable before the index can name the blob (best effort).
    try {
      const dir = await open(this.blobsDir, "r");
      await dir.sync().finally(() => dir.close());
    } catch {
      // Not every filesystem syncs a directory.
    }
  }

  /**
   * Best effort: delete the blobs no record references. Never while a moved-aside index exists;
   * every sha256-shaped string in a record this build could not read (or an unknown top-level
   * key) counts as a reference. At load, also clears temp files a crash left behind.
   */
  private async sweepBlobs(atLoad: boolean): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.blobsDir);
    } catch {
      return;
    }
    if (atLoad) {
      for (const name of names.filter((n) => BLOB_TEMP_PATTERN.test(n))) {
        await unlink(join(this.blobsDir, name)).catch(noop);
      }
    }
    const referenced = new Set<string>();
    for (const record of this.records.values()) for (const sha256 of referencedBlobs(record)) referenced.add(sha256);
    for (const match of JSON.stringify([this.rejected, this.extra]).matchAll(/[0-9a-f]{64}/g)) referenced.add(match[0]);
    const unreferenced = names.filter((name) => isSecretBlobSha256(name) && !referenced.has(name));
    if (unreferenced.length === 0) return;
    if (await this.hasMovedAsideIndex()) {
      if (atLoad) {
        this.logger.warn(
          `Not deleting unused secret file content while a moved-aside ${SECRET_VAULT_INDEX_FILE} exists in ${this.dir}; ` +
            "restore or delete it to let the vault clean up."
        );
      }
      return;
    }
    for (const name of unreferenced) {
      await unlink(join(this.blobsDir, name)).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") this.logger.warn(`Could not delete unused secret file content (${errorCode(error)}).`);
      });
    }
  }

  /** True when a `vaults.json.corrupt-*` exists — or when that cannot be told. */
  private async hasMovedAsideIndex(): Promise<boolean> {
    try {
      return (await readdir(this.dir)).some((name) => name.startsWith(MOVED_ASIDE_PREFIX));
    } catch {
      return true;
    }
  }

  private async quarantine(detail: string): Promise<void> {
    let aside = join(this.dir, `${MOVED_ASIDE_PREFIX}${this.now().toISOString().replace(/[:.]/g, "-")}`);
    if (await exists(aside)) aside = `${aside}-${randomUUID().slice(0, 8)}`;
    try {
      await rename(this.indexFile, aside);
    } catch (error) {
      this.block(`${SECRET_VAULT_INDEX_FILE} is corrupt (${detail}) and could not be moved aside (${errorCode(error)})`);
      return;
    }
    this.logger.warn(`${SECRET_VAULT_INDEX_FILE} is corrupt (${detail}); moved it to ${aside} and started with no vaults.`);
  }

  private block(reason: string): void {
    this.blockedReason = reason;
    this.logger.error(`${reason}. Secret files are read-only until it is fixed and the daemon restarts.`);
  }
}

/** A file's history capped at SECRET_FILE_HISTORY_MAX versions (the newest kept). */
function trimHistory(file: VaultFileRecord): VaultFileRecord {
  return file && Array.isArray(file.versions) ? { ...file, versions: file.versions.slice(0, SECRET_FILE_HISTORY_MAX) } : file;
}

/** Every blob a record points at: its managed files' versions and its retired files' kept history. */
function referencedBlobs(record: VaultRecord): string[] {
  const out: string[] = [];
  for (const file of [...record.files, ...(record.retired ?? [])]) for (const version of file.versions) out.push(version.sha256);
  return out;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function newVersionId(): string {
  return `v_${randomBytes(16).toString("base64url")}`;
}

function copyUpdatedBy(updatedBy: SecretFileUpdatedBy): SecretFileUpdatedBy {
  return {
    kind: updatedBy.kind,
    ...(updatedBy.threadId !== undefined ? { threadId: updatedBy.threadId } : {}),
    ...(updatedBy.projectName !== undefined ? { projectName: updatedBy.projectName } : {})
  };
}

/** JSON with object keys sorted, so a reordered but equal record compares equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, (item as Record<string, unknown>)[k]]))
      : item
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}
