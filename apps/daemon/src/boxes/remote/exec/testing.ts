/**
 * Test doubles for the remote-exec tests: a `BoxRegistry` + hub pair over a
 * set of box connections, where any path under a registered project root is in
 * that box. Not used by production code.
 */

import { EventEmitter } from "node:events";
import { sep } from "node:path";

import type { BoxSummary } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection, BoxHub, BoxRegistry, ProjectLocation } from "../../contracts.ts";

export function boxRecord(id: string, overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "cx22",
    name: `orq-${id}`,
    createdAt: "2026-10-20T00:00:00.000Z",
    state: "ready",
    project: null,
    ...overrides
  };
}

export interface FakeBoxes {
  registry: BoxRegistry;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** Register a box; `projectPath` makes paths under it box paths. */
  add(record: StoredBox, connection: BoxConnection | undefined): void;
  setConnection(boxId: string, connection: BoxConnection | undefined): void;
  /** Update a record (state changes) and fire `onChange`. */
  update(boxId: string, patch: Partial<StoredBox>): void;
  /** Fire the hub's connection-change listeners. */
  emitConnection(boxId: string, connected: boolean): void;
}

export function fakeBoxes(): FakeBoxes {
  const records = new Map<string, StoredBox>();
  const connections = new Map<string, BoxConnection | undefined>();
  const changes = new EventEmitter();
  const connectionChanges = new EventEmitter();

  const locate = (path: string): ProjectLocation => {
    for (const record of records.values()) {
      const root = record.project?.path;
      if (!root || record.purpose !== "project") continue;
      if (path === root || path.startsWith(root + sep)) {
        return { kind: "box", boxId: record.id, record, connection: connections.get(record.id) };
      }
    }
    return { kind: "host" };
  };

  const registry: BoxRegistry = {
    list: () => [...records.values()],
    get: (boxId) => records.get(boxId),
    summary: (): BoxSummary | undefined => undefined,
    locate,
    async requireConnected(path) {
      const location = locate(path);
      if (location.kind === "host") return null;
      if (!location.connection?.connected || location.record.state !== "ready") {
        throw Object.assign(new Error("The project's box is not connected."), { status: 409, code: "BOX_NOT_READY" });
      }
      return location.connection;
    },
    onChange(listener) {
      changes.on("change", listener);
      return () => changes.off("change", listener);
    }
  };

  const hub: FakeBoxes["hub"] = {
    get: (boxId) => connections.get(boxId),
    onConnectionChange(listener) {
      connectionChanges.on("change", listener);
      return () => connectionChanges.off("change", listener);
    }
  };

  return {
    registry,
    hub,
    add(record, connection) {
      records.set(record.id, record);
      connections.set(record.id, connection);
    },
    setConnection(boxId, connection) {
      connections.set(boxId, connection);
    },
    update(boxId, patch) {
      const record = records.get(boxId);
      if (!record) return;
      records.set(boxId, { ...record, ...patch });
      changes.emit("change", boxId);
    },
    emitConnection(boxId, connected) {
      connectionChanges.emit("change", boxId, connected);
    }
  };
}
