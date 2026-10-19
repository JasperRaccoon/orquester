/**
 * `BoxRegistry` (contracts.ts) over the box records: which box a host path lives in, and the
 * summaries every other module and route shows. Lookups are in memory and synchronous enough for
 * hot paths (file routes call `locate` per request).
 */

import { resolve } from "node:path";

import type { BoxSummary } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection, BoxHub, BoxProviderRegistry, BoxRegistry, ProjectLocation } from "../contracts.ts";
import { BoxError } from "./errors.ts";
import type { BoxStore } from "./store.ts";
import { toBoxSummary } from "./summary.ts";

/** Set on a record when its project was deleted: the record stays (month totals) but no longer owns the path. */
export const PROJECT_DELETED_FIELD = "projectDeletedAt";

export function projectDeleted(record: StoredBox): boolean {
  return typeof record[PROJECT_DELETED_FIELD] === "string";
}

export class StoreBoxRegistry implements BoxRegistry {
  constructor(
    private readonly store: BoxStore,
    private readonly hub: BoxHub,
    private readonly providers: BoxProviderRegistry,
    private readonly now: () => number
  ) {}

  list(): StoredBox[] {
    return this.store.list();
  }

  get(boxId: string): StoredBox | undefined {
    return this.store.get(boxId);
  }

  summary(boxId: string): BoxSummary | undefined {
    const record = this.store.get(boxId);
    return record ? (this.summarize(record) ?? undefined) : undefined;
  }

  summarize(record: StoredBox): BoxSummary | null {
    return toBoxSummary(record, { providers: this.providers, connected: this.hub.get(record.id)?.connected === true, now: this.now() });
  }

  /** Every record this build can show, newest first. */
  summaries(): BoxSummary[] {
    return this.store
      .list()
      .map((record) => this.summarize(record))
      .filter((summary): summary is BoxSummary => summary !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** The project box record for exactly `projectPath` (or one that contains `path`), deleted projects excluded. */
  projectRecord(path: string): StoredBox | undefined {
    const target = resolve(path);
    let best: StoredBox | undefined;
    for (const record of this.store.list()) {
      const project = record.project;
      if (record.purpose !== "project" || !project || projectDeleted(record)) continue;
      const root = resolve(project.path);
      if (target !== root && !target.startsWith(`${root}/`)) continue;
      // The newest record wins when a stale one (an older build's) names the same path.
      if (!best || record.createdAt > best.createdAt) best = record;
    }
    return best;
  }

  locate(path: string): ProjectLocation {
    const record = this.projectRecord(path);
    if (!record) return { kind: "host" };
    return { kind: "box", boxId: record.id, record, connection: this.hub.get(record.id) };
  }

  async requireConnected(path: string): Promise<BoxConnection | null> {
    const location = this.locate(path);
    if (location.kind === "host") return null;
    const { record, connection } = location;
    if (record.state === "ready" && connection?.connected) return connection;
    const why =
      record.state === "destroyed"
        ? "This project's box was destroyed."
        : record.state === "provisioning"
          ? "This project's box is still being set up."
          : record.state === "unreachable" || (record.state === "ready" && !connection?.connected)
            ? "This project's box is reconnecting."
            : `This project's box is ${record.state}.`;
    throw new BoxError(409, "BOX_NOT_READY", why);
  }

  onChange(listener: (boxId: string) => void): () => void {
    const onChanged = (boxId: string | null) => {
      if (boxId !== null) listener(boxId);
    };
    this.store.events.on("changed", onChanged);
    return () => void this.store.events.off("changed", onChanged);
  }
}
