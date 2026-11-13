// The storage action guard (design §4): which scanned paths the Storage view may
// delete, rename or download. Separate from the /api/fs `fsRoot` sandbox — storage
// actions reach the whole host — so it refuses, with a reason the UI shows:
//
// - delete/rename: the root, every direct child of it, every mount point, the
//   daemon's and client's state (`<appdir>/daemon`, `<appdir>/app`), the running checkout, the workspaces root
//   and fsRoot themselves, the host tool dirs, the service user's tool/credential
//   dirs in its home (and the appdir), and every ancestor of any of those;
// - download: the secrets (daemon state incl. agent-account homes, ssh keys, agent
//   CLI credentials, /etc/orquester…) and every folder that contains one, since its
//   zip would carry the secret along.
//
// `actionsFor` / `projectFor` are pure string logic on canonical paths (the scan's
// paths are canonical; every configured path is realpath'd once here). `check`
// is what the action routes call: it resolves the request's path against the
// real filesystem first, so a symlinked parent is judged where it really points.

import { readFileSync, realpathSync, type Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { StorageNodeActions } from "@orquester/api";
import { appConfigDir, daemonConfigDir } from "@orquester/config";

import type { StorageGuardPort } from "./types.ts";

export interface StorageGuardConfig {
  /** "/" in production; a temp dir in tests. */
  rootDir: string;
  /** Every mount point (bind mounts included), e.g. {@link readMountPoints}. Called per evaluation; keep it cheap. */
  mountPoints: () => string[];
  appdir: string;
  /** The service user's home (on a deployed host the same dir as the appdir). */
  homeDir: string;
  workspacesDir: string;
  fsRoot: string;
  /** Repo root of the running daemon. */
  daemonCheckoutDir: string;
  /** Host tool install dirs (e.g. /opt/orquester-tools, the resolved gdu binary's dir). */
  toolDirs: string[];
  /** Extra secret dirs/files refused for download (and protected), e.g. /etc/orquester. */
  secretPaths?: string[];
}

export type StorageAction = "delete" | "rename" | "download";

export type StorageGuardCheck =
  | {
      ok: true;
      /** Canonical path to act on (delete/rename: the entry itself, a final symlink not followed; download: the real target). */
      path: string;
      /** lstat (delete/rename) or stat (download) of `path`. */
      stats: Stats;
      actions: StorageNodeActions;
    }
  | { ok: false; status: 403 | 404; code: "STORAGE_FORBIDDEN" | "STORAGE_PATH_NOT_FOUND"; message: string };

export interface StorageGuard extends StorageGuardPort {
  /**
   * Resolve `rawPath` on the real filesystem and judge it for `action`. Missing →
   * 404; refused → 403 with the reason. Throws on other OS errors (EACCES…).
   */
  check(action: StorageAction, rawPath: string): Promise<StorageGuardCheck>;
}

/** The service's own entries in its home (and appdir) that delete/rename refuse. */
const HOME_PROTECTED = [
  "bin",
  "tmp",
  ".local",
  ".npm-global",
  ".claude",
  ".claude.json",
  ".codex",
  ".grok",
  ".config",
  ".ssh",
  ".docker"
];
/** The entries in the home (and appdir) that hold credentials: download refuses them. */
const HOME_SECRETS = [
  ".ssh",
  ".claude",
  ".claude.json",
  ".codex",
  ".grok",
  ".config", // gh, gcloud… tokens
  ".docker", // registry auth
  ".gnupg",
  ".aws",
  ".kube",
  ".netrc",
  ".npmrc",
  ".git-credentials"
];

interface Rule {
  path: string;
  /** "subtree": the path and everything inside it; "exact": only the path. */
  scope: "subtree" | "exact";
  label: string;
}

/** Mount-point list freshness for `actionsFor` (the tree annotates hundreds of nodes per response). */
const MOUNTS_TTL_MS = 5_000;

export function createStorageGuard(config: StorageGuardConfig): StorageGuard {
  const rootDir = canonical(config.rootDir);
  const workspacesDir = canonical(config.workspacesDir);
  const homes = unique([canonical(config.appdir), canonical(config.homeDir)]);

  const protectedRules: Rule[] = [];
  const secretRules: Rule[] = [];
  const add = (rules: Rule[], path: string, scope: Rule["scope"], label: string): void => {
    for (const form of pathForms(path)) rules.push({ path: form, scope, label });
  };

  add(protectedRules, daemonConfigDir(config.appdir), "subtree", "Orquester's daemon state");
  add(protectedRules, appConfigDir(config.appdir), "subtree", "Orquester's client config");
  add(protectedRules, config.daemonCheckoutDir, "subtree", "the running Orquester daemon's checkout");
  add(protectedRules, config.workspacesDir, "exact", "the workspaces root");
  add(protectedRules, config.fsRoot, "exact", "the file browser's root");
  for (const dir of config.toolDirs) add(protectedRules, dir, "subtree", "Orquester's host tools");
  for (const home of homes) {
    for (const name of HOME_PROTECTED) {
      add(protectedRules, join(home, name), "subtree", `${name}, which the Orquester service needs for chats, tools or git`);
    }
  }

  add(secretRules, daemonConfigDir(config.appdir), "subtree", "Orquester's daemon state (keys, sessions, agent accounts)");
  add(secretRules, appConfigDir(config.appdir), "subtree", "Orquester's client config (remote connection passwords)");
  for (const home of homes) {
    for (const name of HOME_SECRETS) add(secretRules, join(home, name), "subtree", `${name} (credentials)`);
  }
  for (const path of config.secretPaths ?? []) {
    add(secretRules, path, "subtree", "credentials");
    add(protectedRules, path, "subtree", "Orquester's host configuration");
  }

  let mounts: { at: number; set: Set<string> } | null = null;
  const mountSet = (fresh: boolean): Set<string> => {
    const now = Date.now();
    if (fresh || !mounts || now - mounts.at > MOUNTS_TTL_MS) {
      mounts = { at: now, set: new Set(config.mountPoints().map((mount) => resolve(mount))) };
    }
    return mounts.set;
  };

  const homeSecretFile = (path: string): boolean =>
    // Copies of the Claude config (`.claude.json.bak-…`) carry the same credentials.
    homes.includes(dirname(path)) && basename(path).startsWith(".claude.json.");

  const modifyReason = (path: string, freshMounts: boolean): string | null => {
    if (path === rootDir) return "The filesystem root can't be changed.";
    for (const rule of protectedRules) {
      if (path === rule.path || (rule.scope === "subtree" && isInside(path, rule.path))) {
        return `This is ${rule.label}.`;
      }
    }
    const mountSetNow = mountSet(freshMounts);
    if (mountSetNow.has(path)) return "This is a mount point (the root of a filesystem).";
    if (dirname(path) === rootDir) return "Top-level system folders can't be changed.";
    for (const rule of protectedRules) {
      if (isInside(rule.path, path)) return `It contains ${rule.path} (${rule.label}).`;
    }
    for (const mount of mountSetNow) {
      if (isInside(mount, path)) return `It contains the mount point ${mount}.`;
    }
    return null;
  };

  const downloadReason = (path: string): string | null => {
    for (const rule of secretRules) {
      if (path === rule.path || isInside(path, rule.path)) return `Not downloadable: this is ${rule.label}.`;
    }
    if (homeSecretFile(path)) return "Not downloadable: a copy of .claude.json (credentials).";
    for (const rule of secretRules) {
      if (isInside(rule.path, path)) {
        return `Not downloadable: it contains ${rule.path} (${rule.label}), which its zip would include.`;
      }
    }
    return null;
  };

  const actions = (path: string, freshMounts: boolean): StorageNodeActions => {
    const modify = modifyReason(path, freshMounts);
    return {
      delete: modify,
      rename: modify,
      download: downloadReason(path),
      confirmDelete: !isInside(path, workspacesDir)
    };
  };

  return {
    actionsFor(path: string): StorageNodeActions {
      return actions(path, false);
    },

    projectFor(path) {
      if (!isInside(path, workspacesDir)) return undefined;
      const [workspace, project] = path.slice(workspacesDir.length).split(sep).filter(Boolean);
      if (!workspace || !project || workspace.startsWith(".") || project.startsWith(".")) return undefined;
      return { workspace, project, projectPath: join(workspacesDir, workspace, project) };
    },

    async check(action, rawPath) {
      const resolved = await resolveTarget(action, rawPath);
      if (!resolved) return { ok: false, status: 404, code: "STORAGE_PATH_NOT_FOUND", message: "No such file or folder." };
      const result = actions(resolved.path, true);
      const reason = result[action];
      if (reason) return { ok: false, status: 403, code: "STORAGE_FORBIDDEN", message: reason };
      return { ok: true, path: resolved.path, stats: resolved.stats, actions: result };
    }
  };
}

/**
 * Mount points of this process' mount namespace, bind mounts included (field 5 of
 * `/proc/self/mountinfo`, octal escapes decoded). Empty when the file is unreadable.
 */
export function readMountPoints(file = "/proc/self/mountinfo"): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const points = new Set<string>();
  for (const line of text.split("\n")) {
    const field = line.split(" ")[4];
    if (field) points.add(field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  }
  return [...points];
}

/**
 * Where the request's path really is. delete/rename act on the entry itself, so a
 * final symlink is not followed: realpath(parent) + basename. download reads
 * through it, so the whole path is realpath'd and the target judged.
 */
async function resolveTarget(action: StorageAction, rawPath: string): Promise<{ path: string; stats: Stats } | null> {
  const absolute = resolve(rawPath);
  try {
    if (action === "download") {
      const path = await realpath(absolute);
      return { path, stats: await stat(path) };
    }
    const parent = dirname(absolute);
    const path = parent === absolute ? await realpath(absolute) : join(await realpath(parent), basename(absolute));
    return { path, stats: await lstat(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return null;
    throw error;
  }
}

/** realpath, or (for a missing path) its deepest existing ancestor's realpath + the rest. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}

/** A configured path as the entry itself (a final symlink kept) and as what it resolves to. */
function pathForms(path: string): string[] {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const literal = parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  return unique([literal, canonical(absolute)]);
}

/** Segment-aware: `child` is strictly inside `parent` (`/a/bc` is not inside `/a/b`). */
function isInside(child: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child !== parent && child.startsWith(prefix);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
