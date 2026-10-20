/**
 * `BoxRegistry` (contracts.ts) over the box records: which box a host path lives in, and the
 * summaries every other module and route shows. Lookups are in memory and synchronous enough for
 * hot paths (file routes call `locate` per request).
 */

import { dirname, resolve } from "node:path";

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
  /** Project path → its box record, rebuilt after a record change: `locate` runs on hot paths. */
  private projectIndex: Map<string, StoredBox> | null = null;

  constructor(
    private readonly store: BoxStore,
    private readonly hub: BoxHub,
    private readonly providers: BoxProviderRegistry,
    private readonly now: () => number
  ) {
    store.events.on("changed", () => {
      this.projectIndex = null;
    });
  }

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

  private index(): Map<string, StoredBox> {
    if (this.projectIndex) return this.projectIndex;
    const index = new Map<string, StoredBox>();
    for (const record of this.store.list()) {
      const project = record.project;
      if (record.purpose !== "project" || !project || projectDeleted(record)) continue;
      const root = resolve(project.path);
      const current = index.get(root);
      // The newest record wins when a stale one (an older build's) names the same path.
      if (!current || record.createdAt > current.createdAt) index.set(root, record);
    }
    this.projectIndex = index;
    return index;
  }

  /** The project box record for exactly `projectPath` (or one that contains `path`), deleted projects excluded. */
  projectRecord(path: string): StoredBox | undefined {
    const index = this.index();
    if (index.size === 0) return undefined;
    // Walk up from the path: a box project is a directory, so a file under it maps to it too.
    for (let current = resolve(path); ; ) {
      const record = index.get(current);
      if (record) return record;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
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
