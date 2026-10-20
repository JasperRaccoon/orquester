/**
 * The known_hosts lines a box trusts for its git remote (spec §7 "Git"): the daemon-owned
 * `<keys>/known_hosts` (Bitbucket pins, TOFU'd Data Center hosts) plus the daemon user's own
 * `~/.ssh/known_hosts` entries for that one host — GitHub's, which the host's git trusts there.
 * Public keys only; nothing here is secret. A host neither file knows is accepted on first use in
 * the box, as on the host (`StrictHostKeyChecking=accept-new`).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureKnownHosts } from "../../known-hosts.ts";

const run = promisify(execFile);

/** `host` or `[host]:port`, as known_hosts names a host. */
function hostPattern(host: string, port: number | null): string {
  return port !== null && port !== 22 ? `[${host}]:${port}` : host;
}

export async function knownHostsForBox(options: { keysDir: string; home: string; host: string; port: number | null }): Promise<string> {
  const lines = new Set<string>();
  const daemonFile = await ensureKnownHosts(options.keysDir, { refresh: false }).catch(() => null);
  if (daemonFile) {
    const text = await readFile(daemonFile, "utf8").catch(() => "");
    for (const line of text.split("\n")) if (line.trim() && !line.startsWith("#")) lines.add(line.trim());
  }
  // `ssh-keygen -F` matches hashed entries too, and prints only the matching lines.
  const userFile = join(options.home, ".ssh", "known_hosts");
  try {
    const { stdout } = await run("ssh-keygen", ["-F", hostPattern(options.host, options.port), "-f", userFile], { timeout: 10_000 });
    for (const line of stdout.split("\n")) if (line.trim() && !line.startsWith("#")) lines.add(line.trim());
  } catch {
    // No such file, no entry (exit 1), or no ssh-keygen: the daemon's own file is all there is.
  }
  return lines.size > 0 ? `${[...lines].join("\n")}\n` : "";
}
