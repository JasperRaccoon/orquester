import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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
 *    where they live on disk;
 * 2. the realpathed root of the main checkout (a linked worktree's `gitdir:`
 *    resolves through `<repo>/.git/worktrees/<name>`) — local-only repos;
 * 3. null — not a git checkout, or unreadable: the caller omits the field and
 *    the project groups on its own.
 *
 * Reads `.git`/`config` directly instead of spawning `git` — this runs for
 * every project on every workspace listing.
 */
export async function detectRepoId(projectDir: string): Promise<string | null> {
  const layout = await resolveGitLayout(projectDir);
  if (layout === null) {
    return null;
  }
  const origin = parseOriginUrl(await readTextOrNull(join(layout.gitDir, "config")));
  if (origin !== null) {
    return normalizeGitUrl(origin);
  }
  try {
    return await realpath(layout.root);
  } catch {
    return layout.root;
  }
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

/** The `url` of `[remote "origin"]` from a git config, without spawning git. */
function parseOriginUrl(config: string | null): string | null {
  if (config === null) {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
    } else if (inOrigin) {
      const url = /^url\s*=\s*(.+)$/.exec(line)?.[1];
      if (url) {
        return url.trim();
      }
    }
  }
  return null;
}

/**
 * Collapse the URL forms git accepts for one repo onto a single key:
 * protocol and `user@` are dropped, the host is lowercased, the scp-like
 * `host:path` colon becomes a slash, and a trailing `.git`/slash is stripped.
 * The path keeps its case — hosts differ on sensitivity, and a consistent key
 * is all grouping needs.
 */
function normalizeGitUrl(url: string): string {
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
  rest = rest.replace(/^[^/@]+@/, "");
  const slash = rest.indexOf("/");
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = (slash === -1 ? "" : rest.slice(slash)).replace(/\/+$/, "").replace(/\.git$/i, "");
  return host + path;
}
