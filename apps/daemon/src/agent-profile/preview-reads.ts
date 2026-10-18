/**
 * The filesystem half of the approval-card reads (`@orquester/api` agent-profile.ts): a directory's files in full
 * with their SHA-256 and flags, a git checkout's commit, and what a plugin directory ships.
 *
 * - Symlinks inside a tree are never followed: listed with their target text, flagged.
 * - A file is `text` when it is valid UTF-8 without NUL; `executable` when it has an exec bit,
 *   starts with `#!`, or carries ELF / Mach-O / PE magic (its text, if any, is still shown);
 *   anything else is `binary` (listed with size and hash only).
 * - Caps: {@link PREVIEW_TREE_MAX_FILES} files and {@link PREVIEW_TREE_MAX_BYTES} bytes of text;
 *   past either the tree is `complete: false` and the card refuses (`PREVIEW_TOO_LARGE`) rather
 *   than show part of it. `.git` is skipped.
 */

import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProfilePluginHook, ProfilePluginMcpServer, ProfilePluginPreviewResponse, ProfilePreviewFile, ProfilePreviewTree } from "@orquester/api";

export const PREVIEW_TREE_MAX_FILES = 2_000;
/** Above the card's 1 MiB full-preview cap: a tree this large could never be shown anyway. */
export const PREVIEW_TREE_MAX_BYTES = 2 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExecutableMagic(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true; // #!
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true; // ELF
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true; // Mach-O, fat
  }
  return bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a; // MZ (PE)
}

/** One regular file as a preview shows it. */
export async function previewFile(path: string, rel: string, mode: number, budget: { bytes: number }): Promise<ProfilePreviewFile | null> {
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const st = await handle.stat();
    if (st.size > budget.bytes) return null;
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  budget.bytes -= bytes.length;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let text: string | undefined;
  try {
    const decoded = decoder.decode(bytes);
    if (!decoded.includes("\0")) text = decoded;
  } catch {
    text = undefined;
  }
  const executable = (mode & 0o111) !== 0 || hasExecutableMagic(bytes);
  const flag = executable ? "executable" : text === undefined ? "binary" : undefined;
  return { path: rel, size: bytes.length, sha256, ...(flag ? { flag } : {}), ...(text !== undefined ? { text } : {}) };
}

/**
 * Every file under `root` (a directory, or one file), sorted by path. `root` itself may be a
 * symlink (a shared skills dir); nothing below it is followed.
 */
export async function readPreviewTree(root: string): Promise<ProfilePreviewTree> {
  const base = await realpath(root);
  const top = await lstat(base);
  const budget = { bytes: PREVIEW_TREE_MAX_BYTES };
  if (top.isFile()) {
    const name = base.split(sep).pop() ?? "file";
    const file = await previewFile(base, name, top.mode, budget);
    return file ? { files: [file], complete: true } : { files: [], complete: false };
  }
  const files: ProfilePreviewFile[] = [];
  const stack: string[] = [base];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const rel = relative(base, path).split(sep).join("/");
      if (files.length >= PREVIEW_TREE_MAX_FILES) return { files, complete: false };
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        files.push({ path: rel, size: Buffer.byteLength(target), sha256: createHash("sha256").update(target).digest("hex"), flag: "symlink", target });
      } else if (entry.isFile()) {
        const file = await previewFile(path, rel, (await lstat(path)).mode, budget);
        if (file === null) return { files, complete: false };
        files.push(file);
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, complete: true };
}

/** A stable digest of a tree (paths, hashes, flags): what a pin compares. */
export function treeDigest(tree: ProfilePreviewTree): string {
  const hash = createHash("sha256");
  for (const file of tree.files) hash.update(`${file.path}\0${file.sha256}\0${file.flag ?? ""}\n`);
  hash.update(tree.complete ? "complete" : "partial");
  return hash.digest("hex");
}

