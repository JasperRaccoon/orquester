/**
 * The device service's two tolerant stores (devices spec §11), on the `desktops/store.ts` model:
 *
 * - a missing file is an empty store that loaded cleanly;
 * - a file whose OUTER shape does not parse is moved aside to `<file>.corrupt-<stamp>` and the
 *   store is read-only until the next start, so nothing is ever written where the owner's data
 *   may have been; a file that cannot be read at all (permissions, I/O) is read-only too;
 * - records, fields and top-level keys this build cannot use are kept verbatim and written back;
 * - writes are chained and atomic (temp file + rename, 0600), and each serializes the state when
 *   it RUNS, so the last write always carries the latest state.
 *
 * {@link DeviceSettingsStore}: `devices.json`. {@link DeviceLeaseStore}: `device-leases.json`, the
 * durable record of every live lease (the service rebuilds its view from it after a restart).
 * {@link DevicePoolStore}: `device-pool.json`, the pool's spend, rentals, learned capacity, drains
 * and cache warms.
 */

import { readFile, rename } from "node:fs/promises";

import {
  createDefaultDeviceLeasesFile,
  createDefaultDevicePoolStateFile,
  createDefaultDevicesSettingsFile,
  mergeDevicesSettings,
  parseDeviceLeasesFile,
  parseDevicePoolStateFile,
  parseDevicesSettingsFile,
  serializeDeviceLeasesFile,
  serializeDevicePoolStateFile,
  serializeDevicesSettingsFile,
  type DevicePoolState,
  type DevicesSettings,
  type DevicesSettingsPatch,
  type StoredDeviceLease
} from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";

type Logger = Pick<Console, "warn" | "error">;

type JsonRead = { kind: "value"; value: unknown } | { kind: "missing" } | { kind: "unreadable"; code: string } | { kind: "corrupt"; detail: string };

/** Read a JSON file: its value, `missing`, `unreadable` (with the errno) or `corrupt` (not JSON). */
async function readJson(file: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unreadable", code: code ?? "unknown error" };
  }
  try {
    return { kind: "value", value: JSON.parse(text) };
  } catch (error) {
    return { kind: "corrupt", detail: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Shared read-only / quarantine / write-chain behaviour. */
abstract class TolerantJsonStore {
  /** Why writes are refused this run, or null. */
  readOnlyReason: string | null = null;
  /** The file was read cleanly (or did not exist). */
  loaded = false;
  private writes: Promise<void> = Promise.resolve();

  protected constructor(
    protected readonly file: string,
    protected readonly logger: Logger,
    private readonly what: string
  ) {}

  /** Read the file and hand its value to `accept` (which may throw: the file is then quarantined). Never throws. */
  protected async read(accept: (value: unknown) => void, reset: () => void): Promise<void> {
    this.readOnlyReason = null;
    this.loaded = false;
    reset();
    const read = await readJson(this.file);
    if (read.kind === "missing") {
      this.loaded = true;
      return;
    }
    if (read.kind === "unreadable") {
      this.readOnlyReason = `${this.name()} could not be read (${read.code})`;
      this.logger.error(`${this.readOnlyReason}; ${this.what} are read-only until the next start.`);
      return;
    }
    if (read.kind === "corrupt") {
      await this.quarantine(read.detail);
      return;
    }
    try {
      accept(read.value);
      this.loaded = true;
    } catch (error) {
      reset();
      await this.quarantine(error instanceof Error ? error.message : String(error));
    }
  }

  /** Queue an atomic write of `serialize()` (called when the write runs). Never rejects. */
  protected queueWrite(serialize: () => unknown): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.readOnlyReason !== null) return;
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(serialize(), null, 2)}\n`, 0o600, false);
      } catch (error) {
        this.logger.error(`Failed to write ${this.name()}`, error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Resolves once every queued write has run. */
  flush(): Promise<void> {
    return this.writes;
  }

  private name(): string {
    return this.file.split("/").pop() ?? this.file;
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
      this.readOnlyReason = `${this.name()} was corrupt (${detail}) and was moved to ${aside}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.readOnlyReason = `${this.name()} is corrupt (${detail}) and could not be moved aside (${code ?? "unknown error"})`;
    }
    this.logger.error(`${this.readOnlyReason}; ${this.what} are read-only until the next start.`);
  }
}

/** `devices.json`: Settings → Devices. */
export class DeviceSettingsStore extends TolerantJsonStore {
  private file_ = createDefaultDevicesSettingsFile();

