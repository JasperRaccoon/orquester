/**
 * Agent profile — the stash (spec §4.4): where an item goes when it is turned
 * off on an agent that has no native "off" for its kind (Claude hooks and
 * commands, Grok hooks, OpenCode commands and plugin files). Off moves the
 * item here exactly as it was; on moves it back, byte for byte.
 *
 * Layout: `<dir>/<agent>/<kind>/<encoded id>/`
 *   - `manifest.json` — {@link StashManifest} (0600);
 *   - `payload` — the moved file or directory itself (its own modes kept),
 *     present only for a `path` entry. A `fragment` entry (a hook's JSON
 *     object, removed from its settings group) carries its data in the
 *     manifest and has no payload.
 *
 * The encoded id is the id in base64url (`~<sha256>` when that would be too
 * long for a directory name); the manifest holds the real id. Directories are
 * 0700. One entry per id: stashing an id that is already stashed is refused.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ProfileItemKind, isProfileItemKind } from "@orquester/api";
import { profileErrors } from "../errors.ts";
import { assertSafeSegment } from "./names.ts";
import { moveEntry, pathKind } from "./tree.ts";

/** Where the item goes back to on "on". */
type StashOriginal =
  | { type: "path"; path: string }
  /** A hook entry: the adapter's own JSON (the handler plus where it came from — event, matcher). */
  | { type: "fragment"; data: unknown };

/** `manifest.json`, as written. */
interface StashManifest {
  version: 1;
  agent: string;
  kind: ProfileItemKind;
  id: string;
  name: string;
  /** ISO time. */
  stashedAt: string;
  original: StashOriginal;
  /** Anything else the adapter wants back on restore (a description for the snapshot, …). */
  meta?: Record<string, unknown>;
}

/** A manifest plus where it lives on disk. */
export interface StashEntry extends StashManifest {
  /** The entry's directory. */
  dir: string;
  /** `<dir>/payload` for a `path` entry (read it for the snapshot's name/description); `null` for a fragment. */
  payloadPath: string | null;
}

interface ProfileStashOptions {
  /** `agentProfileStashDir(appdir)`. */
  dir: string;
  now?: () => Date;
  /** Told about entries `list()` skipped. */
  logger?: { warn(message: string): void };
}

const MANIFEST = "manifest.json";
const PAYLOAD = "payload";
/** Longest encoded id used as it is; longer ones are hashed. */
const MAX_ENCODED_ID = 200;