/**
 * The commit a git checkout is at, read from `.git` without running git (a worktree's `.git`
 * file, a symbolic `HEAD`, loose and packed refs); null when `dir` is not a checkout.
 */
export async function readGitCommit(dir: string): Promise<string | null> {
  try {
    let gitDir = join(dir, ".git");
    const st = await lstat(gitDir);
    if (st.isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(gitDir, "utf8"));
      if (!pointer) return null;
      gitDir = isAbsolute(pointer[1]!) ? pointer[1]! : resolve(dir, pointer[1]!);
    }
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return null;
    const commonDir = await readFile(join(gitDir, "commondir"), "utf8").then((text) => resolve(gitDir, text.trim()), () => gitDir);
    for (const root of [gitDir, commonDir]) {
      try {
        const loose = (await readFile(join(root, ref), "utf8")).trim();
        if (/^[0-9a-f]{40,64}$/.test(loose)) return loose;
      } catch {
        // Not a loose ref here.
      }
      try {
        const packed = await readFile(join(root, "packed-refs"), "utf8");
        for (const line of packed.split("\n")) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
        }
      } catch {
        // No packed refs here.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** `path` resolved inside `root` (no `..` escape), else null. */
export function insideOrNull(root: string, path: string): string | null {
  const full = resolve(root, path);
  return full === root || full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) ? full : null;
}

/** `./hooks/x.json` / `${CLAUDE_PLUGIN_ROOT}/hooks/x.json` → `hooks/x.json` (the tree's paths). */
function normalisePluginPath(path: string): string {
  return path.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, "").replace(/^(\.\/)+/, "").replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// What a plugin directory ships
// ---------------------------------------------------------------------------

function textOf(tree: ProfilePreviewTree, path: string): string | undefined {
  return tree.files.find((file) => file.path === path)?.text;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hooksOf(doc: unknown): ProfilePluginHook[] {
  const hooks = isRecord(doc) && isRecord(doc.hooks) ? doc.hooks : isRecord(doc) ? doc : null;
  if (hooks === null) return [];
  const out: ProfilePluginHook[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const handlers = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const handler of handlers) {
        if (isRecord(handler) && typeof handler.command === "string") {
          out.push({ event, ...(typeof group.matcher === "string" && group.matcher !== "" ? { matcher: group.matcher } : {}), command: handler.command });
        }
      }
    }
  }
  return out;
}

function mcpServersOf(map: unknown): ProfilePluginMcpServer[] {
  const servers = isRecord(map) && isRecord(map.mcpServers) ? map.mcpServers : map;
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, def]) => {
    if (!isRecord(def)) return [];
    const keys = (value: unknown) => (isRecord(value) ? Object.keys(value) : []);
    return [{
      name,
      ...(typeof def.command === "string" ? { command: def.command } : {}),
      ...(Array.isArray(def.args) ? { args: def.args.map(String) } : {}),
      ...(typeof def.url === "string" ? { url: def.url } : {}),
      envKeys: keys(def.env),
      headerKeys: keys(def.headers)
    }];
  });
}

/**
 * What a plugin ships, from its files (Claude's layout, which Codex and Grok plugins share):
 * `skills/<n>/SKILL.md`, `commands/**.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, and the
 * manifest's `hooks` / `mcpServers` — inline objects, or path strings (one or a list) naming files
 * inside the plugin. Every file is listed in the tree anyway; this is the summary the card leads with.
 */
