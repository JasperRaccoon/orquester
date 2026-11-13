import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  STORAGE_CHANGED_EVENT,
  STORAGE_EVENTS_CHANNEL,
  type StorageScanState,
  type StorageScanTrigger,
  type StorageStatusResponse,
  type StorageTreeResponse,
  type StorageVolume
} from "@orquester/api";
import { storageScansDir } from "@orquester/config";

import { storageErrors } from "./errors.ts";
import { parseGduExport, type ParsedScan } from "./export-parser.ts";
import { GduProbe, runGduExport, ScanCancelledError, type GduScanner } from "./gdu.ts";
import { EXPORT_SUFFIX, loadSavedScans, writeSavedScan } from "./store.ts";
import { findNode, removeFromScan, renameInScan, segmentsBelow, subtree, type SavedScan } from "./tree.ts";
import type { StorageGuardPort, StorageTreeMutations } from "./types.ts";
import { listVolumes, volumeSpace, type VolumeInfo, type VolumeSpace } from "./volumes.ts";

/** Hour (host-local) of the nightly scan of every volume. */
const NIGHTLY_HOUR = 4;
/** The nightly run skips a volume scanned more recently than this. */
const NIGHTLY_SKIP_MS = 20 * 60 * 60 * 1000;
/** Entries smaller than max(this, used / KEEP_DIVISOR) fold into their directory's `smaller`. */
const MIN_KEEP_BYTES = 1024 * 1024;
const KEEP_DIVISOR = 500_000;
/** Export bytes per entry with `--output-attrs name,asize,dsize,ino`, generously rounded up. */
const EXPORT_BYTES_PER_ENTRY = 96;
/** A scan never starts with less free space than this where the export is written. */
const MIN_FREE_FOR_EXPORT = 256 * 1024 * 1024;

export interface ScannerRun {
  scanner: GduScanner;
  volume: VolumeInfo;
  /** Absolute directories gdu must skip (other volumes below this one, the scans dir). */
  ignore: string[];
  /** Where the export goes (the scans dir). */
  workDir: string;
  minKeepBytes: number;
  signal: AbortSignal;
}

export interface StorageScanServiceOptions {
  /** The appdir. */
  baseDir: string;
  /** The daemon Broadcaster's `publish`. */
  publish?: (channel: string, type: string, payload: unknown) => void;
  logger?: Pick<Console, "warn">;
  /** Sessions' PATH for finding gdu (default: tmux.ts `sessionPath()`). */
  path?: () => string;
  // Seams for tests; the defaults are the real host.
  supported?: boolean;
  listVolumes?: () => Promise<VolumeInfo[]>;
  volumeSpace?: (path: string) => Promise<VolumeSpace>;
  locateScanner?: () => Promise<GduScanner | null>;
  runScanner?: (run: ScannerRun) => Promise<ParsedScan>;
}

