/**
 * Agent host — the per-thread launch configuration (spec §3.1 "Launch
 * environment for provider children", §6.1).
 *
 * `CreateHostThreadRequest` carries `launchEnv` / `unsetEnv` / `homePath`:
 * **exactly** what a terminal launch of the same registry entry gets today,
 * composed by the daemon because only the daemon has the sources (the entry's
 * own env, `<appdir>/daemon/env/<id>.env`, and every `resolveExtraEnv`
 * contributor) — and `serverPool`, the keyed provider server an OpenCode
 * thread runs on, and `profile`, the Agent Profile the thread launches with
 * (`HostThreadProfile`, handed to every session start as
 * `StartSessionInput.profile`).
 *
 * It has to be **persisted**, and that is the whole reason this module exists.
 * The daemon sends it once, at create. A session is started long afterwards —
 * by lazy recovery (§4.1) or by the §3.3 reconcile, both of which can run in a
 * host that started after the daemon did. A host that kept this in memory would
 * relaunch a thread without its launcher env (an `opencode.env` proxy, the
 * account home) and talk to the wrong endpoint, or as the wrong identity,
 * without saying so.
 *
 * It is **not** thread-head state: `agentThreadHeadSchema` is a shared contract
 * and strips what it does not know, so this lives in its own file beside
 * `meta.json` inside the thread's directory. Deleting the thread removes the
 * directory, so it needs no cascade of its own.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { HostThreadBox, HostThreadProfile, HostThreadServerPool } from "../host-protocol.ts";
import { parseHostThreadBox } from "../boxes/launch-info.ts";

export interface ThreadLaunchConfig {
  /** Layered over the adapter's own extras; the daemon's values win. */
  launchEnv?: Record<string, string>;
  /** Ambient vars removed from the built env — the `unset` half of §3.1. */
  unsetEnv?: string[];
  /** The daemon's resolved absolute home dir. Never on a client wire. */
  homePath?: string;
  /**
   * The keyed provider server the thread runs on (OpenCode), handed to the
   * adapter as `StartSessionInput.serverPool`. Omitted: the global server.
   */
  serverPool?: HostThreadServerPool;
  /**
   * The Agent Profile the thread launches with, handed to the adapter as
   * `StartSessionInput.profile`. Omitted: Global.
   */
  profile?: HostThreadProfile;
  /**
   * The file named a `profile` that does not read, so the session start FAILS
   * rather than quietly launching a profile thread as Global (spec 2026-10-18
   * §2 anti-goals). Set on load and kept by a rewrite of the same config (a
   * rolled-back switch); a profile switch writes a fresh config without it.
   */
  profileUnreadable?: true;
  /**
   * boxes: the box the thread's CLI runs in (spec 2026-10-19 §8.5), handed to the adapter as
   * `StartSessionInput.box`. Omitted: this machine.
   */
  box?: HostThreadBox;
  /**
   * boxes: the file named a `box` that does not read, so the session start FAILS rather than
   * running the CLI on this machine in the project's empty stub directory.
   */
  boxUnreadable?: true;
}

export interface LaunchConfigStore {
  load(threadId: string): Promise<ThreadLaunchConfig | null>;
  save(threadId: string, config: ThreadLaunchConfig): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field-wise validation with a fallback, never raw `JSON.parse` output reaching
 * typed code (AGENTS.md): this file outlives the build that wrote it (§8), so
 * an unreadable or half-understood one degrades to "no launcher env" rather
 * than failing the thread.
 */
function parseThreadLaunchConfig(value: unknown): ThreadLaunchConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  const config: ThreadLaunchConfig = {};
  if (isRecord(value.launchEnv)) {
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.launchEnv)) {
      if (key.length > 0 && typeof entry === "string") {
        env[key] = entry;
      }
    }
    if (Object.keys(env).length > 0) {
      config.launchEnv = env;
    }
  }
  if (Array.isArray(value.unsetEnv)) {
    const names = value.unsetEnv.filter(
      (name): name is string => typeof name === "string" && name.length > 0
    );
    if (names.length > 0) {
      config.unsetEnv = names;
    }
  }
  if (typeof value.homePath === "string" && value.homePath.length > 0) {
    config.homePath = value.homePath;
  }
  const serverPool = parseServerPool(value.serverPool);
  if (serverPool !== undefined) {
    config.serverPool = serverPool;
  }
  if (value.profile !== undefined && value.profile !== null) {
    const profile = parseHostThreadProfile(value.profile);
    if (profile !== undefined) {
      config.profile = profile;
    } else {
      config.profileUnreadable = true;
    }
  }
  if (value.profileUnreadable === true) {
    config.profileUnreadable = true;
  }
  // boxes:
  if (value.box !== undefined && value.box !== null) {
    const box = parseHostThreadBox(value.box);
    if (box !== undefined) {
      config.box = box;
    } else {
      config.boxUnreadable = true;
    }
  }
  if (value.boxUnreadable === true) {
    config.boxUnreadable = true;
  }
  // Any other field — an older build's `proxyRefId` among them — is ignored.
  return config;
}

