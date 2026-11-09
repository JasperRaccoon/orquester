/**
 * Writing a generated image into the caller's project (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §7.2–7.4).
 *
 * - **Where:** `save_as` (a project-relative file, or a folder ending in `/`) wins over the
 *   plugin's `saveTo`; a folder gets a prompt slug name (`dog-in-snow.png`).
 * - **Never overwrite:** a taken name becomes `name-v2.png`, `name-v3.png`, … Each file is created
 *   with `O_CREAT|O_EXCL`, so two concurrent calls never claim one name and an existing symlink is
 *   never followed.
 * - **Containment:** every folder on the way is checked after realpath to stay inside the project's
 *   real path, itself inside the workspaces root; a folder is created only after its parent passed.
 * - A chat with no project, or in a box, gets no project file: {@link plannedSave} says why.
 */

import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { GPT_IMAGE_DEFAULT_PROJECT_FOLDER, type GptImageSaveTo } from "@orquester/api";

import { GptImageError } from "./errors.ts";

const SLUG_MAX_CHARS = 40;
const SAVE_AS_MAX_LENGTH = 1024;
/** `-v2` … `-v999`: past that the folder is not a place to keep adding to. */
const MAX_VERSIONS = 999;

/** An ASCII slug of the prompt, at most ~40 characters, cut at a word boundary; `image` when nothing is left. */
export function promptSlug(prompt: string): string {
  const words = prompt
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX_CHARS) {
      if (!slug) slug = word.slice(0, SLUG_MAX_CHARS);
      break;
    }
    slug = next;
  }
  return slug || "image";
}

/** `dir` is `parent` or inside it (both already resolved). */
function within(dir: string, parent: string): boolean {
  const rel = relative(parent, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type PlannedSave = { kind: "chat"; reason?: string } | { kind: "project"; projectPath: string; target: string };

const NOT_ALLOWED = (what: string) => new GptImageError("INVALID_ARGUMENT", `save_as: ${what}`);

/**
 * Where this call's image goes besides the chat. `target` is project-relative: a file, or a folder
 * ending in `/`. An explicit `save_as` that leaves the project is refused here, before anything is
 * generated.
 */
export function plannedSave(input: { saveAs?: string; setting: GptImageSaveTo; projectPath: string; inBox: boolean }): PlannedSave {
  const wanted = input.saveAs !== undefined || input.setting.kind === "project";
  if (!wanted) return { kind: "chat" };
  if (input.projectPath === "") return { kind: "chat", reason: "This chat has no project, so the image is kept with the chat only." };
  if (input.inBox) return { kind: "chat", reason: "This chat runs in a box, so the image is kept with the chat only; it is not written into the box's project." };
  if (input.saveAs === undefined) {
    const folder = input.setting.kind === "project" ? input.setting.folder || GPT_IMAGE_DEFAULT_PROJECT_FOLDER : GPT_IMAGE_DEFAULT_PROJECT_FOLDER;
    return { kind: "project", projectPath: input.projectPath, target: `${folder.replace(/\/+$/, "")}/` };
  }
  const raw = input.saveAs.trim();
  // eslint-disable-next-line no-control-regex
  if (raw === "" || raw.length > SAVE_AS_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) throw NOT_ALLOWED("give a project-relative path, e.g. assets/logo.png or assets/.");
  const folder = raw.endsWith("/");
  const root = resolve(input.projectPath);
  const rel = relative(root, resolve(root, raw));
  if (rel.startsWith("..") || isAbsolute(rel)) throw NOT_ALLOWED("path is not allowed: it must be inside this chat's project.");
  if (rel === "") {
    if (!folder) throw NOT_ALLOWED("give a file name or a folder ending in /.");
    return { kind: "project", projectPath: input.projectPath, target: "./" };
  }
  return { kind: "project", projectPath: input.projectPath, target: folder ? `${rel.split(sep).join("/")}/` : rel.split(sep).join("/") };
}

/**
 * The real folder `relDir` names inside the project, created as needed. Each existing step must
 * resolve inside the project's real path; a missing one is created inside the checked parent.
 */
async function containedFolder(realProject: string, relDir: string): Promise<string> {
  let current = realProject;
  for (const segment of relDir.split("/").filter((part) => part !== "" && part !== ".")) {
    const next = join(current, segment);
    const stats = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats === null) {
      await mkdir(next).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const real = await realpath(next);
    if (!within(real, realProject)) throw NOT_ALLOWED("path is not allowed: it leads outside this chat's project.");
    if (!(await lstat(real)).isDirectory()) throw NOT_ALLOWED(`${segment} is a file, not a folder.`);
    current = real;
  }
  return current;
}

/**
 * Write `bytes` at `target` (from {@link plannedSave}) without overwriting anything. Answers the path
 * as the project spells it and the project-relative one.
 */
export async function saveIntoProject(input: {
  fsRoot: string;
  projectPath: string;
  target: string;
  prompt: string;
  bytes: Buffer;
  /** The image's own extension, with the dot (`.png`). */
  ext: string;
}): Promise<{ path: string; relativePath: string }> {
  const realRoot = await realpath(input.fsRoot);
  const realProject = await realpath(input.projectPath);
  if (!within(realProject, realRoot)) throw NOT_ALLOWED("path is not allowed: this chat's project is outside the workspaces folder.");
  const folderTarget = input.target.endsWith("/");
  const relDir = folderTarget ? input.target.slice(0, -1) : input.target.split("/").slice(0, -1).join("/");
  let base = folderTarget ? promptSlug(input.prompt) : input.target.split("/").at(-1)!;
  // The bytes decide the extension: `icon.jpg` for a PNG becomes `icon.png`.
  const given = extname(base);
  if (given) base = base.slice(0, -given.length) || promptSlug(input.prompt);
  const dir = await containedFolder(realProject, relDir);
  for (let version = 1; version <= MAX_VERSIONS; version += 1) {
    const name = version === 1 ? `${base}${input.ext}` : `${base}-v${version}${input.ext}`;
    const file = join(dir, name);
    let handle;
    try {
      handle = await open(file, "wx", 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(input.bytes);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(file).catch(() => undefined);
      throw error;
    }
    await handle.close();
    const relativePath = [relDir, name].filter((part) => part !== "" && part !== ".").join("/");
    return { path: join(input.projectPath, relativePath), relativePath };
  }
  throw NOT_ALLOWED(`every name from ${base}${input.ext} to ${base}-v${MAX_VERSIONS}${input.ext} is taken; pass another save_as.`);
}