interface RunningScan {
  state: Extract<StorageScanState, { state: "scanning" }>;
  controller: AbortController;
  done: Promise<void>;
  /** Deletes/renames applied while this scan ran, replayed onto its result. */
  replay: Array<(scan: SavedScan) => boolean>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** The real scanner: gdu exports to a temp file in the scans dir, which is parsed and always removed. */
export async function runGduScan(run: ScannerRun): Promise<ParsedScan> {
  const outFile = join(run.workDir, `${randomUUID()}${EXPORT_SUFFIX}`);
  try {
    await runGduExport({
      bin: run.scanner.path,
      root: run.volume.mountPoint,
      ignore: run.ignore,
      outFile,
      cwd: run.workDir,
      signal: run.signal
    });
    // Small chunks: parsing runs on the daemon's event loop, a few milliseconds per chunk.
    return await parseGduExport(createReadStream(outFile, { highWaterMark: 256 * 1024 }), {
      minKeepBytes: run.minKeepBytes,
      signal: run.signal
    });
  } catch (error) {
    if (run.signal.aborted) throw new ScanCancelledError();
    throw error;
  } finally {
    await rm(outFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Host storage scans: the volumes, one gdu scan at a time host-wide (manual or
 * nightly), the latest pruned tree per volume (in memory and on disk), the tree
 * query, and keeping saved trees in step with storage deletes/renames. Every
 * state change is published as `storage.changed` with the full status.
 */
export class StorageScanService implements StorageTreeMutations {
  private readonly dir: string;
  private readonly supported: boolean;
  private readonly probe: GduProbe;
  private scans = new Map<string, SavedScan>();
  private running: RunningScan | null = null;
  private lastError: StorageStatusResponse["lastError"] = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: number | null = null;
  private disposed = false;
  /** Serializes saved-scan writes (scan results and mutations). */
  private writes: Promise<unknown> = Promise.resolve();
  /** Keeps published events in order. */
  private publishes: Promise<unknown> = Promise.resolve();
  /**
   * Settles once {@link start} has loaded the saved scans (or failed to). The
   * transports serve before that, so every request waits on it: a scan started
   * earlier would have its export removed as stale, and a status would say
   * "never scanned".
   */
  private readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly options: StorageScanServiceOptions) {
    this.dir = storageScansDir(options.baseDir);
    this.supported = options.supported ?? process.platform === "linux";
    this.probe = new GduProbe({ baseDir: options.baseDir, path: options.path });
    this.ready = new Promise((resolve) => (this.markReady = resolve));
  }

  /**
   * Load saved scans (dropping stale exports), schedule the nightly run and
   * publish the loaded status.
   */
  async start(): Promise<void> {
    try {
      if (!this.supported || this.disposed) return;
      await mkdir(this.dir, { recursive: true });
      this.scans = await loadSavedScans(this.dir);
      this.schedule();
    } finally {
      this.markReady();
    }
    this.publish();
  }

  /** Stop the schedule and any running scan (its gdu process group is killed). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.markReady();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    const running = this.running;
    if (running) {
      running.controller.abort();
      await running.done;
    }
  }

  private locate(): Promise<GduScanner | null> {
    return this.options.locateScanner ? this.options.locateScanner() : this.probe.locate();
  }

  private volumes(): Promise<VolumeInfo[]> {
    return (this.options.listVolumes ?? listVolumes)();
  }

  private space(path: string): Promise<VolumeSpace> {
    return (this.options.volumeSpace ?? volumeSpace)(path);
  }

  async status(): Promise<StorageStatusResponse> {
    if (!this.supported) {
      return {
        supported: false,
        scanner: { installed: false, version: null, path: null },
        volumes: [],
        scan: { state: "idle" },
        lastError: null,
        nextScheduledAt: null
      };
    }
    await this.ready;
    const [scanner, volumes] = await Promise.all([this.locate(), this.volumes()]);
    return {
      supported: true,
      scanner: {
        installed: scanner !== null && scanner.version !== null,
        version: scanner?.version ?? null,
        path: scanner?.path ?? null
      },
      volumes: volumes.map((volume): StorageVolume => ({ ...volume, lastScan: this.scans.get(volume.id)?.summary ?? null })),
      scan: this.running ? { ...this.running.state, queued: [...this.running.state.queued] } : { state: "idle" },
      lastError: this.lastError,
      nextScheduledAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString()
    };
  }

  private publish(): void {
    const publish = this.options.publish;
    if (!publish) return;
    this.publishes = this.publishes
      .then(async () => publish(STORAGE_EVENTS_CHANNEL, STORAGE_CHANGED_EVENT, await this.status()))
      .catch((error: unknown) => this.options.logger?.warn(`[storage] status publish failed: ${message(error)}`));
  }

  /** Start a manual scan of `volume`; resolves once it is running, with the status. */
  async startScan(volume: string, trigger: StorageScanTrigger = "manual"): Promise<StorageStatusResponse> {
    if (!this.supported) throw storageErrors.unsupported();
    await this.ready;
    if (this.running) throw storageErrors.running(this.running.state.volume);
    const scanner = await this.locate();
    if (!scanner || scanner.version === null) throw storageErrors.scannerMissing();
    const target = (await this.volumes()).find((candidate) => candidate.id === volume);
    if (!target) throw storageErrors.unknownVolume(volume);
    await this.checkFreeSpace(target);
    if (this.running) throw storageErrors.running((this.running as RunningScan).state.volume);
    if (this.disposed) throw storageErrors.os("The daemon is shutting down.");
    this.begin([target], trigger, scanner);
    return this.status();
  }

  /** Cancel the running scan (and the rest of a nightly run); resolves once it stopped. */
  async cancelScan(): Promise<StorageStatusResponse> {
    if (!this.supported) throw storageErrors.unsupported();
    await this.ready;
    const running = this.running;
    if (running) {
      running.state.queued = [];
      running.controller.abort();
      await running.done;
    }
    return this.status();
  }

  async tree(volume: string, query: { path?: string; depth?: number; guard: StorageGuardPort }): Promise<StorageTreeResponse> {
    if (!this.supported) throw storageErrors.unsupported();
    await this.ready;
    if (!(await this.volumes()).some((candidate) => candidate.id === volume)) throw storageErrors.unknownVolume(volume);
    const scan = this.scans.get(volume);
    if (!scan) throw storageErrors.noScan(volume);
    return subtree(scan, query);
  }

  // -------------------------------------------------------------------------
  // Running scans
  // -------------------------------------------------------------------------

  private async checkFreeSpace(volume: VolumeInfo): Promise<void> {
    const [workDir, target] = await Promise.all([this.space(this.dir), this.space(volume.mountPoint)]);
    if (workDir.freeBytes === null) return;
    const entries = this.scans.get(volume.id)?.summary.items ?? target.inodesUsed ?? 0;
    const needed = Math.max(MIN_FREE_FOR_EXPORT, Math.ceil(entries * EXPORT_BYTES_PER_ENTRY * 1.25));
    if (workDir.freeBytes < needed) {
      throw storageErrors.os(
        `Not enough free disk space to scan ${volume.id}: the scanner's export needs about ${formatBytes(needed)} in ${this.dir}, and only ${formatBytes(workDir.freeBytes)} is free.`
      );
    }
  }

  private begin(queue: VolumeInfo[], trigger: StorageScanTrigger, scanner: GduScanner): void {
    const controller = new AbortController();
    const running: RunningScan = {
      state: {
        state: "scanning",
        volume: queue[0]!.id,
        trigger,
        startedAt: new Date().toISOString(),
        expectedDurationMs: null,
        queued: queue.slice(1).map((volume) => volume.id)
      },
      controller,
      done: Promise.resolve(),
      replay: []
    };
    this.running = running;
    running.done = this.runQueue(running, queue, scanner)
      .catch((error: unknown) => this.options.logger?.warn(`[storage] scan run failed: ${message(error)}`))
      .finally(() => {
        if (this.running === running) this.running = null;
        this.publish();
      });
  }

  private async runQueue(running: RunningScan, queue: VolumeInfo[], scanner: GduScanner): Promise<void> {
    for (let index = 0; index < queue.length; index++) {
      if (running.controller.signal.aborted) return;
      const volume = queue[index]!;
      running.state = {
        ...running.state,
        volume: volume.id,
        startedAt: new Date().toISOString(),
        expectedDurationMs: this.scans.get(volume.id)?.summary.durationMs ?? null,
        queued: queue.slice(index + 1).map((next) => next.id)
      };
      running.replay = [];
      this.publish();
      try {
        await this.scanOne(running, volume, scanner);
        if (this.lastError?.volume === volume.id) this.lastError = null;
      } catch (error) {
        if (error instanceof ScanCancelledError || running.controller.signal.aborted) return;
        this.lastError = { volume: volume.id, message: message(error), at: new Date().toISOString() };
        this.options.logger?.warn(`[storage] scan of ${volume.id} failed: ${message(error)}`);
      }
    }
  }

  private async scanOne(running: RunningScan, volume: VolumeInfo, scanner: GduScanner): Promise<void> {
    if (running.state.trigger === "schedule") await this.checkFreeSpace(volume);
    const startedAt = Date.now();
    const others = (await this.volumes()).map((other) => other.mountPoint).filter((mount) => mount !== volume.mountPoint);
    const ignore = [...others.filter((mount) => segmentsBelow(volume.mountPoint, mount) !== null), this.dir];
    const parsed = await (this.options.runScanner ?? runGduScan)({
      scanner,
      volume,
      ignore,
      workDir: this.dir,
      minKeepBytes: Math.max(MIN_KEEP_BYTES, Math.floor((volume.usedBytes ?? 0) / KEEP_DIVISOR)),
      signal: running.controller.signal
    });
    running.controller.signal.throwIfAborted();
    const finishedAt = Date.now();
    // Deletes/renames applied by now are already reflected in the used space read next.
    const reflected = running.replay.length;
    const usedBytesAtScan = (await this.space(volume.mountPoint)).usedBytes;
    const root = parsed.root;
    const scan: SavedScan = {
      volume: volume.id,
      root,
      summary: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        trigger: running.state.trigger,
        scannerVersion: parsed.scannerVersion ?? scanner.version ?? "unknown",
        scannedBytes: root.size,
        apparentBytes: root.apparent,
        items: root.items,
        unreadableDirs: parsed.unreadableDirs,
        // Null through the first replay below (a replayed delete would lower it), then set.
        usedBytesAtScan: null,
        unaccountedBytes: 0
      }
    };
    await this.write(async () => {
      // gdu may have walked a path deleted or renamed while it ran: correct the tree. The used
      // space read above already left out what was deleted before it, so only later ones lower it.
      for (const apply of running.replay.slice(0, reflected)) apply(scan);
      scan.summary.usedBytesAtScan = usedBytesAtScan;
      for (const apply of running.replay.slice(reflected)) apply(scan);
      const used = scan.summary.usedBytesAtScan;
      scan.summary.unaccountedBytes = used === null ? 0 : Math.max(0, used - scan.root.size);
      await writeSavedScan(this.dir, scan);
      this.scans.set(volume.id, scan);
    });
  }

  private write<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task);
    this.writes = result.catch(() => undefined);
    return result;
  }

