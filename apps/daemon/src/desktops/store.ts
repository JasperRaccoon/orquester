import { readFile, rename } from "node:fs/promises";
import {
  type DesktopRecord,
  type DesktopsFile,
  type RecentLaunchRecord,
  createDefaultDesktopsFile,
  parseDesktopsFile,
  serializeDesktopsFile
} from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";

/** What the store writes: the live records and the recent launches, read when the write RUNS. */
export interface DesktopsSnapshot {
  desktops: DesktopRecord[];
  recent: Record<string, RecentLaunchRecord[]>;
}

export interface DesktopStoreOptions {
  /** `<appdir>/daemon/desktops.json`. */
  file: string;
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * The tolerant `desktops.json` (desktop spec §9), on the saved-prompts model:
 *
 * - a missing file is an empty index that loaded cleanly;
 * - a file whose OUTER shape does not parse is moved aside to
 *   `desktops.json.corrupt-<stamp>` and the store is read-only until the next
 *   boot, so nothing is ever written where the user's records may have been;
 * - a file that cannot be read at all (permissions, I/O) is neither moved nor
 *   written over: read-only too;
 * - records and top-level keys this build cannot use are kept verbatim and
 *   written back by every write;
 * - writes are chained and atomic (temp file + rename, 0600), and each one
 *   serializes the snapshot when it runs, so the last write always carries the
 *   latest state.
 *
 * `loaded` is false after any read failure: the manager then never reaps a
 * live desktop session it cannot find a record for (the `sessions.ts` rule).
 */
export class DesktopStore {
  private readonly file: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private writes: Promise<void> = Promise.resolve();
  private rejected: unknown[] = [];
  private extra: Record<string, unknown> = {};
  private recentRejected: Record<string, unknown[]> = {};
  private snapshot: (() => DesktopsSnapshot) | null = null;
  /** Why writes are refused this run, or null. */
  readOnlyReason: string | null = null;
  /** The index was read cleanly (or did not exist). */
  loaded = false;

  constructor(options: DesktopStoreOptions) {
    this.file = options.file;
    this.logger = options.logger ?? console;
  }

  /** Read the index; never throws. The records returned are the usable ones. */
  async load(): Promise<DesktopsFile> {
    this.rejected = [];
    this.extra = {};
    this.recentRejected = {};
    this.readOnlyReason = null;
    this.loaded = false;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.loaded = true;
        return createDefaultDesktopsFile();
      }
      this.readOnlyReason = `desktops.json could not be read (${code ?? "unknown error"})`;
      this.logger.error(`${this.readOnlyReason}; desktops are read-only until the next start.`, error);
      return createDefaultDesktopsFile();
    }
    let parsed: DesktopsFile;
    try {
      parsed = parseDesktopsFile(JSON.parse(text));
    } catch (error) {
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return createDefaultDesktopsFile();
    }
    this.rejected = parsed.rejected;
    this.extra = parsed.extra;
    this.recentRejected = parsed.recentRejected ?? {};
    this.loaded = true;
    if (this.rejected.length > 0) {
      this.logger.warn(
        `desktops.json: ${this.rejected.length} desktop record(s) this build cannot read are kept in the file untouched.`
      );
    }
    return parsed;
  }

  /** Ids of the records kept verbatim because this build cannot read them. */
  rejectedIds(): string[] {
    return this.rejected.flatMap((entry) => {
      const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
      return typeof id === "string" && id.length > 0 ? [id] : [];
    });
  }

  /** The state every write serializes (set once by the manager). */
  setSnapshot(snapshot: () => DesktopsSnapshot): void {
    this.snapshot = snapshot;
  }

  /** Queue a write of the current snapshot. Never rejects; a failure is logged. */
  persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.readOnlyReason !== null || !this.snapshot) {
        return;
      }
      const { desktops, recent } = this.snapshot();
      const data = serializeDesktopsFile({
        version: 1,
        desktops,
        recent,
        recentRejected: this.recentRejected,
        rejected: this.rejected,
        extra: this.extra
      });
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600, false);
      } catch (error) {
        this.logger.error("Failed to persist desktops", error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Resolves once every queued write has run. */
  flush(): Promise<void> {
    return this.writes;
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
      this.readOnlyReason = `desktops.json was corrupt (${detail}) and was moved to ${aside}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.readOnlyReason = `desktops.json is corrupt (${detail}) and could not be moved aside (${code ?? "unknown error"})`;
    }
    this.logger.error(`${this.readOnlyReason}; desktops are read-only until the next start.`);
  }
}
