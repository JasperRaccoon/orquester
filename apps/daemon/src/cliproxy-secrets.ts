import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type CliProxySecrets, cliproxySecretsFile, parseCliProxySecrets } from "@orquester/config";

export type LoadSecretsResult =
  | { state: "loaded" | "created"; secrets: CliProxySecrets }
  | { state: "corrupt" };

/**
 * Write `content` to `file` at `mode`, atomically and refusing to be redirected
 * through a symlinked target. The parent dir is realpath-canonicalized (a
 * symlinked ancestor can't relocate the write) and the final path is rebuilt
 * from the real parent + basename; if that path is itself a symlink we refuse
 * rather than following it — secrets must never be written through a link.
 */
async function writeSecretFile(file: string, content: string, mode: number): Promise<void> {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  const target = join(realParent, basename(file));
  let st: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    st = await lstat(target);
  } catch {
    st = null; // new file — fine
  }
  if (st?.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked target: ${file}`);
  }
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode });
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function generateSecrets(): CliProxySecrets {
  return {
    apiKey: randomBytes(24).toString("hex"),
    managementSecret: randomBytes(24).toString("hex"),
    openRouterKey: null
  };
}

/**
 * Load the authoritative secret store from `<daemonDir>/cliproxy/secrets.json`.
 *
 * - Missing file → generate a fresh store and persist it 0600 (`state: "created"`).
 * - Present + valid → `state: "loaded"`.
 * - Present + unparseable/invalid → `state: "corrupt"`, and **nothing is touched**.
 *   A corrupt file must never be regenerated: doing so would orphan a live proxy
 *   (and every session) keyed on the old secret (spec §1).
 */
export async function loadOrInitSecrets(daemonDir: string): Promise<LoadSecretsResult> {
  const file = cliproxySecretsFile(daemonDir);
  let raw: string | null = null;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    raw = null; // missing → generate below
  }
  if (raw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { state: "corrupt" };
    }
    const parsed = parseCliProxySecrets(value);
    if (parsed === "corrupt") {
      return { state: "corrupt" };
    }
    return { state: "loaded", secrets: parsed };
  }
  const secrets = generateSecrets();
  await writeSecretFile(file, JSON.stringify(secrets, null, 2), 0o600);
  return { state: "created", secrets };
}

/**
 * Set (or clear) the OpenRouter key, preserving the local API key and management
 * secret, and rewrite `secrets.json` with the same hardening. A corrupt store
 * throws — callers must not silently regenerate over it.
 */
export async function setOpenRouterKey(daemonDir: string, key: string): Promise<CliProxySecrets> {
  const loaded = await loadOrInitSecrets(daemonDir);
  if (loaded.state === "corrupt") {
    throw new Error("cliproxy secrets are corrupt; refusing to overwrite");
  }
  const next: CliProxySecrets = { ...loaded.secrets, openRouterKey: key };
  await writeSecretFile(cliproxySecretsFile(daemonDir), JSON.stringify(next, null, 2), 0o600);
  return next;
}
