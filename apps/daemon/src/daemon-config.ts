/**
 * daemon.json at boot: the one file the daemon cannot start without.
 *
 * - Boot writes it only when its content changes (first run, a plaintext
 *   password to hash): a host whose env carries the HTTP password must not
 *   rewrite it on every restart.
 * - Every write is temp + fsync + rename, so a full disk or a power cut leaves
 *   the previous file, never an empty one.
 * - Every good boot keeps a copy beside it (`daemon.json.last-good`). A boot
 *   that finds daemon.json unreadable or missing moves the bad file aside and
 *   restores that copy instead of crash-looping.
 */

import { readFile, rename } from "node:fs/promises";
import bcrypt from "bcryptjs";
import {
  createDefaultDaemonConfig,
  parseDaemonConfig,
  type DaemonConfig,
  type DaemonPaths
} from "@orquester/config";
import { writeFileAtomic } from "./agent-hooks.ts";

export function lastGoodDaemonConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

/** bcrypt-hash a plaintext password (stable hash persisted at rest). Cost 12
 *  slows offline cracking / per-guess derivation if a hash ever leaks; the
 *  expensive hash runs only at password-set and client-side login, so
 *  per-request auth stays cheap. */
export function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, bcrypt.genSaltSync(12));
}

/**
 * Migrate a legacy/env plaintext `password` into a bcrypt `passwordHash` and
 * drop the plaintext.
 */
export function migrateHttpPassword(config: DaemonConfig): void {
  const http = config.transports.http;
  if (http.password) {
    if (!http.passwordHash) {
      http.passwordHash = hashPassword(http.password);
    }
    http.password = undefined;
  }
}

export async function loadDaemonConfig(paths: DaemonPaths, env: NodeJS.ProcessEnv): Promise<DaemonConfig> {
  const defaults = createDefaultDaemonConfig({ env });
  const lastGood = lastGoodDaemonConfigPath(paths.configPath);
  const raw = await readTextOrNull(paths.configPath);

  let onDisk: string | null = raw;
  let config: DaemonConfig;
  if (raw === null) {
    const restored = await readLastGood(lastGood, defaults);
    if (restored) {
      console.error(`daemon.json is missing; restoring ${lastGood}.`);
    }
    config = restored ?? defaults;
  } else {
    try {
      config = parseFromDisk(raw, defaults);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const restored = await readLastGood(lastGood, defaults);
      if (!restored) {
        throw new Error(`daemon.json is unreadable (${reason}) and ${lastGood} is missing or unreadable; fix daemon.json by hand.`);
      }
      const aside = `${paths.configPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(paths.configPath, aside).then(
        () => console.error(`daemon.json is unreadable (${reason}); moved it to ${aside} and restored ${lastGood}.`),
        (moveError: unknown) => console.error(`daemon.json is unreadable (${reason}); restoring ${lastGood} over it (could not move it aside: ${String(moveError)}).`)
      );
      onDisk = null;
      config = restored;
    }
  }

  migrateHttpPassword(config);
  const text = serialize(config);
  if (text !== onDisk) {
    // Not fatal: the daemon runs on the config in memory, and the previous
    // file (or the last-good copy) is still there for the next boot.
    await writeFileAtomic(paths.configPath, text, 0o600, true, { durable: true }).catch((error: unknown) => {
      console.error(`Failed to write daemon.json; running on the config in memory: ${String(error)}`);
    });
  }
  if ((await readTextOrNull(lastGood).catch(() => null)) !== text) {
    await writeFileAtomic(lastGood, text, 0o600, false, { durable: true }).catch((error: unknown) => {
      console.warn(`Failed to refresh ${lastGood}: ${String(error)}`);
    });
  }
  return config;
}

function parseFromDisk(raw: string, defaults: DaemonConfig): DaemonConfig {
  const fromDisk = JSON.parse(raw) as Partial<DaemonConfig>;
  return parseDaemonConfig({
    ...defaults,
    ...fromDisk,
    transports: {
      http: { ...defaults.transports.http, ...fromDisk.transports?.http }
    }
  });
}

async function readLastGood(path: string, defaults: DaemonConfig): Promise<DaemonConfig | null> {
  try {
    const raw = await readTextOrNull(path);
    return raw === null ? null : parseFromDisk(raw, defaults);
  } catch {
    return null;
  }
}

function serialize(config: DaemonConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
