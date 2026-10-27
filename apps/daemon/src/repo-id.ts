import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { repoDisplayName, repoKeyOf, stripUrlCredentials } from "./workflows/git-remote/remote-url";

/** What one read of a checkout's `.git`/config yields: its `repoId` and the raw `origin` URL. */
export interface RepoInfo {
  /** The value behind `ProjectSummary.repoId` (see `detectRepoInfo`). */
  repoId: string;
  /**
   * The `url` of `[remote "origin"]` exactly as configured. It MAY carry credentials, so it
   * never leaves the daemon as is (`remoteRepoFields` strips them). Present even when `repoId`
   * fell back to the checkout's path because the URL's authority is ambiguous.
   */
  originUrl: string | null;
}

/**
 * Best-effort identity of the git repository a project directory belongs to —
 * the value behind `ProjectSummary.repoId`, which clients use to group
 * projects that are checkouts of one repo (sibling clones, `git worktree`
 * worktrees).
 *
 * Identity precedence:
 * 1. the `origin` remote URL, normalized (`git@github.com:o/r.git`,
 *    `ssh://git@github.com/o/r.git` and `https://github.com/o/r.git` all
 *    become `github.com/o/r`) — sibling clones of one repo share it no matter
 *    where they live on disk (skipped when `normalizeGitUrl` finds the URL ambiguous);
 * 2. the realpathed root of the main checkout (a linked worktree's `gitdir:`
 *    resolves through `<repo>/.git/worktrees/<name>`) — local-only repos;
 * 3. null — not a git checkout, or unreadable: the caller omits the field and
 *    the project groups on its own.
 *
 * Reads `.git`/`config` directly instead of spawning `git` — this runs for
 * every project on every workspace listing.
 */
export async function detectRepoInfo(projectDir: string): Promise<RepoInfo | null> {
  const layout = await resolveGitLayout(projectDir);
  if (layout === null) {
    return null;
  }
  const originUrl = parseOriginUrl(await readTextOrNull(join(layout.gitDir, "config")));
  const fromUrl = originUrl === null ? null : normalizeGitUrl(originUrl);
  if (fromUrl !== null) {
    return { repoId: fromUrl, originUrl };
  }
  // No origin, or one whose authority is ambiguous: identify the repo by where it lives.
  try {
    return { repoId: await realpath(layout.root), originUrl };
  } catch {
    return { repoId: layout.root, originUrl };
  }
}

/**
 * The `ProjectSummary` remote fields for an `origin` URL: `repoKey` (`repoKeyOf`), `repoName`
 * (`repoDisplayName`) and `cloneUrl` (`stripUrlCredentials`). Null (all three omitted) when the
 * URL is no parseable remote (a local path, `file://`), or when stripping cannot prove the result
 * credential-free (a malformed userinfo with an unencoded `@`, `/`, `?` or `#`), so a secret
 * never reaches a response through any of the three.
 */
export function remoteRepoFields(
  originUrl: string
): { repoKey: string; repoName: string; cloneUrl: string } | null {
  const cloneUrl = stripUrlCredentials(originUrl.trim());
  if (!userinfoFree(cloneUrl)) {
    return null;
  }
  const repoKey = repoKeyOf(cloneUrl);
  return repoKey === null ? null : { repoKey, repoName: repoDisplayName(cloneUrl), cloneUrl };
}

/**
 * Whether a stripped URL is free of secrets: past `scheme://` no `@` may remain, except one
 * `ssh://` login (`user@`, no `:password`) inside the authority. Scp-like forms (`git@host:o/r`)
 * pass: their user is an ssh login, and `remoteUrlProblem` refuses one containing `:`.
 */