export function pluginProvidesOf(tree: ProfilePreviewTree): ProfilePluginPreviewResponse["provides"] {
  const manifest = parseJson(textOf(tree, ".claude-plugin/plugin.json") ?? textOf(tree, ".codex-plugin/plugin.json"));
  const skills = new Set<string>();
  const commands: string[] = [];
  const agents: string[] = [];
  for (const file of tree.files) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/i.exec(file.path);
    if (skill) skills.add(skill[1]!);
    else if (/^commands\/.+\.md$/i.test(file.path)) commands.push(file.path.slice("commands/".length, -3));
    else if (/^agents\/[^/]+\.md$/i.test(file.path)) agents.push(file.path.slice("agents/".length, -3));
  }
  // A manifest field is an inline object, or a path (or list of paths) to a JSON file in the plugin.
  const declared = (value: unknown, defaultPath: string): unknown[] => {
    const docs: unknown[] = [];
    const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    if (!paths.includes(defaultPath) && !paths.some((path) => normalisePluginPath(path) === defaultPath)) docs.push(parseJson(textOf(tree, defaultPath)));
    for (const path of paths) docs.push(parseJson(textOf(tree, normalisePluginPath(path))));
    if (isRecord(value)) docs.push(value);
    return docs;
  };
  const hookDocs = declared(isRecord(manifest) ? manifest.hooks : undefined, "hooks/hooks.json");
  const hooks = hookDocs.flatMap((doc) => hooksOf(doc));
  const servers = new Map<string, ProfilePluginMcpServer>();
  for (const doc of declared(isRecord(manifest) ? manifest.mcpServers : undefined, ".mcp.json")) {
    for (const server of mcpServersOf(doc)) servers.set(server.name, server);
  }
  return { skills: [...skills].sort(), commands: commands.sort(), agents: agents.sort(), hooks, mcpServers: [...servers.values()] };
}

/** A directory that is itself a plugin's root (it holds a manifest). */
async function isPluginRoot(dir: string): Promise<boolean> {
  for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    try {
      if ((await lstat(join(dir, manifest))).isFile()) return true;
    } catch {
      // Not this layout.
    }
  }
  return false;
}

/**
 * The plugin cache a plugin directory lives in — the `…/plugins/cache` ancestor both Claude
 * (`plugins/cache/<mkt>/<name>/<version>`) and Codex (`plugins/cache/<mkt>/<name>`) use — else the
 * directory itself. A symlinked version directory is followed only into it.
 */
function pluginCacheRoot(dir: string): string {
  const parts = dir.split(sep);
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (parts[i] === "cache" && parts[i - 1] === "plugins") return parts.slice(0, i + 1).join(sep) || sep;
  }
  return dir;
}

function insideDir(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Why a path cannot be read, in words: ENOENT is "cache missing"; anything else names its code. */
function unreadableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "contents not readable (cache missing)";
  return `contents not readable (${code ?? (error instanceof Error ? error.message : "unknown error")})`;
}

/**
 * An installed plugin's files and what it ships. `path` is the plugin's install directory as the
 * agent reports it: a plugin root (Claude's versioned `installPath`), or — Codex — the unversioned
 * `plugins/cache/<marketplace>/<name>` whose children are its installed versions. Then the version
 * the agent reports is read, else the only child, else every child (each under `<version>/`).
 * A version directory that is a symlink is followed only when its realpath stays inside the
 * plugin cache. Nothing here throws for an unreadable plugin: a missing cache, a permission error
 * or a symlink leading out is `unreadable` (empty files) — enabling such a plugin still cards.
 */
