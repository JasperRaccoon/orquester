import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// bitbucket.org host keys as served by https://bitbucket.org/site/ssh
// (post-2023 rotation; verified 2026-08-03). ssh.bitbucket.org (the 2026
// replacement SSH host) and DC hosts are TOFU'd via StrictHostKeyChecking=
// accept-new into this same file.
export const KNOWN_HOSTS_SEED = [
  "bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
  "bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
  "bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO"
];

/**
 * Creates/seeds the daemon-owned `<keysDir>/known_hosts` (0600) with the pinned
 * bitbucket.org host keys. Idempotent: it only appends seed lines that are not
 * already present, so TOFU entries appended by ssh (`StrictHostKeyChecking=
 * accept-new`, e.g. ssh.bitbucket.org or a DC host on a non-22 port) survive.
 * Returns the file path.
 */
export async function ensureKnownHosts(keysDir: string): Promise<string> {
  const path = join(keysDir, "known_hosts");
  let existing = "";
  try { existing = await readFile(path, "utf8"); } catch { await writeFile(path, "", { mode: 0o600 }); }
  const lines = new Set(existing.split("\n"));
  const missing = KNOWN_HOSTS_SEED.filter(l => !lines.has(l));
  if (missing.length > 0) await appendFile(path, missing.map(l => l + "\n").join(""));
  await chmod(path, 0o600);
  return path;
}
