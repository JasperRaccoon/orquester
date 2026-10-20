/**
 * GitService's route into a box (spec §8.7): for a project that lives in a box,
 * `git` runs THERE through `orq-agent`, with the same argv, timeouts, buffer
 * caps, per-repo serialization (GitService keys it by the project path, which
 * the box shares) and output parsing as on the host. The git panel's 2 s
 * status polling (`GitWatcher`) calls `GitService.status`, so it runs in the
 * box too. Workflow git triggers are unaffected: they `ls-remote` the remote
 * URL from the host.
 *
 * Env: never the host's. git gets the box user's HOME (so the box's own
 * `~/.gitconfig` — the workspace identity the box setup writes — applies) and
 * {@link boxGitEnv}: HTTPS credentials come from the host's `git.credential`
 * handler, SSH signatures from the host's ssh-agent channel (`../git-auth.ts`);
 * no key or token is ever in the box.
 */

import { posix } from "node:path";
import { Readable } from "node:stream";

import { hostToBoxPath } from "@orquester/api";

import type { GitExecRoute, GitRouteResolver, GitRunner, UntrackedFs } from "../../../git.ts";
import type { BoxConnection, BoxRegistry } from "../../contracts.ts";
import { boxGitEnv } from "./env.ts";
import { runInBox } from "./run.ts";

const routes = new WeakMap<BoxConnection, GitExecRoute>();

/** Read at most `length` bytes of a stream. */
async function readAtMost(stream: Readable, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    chunks.push(buffer);
    total += buffer.length;
    if (total >= length) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/** The git route of one connected box (cached per connection). */
export function boxGitRoute(connection: BoxConnection): GitExecRoute {
  const cached = routes.get(connection);
  if (cached) return cached;
  const toBox = (hostPath: string): string => hostToBoxPath(connection.paths, hostPath);

  const runner: GitRunner = (file, args, options) =>
    runInBox(connection, file, args, {
      cwd: options.cwd,
      env: { HOME: connection.sys.home, ...boxGitEnv(connection.sys), ...(options.env as Record<string, string>) },
      maxBuffer: options.maxBuffer,
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {})
    });

  const fs: UntrackedFs = {
    sep: connection.sys.os === "win32" ? "\\" : "/",
    // Host-form paths (the box mirrors them); mapped to the box at each call.
    join: (dir, file) => posix.join(dir, file),
    async lstat(path) {
      const info = await connection.request("fs.stat", { path: toBox(path), followSymlinks: false });
      if (info === null) throw Object.assign(new Error(`No such file in the box: ${path}`), { code: "ENOENT" });
      return { isSymbolicLink: () => info.kind === "symlink", isFile: () => info.kind === "file" };
    },
    async readlink(path) {
      const target =
        connection.sys.os === "win32"
          ? await runInBox(connection, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write((Get-Item -LiteralPath $env:ORQ_LINK).Target)"], {
              env: { ORQ_LINK: toBox(path) },
              timeout: 15_000
            })
          : await runInBox(connection, "readlink", [toBox(path)], { timeout: 15_000 });
      return target.stdout.replace(/\r?\n$/, "");
    },
    realpath: (path) => connection.request("fs.realpath", { path: toBox(path) }),
    async readHead(path, length) {
      return readAtMost(await connection.readFile(toBox(path), { length }), length);
    }
  };

  const route: GitExecRoute = {
    runner,
    async mtime(path) {
      const info = await connection.request("fs.stat", { path: toBox(path) });
      if (info === null) throw Object.assign(new Error(`No such file in the box: ${path}`), { code: "ENOENT" });
      return new Date(info.mtimeMs).toISOString();
    },
    fs
  };
  routes.set(connection, route);
  return route;
}

/**
 * The resolver GitService takes as `route`: null for a host project (decided
 * synchronously from the registry, so host repos pay nothing), the box's route
 * once it is connected, and the registry's `BOX_NOT_READY` (409) otherwise.
 */
export function createBoxGitRouteResolver(registry: Pick<BoxRegistry, "locate" | "requireConnected">): GitRouteResolver {
  return async (cwd) => {
    if (registry.locate(cwd).kind === "host") return null;
    const connection = await registry.requireConnected(cwd);
    return connection ? boxGitRoute(connection) : null;
  };
}
