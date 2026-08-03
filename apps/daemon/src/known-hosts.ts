import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The two Cloud SSH hostnames one pinned line must cover. */
const CLOUD_SSH_HOSTS = ["bitbucket.org", "ssh.bitbucket.org"] as const;
/** known_hosts host field that matches both Cloud SSH hostnames. */
const CLOUD_HOST_FIELD = CLOUD_SSH_HOSTS.join(",");

/** Key types Bitbucket serves; anything else in the published doc is ignored. */
const KEY_TYPES = new Set([
  "ssh-rsa",
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521"
]);

/** Where Atlassian publishes the Bitbucket Cloud host keys (best-effort refresh). */
export const KNOWN_HOSTS_SOURCE_URL = "https://bitbucket.org/site/ssh";

// Bitbucket Cloud host keys as served by https://bitbucket.org/site/ssh
// (post-2023 rotation; verified 2026-08-03). Each line names BOTH hostnames:
// every clone/push/probe Orquester makes targets `ssh.bitbucket.org` (the
// legacy `bitbucket.org` SSH endpoint is retired 2026-11-12), and OpenSSH
// matches known_hosts on the hostname it connects to — a bitbucket.org-only
// pin would never apply and the first connection would be a plain TOFU.
// The same keys serve both names. DC hosts (unpublished, regenerable) are
// TOFU'd via StrictHostKeyChecking=accept-new into this same file.
export const KNOWN_HOSTS_SEED = [
  `${CLOUD_HOST_FIELD} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=`,
  `${CLOUD_HOST_FIELD} ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=`,
  `${CLOUD_HOST_FIELD} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO`
];

/**
 * Extract known_hosts lines for the Bitbucket Cloud SSH hosts out of the
 * published host-key document, normalizing every accepted line to the
 * `bitbucket.org,ssh.bitbucket.org <type> <key>` form (and deduping).
 *
 * Deliberately strict: only the two Cloud hostnames, only known key types, only
 * base64-looking key material — the document is HTML-wrapped in some responses
 * and must never be able to inject an entry for another host.
 */
export function parseKnownHostsDocument(text: string): string[] {
  const out = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [hostField, keyType, keyData] = line.split(/\s+/);
    if (!hostField || !keyType || !keyData) {
      continue;
    }
    if (!KEY_TYPES.has(keyType) || !/^[A-Za-z0-9+/]{40,}={0,2}$/.test(keyData)) {
      continue;
    }
    const names = hostField.split(",").map((name) => name.toLowerCase());
    if (!names.some((name) => (CLOUD_SSH_HOSTS as readonly string[]).includes(name))) {
      continue;
    }
    out.add(`${CLOUD_HOST_FIELD} ${keyType} ${keyData}`);
  }
  return [...out];
}

/** Append the lines that are not already present, verbatim. Returns how many. */
async function appendMissing(path: string, lines: string[]): Promise<number> {
  const existing = await readFile(path, "utf8").catch(() => "");
  const present = new Set(existing.split("\n"));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length > 0) {
    await appendFile(path, missing.map((line) => `${line}\n`).join(""));
  }
  return missing.length;
}

/**
 * Best-effort refresh of the Cloud pins from Atlassian's published list, so a
 * host-key rotation lands here without a daemon release. Only ever *adds* lines
 * (never removes), and only over a CA-validated TLS connection to bitbucket.org.
 * Any failure (offline host, HTML change, timeout) is a no-op. Returns the
 * number of lines added.
 */
export async function refreshKnownHosts(keysDir: string, timeoutMs = 5000): Promise<number> {
  const response = await fetch(KNOWN_HOSTS_SOURCE_URL, {
    headers: { Accept: "text/plain", "User-Agent": "orquester" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    return 0;
  }
  const lines = parseKnownHostsDocument(await response.text());
  if (lines.length === 0) {
    return 0;
  }
  return appendMissing(join(keysDir, "known_hosts"), lines);
}

/** One refresh attempt per daemon process — this runs on git/ssh hot paths. */
let refreshStarted = false;

/**
 * Creates/seeds the daemon-owned `<keysDir>/known_hosts` (0600) with the pinned
 * Bitbucket Cloud host keys (covering `bitbucket.org` *and* `ssh.bitbucket.org`,
 * the host all Cloud SSH traffic actually targets). Idempotent: it only appends
 * seed lines that are not already present, so TOFU entries appended by ssh
 * (`StrictHostKeyChecking=accept-new`, e.g. a DC host on a non-22 port) survive.
 *
 * Also kicks off a once-per-process, fire-and-forget refresh from Atlassian's
 * published key list (`refresh: false` disables it — used by tests and any
 * caller that must not touch the network). Returns the file path.
 */
export async function ensureKnownHosts(
  keysDir: string,
  options: { refresh?: boolean } = {}
): Promise<string> {
  const path = join(keysDir, "known_hosts");
  try {
    await readFile(path, "utf8");
  } catch {
    await writeFile(path, "", { mode: 0o600 });
  }
  await appendMissing(path, KNOWN_HOSTS_SEED);
  await chmod(path, 0o600);
  if (options.refresh !== false && !refreshStarted) {
    refreshStarted = true;
    // Never blocks a clone/push: the pinned seed already covers today's keys.
    void refreshKnownHosts(keysDir).catch(() => undefined);
  }
  return path;
}
