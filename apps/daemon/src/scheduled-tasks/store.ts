// Scheduled tasks — `<appdir>/daemon/scheduled-tasks.json` (schema: `@orquester/config`
// `scheduled-tasks.ts`).
//
// Memory is the live copy; `persist()` writes it. Writes are serialized and coalesced (every change
// made while a write runs rides the ONE write that follows it) and atomic (temp file + rename) at
// 0600. What this build cannot read — a record in a newer shape, an unknown top-level key — is
// written back verbatim by every write.
//
// - missing → empty;
// - corrupt, or another `version` → moved aside to `scheduled-tasks.json.corrupt-<stamp>` and empty
//   (the old file is still there to look at, and never written over);
// - unreadable (permissions, I/O) → empty and READ-ONLY for this run: the file may hold good tasks,
//   so nothing is written over it and every mutation is refused (`blockedReason`).

import { readFile, rename } from "node:fs/promises";
import {
  parseScheduledTasksFile,
  serializeScheduledTasksFile,
  type ScheduledTaskRecord
} from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";

export interface ScheduledTasksStoreLogger {
  warn(message: string): void;
  error(message: string): void;
}

export class ScheduledTasksStore {
  private readonly records = new Map<string, ScheduledTaskRecord>();
  private rejected: unknown[] = [];
  private extra: Record<string, unknown> = {};
  /** The liveness marker as read at load, then as last stamped (see `ScheduledTasksFile.aliveAt`). */
  aliveAt: string | null = null;
  /** Why the file may not be written this run, or null. */
  blockedReason: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private readonly logger: ScheduledTasksStoreLogger;

  constructor(
    readonly path: string,
    logger?: ScheduledTasksStoreLogger
  ) {
    this.logger = logger ?? console;
  }

  async load(): Promise<void> {
    this.records.clear();
    this.rejected = [];
    this.extra = {};
    this.aliveAt = null;
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      this.blockedReason = `scheduled-tasks.json could not be read (${code ?? "unknown error"})`;
      this.logger.error(`${this.blockedReason}; scheduled tasks are off until the next restart.`);
      return;
    }
    try {
      const file = parseScheduledTasksFile(JSON.parse(text));
      for (const record of file.tasks) this.records.set(record.id, record);
      this.rejected = file.rejected;
      this.extra = file.extra;
      this.aliveAt = file.aliveAt;
      if (this.rejected.length > 0) {
        this.logger.warn(
          `scheduled-tasks.json: ${this.rejected.length} task(s) this build cannot read are not scheduled; they stay in the file untouched.`
        );
      }
    } catch (error) {
      const aside = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await rename(this.path, aside);
        this.logger.warn(`scheduled-tasks.json is not readable (${(error as Error).message}); moved it to ${aside}.`);
      } catch {
        this.blockedReason = "scheduled-tasks.json is corrupt and could not be moved aside";
        this.logger.error(`${this.blockedReason}; scheduled tasks are off until the next restart.`);
      }
    }
  }

  all(): ScheduledTaskRecord[] {
    return [...this.records.values()];
  }

  get(id: string): ScheduledTaskRecord | undefined {
    return this.records.get(id);
  }

  /** Records are replaced, never mutated in place. */
  put(record: ScheduledTaskRecord): void {
    this.records.set(record.id, record);
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  get size(): number {
    return this.records.size;
  }

  /** Resolves once a write carrying every change so far has landed; rejects when it failed. */
  persist(): Promise<void> {
    if (this.blockedReason !== null) return Promise.reject(new Error(this.blockedReason));
    if (this.queued) return this.queued;
    const next = this.writing
      .catch(() => undefined)
      .then(async () => {
        this.queued = null;
        const content = serializeScheduledTasksFile({ tasks: this.all(), aliveAt: this.aliveAt, rejected: this.rejected, extra: this.extra });
        try {
          await writeFileAtomic(this.path, content, 0o600, false);
        } catch (error) {
          this.logger.error(`scheduled-tasks.json could not be written: ${(error as Error).message}`);
          throw error;
        }
      });
    this.queued = next;
    this.writing = next;
    return next;
  }

  /** Waits for every write started or queued so far. Never rejects. */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }
}
