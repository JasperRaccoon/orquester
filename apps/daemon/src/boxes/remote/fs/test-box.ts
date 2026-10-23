/**
 * Test doubles for the box file features: a "box" whose disk is a separate
 * directory of this machine, and a `BoxRegistry` with one project box.
 *
 * {@link boxDiskConnection} wraps `localBoxConnection()` (boxes/testing.ts) so
 * that box path `/x` lives at `<disk>/x` here: a test can leave the host stub of
 * a box project empty and prove that every byte it reads or writes went through
 * the box link. With `windows: true` the box also uses the Windows mapping
 * (`C:\orq\…`), so the host ⇄ box path translation is exercised end to end.
 */

import { posix } from "node:path";

import type { BoxPathMap, BoxSummary } from "@orquester/api";
import { BOX_WINDOWS_PATH_PREFIX } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection, BoxExecOptions, BoxRegistry, ProjectLocation } from "../../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../testing.ts";

export interface BoxDiskOptions {
  /** Real (realpath'd) directory holding the box's whole file system. */
  disk: string;
  /** Use the Windows path mapping (`C:\orq\…`). */
  windows?: boolean;
  /** Extra env for every process the box runs (e.g. a PATH without rg). */
  env?: Record<string, string>;
  boxId?: string;
  /** Box paths (prefixes) that argv entries may name; they are mapped into the disk like `cwd`. */
  argRoots?: string[];
}

export interface BoxDiskConnection extends LocalBoxConnection {
  /** The local path that holds box path `boxPath`. */
  local(boxPath: string): string;
  /** Every process started, in order (command + args). */
  readonly execs: { command: string; args: string[]; cwd?: string }[];
}

export function boxDiskConnection(options: BoxDiskOptions): BoxDiskConnection {
  const windows = options.windows === true;
  const paths: BoxPathMap = windows ? { kind: "windows-prefix", prefix: BOX_WINDOWS_PATH_PREFIX } : { kind: "identity" };
  const inner = localBoxConnection({ boxId: options.boxId ?? "box-1", paths });
  const disk = options.disk;
  const prefix = BOX_WINDOWS_PATH_PREFIX.toLowerCase();

  /** Box path → local path. */
  const local = (boxPath: string): string => {
    if (!windows) return boxPath.startsWith("/") ? posix.join(disk, boxPath) : boxPath;
    if (!boxPath.toLowerCase().startsWith(prefix)) return boxPath;
    const rest = boxPath.slice(prefix.length).split(/[\\/]+/).filter((segment) => segment.length > 0);
    return posix.join(disk, ...rest);
  };
  /** Local path → box path (a local path outside the disk stays as it is: outside every root). */
  const boxed = (localPath: string): string => {
    if (localPath !== disk && !localPath.startsWith(`${disk}/`)) return localPath;
    const rest = localPath.slice(disk.length).split("/").filter((segment) => segment.length > 0);
    if (!windows) return `/${rest.join("/")}`;
    return [BOX_WINDOWS_PATH_PREFIX, ...rest].join("\\");
  };
  const argRoots = (options.argRoots ?? []).map((root) => root.toLowerCase());
  const isArgPath = (value: string): boolean => argRoots.some((root) => value.toLowerCase().startsWith(root));

  const execs: { command: string; args: string[]; cwd?: string }[] = [];
  // Requests as the box received them (box paths), not as the disk double replays them.
  const calls: { method: string; params: unknown }[] = [];
  const wrapped = Object.create(inner) as BoxDiskConnection;
  Object.defineProperty(wrapped, "execs", { value: execs });
  Object.defineProperty(wrapped, "calls", { value: calls });
  wrapped.local = local;
  wrapped.request = (async (method: string, params: Record<string, unknown>, requestOptions?: unknown) => {
    if (inner.connected) calls.push({ method, params });
    const translated: Record<string, unknown> = { ...params };
    for (const key of ["path", "from", "to"]) {
      if (typeof translated[key] === "string") translated[key] = local(translated[key] as string);
    }
    const result = await (inner.request as (m: string, p: unknown, o?: unknown) => Promise<unknown>)(method, translated, requestOptions);
    if (method === "fs.realpath") return boxed(result as string);
    if (method === "fs.stat" && result !== null) {
      // A Windows box reports no inode identity.
      const stat = result as { path: string; identity: string | null };
      return { ...stat, path: params.path, identity: windows ? null : stat.identity };
    }
    return result;
  }) as BoxConnection["request"];
  wrapped.readFile = (path, readOptions) => inner.readFile(local(path), readOptions);
  wrapped.writeFile = (path, data, writeOptions) => inner.writeFile(local(path), data, writeOptions);
  wrapped.readTar = (path, tarOptions) => inner.readTar(local(path), tarOptions);
  wrapped.writeTar = (path, tar, tarOptions) => inner.writeTar(local(path), tar, tarOptions);
  wrapped.exec = (execOptions: BoxExecOptions) => {
    // Box paths in argv (an archive to list) point into the disk, like cwd. Only paths under
    // `argRoots` count: an rg glob such as "/src/keep.ts" is not a path.
    const args = (execOptions.args ?? []).map((arg) => (isArgPath(arg) ? local(arg) : arg));
    execs.push({ command: execOptions.command, args: execOptions.args ?? [], ...(execOptions.cwd ? { cwd: execOptions.cwd } : {}) });
    return inner.exec({
      ...execOptions,
      args,
      ...(execOptions.cwd ? { cwd: local(execOptions.cwd) } : {}),
      ...(options.env ? { env: { ...execOptions.env, ...options.env } } : {})
    });
  };
  return wrapped;
}

/** A `BoxRegistry` with one project box at `projectPath` (host path), backed by `connection`. */
export function fakeBoxRegistry(options: {
  projectPath: string;
  connection: BoxConnection | undefined;
  boxId?: string;
  state?: string;
}): BoxRegistry & { record: StoredBox } {
  const boxId = options.boxId ?? options.connection?.boxId ?? "box-1";
  const record: StoredBox = {
    id: boxId,
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "cx22",
    name: `orq-${boxId}`,
    createdAt: new Date(0).toISOString(),
    state: options.state ?? "ready",
    project: { workspace: "acme", name: posix.basename(options.projectPath), path: options.projectPath }
  };
  const inside = (path: string): boolean => path === options.projectPath || path.startsWith(`${options.projectPath}/`);
  return {
    record,
    list: () => [record],
    get: (id) => (id === boxId ? record : undefined),
    summary: (): BoxSummary | undefined => undefined,
    locate: (path): ProjectLocation =>
      inside(path) ? { kind: "box", boxId, record, connection: options.connection } : { kind: "host" },
    requireConnected: async (path) => (inside(path) ? (options.connection ?? null) : null),
    onChange: () => () => undefined
  };
}
