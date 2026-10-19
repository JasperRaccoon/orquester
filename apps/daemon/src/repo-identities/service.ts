import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type RepoFaviconSource,
  type RepoIcon,
  type RepoIconStoredType,
  type RepoIdentity,
  type RepoIdentityChangedPayload,
  type RepoIdentityErrorCode,
  REPO_ICON_MAX_BYTES,
  REPO_IDENTITIES_CHANNEL,
  REPO_IDENTITY_CHANGED,
  isRepoIconStoredType,
  isSingleEmoji,
  normalizeRepoLabel,
  repoKeyProblem,
  repoLabelProblem
} from "@orquester/api";
import {
  type RepoIdentitiesFile,
  type RepoIdentityIconRecord,
  type RepoIdentityRecord,
  isRepoIconFileName,
  parseRepoIdentitiesConfig,
  repoIconFileOfEntry
} from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";
import type { Broadcaster } from "../broadcaster.ts";
import { sniffRepoIcon } from "./image-sniff.ts";

/** The contract's refusal codes, plus this daemon's read-only and unexpected-failure answers. */
export type RepoIdentityServiceErrorCode = RepoIdentityErrorCode | "REPO_IDENTITIES_UNAVAILABLE" | "REPO_IDENTITIES_ERROR";

const STATUS: Record<RepoIdentityServiceErrorCode, number> = {
  INVALID_REPO_KEY: 400,
  INVALID_LABEL: 400,
  INVALID_EMOJI: 400,
  INVALID_ICON: 400,
  ICON_TOO_LARGE: 413,
  ICON_NOT_FOUND: 404,
  FAVICON_BAD_DOMAIN: 400,
  FAVICON_BLOCKED: 400,
  FAVICON_UNREACHABLE: 502,
  FAVICON_NOT_FOUND: 404,
  FAVICON_BUSY: 409,
  REPO_IDENTITIES_UNAVAILABLE: 503,
  REPO_IDENTITIES_ERROR: 500
};

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class RepoIdentityError extends Error {
  readonly status: number;
  constructor(
    readonly code: RepoIdentityServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RepoIdentityError";
    this.status = STATUS[code];
  }
}

const EXTENSION: Record<RepoIconStoredType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico"
};

export interface RepoIconContent {
  bytes: Buffer;
  contentType: RepoIconStoredType;
  version: string;
}

interface RepoIdentitiesServiceOptions {
  /** `<appdir>/daemon/repo-identities.json` (`repoIdentitiesPath`). */
  file: string;
  /** `<appdir>/daemon/repo-icons` (`repoIconsDir`). */
  iconsDir: string;
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * The daemon-owned repo identities behind `/api/repo-identities` (spec 2026-10-18 §2): a label and
 * an icon per `repoKey`, shared by every client. The `SavedPromptsService` durability model:
 *
 * - an in-memory map mirrored to `repo-identities.json` with serialized atomic 0600 writes, each
 *   serializing the map when it RUNS, so overlapping mutations never land out of order;
 * - a file that does not parse is MOVED ASIDE (`.corrupt-<stamp>`) and the store starts empty; a
 *   file that cannot be read, or a corrupt one that cannot be moved, makes the store read-only
 *   for this run (every mutation a 503) — nothing is written over it;
 * - records this build cannot read and unknown top-level keys are written back verbatim.
 *
 * Image icons are files in `iconsDir` (0700) under a random name (0600), never named from the
 * repo key. A new image's file is written before its record; a replaced or cleared image's file
 * is deleted only after a write that no longer references it succeeded, so the file on disk
 * always names an icon that exists. Files no record (rejected ones included) references are swept
 * at load. A record left with neither label nor icon is removed.
 *
 * `lifecycle` emits `"changed"` ({@link RepoIdentityChangedPayload}) once per change, after the
 * write. Records are never mutated in place.
 */
export class RepoIdentitiesService {
  private readonly records = new Map<string, RepoIdentityRecord>();
  readonly lifecycle = new EventEmitter();
  /** The tail of the write chain (see `persist`). Never rejects. */
  private writes: Promise<boolean> = Promise.resolve(true);
  private blockedReason: string | null = null;
  private rejected: unknown[] = [];
  private extra: Record<string, unknown> = {};
  private readonly file: string;
  private readonly iconsDir: string;
  private readonly logger: Pick<Console, "warn" | "error">;

  constructor(options: RepoIdentitiesServiceOptions) {
    this.file = options.file;
    this.iconsDir = options.iconsDir;
    this.logger = options.logger ?? console;
  }

