/**
 * Test doubles for config and transcript sync.
 *
 * {@link mappedBoxConnection} wraps `localBoxConnection()` (whose "box" is this machine with
 * identity paths) so the box's file system lives under its own directory: a box path `P` (what
 * the sync code computes with `hostToBoxPath(paths, hostPath)`) is the local file
 * `<boxRoot><boxToHostPath(paths, P)>`. Host and box trees then never collide on one machine, and
 * a `windows-prefix` map checks that every box path the code sends is the `C:\orq\…` form.
 * `realpaths` simulates a box whose realpath differs from the logical path (macOS `/private/var`).
 */

import type { Readable } from "node:stream";

import { boxToHostPath, hostToBoxPath, type BoxPathMap, type BoxSysInfo } from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxHub } from "../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../testing.ts";

export interface MappedBoxConnection extends BoxConnection {
  setConnected(connected: boolean): void;
  emitEvent(name: string, data: unknown): void;
  /** Box paths of every file written, in order. */
  readonly writes: string[];
  /** Every bulk push (`writeTar`): the box dir it went to and its compression, in order. */
  readonly tars: { path: string; compression: string | null }[];
  /** Every request (method + params as sent, box paths), in order. */
  readonly calls: { method: string; params: unknown }[];
  /** The local file standing for a HOST path in this box. */
  local(hostPath: string): string;
  readonly inner: LocalBoxConnection;
}

export interface MappedBoxConnectionOptions {
  boxId: string;
  /** Local directory holding the box's file system. */
  boxRoot: string;
  paths?: BoxPathMap;
  sys?: Partial<BoxSysInfo>;
  /** Box path → the box path `fs.realpath` answers for it (and for paths below it). */
  realpaths?: Record<string, string>;
}

export function mappedBoxConnection(options: MappedBoxConnectionOptions): MappedBoxConnection {
  const paths = options.paths ?? { kind: "identity" };
  const inner = localBoxConnection({ boxId: options.boxId, sys: options.sys, paths });
  const writes: string[] = [];
  const tars: { path: string; compression: string | null }[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const toLocal = (boxPath: string): string => {
    const host = boxToHostPath(paths, boxPath);
    if (host === null) throw new Error(`not a box path of this map: ${boxPath}`);
    return `${options.boxRoot}${host === "/" ? "" : host}`;
  };
  const fromLocal = (local: string): string => {
    if (!local.startsWith(options.boxRoot)) return local;
    return hostToBoxPath(paths, local.slice(options.boxRoot.length) || "/");
  };
  const isBoxPath = (value: string): boolean => boxToHostPath(paths, value) !== null && (paths.kind !== "identity" || value.startsWith("/"));
  const mapParams = (method: string, params: unknown): unknown => {
    if (typeof params !== "object" || params === null) return params;
    const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    for (const key of ["path", "from", "to"]) {
      if (typeof out[key] === "string") out[key] = toLocal(out[key] as string);
    }
    if (Array.isArray(out.paths)) out.paths = (out.paths as string[]).map(toLocal);
    // A link the sync makes in the box names a box path: it points inside this box too.
    if (method === "fs.symlink" && typeof out.target === "string" && isBoxPath(out.target)) out.target = toLocal(out.target);
    return out;
  };
  const realpathOverride = (boxPath: string): string | null => {
    for (const [from, to] of Object.entries(options.realpaths ?? {})) {
      if (boxPath === from) return to;
      if (boxPath.startsWith(`${from}/`)) return `${to}${boxPath.slice(from.length)}`;
    }
    return null;
  };

  const connection: MappedBoxConnection = {
    boxId: options.boxId,
    sys: inner.sys,
    paths,
    get connected() {
      return inner.connected;
    },
    agentVersion: inner.agentVersion,
    writes,
    tars,
    calls,
    inner,
    local: (hostPath) => toLocal(hostToBoxPath(paths, hostPath)),
    detachedProcs: () => inner.detachedProcs(),
    async request(method, params, requestOptions) {
      calls.push({ method, params });
      if (method === "fs.realpath") {
        const boxPath = (params as { path: string }).path;
        const override = realpathOverride(boxPath);
        if (override !== null) return override as never;
      }
      const result = await inner.request(method, mapParams(method, params) as typeof params, requestOptions);
      if (method === "fs.realpath" && typeof result === "string") return fromLocal(result) as never;
      if (method === "fs.stat" && result && typeof result === "object") {
        return { ...(result as object), path: (params as { path: string }).path } as never;
      }
      return result;
    },
    requestRaw: (method, params, requestOptions) => inner.requestRaw(method, params, requestOptions),
    exec(execOptions: BoxExecOptions) {
      return inner.exec({
        ...execOptions,
        cwd: execOptions.cwd !== undefined ? toLocal(execOptions.cwd) : undefined,
        args: (execOptions.args ?? []).map((arg) => (isBoxPath(arg) ? toLocal(arg) : arg))
      });
    },
    attach: (procId, fromOffset) => inner.attach(procId, fromOffset),
    openTcp: (port, host) => inner.openTcp(port, host),
    forwardToHost: (boxPort, forwardOptions) => inner.forwardToHost(boxPort, forwardOptions),
    openChannel: (spec) => inner.openChannel(spec),
    readFile: (path, readOptions) => inner.readFile(toLocal(path), readOptions),
    async writeFile(path: string, data: Readable | Uint8Array | string, writeOptions?: { mode?: number; mkdirs?: boolean }) {
      writes.push(path);
      await inner.writeFile(toLocal(path), data, writeOptions);
    },
    readTar: (path, tarOptions) => inner.readTar(toLocal(path), tarOptions),
    async writeTar(path, tar, tarOptions) {
      tars.push({ path, compression: tarOptions?.compression ?? null });
      await inner.writeTar(toLocal(path), tar, tarOptions);
    },
    onEvent: (name, listener) => inner.onEvent(name, listener),
    onStatus: (listener) => inner.onStatus(listener),
    setConnected: (next) => inner.setConnected(next),
    emitEvent: (name, data) => inner.emitEvent(name, data)
  };
  return connection;
}

/** A `BoxHub` over a fixed set of connections (for `get`/`onConnectionChange`). */
export function fakeBoxHub(connections: Record<string, BoxConnection>): Pick<BoxHub, "get" | "onConnectionChange"> & {
  add(connection: BoxConnection): void;
} {
  const listeners = new Set<(boxId: string, connected: boolean) => void>();
  return {
    get: (boxId) => connections[boxId],
    onConnectionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add(connection) {
      connections[connection.boxId] = connection;
      for (const listener of listeners) listener(connection.boxId, true);
    }
  };
}
