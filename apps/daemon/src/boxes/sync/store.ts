/**
 * Config sync — persistence:
 *
 * - {@link BoxConfigChangeStore}: `config-changes.json` (`boxConfigChangesPath`), the box → host
 *   change sets. Tolerant (`parseBoxConfigChangesStore`): unknown fields, states and unreadable
 *   entries survive every rewrite. Written atomically, mode 0600; decided sets are kept for
 *   {@link DECIDED_RETENTION_MS} (at most {@link MAX_DECIDED_SETS}).
 * - {@link BoxSyncBaselines}: `boxes/sync/<boxId>.json` (`boxSyncBaselinePath`), what sync last
 *   agreed with each box per host path. A disposable cache: a lost or unreadable one only means
 *   the host wins where the two sides differ, and that box-only files become pending.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BOX_CONFIG_CHANGES_VERSION,
  BOX_SYNC_BASELINE_VERSION,
  boxConfigChangesPath,
  boxSyncBaselineEntrySchema,
  boxSyncBaselinePath,
  boxSyncBaselineSchema,
  parseBoxConfigChangesStore,
  type BoxSyncBaselineEntry,
  type StoredBoxConfigChangeSet
} from "@orquester/config";

export const DECIDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DECIDED_SETS = 500;

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The parsed file; undefined when it is missing or not JSON (an empty store; the next write replaces it). */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export class BoxConfigChangeStore {
  private readonly path: string;
  private envelope: Record<string, unknown> = { version: BOX_CONFIG_CHANGES_VERSION };
  private sets: StoredBoxConfigChangeSet[] = [];
  private unreadable: unknown[] = [];
  private writes: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;

  constructor(appdir: string, private readonly now: () => Date = () => new Date()) {
    this.path = boxConfigChangesPath(appdir);
  }

  /** Read the file once (concurrent callers share the read). */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let value: unknown = {};
    if (text !== null) {
      try {
        value = JSON.parse(text);
      } catch {
        // Not JSON: keep it aside for the owner instead of overwriting it with the next write.
        await rename(this.path, `${this.path}.unreadable-${this.now().getTime()}`).catch(() => undefined);
      }
    }
    const parsed = parseBoxConfigChangesStore(value);
    this.envelope = parsed.envelope;
    this.sets = parsed.sets;
    this.unreadable = parsed.unreadable;
  }

  list(): StoredBoxConfigChangeSet[] {
    return [...this.sets];
  }

  get(id: string): StoredBoxConfigChangeSet | undefined {
    return this.sets.find((set) => set.id === id);
  }

  /** Pending sets of a box. */
  pending(boxId: string): StoredBoxConfigChangeSet[] {
    return this.sets.filter((set) => set.boxId === boxId && set.state === "pending");
  }

  async add(set: StoredBoxConfigChangeSet): Promise<void> {
    await this.load();
    this.sets.push(set);
    await this.save();
  }

  /** Replace a set (same id) and persist. */
  async update(set: StoredBoxConfigChangeSet): Promise<void> {
    await this.load();
    const index = this.sets.findIndex((entry) => entry.id === set.id);
    if (index < 0) this.sets.push(set);
    else this.sets[index] = set;
    await this.save();
  }

  /** Persist (serialized; decided sets past retention are dropped first). */
  save(): Promise<void> {
    const cutoff = this.now().getTime() - DECIDED_RETENTION_MS;
    const decided = this.sets.filter((set) => set.state !== "pending");
    const keepDecided = new Set(
      decided
        .filter((set) => Date.parse(set.decidedAt ?? set.createdAt) >= cutoff)
        .sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt))
        .slice(0, MAX_DECIDED_SETS)
    );
    this.sets = this.sets.filter((set) => set.state === "pending" || keepDecided.has(set));
    const value = { ...this.envelope, version: BOX_CONFIG_CHANGES_VERSION, changes: [...this.sets, ...this.unreadable] };
    const write = this.writes.then(() => writeJsonAtomic(this.path, value));
    this.writes = write.catch(() => undefined);
    return write;
  }
}

/** Per-box baselines, loaded lazily and written after a short delay (and on {@link flush}). */
export class BoxSyncBaselines {
  private readonly maps = new Map<string, Map<string, BoxSyncBaselineEntry>>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly appdir: string,
    private readonly delayMs = 1000
  ) {}

  async get(boxId: string): Promise<Map<string, BoxSyncBaselineEntry>> {
    const known = this.maps.get(boxId);
    if (known) return known;
    const map = new Map<string, BoxSyncBaselineEntry>();
    const parsed = boxSyncBaselineSchema.safeParse((await readJson(boxSyncBaselinePath(this.appdir, boxId))) ?? {});
    if (parsed.success) {
      for (const [path, entry] of Object.entries(parsed.data.entries)) {
        const value = boxSyncBaselineEntrySchema.safeParse(entry);
        if (value.success) map.set(path, value.data);
      }
    }
    // A concurrent get() may have filled it meanwhile; keep the first.
    const raced = this.maps.get(boxId);
    if (raced) return raced;
    this.maps.set(boxId, map);
    return map;
  }

  markDirty(boxId: string): void {
    this.dirty.add(boxId);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Write every dirty baseline now. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const boxIds = [...this.dirty];
    this.dirty.clear();
    const write = this.writes.then(async () => {
      for (const boxId of boxIds) {
        const map = this.maps.get(boxId);
        if (!map) continue;
        await writeJsonAtomic(boxSyncBaselinePath(this.appdir, boxId), {
          version: BOX_SYNC_BASELINE_VERSION,
          entries: Object.fromEntries(map)
        });
      }
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /** Drop a box's baseline (its box is gone). */
  async forget(boxId: string): Promise<void> {
    this.maps.delete(boxId);
    this.dirty.delete(boxId);
    await this.writes;
    await rm(boxSyncBaselinePath(this.appdir, boxId), { force: true });
  }
}