  async load(): Promise<void> {
    this.records.clear();
    this.rejected = [];
    this.extra = {};
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        await this.sweepOrphanIcons();
        return;
      }
      this.block(`repo-identities.json could not be read (${code ?? "unknown error"})`, error);
      return;
    }
    let parsed: RepoIdentitiesFile;
    try {
      parsed = parseRepoIdentitiesConfig(JSON.parse(text));
    } catch (error) {
      // No sweep: the icons the moved-aside file names stay, so it can still be restored.
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const record of parsed.identities) this.records.set(record.repoKey, record);
    this.rejected = parsed.rejected;
    this.extra = parsed.extra;
    if (this.rejected.length > 0) {
      this.logger.warn(
        `repo-identities.json: ${this.rejected.length} identit(ies) this build cannot read (malformed, a newer ` +
          "shape, or a repeated repo key) are not listed; they stay in the file untouched."
      );
    }
    await this.sweepOrphanIcons();
  }

  list(): RepoIdentity[] {
    return [...this.records.values()].map(toWire);
  }

  get(repoKey: string): RepoIdentity | null {
    const record = this.records.get(repoKey);
    return record ? toWire(record) : null;
  }

  /** `null` or blank clears the label. */
  async setLabel(repoKey: unknown, label: unknown): Promise<RepoIdentity | null> {
    const key = requireRepoKey(repoKey);
    if (label !== null && label !== undefined && typeof label !== "string") {
      throw new RepoIdentityError("INVALID_LABEL", "The label must be a string, or null to clear it.");
    }
    const next = normalizeRepoLabel(label);
    if (next !== null) {
      const problem = repoLabelProblem(next);
      if (problem) throw new RepoIdentityError("INVALID_LABEL", problem);
    }
    this.requireWritable();
    const current = this.records.get(key);
    if ((current?.label ?? null) === next) return current ? toWire(current) : null;
    return this.commit(key, { label: next ?? undefined });
  }

  async setEmoji(repoKey: unknown, emoji: unknown): Promise<RepoIdentity | null> {
    const key = requireRepoKey(repoKey);
    const value = typeof emoji === "string" ? emoji.trim() : "";
    if (!isSingleEmoji(value)) {
      throw new RepoIdentityError("INVALID_EMOJI", "Enter exactly one emoji.");
    }
    this.requireWritable();
    const current = this.records.get(key);
    if (current?.icon?.kind === "emoji" && current.icon.value === value) return toWire(current);
    return this.commit(key, { icon: { kind: "emoji", value } });
  }

  /**
   * Store `bytes` as the repo's image icon. They must sniff as `contentType` (one of the stored
   * types; the routes narrow uploads further) and fit {@link REPO_ICON_MAX_BYTES}.
   */
  async setImage(
    repoKey: unknown,
    bytes: Uint8Array,
    contentType: unknown,
    source?: RepoFaviconSource
  ): Promise<RepoIdentity | null> {
    const key = requireRepoKey(repoKey);
    if (!isRepoIconStoredType(contentType)) {
      throw new RepoIdentityError("INVALID_ICON", "The icon must be a PNG, JPEG, WebP or SVG image.");
    }
    if (bytes.length > REPO_ICON_MAX_BYTES) throw iconTooLarge();
    if (bytes.length === 0) throw new RepoIdentityError("INVALID_ICON", "The icon file is empty.");
    const sniffed = sniffRepoIcon(bytes);
    if (sniffed !== contentType) {
      throw new RepoIdentityError(
        "INVALID_ICON",
        sniffed === null
          ? `The file is not a valid ${describeType(contentType)} image.`
          : `The file is a ${describeType(sniffed)} image, not ${describeType(contentType)}.`
      );
    }
    this.requireWritable();
    const file = `${randomUUID()}.${EXTENSION[contentType]}`;
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    try {
      await mkdir(this.iconsDir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.iconsDir, file), bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await unlink(join(this.iconsDir, file)).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException)?.code;
      throw new RepoIdentityError("REPO_IDENTITIES_ERROR", `Cannot store the icon (${code ?? "write failed"}).`);
    }
    // `commit` reads the record after the await, so a change made meanwhile is kept.
    return this.commit(key, {
      icon: { kind: "image", file, contentType, version, ...(source ? { source: { kind: "favicon", domain: source.domain } } : {}) }
    });
  }

  /** Back to the default icon (any kind). */
  async clearIcon(repoKey: unknown): Promise<RepoIdentity | null> {
    const key = requireRepoKey(repoKey);
    this.requireWritable();
    const current = this.records.get(key);
    if (!current) return null;
    if (!current.icon) return toWire(current);
    return this.commit(key, { icon: undefined });
  }

  /** The repo's image icon, or null when it has none (or its file is gone). */
  async readIcon(repoKey: unknown): Promise<RepoIconContent | null> {
    const key = requireRepoKey(repoKey);
    const icon = this.records.get(key)?.icon;
    if (icon?.kind !== "image" || !isRepoIconFileName(icon.file)) return null;
    try {
      const bytes = await readFile(join(this.iconsDir, icon.file));
      return { bytes, contentType: icon.contentType, version: icon.version };
    } catch {
      return null;
    }
  }

  /**
   * Apply `changes` to the record (created if absent), remove it if neither label nor icon is
   * left, write, then delete a no-longer-referenced image file once the write landed, and emit.
   * Synchronous up to the write, so the record read is the one changed.
   */
  private async commit(
    repoKey: string,
    changes: { label?: string | undefined; icon?: RepoIdentityIconRecord | undefined }
  ): Promise<RepoIdentity | null> {
    const current = this.records.get(repoKey);
    const next: RepoIdentityRecord = { ...(current ?? { repoKey }), updatedAt: new Date().toISOString() } as RepoIdentityRecord;
    for (const field of ["label", "icon"] as const) {
      if (!(field in changes)) continue;
      const value = changes[field];
      if (value === undefined) delete next[field];
      else (next as Record<string, unknown>)[field] = value;
    }
    const replacedFile = current?.icon?.kind === "image" && current.icon !== next.icon ? current.icon.file : null;
    const removed = next.label === undefined && next.icon === undefined;
    if (removed) this.records.delete(repoKey);
    else this.records.set(repoKey, next);
    const written = await this.persist();
    if (written && replacedFile !== null) await this.deleteIconFile(replacedFile);
    const payload: RepoIdentityChangedPayload = removed ? { repoKey, deleted: true } : { identity: toWire(next) };
    this.lifecycle.emit("changed", payload);
    return removed ? null : toWire(next);
  }

  private requireWritable(): void {
    if (this.blockedReason !== null) {
      throw new RepoIdentityError(
        "REPO_IDENTITIES_UNAVAILABLE",
        `Repo icons and labels are read-only: ${this.blockedReason}. Nothing is saved until the file is fixed and the daemon restarts.`
      );
    }
  }

  private block(reason: string, error: unknown): void {
    this.blockedReason = reason;
    this.logger.error(`${reason}: ${String(error)}. Repo identities are read-only until it is fixed and the daemon restarts.`);
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.block(`repo-identities.json is corrupt and could not be moved aside (${code ?? "unknown error"})`, `${detail}; ${String(error)}`);
      return;
    }
    this.logger.warn(`repo-identities.json is corrupt (${detail}); moved it to ${aside} and started with no repo identities.`);
  }

  /** Best effort: delete the icon files no record, read or rejected, names. Only generated names are touched. */
  private async sweepOrphanIcons(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.iconsDir);
    } catch {
      return;
    }
    const referenced = new Set<string>();
    for (const record of this.records.values()) {
      if (record.icon?.kind === "image") referenced.add(record.icon.file);
    }
    for (const entry of this.rejected) {
      const file = repoIconFileOfEntry(entry);
      if (file !== null) referenced.add(file);
    }
    for (const name of names) {
      if (isRepoIconFileName(name) && !referenced.has(name)) await this.deleteIconFile(name);
    }
  }

  private async deleteIconFile(file: string): Promise<void> {
    if (!isRepoIconFileName(file)) return;
    await unlink(join(this.iconsDir, file)).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== "ENOENT") this.logger.warn(`Could not delete repo icon ${file}: ${String(error)}`);
    });
  }

  /**
   * Write the whole store (0600): the records, then the entries this build could not read and the
   * unknown top-level keys, verbatim. Chained; each write serializes the map when it runs. Resolves
   * whether THIS write landed; a failure is logged, not thrown — memory stays authoritative and the
   * next write catches the file up.
   */
  private persist(): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      if (this.blockedReason !== null) return false;
      const data = { version: 1 as const, identities: [...this.records.values(), ...this.rejected], ...this.extra };
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
        return true;
      } catch (error) {
        this.logger.error("Failed to persist repo identities", error);
        return false;
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}

