/**
 * The environment of processes the daemon starts in a box: git, terminals and
 * workflow blocks (spec §7 "Git", §8.8, §10).
 *
 * A box process is never given the host's environment: `orq-agent` starts it
 * with its OWN environment, and these helpers only add to it. That is what
 * keeps the host's `NODE_OPTIONS` preload, host PATH entries and the daemon's
 * `ORQUESTER_*` secrets out of the box.
 *
 * - Git: nothing is added. A box never holds a git hosting token: git in the
 *   box reaches the workspace account's host over SSH only, through the agent
 *   socket `orq-agent` exports as `SSH_AUTH_SOCK` (the host's restricted
 *   `ssh-agent` channel, `../git-auth.ts`), with the HTTPS → SSH rewrites and
 *   pinned host keys the box setup wrote to the box user's own git config. No
 *   env overrides that config (a `GIT_SSH_COMMAND` here would replace its
 *   pinned `core.sshCommand`).
 * - {@link boxToolingEnv}: a tooling plugin's per-target contribution
 *   (`BoxToolingProvisioner.contribution`), with PATH prepended to the box's
 *   own PATH and the `--require` files as the whole of `NODE_OPTIONS`.
 */

import { appendNodeRequireOption } from "@orquester/config";
import type { BoxSysInfo } from "@orquester/api";

import type { BoxConnection, BoxToolingProvisioner, SessionToolingContribution } from "../../contracts.ts";
import { runInBox } from "./run.ts";

/** The name of the search-path variable a box's OS uses. */
export function pathVariable(sys: Pick<BoxSysInfo, "os">): "PATH" | "Path" {
  return sys.os === "win32" ? "Path" : "PATH";
}

const basePaths = new WeakMap<BoxConnection, Promise<string>>();

/**
 * `orq-agent`'s own PATH in the box, read once per connection (and again after
 * it reconnects: an updated `orq-agent` may have started with another PATH).
 */
export function boxBasePath(connection: BoxConnection): Promise<string> {
  const cached = basePaths.get(connection);
  if (cached) return cached;
  const read =
    connection.sys.os === "win32"
      ? runInBox(connection, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write($env:Path)"], { timeout: 15_000 })
      : runInBox(connection, "/bin/sh", ["-c", 'printf %s "$PATH"'], { timeout: 15_000 });
  const pending = read.then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      basePaths.delete(connection);
      throw error;
    }
  );
  basePaths.set(connection, pending);
  const unsubscribe = connection.onStatus((connected) => {
    if (!connected) return;
    unsubscribe();
    if (basePaths.get(connection) === pending) basePaths.delete(connection);
  });
  return pending;
}

/** An empty contribution: what a box gets when no tooling plugin applies. */
export const NO_TOOLING: SessionToolingContribution = { pathPrepend: [], env: {}, nodeRequire: [] };

/** The tooling contribution for a box, tolerating an absent provisioner. */
export function toolingFor(tooling: Pick<BoxToolingProvisioner, "contribution"> | undefined, boxId: string): SessionToolingContribution {
  return tooling ? tooling.contribution(boxId) : NO_TOOLING;
}

/**
 * Env for a tooling contribution in this box: its vars, PATH with its entries
 * first (when there are any), and `NODE_OPTIONS` made of its `--require`
 * files only. Without `--require` files `NODE_OPTIONS` is left to the box.
 */
export async function boxToolingEnv(connection: BoxConnection, contribution: SessionToolingContribution): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...contribution.env };
  if (contribution.pathPrepend.length > 0) {
    const separator = connection.sys.os === "win32" ? ";" : ":";
    const base = await boxBasePath(connection);
    env[pathVariable(connection.sys)] = [...contribution.pathPrepend, ...(base ? [base] : [])].join(separator);
  }
  if (contribution.nodeRequire.length > 0) {
    let options: string | undefined;
    for (const file of contribution.nodeRequire) options = appendNodeRequireOption(options, file);
    if (options !== undefined) env.NODE_OPTIONS = options;
  }
  return env;
}