function userinfoFree(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (!scheme) {
    return true;
  }
  const rest = url.slice(scheme[0].length);
  const at = rest.indexOf("@");
  if (at === -1) {
    return true;
  }
  const authorityEnd = rest.search(/[/?#]/);
  return (
    /^(ssh|ssh\+git|git\+ssh)$/i.test(scheme[1]) &&
    rest.indexOf("@", at + 1) === -1 &&
    (authorityEnd === -1 || at < authorityEnd) &&
    !rest.slice(0, at).includes(":")
  );
}

/**
 * Where the repo's config lives (`gitDir`) and what its main checkout is
 * (`root`), for a plain checkout, a linked worktree, or any other gitfile
 * (e.g. a submodule, whose target dir carries its own config).
 */
async function resolveGitLayout(
  projectDir: string
): Promise<{ root: string; gitDir: string } | null> {
  const gitPath = join(projectDir, ".git");
  try {
    const stats = await stat(gitPath);
    if (stats.isDirectory()) {
      return { root: projectDir, gitDir: gitPath };
    }
    const target = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(gitPath, "utf8"))?.[1];
    if (!target) {
      return null;
    }
    const gitDir = isAbsolute(target) ? target : resolve(projectDir, target);
    const parts = gitDir.split(sep);
    if (
      parts.length >= 4 &&
      parts[parts.length - 3] === ".git" &&
      parts[parts.length - 2] === "worktrees"
    ) {
      const root = parts.slice(0, -3).join(sep) || sep;
      return { root, gitDir: join(root, ".git") };
    }
    return { root: projectDir, gitDir };
  } catch {
    return null;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The first `url` of `[remote "origin"]` in a git config, without spawning git. Values follow
 * git's syntax: double quotes group (and protect `#`/`;`), backslash escapes, an unquoted `#`/`;`
 * starts a comment. `insteadOf` rewrites and `pushurl` are not applied: origin `url` only.
 */
export function parseOriginUrl(config: string | null): string | null {
  if (config === null) {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      // Section names are case-insensitive; subsection names (the remote's name) are not.
      const header = /^\[\s*([A-Za-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(line);
      inOrigin = header !== null && header[1].toLowerCase() === "remote" && header[2] === "origin";
    } else if (inOrigin) {
      const raw = /^url\s*=(.*)$/i.exec(line)?.[1];
      const url = raw === undefined ? "" : parseConfigValue(raw);
      if (url) {
        return url;
      }
    }
  }
  return null;
}

/** One git config value as git reads it: quotes, escapes, comments, outer whitespace. */
function parseConfigValue(raw: string): string {
  const escapes: Record<string, string> = { n: "\n", t: "\t", b: "\b" };
  let out = "";
  let space = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      i += 1;
      out += space + (escapes[raw[i]] ?? raw[i]);
      space = "";
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && (c === "#" || c === ";")) {
      break;
    } else if (!quoted && (c === " " || c === "\t")) {
      // Whitespace inside an unquoted value survives; leading and trailing whitespace does not.
      if (out.length > 0) {
        space += c;
      }
    } else {
      out += space + c;
      space = "";
    }
  }
  return out;
}

/**
 * Collapse the URL forms git accepts for one repo onto a single key:
 * protocol and `user@` are dropped, the host is lowercased, the scp-like
 * `host:path` colon becomes a slash, and a trailing `.git`/slash is stripped.
 * The path keeps its case — hosts differ on sensitivity, and a consistent key
 * is all grouping needs.
 *
 * Null for a `scheme://` URL whose authority is ambiguous — an `@` still left after the userinfo
 * is dropped (e.g. a password holding an unencoded `/`: `https://u:p/ss@host/o/r`) — since any
 * key derived from it could carry part of a secret.
 */
export function normalizeGitUrl(url: string): string | null {
  let rest = url.trim();
  const protocol = /^[a-z+]+:\/\//i.exec(rest);
  if (protocol) {
    rest = rest.slice(protocol[0].length);
  } else {
    const scp = /^(?:[^/@]+@)?([^/:]+):(.*)$/.exec(rest);
    if (scp) {
      rest = `${scp[1]}/${scp[2]}`;
    }
  }
  // Through the LAST `@` before the path, so a password holding an unencoded `@` cannot survive.
  rest = rest.replace(/^[^/]*@/, "");
  if (protocol && rest.includes("@")) {
    return null;
  }
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = (slash === -1 ? "" : rest.slice(slash)).replace(/\/+$/, "").replace(/\.git$/i, "");
  return host + path;
}