  constructor(options: { file: string; logger?: Logger }) {
    super(options.file, options.logger ?? console, "device settings");
  }

  /** Read the file; never throws. The settings are the defaults when it is missing or unusable. */
  async load(): Promise<DevicesSettings> {
    await this.read(
      (value) => {
        this.file_ = parseDevicesSettingsFile(value);
      },
      () => {
        this.file_ = createDefaultDevicesSettingsFile();
      }
    );
    return this.settings();
  }

  settings(): DevicesSettings {
    return this.file_.settings;
  }

  /**
   * Apply a validated patch and persist it. Throws when the store is read-only (the owner's file was
   * unreadable): a change that cannot be saved is refused rather than lost at the next restart.
   */
  async update(patch: DevicesSettingsPatch): Promise<DevicesSettings> {
    if (this.readOnlyReason !== null) throw new Error(`Device settings cannot be saved: ${this.readOnlyReason}.`);
    // A machine the patch names (set or forgotten) is no longer one of the entries kept verbatim.
    const dropped = this.file_.droppedVphoneHosts;
    const named = patch.research?.vphoneHosts;
    const keep = dropped && named ? Object.fromEntries(Object.entries(dropped).filter(([key]) => !Object.hasOwn(named, key))) : dropped;
    const { droppedVphoneHosts: _previous, ...file } = this.file_;
    this.file_ = { ...file, settings: mergeDevicesSettings(this.file_.settings, patch), ...(keep && Object.keys(keep).length > 0 ? { droppedVphoneHosts: keep } : {}) };
    await this.queueWrite(() => serializeDevicesSettingsFile(this.file_));
    return this.settings();
  }
}

/** `device-leases.json`: the live leases. */
export class DeviceLeaseStore extends TolerantJsonStore {
  private rejected: unknown[] = [];
  private extra: Record<string, unknown> = {};
  private snapshot: (() => readonly StoredDeviceLease[]) | null = null;

  constructor(options: { file: string; logger?: Logger }) {
    super(options.file, options.logger ?? console, "device leases");
  }

  /** Read the file; never throws. The leases returned are the usable ones. */
  async load(): Promise<StoredDeviceLease[]> {
    let leases: StoredDeviceLease[] = [];
    await this.read(
      (value) => {
        const file = parseDeviceLeasesFile(value);
        leases = file.leases;
        this.rejected = file.rejected;
        this.extra = file.extra;
        if (file.rejected.length > 0) {
          this.logger.warn(`device-leases.json: ${file.rejected.length} lease record(s) this build cannot read are kept in the file untouched.`);
        }
      },
      () => {
        leases = [];
        const empty = createDefaultDeviceLeasesFile();
        this.rejected = empty.rejected;
        this.extra = empty.extra;
      }
    );
    return leases;
  }

  /** The leases every write serializes (set once by the service). */
  setSnapshot(snapshot: () => readonly StoredDeviceLease[]): void {
    this.snapshot = snapshot;
  }

  /** Queue a write of the current snapshot (none before `setSnapshot`). Never rejects; a failure is logged. */
  persist(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return this.flush();
    return this.queueWrite(() => serializeDeviceLeasesFile({ version: 1, leases: [...snapshot()], rejected: this.rejected, extra: this.extra }));
  }
}

/**
 * `device-pool.json`: the pool's own record (spend, rentals, learned capacity, drains, cache warms).
 * `file: null` keeps it in memory only (a service built without one).
 */
export class DevicePoolStore extends TolerantJsonStore {
  private file_ = createDefaultDevicePoolStateFile();
  private readonly memoryOnly: boolean;

  constructor(options: { file: string | null; logger?: Logger }) {
    super(options.file ?? "device-pool.json", options.logger ?? console, "device pool records");
    this.memoryOnly = options.file === null;
  }

  /** Read the file; never throws. The state is empty when it is missing or unusable. */
  async load(): Promise<DevicePoolState> {
    if (this.memoryOnly) {
      this.loaded = true;
      return this.state();
    }
    await this.read(
      (value) => {
        this.file_ = parseDevicePoolStateFile(value);
      },
      () => {
        this.file_ = createDefaultDevicePoolStateFile();
      }
    );
    return this.state();
  }

  /** The live state: change it in place, then {@link persist}. */
  state(): DevicePoolState {
    return this.file_.state;
  }

  /** Queue a write of the current state. Never rejects. */
  persist(): Promise<void> {
    if (this.memoryOnly) return this.flush();
    return this.queueWrite(() => serializeDevicePoolStateFile(this.file_));
  }
}