/** The directory name an id is stored under. */
function encodeStashId(id: string): string {
  const encoded = Buffer.from(id, "utf8").toString("base64url");
  // `~` is outside base64url's alphabet, so a hashed name never collides with an encoded one.
  return encoded.length <= MAX_ENCODED_ID ? encoded : `~${createHash("sha256").update(id).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The manifest if `value` is a well-formed one; unknown extra fields are dropped. */
function parseManifest(value: unknown): StashManifest | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const { agent, kind, id, name, stashedAt, original, meta } = value;
  if (typeof agent !== "string" || !isProfileItemKind(kind) || typeof id !== "string" || typeof name !== "string") {
    return null;
  }
  if (typeof stashedAt !== "string" || !isRecord(original)) return null;
  let parsedOriginal: StashOriginal;
  if (original.type === "path" && typeof original.path === "string") {
    parsedOriginal = { type: "path", path: original.path };
  } else if (original.type === "fragment" && "data" in original) {
    parsedOriginal = { type: "fragment", data: original.data };
  } else {
    return null;
  }
  const manifest: StashManifest = { version: 1, agent, kind, id, name, stashedAt, original: parsedOriginal };
  if (isRecord(meta)) {
    manifest.meta = meta;
  }
  return manifest;
}

export class ProfileStash {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly logger: { warn(message: string): void };

  constructor(options: ProfileStashOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? { warn: () => undefined };
  }

  /** The directory an entry lives in (whether or not it exists). */
  private entryDir(agent: string, kind: ProfileItemKind, id: string): string {
    assertSafeSegment(agent);
    if (!isProfileItemKind(kind)) {
      throw profileErrors.invalid(`Unknown item kind "${String(kind)}".`);
    }
    return join(this.dir, agent, kind, encodeStashId(id));
  }

  /**
   * Turns an item off by moving the file or directory at `originalPath` (a
   * symlink moves as the link) into a new entry; restore puts it back there.
   * Refuses with 409 `PROFILE_CONFLICT` when `id` is already stashed — to
   * replace it, {@link remove} the old entry first. Throws `ITEM_NOT_FOUND`
   * when nothing is at `originalPath`.
   */
  async stashPath(
    agent: string,
    kind: ProfileItemKind,
    id: string,
    name: string,
    originalPath: string,
    meta?: Record<string, unknown>
  ): Promise<StashEntry> {
    const dir = this.entryDir(agent, kind, id);
    if ((await pathKind(originalPath)) === null) {
      throw profileErrors.notFound(id);
    }
    const manifest = this.manifest(agent, kind, id, name, { type: "path", path: originalPath }, meta);
    await this.create(dir, manifest);
    try {
      await moveEntry(originalPath, join(dir, PAYLOAD));
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { ...manifest, dir, payloadPath: join(dir, PAYLOAD) };
  }

  /**
   * Turns off an item that is a piece of a shared file (a hook entry): keeps
   * `data` — JSON-serializable — in a new entry. The caller removes the piece
   * from its file afterwards. Refuses like {@link stashPath}.
   */
  async stashFragment(
    agent: string,
    kind: ProfileItemKind,
    id: string,
    name: string,
    data: unknown,
    meta?: Record<string, unknown>
  ): Promise<StashEntry> {
    const dir = this.entryDir(agent, kind, id);
    const manifest = this.manifest(agent, kind, id, name, { type: "fragment", data }, meta);
    await this.create(dir, manifest);
    return { ...manifest, dir, payloadPath: null };
  }

  /**
   * Every readable entry of `agent`, sorted by kind then name. Tolerant: an
   * entry without a readable manifest, or a `path` entry whose payload is
   * gone, is skipped with a warning — the snapshot never fails over the stash.
   */
  async list(agent: string): Promise<StashEntry[]> {
    assertSafeSegment(agent);
    const entries: StashEntry[] = [];
    for (const kind of await listDirs(join(this.dir, agent))) {
      if (!isProfileItemKind(kind)) {
        this.logger.warn(`agent-profile stash: skipping unknown kind directory ${join(this.dir, agent, kind)}`);
        continue;
      }
      for (const encoded of await listDirs(join(this.dir, agent, kind))) {
        const entry = await this.read(join(this.dir, agent, kind, encoded), agent, kind);
        if (entry !== null) {
          entries.push(entry);
        }
      }
    }
    return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** One entry, or `null` when it is absent or unreadable. */
  async get(agent: string, kind: ProfileItemKind, id: string): Promise<StashEntry | null> {
    const dir = this.entryDir(agent, kind, id);
    if ((await pathKind(dir)) === null) {
      return null;
    }
    return this.read(dir, agent, kind);
  }

  /**
   * Turns a `path` entry back on: moves its payload back to the original path
   * and deletes the entry. Throws `ITEM_NOT_FOUND` for no such entry (or a
   * fragment entry), and 409 `STASH_CONFLICT` when something now occupies the
   * original path — the entry is then left as it was. Answers the path restored.
   */
  async restorePath(agent: string, kind: ProfileItemKind, id: string): Promise<string> {
    const entry = await this.get(agent, kind, id);
    if (entry === null || entry.original.type !== "path" || entry.payloadPath === null) {
      throw profileErrors.notFound(id);
    }
    const target = entry.original.path;
    if ((await pathKind(target)) !== null) {
      throw profileErrors.stashConflict(target);
    }
    await mkdir(dirname(target), { recursive: true });
    await moveEntry(entry.payloadPath, target);
    await rm(entry.dir, { recursive: true, force: true });
    return target;
  }

  /** Deletes an entry for good (delete of an item that is off). Answers whether one was there. */
  async remove(agent: string, kind: ProfileItemKind, id: string): Promise<boolean> {
    const dir = this.entryDir(agent, kind, id);
    if ((await pathKind(dir)) === null) {
      return false;
    }
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  private manifest(
    agent: string,
    kind: ProfileItemKind,
    id: string,
    name: string,
    original: StashOriginal,
    meta: Record<string, unknown> | undefined
  ): StashManifest {
    const manifest: StashManifest = { version: 1, agent, kind, id, name, stashedAt: this.now().toISOString(), original };
    if (meta !== undefined) {
      manifest.meta = meta;
    }
    return manifest;
  }

  /**
   * Makes the entry directory — its non-recursive `mkdir` is the "already
   * stashed" check — and writes the manifest. A leftover that is not a usable
   * entry (a crash between the two, or before the payload moved) is cleared
   * and replaced rather than blocking the id forever.
   */
  private async create(dir: string, manifest: StashManifest): Promise<void> {
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if ((await this.read(dir, manifest.agent, manifest.kind, true)) !== null) {
        throw profileErrors.conflict(
          `"${manifest.name}" already has a turned-off copy. Delete that copy before turning this one off.`
        );
      }
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { mode: 0o700 });
    }
    try {
      await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async read(dir: string, agent: string, kind: string, quiet = false): Promise<StashEntry | null> {
    const warn = (why: string): null => {
      if (!quiet) {
        this.logger.warn(`agent-profile stash: skipping ${dir}: ${why}`);
      }
      return null;
    };
    let manifest: StashManifest | null;
    try {
      manifest = parseManifest(JSON.parse(await readFile(join(dir, MANIFEST), "utf8")));
    } catch (error) {
      return warn(error instanceof Error ? error.message : String(error));
    }
    if (manifest === null) {
      return warn("the manifest is not a stash manifest");
    }
    if (manifest.agent !== agent || manifest.kind !== kind) {
      return warn(`the manifest names ${manifest.agent}/${manifest.kind}`);
    }
    if (manifest.original.type === "fragment") {
      return { ...manifest, dir, payloadPath: null };
    }
    const payloadPath = join(dir, PAYLOAD);
    if ((await pathKind(payloadPath)) === null) {
      return warn("its payload is missing");
    }
    return { ...manifest, dir, payloadPath };
  }
}

/** Visible subdirectory names of `dir`; `[]` when it does not exist. */
async function listDirs(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return [];
  }
}
