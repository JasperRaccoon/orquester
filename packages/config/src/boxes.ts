/**
 * Ephemeral AI VMs — persisted stores (spec 2026-10-19-ephemeral-ai-vms-design.md §12).
 *
 * - `boxes.json` ({@link boxesStoreSchema}): box records and the plugin's
 *   non-secret settings. Tolerant: unknown fields, unknown box states and
 *   records written by other versions are kept on rewrite.
 * - `box-secrets.json` ({@link boxSecretsSchema}, mode 0600): provider
 *   credentials, Tailscale credentials, provider-returned Windows passwords.
 *   Never sent to clients, never logged.
 *
 * Path helpers live in `index.ts` (`boxesStorePath`, `boxSecretsPath`, …).
 */

import { z } from "zod";

export const BOXES_STORE_VERSION = 1;
export const BOX_SECRETS_VERSION = 1;

const isoString = z.string();

export const storedBoxSetupStepSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    state: z.string(),
    startedAt: isoString.nullable().optional(),
    finishedAt: isoString.nullable().optional(),
    message: z.string().nullable().optional()
  })
  .passthrough();

export const storedBoxProjectSchema = z
  .object({
    workspace: z.string(),
    name: z.string(),
    path: z.string(),
    /** How the project was created: "empty" | "clone" | "create" | "template". */
    source: z.string().optional(),
    cloneUrl: z.string().optional(),
    /** The clone URL actually used (SSH or HTTPS), credentials stripped. */
    remoteUrl: z.string().optional(),
    ref: z.string().optional(),
    repoId: z.string().optional(),
    repoKey: z.string().optional(),
    repoName: z.string().optional(),
    /** Template tab: the command typed into the box's first terminal. */
    templateCommand: z.string().optional(),
    /** When the daemon opened that terminal and typed the command (it is typed once). */
    templateStartedAt: z.string().optional()
  })
  .passthrough();

/**
 * One box. `state`, `kind`, `provider` and `purpose` are kept as plain strings so a
 * record from a newer build (a state or provider this build does not know) is never
 * dropped; readers narrow them with the `isBox*` guards from `@orquester/api`.
 */
export const storedBoxSchema = z
  .object({
    id: z.string().min(1),
    purpose: z.string(),
    kind: z.string(),
    provider: z.string(),
    region: z.string(),
    regionLabel: z.string().optional(),
    size: z.string(),
    sizeLabel: z.string().optional(),
    image: z.string().nullable().optional(),
    /** The provider-side instance name: `orq-<id>` (the reconciler's marker where tags are missing). */
    name: z.string(),
    /** Provider-specific identity of the instance (ids, zone, run id …), set once create returned. */
    providerRef: z.record(z.unknown()).optional(),
    os: z.string().nullable().optional(),
    arch: z.string().nullable().optional(),
    libc: z.string().nullable().optional(),
    hourlyUsd: z.number().nullable().optional(),
    createdAt: isoString,
    readyAt: isoString.nullable().optional(),
    deadlineAt: isoString.nullable().optional(),
    destroyedAt: isoString.nullable().optional(),
    lastSeenAt: isoString.nullable().optional(),
    state: z.string(),
    stateReason: z.string().nullable().optional(),
    destroyedReason: z.string().nullable().optional(),
    project: storedBoxProjectSchema.nullable().optional(),
    threadId: z.string().nullable().optional(),
    purposeNote: z.string().nullable().optional(),
    /** SHA-256 (hex) of the per-box credential issued at first connect. */
    credentialHash: z.string().optional(),
    /** SHA-256 (hex) of the single-use bootstrap token, until used or expired. */
    bootstrapTokenHash: z.string().optional(),
    bootstrapExpiresAt: isoString.optional(),
    /** Which route the box was told to dial: "public-url" | "tailscale". */
    connectRoute: z.string().optional(),
    setup: z.array(storedBoxSetupStepSchema).optional()
  })
  .passthrough();

export type StoredBox = z.infer<typeof storedBoxSchema>;

export const boxConnectionSettingsSchema = z
  .object({
    mode: z.string().optional(),
    publicUrl: z.string().nullable().optional(),
    tailscaleDaemonUrl: z.string().nullable().optional(),
    tailnet: z.string().nullable().optional(),
    lastCheck: z
      .object({ at: isoString, ok: z.boolean(), message: z.string().nullable().optional() })
      .passthrough()
      .optional()
  })
  .passthrough();

export const blacksmithSettingsSchema = z
  .object({
    gitAccountId: z.string().optional(),
    org: z.string().optional(),
    /** `owner/name` of the private control repo. */
    repo: z.string().optional(),
    workflowFile: z.string().optional(),
    /** Last successful test run. */
    testedAt: isoString.optional()
  })
  .passthrough();

