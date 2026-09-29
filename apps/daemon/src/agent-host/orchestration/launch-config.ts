/**
 * Agent host — the per-thread launch configuration (spec §3.1 "Launch
 * environment for provider children", §6.1).
 *
 * `CreateHostThreadRequest` carries `launchEnv` / `unsetEnv` / `homePath`:
 * **exactly** what a terminal launch of the same registry entry gets today,
 * composed by the daemon because only the daemon has the sources (the entry's
 * own env, `<appdir>/daemon/env/<id>.env`, and every `resolveExtraEnv`
 * contributor).
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
import { dirname, join } from "node:path";

export interface ThreadLaunchConfig {
  /** Layered over the adapter's own extras; the daemon's values win. */
  launchEnv?: Record<string, string>;
  /** Ambient vars removed from the built env — the `unset` half of §3.1. */
  unsetEnv?: string[];
  /** The daemon's resolved absolute home dir. Never on a client wire. */
  homePath?: string;
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
  // Any other field — an older build's `proxyRefId` among them — is ignored.
  return config;
}

/** Pick the three launch fields off a create request, dropping empty ones. */
export function launchConfigFromRequest(request: {
  launchEnv?: Record<string, string>;
  unsetEnv?: string[];
  homePath?: string;
}): ThreadLaunchConfig {
  return parseThreadLaunchConfig({
    launchEnv: request.launchEnv,
    unsetEnv: request.unsetEnv,
    homePath: request.homePath
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
