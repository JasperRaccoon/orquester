/**
 * Each lease's action log (devices spec §9): the last {@link DEVICE_ACTION_LOG_LIMIT} agent and
 * user actions, in memory only (a restart starts it empty), oldest first. The service appends a
 * row for every action and broadcasts it; the panel draws taps and swipes from it.
 */

import { randomUUID } from "node:crypto";

import { DEVICE_ACTION_LOG_LIMIT, type DeviceActionEntry } from "@orquester/api";

/** A row before the log stamps it. */
export type DeviceActionDraft = Omit<DeviceActionEntry, "id" | "leaseId" | "at"> & { at?: string };

const SUMMARY_MAX_CHARS = 200;

export class DeviceActionLog {
  private readonly logs = new Map<string, DeviceActionEntry[]>();

  constructor(
    private readonly options: { limit?: number; now?: () => Date; id?: () => string } = {}
  ) {}

  /** Append a row (stamped with an id and time; the summary cut to one short line); returns it. */
  append(leaseId: string, draft: DeviceActionDraft): DeviceActionEntry {
    const limit = this.options.limit ?? DEVICE_ACTION_LOG_LIMIT;
    const summary = draft.summary.replace(/\s+/g, " ").trim();
    const entry: DeviceActionEntry = {
      ...draft,
      id: this.options.id?.() ?? randomUUID(),
      leaseId,
      at: draft.at ?? (this.options.now?.() ?? new Date()).toISOString(),
      summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary
    };
    const log = this.logs.get(leaseId) ?? [];
    log.push(entry);
    if (log.length > limit) log.splice(0, log.length - limit);
    this.logs.set(leaseId, log);
    return entry;
  }

  /** The lease's rows, oldest first (a copy). */
  list(leaseId: string): DeviceActionEntry[] {
    return [...(this.logs.get(leaseId) ?? [])];
  }

  /** The lease ended: its log goes. */
  forget(leaseId: string): void {
    this.logs.delete(leaseId);
  }

  clear(): void {
    this.logs.clear();
  }
}
