/**
 * The box's git configuration for a project box (spec §7 "Git"): git in a box is SSH only. Every
 * HTTPS URL of the workspace account's host is rewritten to its SSH form (`boxGitConfig` in
 * `remote/git-auth.ts`), SSH authenticates through the restricted ssh-agent `orq-agent` forwards
 * to the host (`SSH_AUTH_SOCK` in every process it starts) and trusts only the host keys the daemon
 * wrote, and the workspace's git identity is the box user's global identity. No git hosting token
 * and no private key ever reaches the box; credential helpers are reset to none.
 */

import type { BoxOs } from "@orquester/api";

import { shQuote } from "./box-exec.ts";

export interface BoxGitConfigInput {
  os: BoxOs;
  /** Box path of the known_hosts file the daemon wrote. */
  knownHostsPath: string;
  /** Whether that file holds the git host's keys: SSH then refuses any other key (else accept-new). */
  strictHostKeys: boolean;
  /** `git config --global --add` entries (`BoxGitConfig.entries`: the `url.<ssh>.insteadOf` rewrites). */
  entries: readonly { key: string; value: string }[];
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

/** One `git` invocation of the setup; `mayBeMissing`: exit 5 (nothing to unset) is fine. */
export interface BoxGitConfigCommand {
  args: string[];
  mayBeMissing?: true;
}

/**
 * The `git` argument lists that configure the box, in order. The empty helper entry resets
 * helpers from system config (Git for Windows' credential manager, a distro's): git never asks
 * anything for a password. Each rewrite key is cleared before it is added, so a setup that runs
 * again (a resume) leaves one copy.
 */
export function boxGitConfigCommands(input: BoxGitConfigInput): BoxGitConfigCommand[] {
  const commands: BoxGitConfigCommand[] = [
    { args: ["config", "--global", "--unset-all", "credential.helper"], mayBeMissing: true },
    { args: ["config", "--global", "--add", "credential.helper", ""] },
    {
      args: [
        "config",
        "--global",
        "core.sshCommand",
        `ssh -o UserKnownHostsFile=${configPath(input.os, input.knownHostsPath)} -o StrictHostKeyChecking=${input.strictHostKeys ? "yes" : "accept-new"}`
      ]
    }
  ];
  for (const key of new Set(input.entries.map((entry) => entry.key))) {
    commands.push({ args: ["config", "--global", "--unset-all", key], mayBeMissing: true });
  }
  for (const entry of input.entries) commands.push({ args: ["config", "--global", "--add", entry.key, entry.value] });
  if (input.identity) {
    commands.push({ args: ["config", "--global", "user.name", input.identity.name] });
    commands.push({ args: ["config", "--global", "user.email", input.identity.email] });
  }
  return commands;
}
