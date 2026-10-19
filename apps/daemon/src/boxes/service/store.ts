/**
 * The plugin's two files (spec §12): `boxes.json` (box records and the non-secret settings) and
 * `box-secrets.json` (provider credentials, Tailscale credentials, Windows passwords; mode 0600).
 *
 * - **Tolerant.** Each file is kept as the JSON object it was read as, and every change edits that
 *   object, so unknown top-level fields, unknown record fields and whole records this build cannot
 *   parse (a newer build's) are written back untouched. Readers parse one record or section at a
 *   time; one that does not parse is skipped, never dropped.
 * - **Serialized and atomic.** Every change runs in one queue against a copy of the current state,
 *   is written with temp + rename, and only then becomes the state in memory. A failed write
 *   changes nothing (the caller sees the error — a box is never created without its record).
 * - **Corrupt files** (not JSON, not an object) are moved aside to `.corrupt-<stamp>` and the store
 *   starts empty, logged. A file that cannot even be read, or a corrupt one that cannot be moved,
 *   is never written over: every change answers 503 until the daemon restarts with it fixed.
 *
 * Secret values never appear in a log line or an error message from this module.
 */

import { EventEmitter } from "node:events";
import { chmod, readFile, rename } from "node:fs/promises";

import {
  BOX_SECRETS_VERSION,
  BOXES_STORE_VERSION,
  blacksmithSettingsSchema,
  boxConnectionSettingsSchema,
  boxProviderSettingsSchema,
  boxesStorePath,
  boxSecretsPath,
  storedBoxSchema,
  type StoredBox
} from "@orquester/config";
import { z } from "zod";

import { writeFileAtomic } from "../../agent-hooks.ts";
import { BoxError } from "./errors.ts";

/**
 * What the hub (boxes/hub) needs of the box records: read one, and change one in the store's
 * queue (bootstrap token hash, credential hash, `lastSeenAt`, `os`/`arch`/`libc`). `update`
 * resolves the record as written, or undefined when there is no such box.
 */
export interface BoxRecordStore {
  get(boxId: string): StoredBox | undefined;
  update(boxId: string, mutate: (record: StoredBox) => void): Promise<StoredBox | undefined>;
}

export type BoxConnectionSettingsRecord = z.infer<typeof boxConnectionSettingsSchema>;
export type BlacksmithSettingsRecord = z.infer<typeof blacksmithSettingsSchema>;
export type BoxProviderSettingsRecord = z.infer<typeof boxProviderSettingsSchema>;

