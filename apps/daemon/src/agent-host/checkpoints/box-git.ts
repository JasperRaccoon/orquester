/**
 * Checkpoints — the git runner for a repository in a box (spec 2026-10-19
 * §8.5): the same bounded runner (`git.ts`: permits, timeouts, output caps,
 * transient retries), with each git child started in the box through
 * `orq-agent` and the capture's few file operations sent there too. The
 * hidden refs therefore live in the box's repository, beside its checkout.
 *
 * Paths: the service names the HOST path of the project (identical in a POSIX
 * box); a path git itself printed (the common dir, a temp index) is already a
 * box path. An absolute POSIX path is mapped with `hostToBoxPath`; anything
 * else is the box's own.
 */

import { hostToBoxPath, type BoxPathMap } from "@orquester/api";

import type { BoxConnection } from "../../boxes/contracts.ts";
import { spawnBoxChild } from "../boxes/remote-child.ts";
import { createGitRunner, type GitRunner } from "./git.ts";

/** A path the service or git named, as the box knows it. */
function boxPath(paths: BoxPathMap, path: string): string {
  return path.startsWith("/") ? hostToBoxPath(paths, path) : path;
}

export function createBoxGitRunner(input: {
  connection: BoxConnection;
  /** The box's login PATH (`boxes/box-tools.ts`), in the box's syntax. */
  path: string;
}): GitRunner {
  const { connection } = input;
  const paths = connection.paths;
  return createGitRunner({
    gitEnv: {
      [connection.sys.os === "win32" ? "Path" : "PATH"]: input.path,
      GIT_TERMINAL_PROMPT: "0"
    },
    spawn: ({ args, env, unset, cwd }) =>
      spawnBoxChild({
        connection,
        command: "git",
        args,
        env,
        envUnset: unset,
        cwd: boxPath(paths, cwd)
      }),
    files: {
      rm: async (path) => {
        await connection.request("fs.rm", { path: boxPath(paths, path), force: true });
      },
      exists: async (path) => (await connection.request("fs.stat", { path: boxPath(paths, path) })) !== null
    }
  });
}
