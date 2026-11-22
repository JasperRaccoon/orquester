/**
 * `machines.json` (`machinesStorePath`): the owner's policy per machine, read through
 * `parseMachinesFile` and written through `serializeMachinesFile` (`@orquester/config` machines.ts).
 *
 * - A missing file is an empty store.
 * - A file whose outer shape does not parse is moved aside to `<file>.corrupt-<stamp>`; a file that
 *   cannot be read at all stays where it is. Either way the store is read-only until the next start:
 *   changes are refused rather than written over the owner's data.
 * - Records this build cannot read, and unknown keys, are written back verbatim.
 * - Writes are chained and atomic (temp file + rename, 0600); each serializes the state when it runs.
 */

import { readFile, rename } from "node:fs/promises";

import { createDefaultMachinesFile, parseMachinesFile, serializeMachinesFile, type MachinesFile, type StoredMachine } from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";

type Logger = Pick<Console, "error">;

export class MachineStoreReadOnlyError extends Error {
  constructor(reason: string) {
    super(`Machine settings can't be saved: ${reason}. Fix or remove the file and restart Orquester.`);
  }
}

export class MachinePolicyStore {
  private file: MachinesFile = createDefaultMachinesFile();
  private writes: Promise<void> = Promise.resolve();
  /** Why writes are refused this run, or null. */
  readOnlyReason: string | null = null;

  constructor(private readonly options: { path: string; logger?: Logger }) {}

  private get logger(): Logger {
    return this.options.logger ?? console;
  }

  /** Read the file; never throws. */
  async load(): Promise<void> {
    this.file = createDefaultMachinesFile();
    this.readOnlyReason = null;
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.readOnlyReason = `machines.json could not be read (${code ?? "unknown error"})`;
      this.logger.error(`[machines] ${this.readOnlyReason}; machine settings are read-only until the next start.`);
      return;
    }
    try {
      this.file = parseMachinesFile(JSON.parse(text));
    } catch (error) {
      this.file = createDefaultMachinesFile();
      await this.quarantine(error instanceof Error ? error.message : String(error));
    }
  }

  /** Every readable record, by machine id (a copy). */
  all(): Record<string, StoredMachine> {
    return structuredClone(this.file.machines);
  }

  get(machineId: string): StoredMachine | undefined {
    const record = this.file.machines[machineId];
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Apply `mutate` to a copy of the records and persist the result. Throws
   * {@link MachineStoreReadOnlyError} while read-only (nothing changes then). `mutate` may delete,
   * add or move records; returning false skips the write.
   */
  async update(mutate: (machines: Record<string, StoredMachine>) => boolean | void): Promise<void> {
    if (this.readOnlyReason !== null) throw new MachineStoreReadOnlyError(this.readOnlyReason);
    const next = structuredClone(this.file.machines);
    if (mutate(next) === false) return;
    this.file = { ...this.file, machines: next };
    // A record now readable under an id replaces the unreadable one kept there.
    for (const id of Object.keys(next)) delete this.file.rejected[id];
    await this.queueWrite();
  }

  /** Resolves once every queued write has landed. */
  flush(): Promise<void> {
    return this.writes;
  }

  private queueWrite(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.readOnlyReason !== null) return;
      try {
        await writeFileAtomic(this.options.path, `${JSON.stringify(serializeMachinesFile(this.file), null, 2)}\n`, 0o600, false);
      } catch (error) {
        this.logger.error("[machines] Failed to write machines.json", error instanceof Error ? error.message : String(error));
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.options.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.options.path, aside);
      this.readOnlyReason = `machines.json was corrupt (${detail}) and was moved to ${aside}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.readOnlyReason = `machines.json is corrupt (${detail}) and could not be moved aside (${code ?? "unknown error"})`;
    }
    this.logger.error(`[machines] ${this.readOnlyReason}; machine settings are read-only until the next start.`);
  }
}