/**
 * A {@link HostThreadProfile}, or `undefined` when the value is not one: the
 * three fields non-empty strings and `preparedDir` absolute. Extra fields are
 * dropped. Used for both the persisted file and the requests that carry one.
 */
export function parseHostThreadProfile(value: unknown): HostThreadProfile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { profileId, revision, preparedDir } = value;
  if (
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    typeof revision !== "string" ||
    revision.length === 0 ||
    typeof preparedDir !== "string" ||
    !isAbsolute(preparedDir)
  ) {
    return undefined;
  }
  return { profileId, revision, preparedDir };
}

/**
 * The shape only: a key and string-valued env entries. Whether the pool can
 * APPLY the spec (a reserved key or variable) is the adapter's to decide —
 * it refuses the session rather than quietly running the thread on another
 * server, and dropping the spec here would do exactly that.
 */
function parseServerPool(value: unknown): HostThreadServerPool | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || value.key.length === 0) {
    return undefined;
  }
  const pool: HostThreadServerPool = { key: value.key };
  if (isRecord(value.env)) {
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.env)) {
      if (key.length > 0 && typeof entry === "string") {
        env[key] = entry;
      }
    }
    if (Object.keys(env).length > 0) {
      pool.env = env;
    }
  }
  if (Array.isArray(value.unsetEnv)) {
    const names = value.unsetEnv.filter(
      (name): name is string => typeof name === "string" && name.length > 0
    );
    if (names.length > 0) {
      pool.unsetEnv = names;
    }
  }
  return pool;
}

/**
 * Pick the launch fields off a create, fork or identity request, dropping
 * empty ones. `profile` is the one the caller RESOLVED (a fork's inherited
 * one, an identity switch's unchanged one), already validated with
 * {@link parseHostThreadProfile}; omitted, Global.
 */
export function launchConfigFromRequest(
  request: {
    launchEnv?: Record<string, string>;
    unsetEnv?: string[];
    homePath?: string;
    serverPool?: HostThreadServerPool;
    /** boxes: validated here like the persisted copy; one that does not read marks the config. */
    box?: unknown;
  },
  profile?: HostThreadProfile
): ThreadLaunchConfig {
  return parseThreadLaunchConfig({
    launchEnv: request.launchEnv,
    unsetEnv: request.unsetEnv,
    homePath: request.homePath,
    serverPool: request.serverPool,
    profile,
    // boxes:
    box: request.box
  }) ?? {};
}

const LAUNCH_CONFIG_FILE = "launch.json";

/**
 * `<rootDir>/threads/<threadId>/launch.json`, written atomically (tmp +
 * rename) and 0600 — a launcher env can carry a credential.
 */
export function createFileLaunchConfigStore(options: { rootDir: string }): LaunchConfigStore {
  const pathFor = (threadId: string): string =>
    join(options.rootDir, "threads", threadId, LAUNCH_CONFIG_FILE);

  return {
    async load(threadId: string): Promise<ThreadLaunchConfig | null> {
      try {
        const raw = await readFile(pathFor(threadId), "utf8");
        return parseThreadLaunchConfig(JSON.parse(raw) as unknown);
      } catch {
        // Missing or unreadable: a thread created before this file existed, or
        // one whose launcher has no env at all.
        return null;
      }
    },

    async save(threadId: string, config: ThreadLaunchConfig): Promise<void> {
      const path = pathFor(threadId);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(config, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(tmp, path);
    }
  };
}
