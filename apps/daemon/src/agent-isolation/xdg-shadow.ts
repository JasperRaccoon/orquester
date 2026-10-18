/**
 * Agent isolation — an `XDG_CONFIG_HOME` shadow for a profile OpenCode server
 * (spec §6.4).
 *
 * `OPENCODE_CONFIG_DIR` is ADDITIVE: OpenCode still reads
 * `$XDG_CONFIG_HOME/opencode`. A profile server therefore runs with
 * `XDG_CONFIG_HOME=<shadow>`, a directory holding a symlink to every entry of
 * the real `~/.config` except `opencode`, so tools the agent runs (`gh`, git's
 * XDG config, …) keep working while the global OpenCode config is never read.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface XdgShadowResult {
  /** Links created or retargeted by this call. */
  linked: string[];
  /** Links removed: their real entry is gone or now excluded. */
  removed: string[];
  /** Real entries not linked because the shadow already holds a non-link entry of that name. */
  shadowed: string[];
}

/**
 * Creates or refreshes `shadowDir` (mode 0700) so it holds `<name> →
 * <realConfigHome>/<name>` for every entry of `realConfigHome` not in
 * `exclude`. Idempotent. The shadow is Orquester-owned: every SYMLINK in it
 * counts as one this function made, so a stale one (its name gone from the
 * real directory, or excluded) is removed and a wrong one retargeted, while a
 * real file or directory — one a tool created there — is left as it is.
 * Nothing is ever written under `realConfigHome`; a missing one yields a
 * shadow with no links. Throws when either path is relative or when the
 * shadow would sit inside the real directory (or the other way round).
 */
export async function buildXdgConfigShadow(options: {
  realConfigHome: string;
  shadowDir: string;
  exclude: readonly string[];
}): Promise<XdgShadowResult> {
  const { realConfigHome, shadowDir } = options;
  if (!isAbsolute(realConfigHome) || !isAbsolute(shadowDir)) {
    throw new Error("buildXdgConfigShadow needs absolute paths.");
  }
  await assertDisjoint(realConfigHome, shadowDir);
  const exclude = new Set(options.exclude);
  await mkdir(shadowDir, { recursive: true, mode: 0o700 });

  let realNames: string[] = [];
  try {
    realNames = (await readdir(realConfigHome)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const wanted = new Set(realNames.filter((name) => !exclude.has(name)));
  const result: XdgShadowResult = { linked: [], removed: [], shadowed: [] };

  // Drop stale links first.
  for (const name of (await readdir(shadowDir)).sort()) {
    const path = join(shadowDir, name);
    if ((await linkTarget(path)) === null) continue;
    if (!wanted.has(name)) {
      await unlink(path);
      result.removed.push(name);
    }
  }

  for (const name of wanted) {
    const path = join(shadowDir, name);
    const desired = join(realConfigHome, name);
    const target = await linkTarget(path);
    if (target === desired) continue;
    if (target === null && (await exists(path))) {
      result.shadowed.push(name);
      continue;
    }
    // Missing, or a link elsewhere: (re)create it through a rename (atomic replace).
    const tmp = join(shadowDir, `.${name}.link-${randomBytes(6).toString("hex")}`);
    await symlink(desired, tmp);
    try {
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    result.linked.push(name);
  }
  return result;
}

async function linkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Canonical form for the containment check: the realpath when the path exists, else the resolved path. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertDisjoint(realConfigHome: string, shadowDir: string): Promise<void> {
  const real = await canonical(realConfigHome);
  const shadow = await canonical(shadowDir);
  if (inside(shadow, real) || inside(real, shadow)) {
    throw new Error(`The XDG shadow ${shadowDir} must not overlap the real config directory ${realConfigHome}.`);
  }
}