  // -------------------------------------------------------------------------
  // Nightly schedule
  // -------------------------------------------------------------------------

  private schedule(): void {
    if (this.disposed || !this.supported) return;
    const now = Date.now();
    const next = new Date(now);
    next.setHours(NIGHTLY_HOUR, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    this.nextAt = next.getTime();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
      void this.runNightly().catch((error: unknown) =>
        this.options.logger?.warn(`[storage] nightly scan could not start: ${message(error)}`)
      );
    }, this.nextAt - now);
    this.timer.unref?.();
  }

  private async runNightly(): Promise<void> {
    if (this.running || this.disposed) return;
    const scanner = await this.locate();
    if (!scanner || scanner.version === null) return;
    const now = Date.now();
    const due = (await this.volumes()).filter((volume) => {
      const last = this.scans.get(volume.id)?.summary.finishedAt;
      return !last || now - Date.parse(last) >= NIGHTLY_SKIP_MS;
    });
    if (due.length === 0 || this.running || this.disposed) return;
    this.begin(due, "schedule", scanner);
  }

  // -------------------------------------------------------------------------
  // StorageTreeMutations
  // -------------------------------------------------------------------------

  sizeOf(path: string): number {
    for (const scan of this.scans.values()) {
      const found = findNode(scan, path);
      if (found) return found.node.size;
    }
    return 0;
  }

  applyDelete(path: string): Promise<void> {
    return this.mutate((scan) => removeFromScan(scan, path));
  }

  applyRename(from: string, to: string): Promise<void> {
    return this.mutate((scan) => renameInScan(scan, from, to));
  }

  /**
   * Never rejects: the action already happened on disk, so a saved scan that
   * cannot be rewritten (a full disk) is logged, and the in-memory tree, which
   * every response is answered from, is still correct.
   */
  private async mutate(apply: (scan: SavedScan) => boolean): Promise<void> {
    // Applied before the load would be overwritten by it.
    await this.ready;
    this.running?.replay.push(apply);
    const changed = await this.write(async () => {
      const touched = [...this.scans.values()].filter((scan) => apply(scan));
      for (const scan of touched) {
        await writeSavedScan(this.dir, scan).catch((error: unknown) =>
          this.options.logger?.warn(`[storage] could not save the edited scan of ${scan.volume}: ${message(error)}`)
        );
      }
      return touched.length > 0;
    });
    if (changed) this.publish();
  }
}
