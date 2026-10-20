/**
 * The box's git configuration for a project box (spec §7 "Git"): HTTPS credentials come from
 * `orq-agent git-credential` (answered by the host), SSH authenticates through the ssh-agent
 * `orq-agent` forwards to the host (`SSH_AUTH_SOCK` in every process it starts) and trusts the
 * host keys the daemon wrote, and the workspace's git identity is the box user's global identity.
 * No token or private key is ever written to the box.
 */

import type { BoxOs } from "@orquester/api";

import { shQuote } from "./box-exec.ts";

export interface BoxGitConfigInput {
  os: BoxOs;
  /** Absolute path of `orq-agent` in the box (`BoxSysInfo.agentPath`). */
  agentPath: string;
  /** Box path of the known_hosts file the daemon wrote. */
  knownHostsPath: string;
  identity: { name: string; email: string } | null;
}

/** Box path of the daemon-written known_hosts (inside the box user's `~/.ssh`). */
export function boxKnownHostsPath(os: BoxOs, home: string): string {
  return os === "win32" ? `${home.replace(/[\\/]+$/, "")}\\.ssh\\orquester_known_hosts` : `${home.replace(/\/+$/, "")}/.ssh/orquester_known_hosts`;
}

/** A path as git's (sh-parsed) config values expect it: forward slashes on Windows, quoted. */
function configPath(os: BoxOs, path: string): string {
  return os === "win32" ? `"${path.replace(/\\/g, "/")}"` : shQuote(path);
}

/**
 * The `git` argument lists that configure the box, in order. The first may exit 5 (no helper to
 * unset); every other must succeed. The empty helper entry resets helpers from system config
 * (Git for Windows' credential manager, a distro's), so only `orq-agent` answers.
 */
export function boxGitConfigCommands(input: BoxGitConfigInput): string[][] {
  const commands: string[][] = [
    ["config", "--global", "--unset-all", "credential.helper"],
    ["config", "--global", "--add", "credential.helper", ""],
    ["config", "--global", "--add", "credential.helper", `!${configPath(input.os, input.agentPath)} git-credential`],
    // The host picks the account by repository, so git must pass the path along.
    ["config", "--global", "credential.useHttpPath", "true"],
    [
      "config",
      "--global",
      "core.sshCommand",
      `ssh -o UserKnownHostsFile=${configPath(input.os, input.knownHostsPath)} -o StrictHostKeyChecking=accept-new`
    ]
  ];
  if (input.identity) {
    commands.push(["config", "--global", "user.name", input.identity.name]);
    commands.push(["config", "--global", "user.email", input.identity.email]);
  }
  return commands;
}

/** The host a clone URL connects to (`git@host:o/r`, `ssh://git@host:7999/o/r`, `https://host/o/r`), or null. */
export function cloneUrlHost(url: string): { host: string; port: number | null } | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(url);
  if (scheme) {
    return { host: scheme[2]!.replace(/^\[|\]$/g, "").toLowerCase(), port: scheme[3] ? Number(scheme[3]) : null };
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/.exec(url);
  return scp ? { host: scp[1]!.toLowerCase(), port: null } : null;
}