export async function readInstalledPlugin(
  path: string,
  version: string | undefined
): Promise<{ tree: ProfilePreviewTree; provides: ProfilePluginPreviewResponse["provides"]; unreadable?: string }> {
  const empty = { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] };
  const unreadable = (reason: string) => ({ tree: { files: [], complete: true }, provides: empty, unreadable: reason });
  try {
    const real = await realpath(path);
    if (!(await lstat(real)).isDirectory()) return unreadable("contents not readable (cache missing)");
    if (await isPluginRoot(real)) {
      const tree = await readPreviewTree(real);
      return { tree, provides: pluginProvidesOf(tree) };
    }
    // The cache root as the agent names it (`…/plugins/cache` on the unresolved path), then
    // resolved: an account home that reaches the cache through a symlink still finds its own
    // sibling versions inside it.
    const cacheRoot = await realpath(pluginCacheRoot(resolve(path))).catch(() => real);
    // Version directories, and symlinks to one that stay inside the plugin cache.
    const children = new Map<string, string>();
    for (const entry of await readdir(real, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) children.set(entry.name, join(real, entry.name));
      else if (entry.isSymbolicLink()) {
        const target = await realpath(join(real, entry.name)).catch(() => null);
        if (target === null || !(await lstat(target)).isDirectory()) continue;
        if (!insideDir(cacheRoot, target)) return unreadable(`contents not readable (the version directory "${entry.name}" leads outside the plugin cache)`);
        children.set(entry.name, target);
      }
    }
    const names = [...children.keys()].sort();
    // The version the agent reports, else every child there is (one, usually).
    const chosen = version !== undefined && children.has(version) ? [version] : names;
    if (chosen.length === 0) return unreadable("contents not readable (cache empty)");
    if (chosen.length === 1) {
      const tree = await readPreviewTree(children.get(chosen[0]!)!);
      return { tree, provides: pluginProvidesOf(tree) };
    }
    return await readVersions(children, chosen);
  } catch (error) {
    return unreadable(unreadableReason(error));
  }
}

/**
 * The ONE directory holding an installed plugin's files (Agent Profiles copy it into a profile):
 * `path` itself when it is a plugin root or has no version directories, else — Codex's unversioned
 * `plugins/cache/<marketplace>/<name>` — the version the agent reports, else its only version.
 * A realpath; a version reached through a symlink must stay inside the plugin cache. Throws an
 * `Error` saying why there is no single directory.
 */
export async function installedPluginRoot(path: string, version: string | undefined): Promise<string> {
  const real = await realpath(path);
  if (!(await lstat(real)).isDirectory() || (await isPluginRoot(real))) return real;
  // Only an agent's plugin cache (`…/plugins/cache/…`) holds version directories.
  if (pluginCacheRoot(resolve(path)) === resolve(path)) return real;
  const cacheRoot = await realpath(pluginCacheRoot(resolve(path))).catch(() => real);
  const children = new Map<string, string>();
  for (const entry of await readdir(real, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) children.set(entry.name, join(real, entry.name));
    else if (entry.isSymbolicLink()) {
      const target = await realpath(join(real, entry.name)).catch(() => null);
      if (target !== null && (await lstat(target)).isDirectory() && insideDir(cacheRoot, target)) children.set(entry.name, target);
    }
  }
  if (version !== undefined && children.has(version)) return children.get(version)!;
  const versions = [...children.values()];
  if (versions.length === 1) return versions[0]!;
  if (versions.length === 0) return real;
  throw new Error(`it has ${versions.length} installed versions and none is reported`);
}

/** Several versions and none reported: every one, each under `<version>/`. */
async function readVersions(
  children: ReadonlyMap<string, string>,
  chosen: readonly string[]
): Promise<{ tree: ProfilePreviewTree; provides: ProfilePluginPreviewResponse["provides"] }> {
  const files: ProfilePreviewFile[] = [];
  let complete = true;
  const provides: ProfilePluginPreviewResponse["provides"] = { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] };
  for (const child of chosen) {
    const tree = await readPreviewTree(children.get(child)!);
    complete &&= tree.complete;
    files.push(...tree.files.map((file) => ({ ...file, path: `${child}/${file.path}` })));
    const own = pluginProvidesOf(tree);
    provides.skills.push(...own.skills.filter((name) => !provides.skills.includes(name)));
    provides.commands.push(...own.commands.filter((name) => !provides.commands.includes(name)));
    provides.agents.push(...own.agents.filter((name) => !provides.agents.includes(name)));
    provides.hooks.push(...own.hooks);
    // Each distinct definition is kept: two versions may run different command lines under one name.
    provides.mcpServers.push(...own.mcpServers.filter((server) => !provides.mcpServers.some((known) => JSON.stringify(known) === JSON.stringify(server))));
  }
  return { tree: { files, complete }, provides };
}