export const boxProviderSettingsSchema = z
  .object({
    /** Validation result of the stored credentials. */
    status: z.string().optional(),
    error: z.string().nullable().optional(),
    checkedAt: isoString.optional(),
    /** Prepared Windows image (snapshot) for providers that need one. */
    windowsImage: z
      .object({
        state: z.string(),
        imageId: z.string().optional(),
        region: z.string().optional(),
        message: z.string().nullable().optional(),
        updatedAt: isoString.optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

/**
 * This appdir's installation id: {@link BOX_INSTALLATION_ID_PATTERN}, written once. New boxes carry
 * it in their `orquester-install` tag and their `orq-<installationId>-<boxId>` name, so the
 * reconciler of one appdir never sweeps another's boxes on a shared provider account.
 */
export const BOX_INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}$/;

export const boxesStoreSchema = z
  .object({
    version: z.number().int().optional(),
    /** See {@link BOX_INSTALLATION_ID_PATTERN}. Absent in stores written before it existed (added at load). */
    installationId: z.string().optional(),
    /**
     * Set when a corrupt boxes.json was moved aside: until then the reconciler destroys no
     * instance of this installation that has no record at all (its record may be in the moved file).
     */
    orphanSweepPausedUntil: isoString.optional(),
    boxes: z.record(storedBoxSchema).default({}),
    connection: boxConnectionSettingsSchema.optional(),
    blacksmith: blacksmithSettingsSchema.optional(),
    providers: z.record(boxProviderSettingsSchema).optional()
  })
  .passthrough();

export type BoxesStore = z.infer<typeof boxesStoreSchema>;

export function emptyBoxesStore(): BoxesStore {
  return { version: BOXES_STORE_VERSION, boxes: {} };
}

export const boxSecretsSchema = z
  .object({
    version: z.number().int().optional(),
    /** provider id → credential field id → value. */
    providers: z.record(z.record(z.string())).default({}),
    tailscale: z
      .object({
        apiToken: z.string().optional(),
        oauthClientId: z.string().optional(),
        oauthClientSecret: z.string().optional()
      })
      .passthrough()
      .optional(),
    /** box id → Windows administrator password the provider returned at creation. */
    windowsPasswords: z.record(z.string()).optional()
  })
  .passthrough();

export type BoxSecrets = z.infer<typeof boxSecretsSchema>;

export function emptyBoxSecrets(): BoxSecrets {
  return { version: BOX_SECRETS_VERSION, providers: {} };
}

// ---------------------------------------------------------------------------
// boxes (sync): box → host config changes waiting for approval (spec §8.3), and the per-box
// sync baseline. Path helpers: `boxConfigChangesPath`, `boxSyncBaselinePath`.
// ---------------------------------------------------------------------------

export const BOX_CONFIG_CHANGES_VERSION = 1;
export const BOX_SYNC_BASELINE_VERSION = 1;

/**
 * One file of a change set: the wire `BoxConfigChangeFile` plus what the daemon pins to decide it
 * (`hostHash`/`boxHash`: SHA-256 hex of the host and box content when the set was made, null when
 * the file was absent on that side; `root`/`agent`: the sync root the file belongs to).
 */
export const storedBoxConfigChangeFileSchema = z
  .object({
    path: z.string(),
    change: z.string(),
    executable: z.boolean().optional(),
    diff: z.string().optional(),
    truncated: z.boolean().optional(),
    binary: z.boolean().optional(),
    hostHash: z.string().nullable().optional(),
    boxHash: z.string().nullable().optional(),
    root: z.string().optional(),
    agent: z.string().optional()
  })
  .passthrough();

/** A change set; `state` is a plain string so a state from a newer build is kept, not dropped. */
export const storedBoxConfigChangeSetSchema = z
  .object({
    id: z.string().min(1),
    boxId: z.string(),
    threadId: z.string().nullable().optional(),
    createdAt: isoString,
    decidedAt: isoString.nullable().optional(),
    state: z.string(),
    files: z.array(storedBoxConfigChangeFileSchema)
  })
  .passthrough();

export type StoredBoxConfigChangeFile = z.infer<typeof storedBoxConfigChangeFileSchema>;
export type StoredBoxConfigChangeSet = z.infer<typeof storedBoxConfigChangeSetSchema>;

/**
 * `config-changes.json`. `changes` is read entry by entry: an entry this build cannot read is kept
 * verbatim on rewrite (see {@link parseBoxConfigChangesStore}).
 */
export const boxConfigChangesStoreSchema = z
  .object({
    version: z.number().int().optional(),
    changes: z.array(z.unknown()).default([])
  })
  .passthrough();

export interface ParsedBoxConfigChangesStore {
  /** The envelope's own fields other than `changes` (kept on rewrite). */
  envelope: Record<string, unknown>;
  /** Readable sets, in file order. */
  sets: StoredBoxConfigChangeSet[];
  /** Entries this build could not read, kept verbatim. */
  unreadable: unknown[];
}

/** Tolerant read of `config-changes.json`; a value that is not an envelope at all reads as empty. */
export function parseBoxConfigChangesStore(value: unknown): ParsedBoxConfigChangesStore {
  const parsed = boxConfigChangesStoreSchema.safeParse(value);
  if (!parsed.success) {
    return { envelope: { version: BOX_CONFIG_CHANGES_VERSION }, sets: [], unreadable: [] };
  }
  const { changes, ...envelope } = parsed.data;
  const sets: StoredBoxConfigChangeSet[] = [];
  const unreadable: unknown[] = [];
  for (const entry of changes) {
    const set = storedBoxConfigChangeSetSchema.safeParse(entry);
    if (set.success) sets.push(set.data);
    else unreadable.push(entry);
  }
  return { envelope, sets, unreadable };
}

/**
 * What config sync last agreed with a box for one host path: `h` = SHA-256 of the file's synced
 * view (equal on both sides then: the bytes, or the secret-blanked / subset form of a config),
 * `s`/`m` = the box file's size and mtime then (a box file still at those is unchanged).
 */
export const boxSyncBaselineEntrySchema = z
  .object({
    h: z.string(),
    s: z.number(),
    m: z.number()
  })
  .passthrough();

/** `boxes/sync/<boxId>.json`: host path → {@link boxSyncBaselineEntrySchema}. A disposable cache. */
export const boxSyncBaselineSchema = z
  .object({
    version: z.number().int().optional(),
    entries: z.record(z.unknown()).default({})
  })
  .passthrough();

export type BoxSyncBaselineEntry = z.infer<typeof boxSyncBaselineEntrySchema>;
