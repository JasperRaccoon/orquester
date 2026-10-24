import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Temp files are hidden and end in `.tmp`, so neither the store nor myKG (`*.md`) ever reads one. */
export const TMP_SUFFIX = ".tmp";

/** Write `content` to a hidden temp file beside `path`, then rename it over `path`. */
export async function writeFileAtomic(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`);
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The file's text, or null when it does not exist. */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function isTempName(name: string): boolean {
  return name.startsWith(".") && name.endsWith(TMP_SUFFIX);
}
