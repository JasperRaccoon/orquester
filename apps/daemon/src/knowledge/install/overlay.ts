/**
 * Orquester's myKG prompt overlay (spec "Prompt overlay"). myKG reads its
 * prompts from `<site-packages>/mykg/prompts/<step>/<name>.txt` at import
 * (`mykg/prompts.py`) and nothing in its config replaces them; its Pass 2
 * prompt is written for WWII aircraft documents. `../mykg-prompts/<line>/`
 * mirrors the package's paths with versions for saved posts, threads,
 * articles and notes. They keep myKG's output contract (JSON shapes, field
 * names, the trailing "## SOURCE TEXT" / "## SCHEMA:" headers the code appends
 * to) and change only the domain guidance and examples.
 *
 * Overlaid for 0.4: pass1/system, pass2/system, normalize/system and the four
 * schema_merge prompts. Not overlaid (no domain wording): feedback/* (generic
 * repair prompts) and orphan/* (the orphan pass is off).
 *
 * The installer copies the overlay over the package's files inside the
 * plugin's private venv only, after checking every target exists: a myKG that
 * renamed or moved a prompt fails the install instead of running with a
 * mismatched one.
 */
import { createHash } from "node:crypto";
import { copyFile, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/daemon/src/knowledge/mykg-prompts/`. */
export const MYKG_PROMPTS_ROOT = fileURLToPath(new URL("../mykg-prompts/", import.meta.url));

/** The overlay dir of a minor line ("0.4"). */
export function overlayDir(line: string, root: string = MYKG_PROMPTS_ROOT): string {
  return join(root, line);
}

/** Every overlay file of `line`, as package-relative POSIX paths ("pass2/system.txt"), sorted. */
export async function overlayFiles(line: string, root: string = MYKG_PROMPTS_ROOT): Promise<string[]> {
  const base = overlayDir(line, root);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".txt")) out.push(relative(base, path).split(sep).join("/"));
    }
  };
  await walk(base);
  return out.sort();
}

/** One sha256 over the overlay's paths and bytes: what an installed runtime records, to notice a changed overlay. */
export async function overlayDigest(line: string, root: string = MYKG_PROMPTS_ROOT): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await overlayFiles(line, root)) {
    hash.update(`${file}\0`);
    hash.update(await readFile(join(overlayDir(line, root), ...file.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Copy the overlay of `line` over `<promptsDir>/<file>`. Every target must
 * already exist as a file (throws naming the first missing one, before
 * anything is copied). Returns the files overlaid.
 */
export async function applyOverlay(line: string, promptsDir: string, root: string = MYKG_PROMPTS_ROOT): Promise<string[]> {
  const files = await overlayFiles(line, root);
  if (files.length === 0) throw new Error(`no prompt overlay for myKG ${line}`);
  for (const file of files) {
    const info = await stat(join(promptsDir, ...file.split("/"))).catch(() => null);
    if (!info?.isFile()) throw new Error(`the installed myKG has no prompts/${file} to overlay`);
  }
  for (const file of files) {
    await copyFile(join(overlayDir(line, root), ...file.split("/")), join(promptsDir, ...file.split("/")));
  }
  return files;
}

/** Whether every overlay file of `line` is in `promptsDir` with the overlay's bytes. */
export async function overlayApplied(line: string, promptsDir: string, root: string = MYKG_PROMPTS_ROOT): Promise<boolean> {
  for (const file of await overlayFiles(line, root)) {
    const [want, have] = await Promise.all([
      readFile(join(overlayDir(line, root), ...file.split("/"))),
      readFile(join(promptsDir, ...file.split("/"))).catch(() => null)
    ]);
    if (!have || !want.equals(have)) return false;
  }
  return true;
}