export interface TailscaleSecrets {
  apiToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

type JsonObject = Record<string, unknown>;

const credentialsSchema = z.record(z.string());
const tailscaleSecretsSchema = z
  .object({ apiToken: z.string().optional(), oauthClientId: z.string().optional(), oauthClientSecret: z.string().optional() })
  .passthrough();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A map field of `parent`, created when missing or not an object (the bad value is only replaced on write). */
function objectField(parent: JsonObject, key: string): JsonObject {
  const current = parent[key];
  if (isObject(current)) return current;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

export interface BoxStoreOptions {
  baseDir: string;
  logger?: Pick<Console, "warn" | "error">;
}

/** One file's state: the object as read, or why changes are refused. */
interface FileState {
  path: string;
  label: string;
  data: JsonObject;
  blocked: string | null;
  mode: number;
}

export class BoxStore implements BoxRecordStore {
  /** Emits `"changed"` with the box id a write touched, or null for settings and secrets. */
  readonly events = new EventEmitter();

  private readonly boxes: FileState;
  private readonly secrets: FileState;
  private readonly logger: Pick<Console, "warn" | "error">;
  private queue: Promise<unknown> = Promise.resolve();
  /** Parsed records, rebuilt after every load and write. */
  private records = new Map<string, StoredBox>();

  constructor(options: BoxStoreOptions) {
    this.logger = options.logger ?? console;
    this.boxes = { path: boxesStorePath(options.baseDir), label: "boxes.json", data: { version: BOXES_STORE_VERSION, boxes: {} }, blocked: null, mode: 0o600 };
    this.secrets = { path: boxSecretsPath(options.baseDir), label: "box-secrets.json", data: { version: BOX_SECRETS_VERSION, providers: {} }, blocked: null, mode: 0o600 };
  }

  async load(): Promise<void> {
    await this.loadFile(this.boxes, (data) => isObject(data) && (data.boxes === undefined || isObject(data.boxes)));
    await this.loadFile(this.secrets, (data) => isObject(data));
    this.reindex();
  }

  /** Why changes to boxes.json are refused this run, if they are. */
  get blockedReason(): string | null {
    return this.boxes.blocked ?? this.secrets.blocked;
  }

  // ---- records ---------------------------------------------------------------------------------

  list(): StoredBox[] {
    return [...this.records.values()];
  }

  get(boxId: string): StoredBox | undefined {
    return this.records.get(boxId);
  }

  /** Add a new record (written before any provider call). Refuses an id that exists. */
  async insert(record: StoredBox): Promise<StoredBox> {
    const parsed = storedBoxSchema.parse(record);
    await this.change(this.boxes, (data) => {
      const boxes = objectField(data, "boxes");
      if (Object.hasOwn(boxes, parsed.id)) throw new BoxError(409, "BOX_INVALID_REQUEST", `Box ${parsed.id} already exists.`);
      boxes[parsed.id] = structuredClone(parsed);
    });
    this.events.emit("changed", parsed.id);
    return this.records.get(parsed.id)!;
  }

  async update(boxId: string, mutate: (record: StoredBox) => void): Promise<StoredBox | undefined> {
    let found = false;
    await this.change(this.boxes, (data) => {
      const boxes = objectField(data, "boxes");
      if (!Object.hasOwn(boxes, boxId)) return false;
      const parsed = storedBoxSchema.safeParse(boxes[boxId]);
      // A record this build cannot read is never rewritten through it.
      if (!parsed.success) return false;
      const record = parsed.data;
      mutate(record);
      boxes[boxId] = storedBoxSchema.parse(record);
      found = true;
      return true;
    });
    if (!found) return undefined;
    this.events.emit("changed", boxId);
    return this.records.get(boxId);
  }

  /** Drop records (pruning old destroyed boxes). Records this build cannot parse are never removed. */
  async remove(boxIds: string[]): Promise<void> {
    if (boxIds.length === 0) return;
    await this.change(this.boxes, (data) => {
      const boxes = objectField(data, "boxes");
      let changed = false;
      for (const id of boxIds) {
        if (Object.hasOwn(boxes, id) && storedBoxSchema.safeParse(boxes[id]).success) {
          delete boxes[id];
          changed = true;
        }
      }
      return changed;
    });
    for (const id of boxIds) this.events.emit("changed", id);
  }

  // ---- settings (boxes.json) -------------------------------------------------------------------

  connection(): BoxConnectionSettingsRecord {
    return this.section(this.boxes.data.connection, boxConnectionSettingsSchema) ?? {};
  }

  blacksmith(): BlacksmithSettingsRecord {
    return this.section(this.boxes.data.blacksmith, blacksmithSettingsSchema) ?? {};
  }

  providerSettings(providerId: string): BoxProviderSettingsRecord {
    const providers = this.boxes.data.providers;
    return (isObject(providers) ? this.section(providers[providerId], boxProviderSettingsSchema) : null) ?? {};
  }

  async updateConnection(mutate: (settings: BoxConnectionSettingsRecord) => void): Promise<void> {
    await this.changeSection(this.boxes, (data) => data, "connection", boxConnectionSettingsSchema, mutate);
  }

  async updateBlacksmith(mutate: (settings: BlacksmithSettingsRecord) => void): Promise<void> {
    await this.changeSection(this.boxes, (data) => data, "blacksmith", blacksmithSettingsSchema, mutate);
  }

  /** `mutate` returning null removes the provider's settings record. */
  async updateProviderSettings(providerId: string, mutate: (settings: BoxProviderSettingsRecord) => void | null): Promise<void> {
    await this.changeSection(this.boxes, (data) => objectField(data, "providers"), providerId, boxProviderSettingsSchema, mutate);
  }

  // ---- secrets (box-secrets.json) --------------------------------------------------------------

  providerCredentials(providerId: string): Record<string, string> | null {
    const providers = this.secrets.data.providers;
    if (!isObject(providers)) return null;
    const parsed = credentialsSchema.safeParse(providers[providerId]);
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
  }

  /** Store (or with null, forget) a provider's credentials. */
  async setProviderCredentials(providerId: string, credentials: Record<string, string> | null): Promise<void> {
    await this.change(this.secrets, (data) => {
      const providers = objectField(data, "providers");
      if (credentials === null) {
        if (!Object.hasOwn(providers, providerId)) return false;
        delete providers[providerId];
      } else {
        providers[providerId] = { ...credentials };
      }
      return true;
    });
    this.events.emit("changed", null);
  }

  tailscale(): TailscaleSecrets | null {
    const parsed = tailscaleSecretsSchema.safeParse(this.secrets.data.tailscale);
    if (!parsed.success) return null;
    const { apiToken, oauthClientId, oauthClientSecret } = parsed.data;
    if (!apiToken && !(oauthClientId && oauthClientSecret)) return null;
    return { ...(apiToken ? { apiToken } : {}), ...(oauthClientId ? { oauthClientId } : {}), ...(oauthClientSecret ? { oauthClientSecret } : {}) };
  }

  async setTailscale(secrets: TailscaleSecrets | null): Promise<void> {
    await this.change(this.secrets, (data) => {
      if (secrets === null) {
        if (!Object.hasOwn(data, "tailscale")) return false;
        delete data.tailscale;
      } else {
        data.tailscale = { ...secrets };
      }
      return true;
    });
    this.events.emit("changed", null);
  }

  windowsPassword(boxId: string): string | null {
    const passwords = this.secrets.data.windowsPasswords;
    if (!isObject(passwords)) return null;
    const value = passwords[boxId];
    return typeof value === "string" ? value : null;
  }

  async setWindowsPassword(boxId: string, password: string | null): Promise<void> {
    await this.change(this.secrets, (data) => {
      const passwords = objectField(data, "windowsPasswords");
      if (password === null) {
        if (!Object.hasOwn(passwords, boxId)) return false;
        delete passwords[boxId];
      } else {
        passwords[boxId] = password;
      }
      return true;
    });
  }

  /** Every write queued so far has landed (or failed). Never rejects. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // ---- internals -------------------------------------------------------------------------------

  private section<T extends z.ZodTypeAny>(value: unknown, schema: T): z.infer<T> | null {
    if (value === undefined) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private async changeSection<T extends z.ZodTypeAny>(
    file: FileState,
    parentOf: (data: JsonObject) => JsonObject,
    key: string,
    schema: T,
    mutate: (settings: z.infer<T>) => void | null
  ): Promise<void> {
    await this.change(file, (data) => {
      const parent = parentOf(data);
      const current = parent[key] === undefined ? {} : parent[key];
      const parsed = schema.safeParse(current);
      // A section this build cannot read is never written over.
      if (!parsed.success) throw new BoxError(500, "BOXES_UNAVAILABLE", `${file.label} has a malformed "${key}" section; refusing to overwrite it.`);
      const value = parsed.data;
      if (mutate(value) === null) {
        delete parent[key];
      } else {
        parent[key] = schema.parse(value);
      }
      return true;
    });
    this.events.emit("changed", null);
  }

  /**
   * Run `mutate` against a copy of `file`'s data in the queue; write it when `mutate` did not
   * return false, then make it the state. A throw from `mutate` or the write changes nothing.
   */
  private change(file: FileState, mutate: (data: JsonObject) => boolean | void): Promise<void> {
    const run = this.queue.then(async () => {
      if (file.blocked !== null) {
        throw new BoxError(503, "BOXES_UNAVAILABLE", `${file.label} is read-only: ${file.blocked}. Nothing is saved until it is fixed and the daemon restarts.`);
      }
      const next = structuredClone(file.data);
      if (mutate(next) === false) return;
      await this.write(file, next);
      file.data = next;
      if (file === this.boxes) this.reindex();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(file: FileState, data: JsonObject): Promise<void> {
    try {
      await writeFileAtomic(file.path, `${JSON.stringify(data, null, 2)}\n`, file.mode, false);
      await chmod(file.path, file.mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.logger.error(`Failed to write ${file.label} (${code ?? "unknown error"})`);
      throw new BoxError(500, "BOXES_UNAVAILABLE", `Could not save ${file.label} (${code ?? "unknown error"}).`);
    }
  }

  private async loadFile(file: FileState, valid: (data: unknown) => boolean): Promise<void> {
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.block(file, `it could not be read (${code ?? "unknown error"})`);
      return;
    }
    let data: unknown;
    let detail: string | null = null;
    try {
      data = JSON.parse(text);
      if (!valid(data)) detail = "not a valid store";
    } catch {
      // JSON.parse names a position only, never the content.
      detail = "not JSON";
    }
    if (detail === null) {
      file.data = data as JsonObject;
      return;
    }
    const aside = `${file.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(file.path, aside);
    } catch (moveError) {
      const code = (moveError as NodeJS.ErrnoException)?.code;
      this.block(file, `it is unreadable (${detail}) and could not be moved aside (${code ?? "unknown error"})`);
      return;
    }
    this.logger.warn(`${file.label} is unreadable (${detail}); moved it to ${aside} and started empty.`);
  }

  private block(file: FileState, reason: string): void {
    file.blocked = reason;
    this.logger.error(`${file.label}: ${reason}. Box changes are refused until it is fixed and the daemon restarts.`);
  }

  private reindex(): void {
    const records = new Map<string, StoredBox>();
    const boxes = this.boxes.data.boxes;
    if (isObject(boxes)) {
      for (const [id, raw] of Object.entries(boxes)) {
        const parsed = storedBoxSchema.safeParse(raw);
        if (parsed.success && parsed.data.id === id) records.set(id, Object.freeze(parsed.data) as StoredBox);
      }
    }
    this.records = records;
  }
}