/** Every identity change → the `/events` bus, on {@link REPO_IDENTITIES_CHANNEL}. */
export function publishRepoIdentityEvents(service: RepoIdentitiesService, broadcaster: Pick<Broadcaster, "publish">): void {
  service.lifecycle.on("changed", (payload: RepoIdentityChangedPayload) =>
    broadcaster.publish(REPO_IDENTITIES_CHANNEL, REPO_IDENTITY_CHANGED, payload)
  );
}

/** The wire shape: known fields only — never the icon's `file`, never an unknown stored field. */
export function toWire(record: RepoIdentityRecord): RepoIdentity {
  return {
    repoKey: record.repoKey,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.icon ? { icon: iconToWire(record.icon) } : {}),
    updatedAt: record.updatedAt
  };
}

function iconToWire(icon: RepoIdentityIconRecord): RepoIcon {
  if (icon.kind === "emoji") return { kind: "emoji", value: icon.value };
  return {
    kind: "image",
    contentType: icon.contentType,
    version: icon.version,
    ...(icon.source ? { source: { kind: "favicon", domain: icon.source.domain } } : {})
  };
}

function requireRepoKey(repoKey: unknown): string {
  const problem = repoKeyProblem(repoKey);
  if (problem) throw new RepoIdentityError("INVALID_REPO_KEY", problem);
  return repoKey as string;
}

export function iconTooLarge(): RepoIdentityError {
  return new RepoIdentityError("ICON_TOO_LARGE", `An icon is at most ${Math.floor(REPO_ICON_MAX_BYTES / (1024 * 1024))} MB.`);
}

function describeType(type: RepoIconStoredType): string {
  return { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/svg+xml": "SVG", "image/x-icon": "ICO" }[type];
}
