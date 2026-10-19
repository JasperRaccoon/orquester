import type { SecretFileUpdatedBy } from "@orquester/api";

/**
 * The secret-files vault store (spec §3): `<appdir>/daemon/secret-files/`
 * (dir 0700) holding `vaults.json` (0600, a tolerant schema in
 * `packages/config`) and content blobs (0600) keyed by content sha256.
 *
 * Host-only. Nothing here is ever sent to a client as-is: the service maps
 * records to the wire types in `@orquester/api` (`secret-files.ts`), which
 * carry opaque version ids, never content or content hashes.
 *
 * INTERFACE STUB — the implementation lands separately; the service builds on
 * exactly these exports.
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
}

export interface VaultRecord {
  workspace: string;
  repoKey: string;
  files: VaultFileRecord[];
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
}

export class SecretVaultStore {
  constructor(options: SecretVaultStoreOptions) {
    void options;
  }

  /** Read (or create) the store; a corrupt index is moved aside, an unreadable one makes the store read-only. */
  async load(): Promise<void> {
    throw new SecretVaultStoreError("SECRET_FILES_UNAVAILABLE", "Not implemented.");
  }

  /** False after an unreadable index: every `update`/`delete` throws SECRET_FILES_UNAVAILABLE. */
  get writable(): boolean {
    return false;
  }

  list(): VaultRecord[] {
    return [];
  }

  get(workspace: string, repoKey: string): VaultRecord | undefined {
    void workspace;
    void repoKey;
    return undefined;
  }

  /**
   * Serialized read-modify-write of one vault. `mutate` gets a deep copy of the
   * current record (undefined: none yet) and returns the next one (null: delete
   * it). Content stored through `tx` is durable before the index points at it;
   * versions beyond SECRET_FILE_HISTORY_MAX are dropped and their blobs swept
   * when unreferenced.
   */
  async update(
    workspace: string,
    repoKey: string,
    mutate: (current: VaultRecord | undefined, tx: VaultTransaction) => Promise<VaultRecord | null> | VaultRecord | null
  ): Promise<VaultRecord | null> {
    void workspace;
    void repoKey;
    void mutate;
    throw new SecretVaultStoreError("SECRET_FILES_UNAVAILABLE", "Not implemented.");
  }

  /** The content of a version (by its sha256). Throws SECRET_FILES_ERROR when the blob is gone. */
  async readContent(sha256: string): Promise<Uint8Array> {
    void sha256;
    throw new SecretVaultStoreError("SECRET_FILES_ERROR", "Not implemented.");
  }
}
